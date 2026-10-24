import { SnykProject, WorkItem } from "./models";

export interface SnykHttpResponse {
  status: number;
  statusText?: string;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

export type SnykHttpTransport = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
  }
) => Promise<SnykHttpResponse>;

export class SnykApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = "SnykApiError";
  }
}

export type SnykSourceResult<T> =
  | { status: "success"; data: T }
  | { status: "error"; error: SnykApiError };

export interface SnykOrganizationSnapshot {
  projects: SnykSourceResult<SnykProject[]>;
  issues: SnykSourceResult<WorkItem[]>;
}

export interface SnykClientOptions {
  baseUrl: string;
  token: string;
  transport?: SnykHttpTransport;
  apiVersion?: string;
}

const defaultTransport: SnykHttpTransport = (url, init) => fetch(url, init);
const defaultApiVersion = "2024-10-15";

export class SnykClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly token: string;
  private readonly transport: SnykHttpTransport;
  private readonly apiVersion: string;

  public constructor(options: SnykClientOptions) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new Error("Snyk base URL must be a complete HTTPS URL.");
    }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new Error("Snyk base URL must be an HTTPS URL without credentials, query, or fragment.");
    }
    if (!options.token.trim() || /[\u0000-\u001f\u007f]/.test(options.token)) {
      throw new Error("A non-empty Snyk token without control characters is required.");
    }

    this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
    this.origin = base.origin;
    this.token = options.token;
    this.transport = options.transport ?? defaultTransport;
    this.apiVersion = options.apiVersion ?? defaultApiVersion;
    if (!this.apiVersion.trim() || /[\u0000-\u001f\u007f]/.test(this.apiVersion)) {
      throw new Error("A valid Snyk REST API version is required.");
    }
  }

  public async getOrganizationProjects(orgId: string): Promise<SnykProject[]> {
    const items = await this.getPaginatedArray(this.organizationUrl(orgId, "projects"), "projects");
    return items.map((item) => normalizeProject(item));
  }

  public async getOrganizationIssues(orgId: string): Promise<WorkItem[]> {
    const items = await this.getPaginatedArray(this.organizationUrl(orgId, "issues"), "issues");
    return items.map((item) => normalizeIssue(item));
  }

  public async getOrganizationSnapshot(orgId: string): Promise<SnykOrganizationSnapshot> {
    const [projects, issues] = await Promise.all([
      capture(() => this.getOrganizationProjects(orgId)),
      capture(() => this.getOrganizationIssues(orgId))
    ]);
    return { projects, issues };
  }

  private async getPaginatedArray(initialUrl: string, label: string): Promise<unknown[]> {
    const results: unknown[] = [];
    let url: string | undefined = initialUrl;
    const visitedUrls = new Set<string>();
    while (url !== undefined) {
      if (visitedUrls.has(url)) {
        throw new SnykApiError("Snyk returned a repeated pagination URL.");
      }
      visitedUrls.add(url);
      const { body } = await this.getJson(url);
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw invalidResponse(label);
      }
      results.push(...body.data);
      url = nextUrl(body.links, url, this.origin);
    }
    return results;
  }

  private async getJson(url: string): Promise<{ body: unknown }> {
    let response: SnykHttpResponse;
    try {
      response = await this.transport(url, {
        method: "GET",
        headers: {
          Authorization: `token ${this.token}`,
          Accept: "application/vnd.api+json"
        }
      });
    } catch {
      throw new SnykApiError("Could not reach Snyk. Check the regional API URL and network connection.");
    }

    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status, response.headers.get("Retry-After"));
    }

    try {
      return { body: await response.json() };
    } catch {
      throw invalidResponse("response");
    }
  }

  private organizationUrl(orgId: string, resource: "projects" | "issues"): string {
    const id = orgId.trim();
    if (!id || /[\u0000-\u001f\u007f]/.test(id)) {
      throw new SnykApiError("A valid Snyk organization ID is required.");
    }
    const url = new URL(`${this.baseUrl}/rest/orgs/${encodeURIComponent(id)}/${resource}`);
    url.searchParams.set("version", this.apiVersion);
    return url.toString();
  }
}

async function capture<T>(request: () => Promise<T>): Promise<SnykSourceResult<T>> {
  try {
    return { status: "success", data: await request() };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof SnykApiError
        ? error
        : new SnykApiError("Snyk returned data that could not be processed.")
    };
  }
}

