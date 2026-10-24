const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeDashboardState, parseWebviewMessage, safeHttpsUrl } = require("../out/messages.js");

test("accepts only the typed dashboard message shapes", () => {
  assert.deepEqual(parseWebviewMessage({ type: "dashboard.ready" }), { type: "dashboard.ready" });
  assert.deepEqual(parseWebviewMessage({ type: "dashboard.refresh" }), { type: "dashboard.refresh" });
  assert.deepEqual(parseWebviewMessage({
    type: "dashboard.openRisk",
    riskId: "risk-12"
  }), { type: "dashboard.openRisk", riskId: "risk-12" });

  for (const message of [
    null,
    [],
    { type: "dashboard.ready", token: "secret" },
    { type: "dashboard.refresh", extra: true },
    { type: "dashboard.openRisk", riskId: "risk-1", url: "https://example.com" },
    { type: "dashboard.openRisk", riskId: "../anything" },
    { type: "dashboard.openRisk", riskId: 12 },
    { type: "unknown" }
  ]) {
    assert.equal(parseWebviewMessage(message), undefined);
  }
});

test("accepts HTTPS links only and strips unsafe URLs during dashboard normalization", () => {
  assert.equal(safeHttpsUrl("https://gitlab.example/team/repo"), true);
  assert.equal(safeHttpsUrl("http://gitlab.example/team/repo"), false);
  assert.equal(safeHttpsUrl("https://user:pass@gitlab.example/team/repo"), false);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), false);

  const state = normalizeDashboardState({
    status: "ready",
    repositories: [{
      key: "repo",
      name: "Repo",
      path: "team/repo",
      externalUrl: "javascript:alert(1)",
      risks: [{
        id: "risk-1",
        type: "gitlab-issue",
        title: "Issue",
        reason: "Old activity",
        externalUrl: "http://gitlab.example/issue/1"
      }]
    }],
    errors: {}
  });
  assert.equal(state.repositories[0].externalUrl, "");
  assert.equal(state.repositories[0].risks[0].externalUrl, undefined);
});
