import { Branch, Repository, WorkItem } from "./models";

export interface GitLabHttpResponse {
  status: number;
  statusText?: string;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

export type GitLabHttpTransport = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
  }
) => Promise<GitLabHttpResponse>;

export class GitLabApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

export type SourceResult<T> =
  | { status: "success"; data: T }
  | { status: "error"; error: GitLabApiError };

export interface GitLabProjectSnapshot {
  project: SourceResult<Repository>;
  branches: SourceResult<Branch[]>;
  issues: SourceResult<WorkItem[]>;
  mergeRequests: SourceResult<WorkItem[]>;
}

type ProjectId = string | number;

interface GitLabClientOptions {
  baseUrl: string;
  token: string;
  transport?: GitLabHttpTransport;
}

const defaultTransport: GitLabHttpTransport = (url, init) => fetch(url, init);

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly transport: GitLabHttpTransport;

  public constructor(options: GitLabClientOptions) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new Error("GitLab base URL must be a complete HTTP(S) URL.");
    }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new Error("GitLab base URL must be an HTTPS URL without credentials, query, or fragment.");
    }
    if (!options.token.trim() || /[\u0000-\u001f\u007f]/.test(options.token)) {
      throw new Error("A non-empty GitLab token without control characters is required.");
    }

    this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
    this.apiBaseUrl = `${this.baseUrl}/api/v4`;
    this.token = options.token;
    this.transport = options.transport ?? defaultTransport;
  }

  public async getProject(projectId: ProjectId): Promise<Repository> {
    const { body: raw } = await this.getJson(this.projectUrl(projectId));
    if (!isRecord(raw)) {
      throw invalidResponse("project");
    }

    const id = requiredNumber(raw.id, "project.id");
    const path = requiredString(raw.path_with_namespace, "project.path_with_namespace");
    const webUrl = requiredUrl(raw.web_url, "project.web_url");
    const name = requiredString(raw.name, "project.name");
    const description = optionalString(raw.description, "project.description");
    const defaultBranch = optionalString(raw.default_branch, "project.default_branch");

    return {
      key: this.repositoryKey(id),
      gitlabInstanceUrl: this.baseUrl,
      gitlabProjectId: id,
      gitlabPath: path,
      gitlabWebUrl: webUrl,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(defaultBranch !== undefined ? { defaultBranch } : {})
    };
  }

  public async getBranches(projectId: ProjectId): Promise<Branch[]> {
    const repositoryKey = this.repositoryKey(projectId);
    const branches = await this.getPaginatedArray(`${this.projectUrl(projectId)}/repository/branches?per_page=100`, "branches");
    return branches.map((item) => {
      if (!isRecord(item)) {
        throw invalidResponse("branches");
      }
      const name = requiredString(item.name, "branch.name");
      const commit = item.commit;
      if (commit !== undefined && commit !== null && !isRecord(commit)) {
        throw invalidResponse("branches");
      }
      const latestCommitAt = commit !== undefined && commit !== null
        ? optionalString(commit.committed_date, "branch.commit.committed_date")
        : undefined;
      const isDefault = typeof item.default === "boolean" ? item.default : false;

      return {
        repositoryKey,
        name,
        isDefault,
        isProtected: requiredBoolean(item.protected, "branch.protected"),
        ...(latestCommitAt !== undefined ? { latestCommitAt } : {})
      };
    });
  }

  public async getOpenedIssues(projectId: ProjectId): Promise<WorkItem[]> {
    const url = `${this.projectUrl(projectId)}/issues?state=opened&per_page=100`;
    return this.getWorkItems(url, projectId, "gitlab-issue", "issues");
  }

  public async getOpenedMergeRequests(projectId: ProjectId): Promise<WorkItem[]> {
    const url = `${this.projectUrl(projectId)}/merge_requests?state=opened&per_page=100`;
    return this.getWorkItems(url, projectId, "gitlab-mr", "merge requests");
  }

  public async getProjectSnapshot(projectId: ProjectId): Promise<GitLabProjectSnapshot> {
    const [project, branches, issues, mergeRequests] = await Promise.all([
      capture(() => this.getProject(projectId)),
      capture(() => this.getBranches(projectId)),
      capture(() => this.getOpenedIssues(projectId)),
      capture(() => this.getOpenedMergeRequests(projectId))
    ]);
    return { project, branches, issues, mergeRequests };
  }

  private async getWorkItems(
    url: string,
    projectId: ProjectId,
    source: "gitlab-issue" | "gitlab-mr",
    label: string
  ): Promise<WorkItem[]> {
    const items = await this.getPaginatedArray(url, label);
    const repositoryKey = this.repositoryKey(projectId);
    return items.map((item) => {
      if (!isRecord(item)) {
        throw invalidResponse(label);
      }
      const id = requiredIdentifier(item.id, `${label}.id`);
      const title = requiredString(item.title, `${label}.title`);
      const state = requiredString(item.state, `${label}.state`);
      const externalUrl = requiredUrl(item.web_url, `${label}.web_url`);
      const createdAt = optionalString(item.created_at, `${label}.created_at`);
      const updatedAt = optionalString(item.updated_at, `${label}.updated_at`);

      return {
        repositoryKey,
        source,
        sourceId: String(id),
        title,
        state,
        externalUrl,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {})
      };
    });
  }

  private async getPaginatedArray(initialUrl: string, label: string): Promise<unknown[]> {
    const results: unknown[] = [];
    let url: string | undefined = initialUrl;
    while (url !== undefined) {
      const { body: raw, link } = await this.getJson(url);
      if (!Array.isArray(raw)) {
        throw invalidResponse(label);
      }
      results.push(...raw);
      url = nextLink(link, new URL(this.apiBaseUrl).origin);
    }
    return results;
  }

  private async getJson(url: string): Promise<{ body: unknown; link: string | null }> {
    let response: GitLabHttpResponse;
    try {
      response = await this.transport(url, {
        method: "GET",
        headers: {
          "PRIVATE-TOKEN": this.token,
          Accept: "application/json"
        }
      });
    } catch {
      throw new GitLabApiError("Could not reach GitLab. Check the instance URL and network connection.");
    }

    const link = response.headers.get("Link");
    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status, response.headers.get("Retry-After"));
    }

    try {
      return { body: await response.json(), link };
    } catch {
      throw invalidResponse("response");
    }
  }

  private projectUrl(projectId: ProjectId): string {
    const value = String(projectId).trim();
    if (!value) {
      throw new Error("A GitLab project ID or path is required.");
    }
    return `${this.apiBaseUrl}/projects/${encodeURIComponent(value)}`;
  }

  private repositoryKey(projectId: ProjectId): string {
    return `gitlab:${this.baseUrl}:${String(projectId)}`;
  }
}

