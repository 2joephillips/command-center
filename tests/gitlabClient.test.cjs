const assert = require("node:assert/strict");
const { test } = require("node:test");
const { GitLabApiError, GitLabClient } = require("../out/gitlabClient.js");

function response(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? headers[name] ?? null;
      }
    },
    json: async () => body
  };
}

function clientWith(handler) {
  const requests = [];
  const client = new GitLabClient({
    baseUrl: "https://git.example.com/instance/",
    token: "secret-token",
    transport: async (url, init) => {
      requests.push({ url, init });
      return handler(url, init);
    }
  });
  return { client, requests };
}

test("normalizes selected project details and encodes project paths", async () => {
  const { client, requests } = clientWith(() => response({
    id: 42,
    name: "Service",
    description: "A service",
    path_with_namespace: "team/service",
    web_url: "https://git.example.com/team/service",
    default_branch: "main"
  }));

  const project = await client.getProject("team/service");

  assert.deepEqual(project, {
    key: "gitlab:https://git.example.com/instance:42",
    gitlabInstanceUrl: "https://git.example.com/instance",
    gitlabProjectId: 42,
    gitlabPath: "team/service",
    gitlabWebUrl: "https://git.example.com/team/service",
    name: "Service",
    description: "A service",
    defaultBranch: "main"
  });
  assert.equal(requests[0].url, "https://git.example.com/instance/api/v4/projects/team%2Fservice");
  assert.equal(requests[0].init.headers["PRIVATE-TOKEN"], "secret-token");
});

test("normalizes branches, opened issues, and merge requests across absolute next links", async () => {
  const nextBranches = "https://git.example.com/api/v4/projects/42/repository/branches?page=2&per_page=100";
  const nextIssues = "https://git.example.com/api/v4/projects/42/issues?state=opened&page=2";
  const { client, requests } = clientWith((url) => {
    if (url.endsWith("/repository/branches?per_page=100")) {
      return response([{
        name: "main",
        default: true,
        protected: true,
        commit: { committed_date: "2026-01-02T03:04:05Z" }
      }], { headers: { link: `<${nextBranches}>; rel="next", <https://git.example.com/last>; rel="last"` } });
    }
    if (url === nextBranches) {
      return response([{ name: "feature", default: false, protected: false, commit: { committed_date: null } }]);
    }
    if (url.endsWith("/issues?state=opened&per_page=100")) {
      return response([{
        id: 7,
        title: "Fix bug",
        state: "opened",
        web_url: "https://git.example.com/team/service/-/issues/7",
        created_at: "2026-01-01",
        updated_at: "2026-01-03"
      }], { headers: { link: `<${nextIssues}>; rel="next"` } });
    }
    if (url === nextIssues) {
      return response([{
        id: 8,
        title: "Second issue",
        state: "opened",
        web_url: "https://git.example.com/team/service/-/issues/8"
      }]);
    }
    if (url.endsWith("/merge_requests?state=opened&per_page=100")) {
      return response([{
        id: 9,
        title: "Add feature",
        state: "opened",
        web_url: "https://git.example.com/team/service/-/merge_requests/9"
      }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  assert.deepEqual(await client.getBranches(42), [
    {
      repositoryKey: "gitlab:https://git.example.com/instance:42",
      name: "main",
      isDefault: true,
      isProtected: true,
      latestCommitAt: "2026-01-02T03:04:05Z"
    },
    {
      repositoryKey: "gitlab:https://git.example.com/instance:42",
      name: "feature",
      isDefault: false,
      isProtected: false
    }
  ]);
  assert.deepEqual(await client.getOpenedIssues(42), [
    {
      repositoryKey: "gitlab:https://git.example.com/instance:42",
      source: "gitlab-issue",
      sourceId: "7",
      title: "Fix bug",
      state: "opened",
      externalUrl: "https://git.example.com/team/service/-/issues/7",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-03"
    },
    {
      repositoryKey: "gitlab:https://git.example.com/instance:42",
      source: "gitlab-issue",
      sourceId: "8",
      title: "Second issue",
      state: "opened",
      externalUrl: "https://git.example.com/team/service/-/issues/8"
    }
  ]);
  assert.equal((await client.getOpenedMergeRequests(42))[0].source, "gitlab-mr");
  assert.equal(requests.length, 5);
  assert.ok(requests.every(({ init }) => init.headers["PRIVATE-TOKEN"] === "secret-token"));
});

test("surfaces actionable authentication, permission, and rate-limit failures", async (t) => {
  for (const [status, expected] of [
    [401, /valid.*read_api access/],
    [403, /read_api scope.*project permissions/],
    [429, /rate limit reached.*Retry after 37/]
  ]) {
    await t.test(`HTTP ${status}`, async () => {
      const { client } = clientWith(() => response({}, {
        status,
        headers: { "retry-after": "37" }
      }));

      await assert.rejects(client.getProject(42), (error) => {
        assert.ok(error instanceof GitLabApiError);
        assert.equal(error.statusCode, status);
        assert.equal(error.retryAfter, "37");
        assert.match(error.message, expected);
        assert.equal(error.message.includes("secret-token"), false);
        return true;
      });
    });
  }
});

test("keeps successful project sources when one snapshot source fails", async () => {
  const { client } = clientWith((url) => {
    if (url.endsWith("/issues?state=opened&per_page=100")) {
      return response({}, { status: 403 });
    }
    if (url.endsWith("/projects/42")) {
      return response({
        id: 42,
        name: "Service",
        path_with_namespace: "team/service",
        web_url: "https://git.example.com/team/service"
      });
    }
    if (url.endsWith("/repository/branches?per_page=100")) {
      return response([{ name: "main", default: true, protected: false, commit: {} }]);
    }
    if (url.endsWith("/merge_requests?state=opened&per_page=100")) {
      return response([]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const snapshot = await client.getProjectSnapshot(42);
  assert.equal(snapshot.project.status, "success");
  assert.equal(snapshot.branches.status, "success");
  assert.equal(snapshot.mergeRequests.status, "success");
  assert.deepEqual(snapshot.mergeRequests.data, []);
  assert.equal(snapshot.issues.status, "error");
  assert.equal(snapshot.issues.error.statusCode, 403);
});

test("rejects malformed successful response shapes", async () => {
  const { client } = clientWith(() => response({ id: "wrong shape" }));
  await assert.rejects(client.getProject(42), /invalid project\.id response/);
});

test("rejects pagination links that would send the token to another host", async () => {
  const { client, requests } = clientWith(() => response([], {
    headers: { link: '<https://attacker.example/collect?page=2>; rel="next"' }
  }));

  await assert.rejects(client.getOpenedIssues(42), /pagination URL for a different host/);
  assert.equal(requests.length, 1);
});
