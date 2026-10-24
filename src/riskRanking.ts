import { Branch, WorkItem } from "./models";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const severityOrder = ["critical", "high", "medium", "low"];

export type RiskItem =
  | { kind: "work-item"; workItem: WorkItem }
  | { kind: "stale-branch"; branch: Branch };

export interface RankedRiskItem {
  rank: number;
  item: RiskItem;
  reason: string;
}

interface SortableRiskItem {
  item: RiskItem;
  category: number;
  severity: number;
  activityAt?: number;
  stableKey: string[];
  reason: string;
}

/**
 * Returns branches older than the configured threshold. Unknown timestamps,
 * default branches, and protected branches are intentionally excluded.
 */
export function detectStaleBranches(
  branches: readonly Branch[],
  referenceTime: Date,
  thresholdDays: number
): Branch[] {
  const referenceMilliseconds = validReferenceTime(referenceTime);
  if (!Number.isFinite(thresholdDays) || thresholdDays < 0) {
    throw new RangeError("Stale branch threshold must be a finite, non-negative number of days.");
  }
  const cutoff = referenceMilliseconds - thresholdDays * millisecondsPerDay;
  if (!Number.isFinite(cutoff)) {
    throw new RangeError("Stale branch threshold is outside the supported date range.");
  }

  return branches.filter((branch) => {
    if (branch.isDefault || branch.isProtected || !branch.latestCommitAt) {
      return false;
    }
    const committedAt = Date.parse(branch.latestCommitAt);
    return Number.isFinite(committedAt) && committedAt <= cutoff;
  });
}

/**
 * Orders findings before GitLab issues, merge requests, and stale branches.
 * Older activity and stable identifiers break ties within each category.
 */
export function rankRiskItems(
  workItems: readonly WorkItem[],
  staleBranches: readonly Branch[],
  referenceTime: Date
): RankedRiskItem[] {
  const referenceMilliseconds = validReferenceTime(referenceTime);
  const sortable: SortableRiskItem[] = [
    ...workItems.map((workItem) => sortWorkItem(workItem)),
    ...staleBranches.map((branch) => sortBranch(branch, referenceMilliseconds))
  ];

  sortable.sort(compareRiskItems);
  return sortable.map(({ item, reason }, index) => ({ rank: index + 1, item, reason }));
}

function sortWorkItem(workItem: WorkItem): SortableRiskItem {
  const activityAt = parseTimestamp(workItem.updatedAt) ?? parseTimestamp(workItem.createdAt);
  const repositoryKey = workItem.repositoryKey ?? workItem.scanItemProjectId ?? "";
  const category = workItem.source === "snyk" ? 0 : workItem.source === "gitlab-issue" ? 1 : 2;
  const severity = workItem.source === "snyk" ? severityRank(workItem.severity) : 0;
  const groupName = workItem.source === "snyk"
    ? "Snyk finding"
    : workItem.source === "gitlab-issue"
      ? "GitLab issue"
      : "GitLab merge request";
  const details = workItem.source === "snyk"
    ? `${knownSeverity(workItem.severity)} severity`
    : "oldest activity first";

  return {
    item: { kind: "work-item", workItem },
    category,
    severity,
    activityAt,
    stableKey: [
      repositoryKey,
      workItem.sourceId,
      workItem.title,
      workItem.state,
      workItem.severity ?? "",
      workItem.createdAt ?? "",
      workItem.updatedAt ?? "",
      workItem.externalUrl ?? "",
      workItem.scanItemProjectId ?? ""
    ],
    reason: `${groupName}: ${details}; oldest activity first${activityAt === undefined ? " (unknown activity last)" : ""}`
  };
}

function sortBranch(branch: Branch, referenceMilliseconds: number): SortableRiskItem {
  const activityAt = parseTimestamp(branch.latestCommitAt);
  const ageDays = activityAt === undefined
    ? undefined
    : Math.floor((referenceMilliseconds - activityAt) / millisecondsPerDay);

  return {
    item: { kind: "stale-branch", branch },
    category: 3,
    severity: 0,
    activityAt,
    stableKey: [
      branch.repositoryKey,
      branch.name,
      branch.latestCommitAt ?? "",
      String(branch.isDefault),
      String(branch.isProtected)
    ],
    reason: `Stale branch: oldest commit first${ageDays === undefined ? "" : `; ${ageDays} days since last commit`}`
  };
}

function compareRiskItems(left: SortableRiskItem, right: SortableRiskItem): number {
  return left.category - right.category
    || left.severity - right.severity
    || compareActivity(left.activityAt, right.activityAt)
    || compareStringArrays(left.stableKey, right.stableKey);
}

function compareActivity(left?: number, right?: number): number {
  if (left === undefined) {
    return right === undefined ? 0 : 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}

function compareStringArrays(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const comparison = compareStrings(left[index] ?? "", right[index] ?? "");
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function severityRank(severity?: string): number {
  const index = severityOrder.indexOf(severity?.trim().toLowerCase() ?? "");
  return index < 0 ? severityOrder.length : index;
}

function knownSeverity(severity?: string): string {
  const normalized = severity?.trim().toLowerCase() ?? "";
  return severityOrder.includes(normalized) ? normalized : "unknown";
}

function parseTimestamp(timestamp?: string): number | undefined {
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validReferenceTime(referenceTime: Date): number {
  const milliseconds = referenceTime.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("Reference time must be a valid date.");
  }
  return milliseconds;
}