async function capture<T>(request: () => Promise<T>): Promise<SourceResult<T>> {
  try {
    return { status: "success", data: await request() };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof GitLabApiError
        ? error
        : new GitLabApiError("GitLab returned data that could not be processed.")
    };
  }
}

function httpError(status: number, retryAfter: string | null): GitLabApiError {
  const retry = retryAfter !== null ? ` Retry after ${retryAfter}.` : "";
  const details = { statusCode: status, retryAfter: retryAfter ?? undefined };
  switch (status) {
    case 401:
      return new GitLabApiError(`GitLab rejected the token. Verify that it is valid and has read_api access.${retry}`, details.statusCode, details.retryAfter);
    case 403:
      return new GitLabApiError(`GitLab denied access. Verify the token's read_api scope and project permissions.${retry}`, details.statusCode, details.retryAfter);
    case 404:
      return new GitLabApiError(`GitLab project was not found or is not visible to this token.${retry}`, details.statusCode, details.retryAfter);
    case 429:
      return new GitLabApiError(`GitLab rate limit reached.${retry}`, details.statusCode, details.retryAfter);
    default:
      return new GitLabApiError(`GitLab request failed with HTTP ${status}. Check the instance and project access.${retry}`, details.statusCode, details.retryAfter);
  }
}

function nextLink(linkHeader: string | null, expectedOrigin: string): string | undefined {
  if (!linkHeader) {
    return undefined;
  }

  const entries = linkHeader.match(/<[^>]+>\s*;[^,]+/g) ?? [];
  for (const entry of entries) {
    const match = /^<([^>]+)>\s*;(.*)$/.exec(entry.trim());
    if (!match || !/(?:^|;)\s*rel\s*=\s*"?next"?(?:\s*;|$)/i.test(match[2])) {
      continue;
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(match[1]);
    } catch {
      throw new GitLabApiError("GitLab returned an invalid pagination URL.");
    }
    if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
      throw new GitLabApiError("GitLab returned an unsupported pagination URL.");
    }
    if (nextUrl.origin !== expectedOrigin) {
      throw new GitLabApiError("GitLab returned a pagination URL for a different host.");
    }
    return nextUrl.toString();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidResponse(field);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidResponse(field);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidResponse(field);
  }
  return value;
}

function requiredIdentifier(value: unknown, field: string): string | number {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw invalidResponse(field);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse(field);
  }
  return value;
}

function requiredUrl(value: unknown, field: string): string {
  const string = requiredString(value, field);
  try {
    const url = new URL(string);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw invalidResponse(field);
  }
  return string;
}

function invalidResponse(field: string): GitLabApiError {
  return new GitLabApiError(`GitLab returned an invalid ${field} response. Check API compatibility and retry.`);
}