function normalizeProject(value: unknown): SnykProject {
  if (!isRecord(value) || !isRecord(value.attributes)) {
    throw invalidResponse("project");
  }
  const id = requiredIdentifier(value.id, "project.id");
  const name = requiredString(value.attributes.name, "project.attributes.name");
  const projectUrl = optionalString(
    value.attributes.browseUrl ?? value.attributes.url,
    "project.attributes.browseUrl"
  );
  return {
    id: String(id),
    name,
    ...(projectUrl !== undefined ? { url: requiredUrl(projectUrl, "project.attributes.browseUrl") } : {})
  };
}

function normalizeIssue(value: unknown): WorkItem {
  if (!isRecord(value) || !isRecord(value.attributes)) {
    throw invalidResponse("issue");
  }
  const sourceId = String(requiredIdentifier(value.id, "issue.id"));
  const title = requiredString(value.attributes.title, "issue.attributes.title");
  const state = optionalString(value.attributes.status, "issue.attributes.status") ?? "open";
  const severity = optionalString(
    value.attributes.effective_severity_level ?? value.attributes.effectiveSeverityLevel,
    "issue.attributes.effective_severity_level"
  );
  const relatedProjectId = scanItemProjectId(value.relationships);
  const problemUrl = firstProblemUrl(value.attributes.problems);

  return {
    source: "snyk",
    sourceId,
    title,
    state,
    ...(severity !== undefined ? { severity } : {}),
    ...(relatedProjectId !== undefined ? { scanItemProjectId: relatedProjectId } : {}),
    ...(problemUrl !== undefined ? { externalUrl: problemUrl } : {})
  };
}

function scanItemProjectId(relationships: unknown): string | undefined {
  if (relationships === undefined || relationships === null) {
    return undefined;
  }
  if (!isRecord(relationships)) {
    throw invalidResponse("issue.relationships");
  }
  const scanItem = relationships.scan_item;
  if (scanItem === undefined || scanItem === null) {
    return undefined;
  }
  if (!isRecord(scanItem) || (scanItem.data !== null && scanItem.data !== undefined && !isRecord(scanItem.data))) {
    throw invalidResponse("issue.relationships.scan_item");
  }
  if (scanItem.data === null || scanItem.data === undefined) {
    return undefined;
  }
  return String(requiredIdentifier(scanItem.data.id, "issue.relationships.scan_item.data.id"));
}

function firstProblemUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidResponse("issue.attributes.problems");
  }
  for (const problem of value) {
    if (!isRecord(problem)) {
      throw invalidResponse("issue.attributes.problems");
    }
    if (problem.url !== undefined && problem.url !== null) {
      return requiredUrl(requiredString(problem.url, "issue.attributes.problems.url"), "issue.attributes.problems.url");
    }
  }
  return undefined;
}

function nextUrl(links: unknown, currentUrl: string, expectedOrigin: string): string | undefined {
  if (links === undefined || links === null) {
    return undefined;
  }
  if (!isRecord(links)) {
    throw invalidResponse("links");
  }
  if (links.next === undefined || links.next === null || links.next === "") {
    return undefined;
  }
  if (typeof links.next !== "string") {
    throw invalidResponse("links.next");
  }

  let url: URL;
  try {
    url = new URL(links.next, currentUrl);
  } catch {
    throw new SnykApiError("Snyk returned an invalid pagination URL.");
  }
  if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password) {
    throw new SnykApiError("Snyk returned a pagination URL outside the configured regional API host.");
  }
  return url.toString();
}

function httpError(status: number, retryAfter: string | null): SnykApiError {
  const retry = retryAfter !== null ? ` Retry after ${retryAfter}.` : "";
  const details = { statusCode: status, retryAfter: retryAfter ?? undefined };
  switch (status) {
    case 401:
      return new SnykApiError(`Snyk rejected the token. Verify that it is valid and has access to the selected organization.${retry}`, details.statusCode, details.retryAfter);
    case 403:
      return new SnykApiError(`Snyk denied access. Verify the token permissions and organization access.${retry}`, details.statusCode, details.retryAfter);
    case 404:
      return new SnykApiError(`The Snyk organization or requested resource was not found or is not visible to this token.${retry}`, details.statusCode, details.retryAfter);
    case 429:
      return new SnykApiError(`Snyk rate limit reached.${retry}`, details.statusCode, details.retryAfter);
    default:
      return new SnykApiError(`Snyk request failed with HTTP ${status}. Check the regional API URL and organization access.${retry}`, details.statusCode, details.retryAfter);
  }
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

function requiredIdentifier(value: unknown, field: string): string | number {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).length ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw invalidResponse(field);
  }
  return value;
}

function requiredUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw invalidResponse(field);
  }
  return value;
}

function invalidResponse(field: string): SnykApiError {
  return new SnykApiError(`Snyk returned an invalid ${field} response. Check API compatibility and retry.`);
}
