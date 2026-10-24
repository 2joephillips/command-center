const assert = require("node:assert/strict");
const { test } = require("node:test");
const { detectStaleBranches, rankRiskItems } = require("../out/riskRanking.js");

const referenceTime = new Date("2026-10-24T00:00:00.000Z");

function branch(name, overrides = {}) {
  return {
    repositoryKey: "repo:1",
    name,
    isDefault: false,
    isProtected: false,
    ...overrides
  };
}

function workItem(source, sourceId, overrides = {}) {
  return {
    source,
    sourceId,
    title: sourceId,
    state: "open",
    repositoryKey: "repo:1",
    ...overrides
  };
}

test("stale branch threshold includes the exact boundary and excludes newer commits", () => {
  const stale = detectStaleBranches([
    branch("boundary", { latestCommitAt: "2026-10-14T00:00:00.000Z" }),
    branch("newer", { latestCommitAt: "2026-10-14T00:00:00.001Z" })
  ], referenceTime, 10);

  assert.deepEqual(stale.map(({ name }) => name), ["boundary"]);
});

test("stale branch detection excludes default and protected branches", () => {
  const stale = detectStaleBranches([
    branch("default", { isDefault: true, latestCommitAt: "2020-01-01T00:00:00Z" }),
    branch("protected", { isProtected: true, latestCommitAt: "2020-01-01T00:00:00Z" }),
    branch("ordinary", { latestCommitAt: "2020-01-01T00:00:00Z" })
  ], referenceTime, 30);

  assert.deepEqual(stale.map(({ name }) => name), ["ordinary"]);
});

test("missing and invalid commit timestamps are excluded rather than marked stale", () => {
  const stale = detectStaleBranches([
    branch("missing"),
    branch("invalid", { latestCommitAt: "not-a-date" }),
    branch("valid", { latestCommitAt: "2020-01-01T00:00:00Z" })
  ], referenceTime, 30);

  assert.deepEqual(stale.map(({ name }) => name), ["valid"]);
});

test("risk ordering applies Snyk severity before age and uses stable ties", () => {
  const items = [
    workItem("snyk", "high-newer", { severity: "HIGH", updatedAt: "2026-10-23T00:00:00Z" }),
    workItem("snyk", "high-older", { severity: "high", updatedAt: "2026-10-20T00:00:00Z" }),
    workItem("snyk", "critical", { severity: "critical", updatedAt: "2026-10-23T00:00:00Z" }),
    workItem("snyk", "unknown", { severity: "unmapped", updatedAt: "2020-01-01T00:00:00Z" }),
    workItem("snyk", "stable-b", { severity: "low", updatedAt: "2026-10-20T00:00:00Z" }),
    workItem("snyk", "stable-a", { severity: "low", updatedAt: "2026-10-20T00:00:00Z" })
  ];
  const ranked = rankRiskItems(items, [], referenceTime);

  assert.deepEqual(ranked.map(({ item }) => item.workItem.sourceId), [
    "critical", "high-older", "high-newer", "stable-a", "stable-b", "unknown"
  ]);
  assert.deepEqual(ranked.map(({ rank }) => rank), [1, 2, 3, 4, 5, 6]);
  assert.match(ranked[0].reason, /critical severity/);
});

test("GitLab issues, merge requests, and stale branches have deterministic category precedence", () => {
  const ranked = rankRiskItems([
    workItem("gitlab-mr", "mr", { createdAt: "2020-01-01T00:00:00Z" }),
    workItem("gitlab-issue", "issue", { createdAt: "2026-10-23T00:00:00Z" })
  ], [
    branch("branch", { latestCommitAt: "2020-01-01T00:00:00Z" })
  ], referenceTime);

  assert.deepEqual(ranked.map(({ item }) => item.kind === "work-item"
    ? item.workItem.source
    : item.branch.name), ["gitlab-issue", "gitlab-mr", "branch"]);
});

test("missing activity dates sort after dated items and stable keys break remaining ties", () => {
  const ranked = rankRiskItems([
    workItem("gitlab-issue", "unknown-b"),
    workItem("gitlab-issue", "unknown-a"),
    workItem("gitlab-issue", "newer", { updatedAt: "2026-10-22T00:00:00Z" })
  ], [], referenceTime);

  assert.deepEqual(ranked.map(({ item }) => item.workItem.sourceId), ["newer", "unknown-a", "unknown-b"]);
});
