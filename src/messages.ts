export type DashboardRiskType = "snyk" | "gitlab-issue" | "gitlab-mr" | "stale-branch";
export type DashboardStatus = "loading" | "ready" | "partial" | "error";

export interface DashboardRisk {
  id: string;
  rank: number;
  type: DashboardRiskType;
  title: string;
  severity?: string;
  reason: string;
  externalUrl?: string;
}

export interface DashboardRepository {
  key: string;
  name: string;
  path: string;
  externalUrl: string;
  risks: DashboardRisk[];
}

export interface DashboardState {
  status: DashboardStatus;
  repositories: DashboardRepository[];
  lastRefreshed?: string;
  errors: { gitlab?: string; snyk?: string };
  message?: string;
}

export interface DashboardReadyMessage {
  type: "dashboard.ready";
}

export interface DashboardRefreshMessage {
  type: "dashboard.refresh";
}

export interface DashboardOpenRiskMessage {
  type: "dashboard.openRisk";
  riskId: string;
}

export type WebviewMessage = DashboardReadyMessage | DashboardRefreshMessage | DashboardOpenRiskMessage;

export interface DashboardInitializeMessage {
  type: "dashboard.initialize";
  state: DashboardState;
}

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (message.type === "dashboard.ready" && Object.keys(message).length === 1) {
    return { type: "dashboard.ready" };
  }
  if (message.type === "dashboard.refresh" && Object.keys(message).length === 1) {
    return { type: "dashboard.refresh" };
  }
  if (
    message.type === "dashboard.openRisk" &&
    Object.keys(message).length === 2 &&
    typeof message.riskId === "string" &&
    /^[a-zA-Z0-9:_-]{1,200}$/.test(message.riskId)
  ) {
    return { type: "dashboard.openRisk", riskId: message.riskId };
  }
  return undefined;
}

export function normalizeDashboardState(value: DashboardState): DashboardState {
  const repositories = value.repositories.map((repository) => ({
    ...repository,
    risks: repository.risks.map((risk) => ({
      ...risk,
      externalUrl: safeHttpsUrl(risk.externalUrl) ? risk.externalUrl : undefined
    })),
    externalUrl: safeHttpsUrl(repository.externalUrl) ? repository.externalUrl : ""
  }));
  return { ...value, repositories };
}

export function safeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
