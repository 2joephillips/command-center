const assert = require("node:assert/strict");
const { test } = require("node:test");
const { SnykApiError, SnykClient } = require("../out/snykClient.js");

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
  const client = new SnykClient({
    baseUrl: "https://api.eu.snyk.io/",
    token: "secret-token",
    transport: async (url, init) => {
      requests.push({ url, init });
      return handler(url, init);
    }
  });
  return { client, requests };
}

test("normalizes projects and findings, preserving the scan-item project ID", async () => {
  const { client, requests } = clientWith((url) => {
    if (url.includes("/projects?")) {
      return response({
        data: [{
          id: "project-1",
          type: "project",
          attributes: {
            name: "Service",
            browseUrl: "https://app.snyk.io/org/acme/project/project-1"
          }
        }]
      });
    }
    if (url.includes("/issues?")) {
      return response({
        data: [{
          id: "issue-1",
          type: "issue",
          attributes: {
            title: "Upgrade vulnerable package",
            effective_severity_level: "high",
            problems: [{ url: "https://security.example/advisory/1" }]
          },
          relationships: {
            scan_item: { data: { id: "project-1", type: "project" } }
          }
        }]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  assert.deepEqual(await client.getOrganizationProjects("org-1"), [{
    id: "project-1",
    name: "Service",
    url: "https://app.snyk.io/org/acme/project/project-1"
  }]);
  assert.deepEqual(await client.getOrganizationIssues("org-1"), [{
    source: "snyk",
    sourceId: "issue-1",
    title: "Upgrade vulnerable package",
    state: "open",
    severity: "high",
    scanItemProjectId: "project-1",
    externalUrl: "https://security.example/advisory/1"
  }]);
  assert.equal(requests[0].url, "https://api.eu.snyk.io/rest/orgs/org-1/projects?version=2024-10-15");
  assert.ok(requests.every(({ init }) => init.headers.Authorization === "token secret-token"));
});

test("follows links.next without constructing cursors and retains independent pagination", async () => {
  const projectNext = "https://api.eu.snyk.io/rest/orgs/org-1/projects?cursor=projects-2";
  const issueNext = "https://api.eu.snyk.io/rest/orgs/org-1/issues?cursor=issues-2";
  const { client, requests } = clientWith((url) => {
    if (url.endsWith("/projects?version=2024-10-15")) {
      return response({ data: [{ id: "p1", attributes: { name: "First" } }], links: { next: projectNext } });
    }
    if (url === projectNext) {
      return response({ data: [{ id: "p2", attributes: { name: "Second" } }] });
    }
    if (url.endsWith("/issues?version=2024-10-15")) {
      return response({ data: [{ id: "i1", attributes: { title: "Issue" } }], links: { next: issueNext } });
    }
    if (url === issueNext) {
      return response({ data: [{ id: "i2", attributes: { title: "Next issue" } }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  assert.deepEqual((await client.getOrganizationProjects("org-1")).map((project) => project.id), ["p1", "p2"]);
  assert.deepEqual((await client.getOrganizationIssues("org-1")).map((issue) => issue.sourceId), ["i1", "i2"]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ init }) => init.headers.Authorization === "token secret-token"));
});

test("rejects pagination URLs outside the configured regional host before forwarding the token", async () => {
  const { client, requests } = clientWith(() => response({
    data: [],
    links: { next: "https://attacker.example/collect" }
  }));

  await assert.rejects(client.getOrganizationProjects("org-1"), /outside the configured regional API host/);
  assert.equal(requests.length, 1);
});

test("stops repeated cursor links rather than requesting a page forever", async () => {
  const next = "https://api.eu.snyk.io/rest/orgs/org-1/projects?cursor=repeat";
  const { client, requests } = clientWith(() => response({ data: [], links: { next } }));
  await assert.rejects(client.getOrganizationProjects("org-1"), /repeated pagination URL/);
  assert.equal(requests.length, 2);
});

test("surfaces actionable authentication, permission, and rate-limit failures without the token", async (t) => {
  for (const [status, expected] of [
    [401, /rejected the token.*selected organization/],
    [403, /token permissions and organization access/],
    [429, /rate limit reached.*Retry after 37/]
  ]) {
    await t.test(`HTTP ${status}`, async () => {
      const { client } = clientWith(() => response({}, {
        status,
        headers: { "retry-after": "37" }
      }));
      await assert.rejects(client.getOrganizationProjects("org-1"), (error) => {
        assert.ok(error instanceof SnykApiError);
        assert.equal(error.statusCode, status);
        assert.equal(error.retryAfter, "37");
        assert.match(error.message, expected);
        assert.equal(error.message.includes("secret-token"), false);
        return true;
      });
    });
  }
});

test("keeps successful organization sources when the other source fails", async () => {
  const { client } = clientWith((url) => {
    if (url.includes("/projects?")) {
      return response({ data: [{ id: "p1", attributes: { name: "Service" } }] });
    }
    if (url.includes("/issues?")) {
      return response({}, { status: 403 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const snapshot = await client.getOrganizationSnapshot("org-1");
  assert.equal(snapshot.projects.status, "success");
  assert.deepEqual(snapshot.projects.data, [{ id: "p1", name: "Service" }]);
  assert.equal(snapshot.issues.status, "error");
  assert.equal(snapshot.issues.error.statusCode, 403);
});

test("rejects malformed successful response shapes and invalid configuration", async () => {
  const { client } = clientWith(() => response({ data: [{ id: "p1", attributes: {} }] }));
  await assert.rejects(client.getOrganizationProjects("org-1"), /invalid project\.attributes\.name response/);
  assert.throws(() => new SnykClient({ baseUrl: "http://api.snyk.io", token: "token" }), /HTTPS/);
});

test("supports findings without an optional problem URL or project relationship", async () => {
  const { client } = clientWith(() => response({
    data: [{ id: "issue-2", attributes: { title: "No URL", effective_severity_level: "medium" } }]
  }));
  assert.deepEqual(await client.getOrganizationIssues("org-1"), [{
    source: "snyk",
    sourceId: "issue-2",
    title: "No URL",
    state: "open",
    severity: "medium"
  }]);
});
