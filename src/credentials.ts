export const gitLabTokenSecretKey = "commandCenter.gitlab.token";
export const snykTokenSecretKey = "commandCenter.snyk.token";

export interface SecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface PreferenceStorage {
  update(key: string, value: string): Thenable<void>;
}

export function validateServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete URL, such as https://gitlab.example.com.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Use an HTTPS URL to protect credentials in transit.");
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error("Enter a service URL without embedded credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("The service URL cannot include a query string or fragment.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function validateToken(value: string): string {
  const token = value.trim();
  if (!token) {
    throw new Error("Enter a non-empty access token.");
  }
  if (/[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("The token cannot contain control characters.");
  }
  return token;
}

export class CredentialStore {
  public constructor(
    private readonly secrets: SecretStorage,
    private readonly preferences: PreferenceStorage
  ) {}

  public async saveGitLab(baseUrl: string, token: string): Promise<void> {
    const validUrl = validateServiceUrl(baseUrl);
    const validToken = validateToken(token);
    await this.preferences.update("gitlab.baseUrl", validUrl);
    await this.secrets.store(gitLabTokenSecretKey, validToken);
  }

  public async saveSnyk(apiUrl: string, token: string): Promise<void> {
    const validUrl = validateServiceUrl(apiUrl);
    const validToken = validateToken(token);
    await this.preferences.update("snyk.apiUrl", validUrl);
    await this.secrets.store(snykTokenSecretKey, validToken);
  }

  public getGitLabToken(): Thenable<string | undefined> {
    return this.secrets.get(gitLabTokenSecretKey);
  }

  public getSnykToken(): Thenable<string | undefined> {
    return this.secrets.get(snykTokenSecretKey);
  }

  public deleteGitLabToken(): Thenable<void> {
    return this.secrets.delete(gitLabTokenSecretKey);
  }

  public deleteSnykToken(): Thenable<void> {
    return this.secrets.delete(snykTokenSecretKey);
  }
}
