const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  CredentialStore,
  gitLabTokenSecretKey,
  snykTokenSecretKey,
  validateServiceUrl,
  validateToken
} = require("../out/credentials.js");

function createCredentialStore() {
  const secrets = new Map();
  const preferences = new Map();
  return {
    store: new CredentialStore(
      {
        get: async (key) => secrets.get(key),
        store: async (key, value) => secrets.set(key, value),
        delete: async (key) => secrets.delete(key)
      },
      { update: async (key, value) => preferences.set(key, value) }
    ),
    secrets,
    preferences
  };
}

test("validates and normalizes configurable service URLs", () => {
  assert.equal(validateServiceUrl(" https://git.example.com/group/ "), "https://git.example.com/group");
  assert.equal(validateServiceUrl("https://api.eu.snyk.io/"), "https://api.eu.snyk.io");
  assert.throws(() => validateServiceUrl("gitlab.example.com"), /complete URL/);
  assert.throws(() => validateServiceUrl("http://gitlab.example.com"), /HTTPS URL/);
  assert.throws(() => validateServiceUrl("https://user:pass@gitlab.example.com"), /embedded credentials/);
  assert.throws(() => validateServiceUrl("https://gitlab.example.com/?token=secret"), /query string or fragment/);
});

test("rejects empty or control-character tokens", () => {
  assert.throws(() => validateToken("   "), /non-empty/);
  assert.throws(() => validateToken("abc\nsecret"), /control characters/);
  assert.equal(validateToken(" token-value "), "token-value");
});

test("stores tokens only in secret storage and URLs only in preferences", async () => {
  const { store, secrets, preferences } = createCredentialStore();

  await store.saveGitLab("https://git.example.com/", "git-token");
  await store.saveSnyk("https://api.au.snyk.io", "snyk-token");

  assert.equal(secrets.get(gitLabTokenSecretKey), "git-token");
  assert.equal(secrets.get(snykTokenSecretKey), "snyk-token");
  assert.equal(preferences.get("gitlab.baseUrl"), "https://git.example.com");
  assert.equal(preferences.get("snyk.apiUrl"), "https://api.au.snyk.io");
  assert.deepEqual([...preferences.values()], ["https://git.example.com", "https://api.au.snyk.io"]);
  assert.deepEqual([...secrets.keys()], [gitLabTokenSecretKey, snykTokenSecretKey]);
});

test("does not persist a token when its URL or token is invalid", async () => {
  const { store, secrets, preferences } = createCredentialStore();

  await assert.rejects(store.saveGitLab("not-a-url", "token"), /complete URL/);
  await assert.rejects(store.saveSnyk("https://api.snyk.io", " "), /non-empty/);
  assert.equal(secrets.size, 0);
  assert.equal(preferences.size, 0);
});

test("deletes a provider token without changing its URL preference", async () => {
  const { store, secrets, preferences } = createCredentialStore();

  await store.saveGitLab("https://git.example.com", "git-token");
  await store.deleteGitLabToken();

  assert.equal(await store.getGitLabToken(), undefined);
  assert.equal(preferences.get("gitlab.baseUrl"), "https://git.example.com");
});
