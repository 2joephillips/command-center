import * as vscode from "vscode";
import { CommandCenterViewProvider } from "./commandCenterViewProvider";
import { CredentialStore, validateServiceUrl, validateToken } from "./credentials";
import { GitLabClient } from "./gitlabClient";
import { Branch, Repository, SnykProject, WorkItem } from "./models";
import { DashboardRepository, DashboardRisk, DashboardState, safeHttpsUrl } from "./messages";
import { detectStaleBranches, rankRiskItems, RiskItem } from "./riskRanking";
import { SnykClient } from "./snykClient";

const defaultGitLabUrl = "https://gitlab.com";
const defaultSnykApiUrl = "https://api.snyk.io";
const selectedProjectsKey = "commandCenter.selectedGitLabProjects";
const snykOrgIdKey = "commandCenter.snykOrganizationId";
const snykMappingsKey = "commandCenter.snykProjectMappings";

interface SnykMapping {
  [snykProjectId: string]: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const credentialStore = new CredentialStore(
    context.secrets,
    {
      update: (key, value) =>
        vscode.workspace.getConfiguration("commandCenter").update(key, value, vscode.ConfigurationTarget.Global)
    }
  );
  let refreshInProgress = false;
  const runRefresh = async (): Promise<void> => {
    if (refreshInProgress) {
      return;
    }
    refreshInProgress = true;
    try {
      await refreshDashboard(context, credentialStore, provider);
    } finally {
      refreshInProgress = false;
    }
  };
  const provider = new CommandCenterViewProvider(
    runRefresh,
    async (url) => {
      if (safeHttpsUrl(url)) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CommandCenterViewProvider.viewType, provider),
    vscode.commands.registerCommand("commandCenter.openDashboard", () =>
      vscode.commands.executeCommand("workbench.view.extension.commandCenter")
    ),
    vscode.commands.registerCommand("commandCenter.refresh", runRefresh),
    vscode.commands.registerCommand("commandCenter.configureGitLab", () =>
      configureCredentials({
        name: "GitLab",
        urlPrompt: "GitLab base URL",
        urlPlaceholder: "https://gitlab.example.com",
        urlDefault: vscode.workspace.getConfiguration("commandCenter").get<string>("gitlab.baseUrl") ?? defaultGitLabUrl,
        tokenPrompt: "GitLab access token (prefer a read_api-scoped token)",
        save: (url, token) => credentialStore.saveGitLab(url, token)
      })
    ),
    vscode.commands.registerCommand("commandCenter.configureSnyk", () =>
      configureCredentials({
        name: "Snyk",
        urlPrompt: "Snyk regional API URL",
        urlPlaceholder: "https://api.eu.snyk.io",
        urlDefault: vscode.workspace.getConfiguration("commandCenter").get<string>("snyk.apiUrl") ?? defaultSnykApiUrl,
        tokenPrompt: "Snyk API token",
        save: (url, token) => credentialStore.saveSnyk(url, token)
      })
    ),
    vscode.commands.registerCommand("commandCenter.addGitLabProject", () => addGitLabProject(context, credentialStore)),
    vscode.commands.registerCommand("commandCenter.removeGitLabProject", () => removeGitLabProject(context)),
    vscode.commands.registerCommand("commandCenter.setSnykOrganization", () => setSnykOrganization(context)),
    vscode.commands.registerCommand("commandCenter.mapSnykProjects", () => mapSnykProjects(context, credentialStore)),
    vscode.commands.registerCommand("commandCenter.clearGitLabToken", () =>
      clearToken("GitLab", () => credentialStore.deleteGitLabToken())
    ),
    vscode.commands.registerCommand("commandCenter.clearSnykToken", () =>
      clearToken("Snyk", () => credentialStore.deleteSnykToken())
    )
  );
}

export function deactivate(): void {}

async function refreshDashboard(
  context: vscode.ExtensionContext,
  credentialStore: CredentialStore,
  provider: CommandCenterViewProvider
): Promise<void> {
  const selected = getSelectedProjects(context);
  const mappings = context.globalState.get<SnykMapping>(snykMappingsKey, {});
  const orgId = context.globalState.get<string>(snykOrgIdKey, "").trim();
  const config = vscode.workspace.getConfiguration("commandCenter");
  const state: DashboardState = {
    status: "loading",
    repositories: selected.map(toDashboardRepository),
    errors: {},
    message: "Loading selected repositories…"
  };
  provider.setState(state);

  const repositoryByKey = new Map(selected.map((repository) => [repository.key, repository]));
  const branches: Branch[] = [];
  const workItems: WorkItem[] = [];
  const errors: { gitlab?: string; snyk?: string } = {};
  let gitlabSucceeded = false;
  let snykSucceeded = false;
  let unmappedFindings = 0;

  if (selected.length > 0) {
    let token: string | undefined;
    try {
      token = await credentialStore.getGitLabToken();
    } catch (error) {
      errors.gitlab = safeError(error, "Could not read the stored GitLab token.");
    }
    if (!token) {
      errors.gitlab ??= "Configure GitLab credentials to load selected projects.";
    } else {
      const clients = new Map<string, GitLabClient>();
      for (const stored of selected) {
        try {
          let client = clients.get(stored.gitlabInstanceUrl);
          if (!client) {
            client = new GitLabClient({ baseUrl: stored.gitlabInstanceUrl, token });
            clients.set(stored.gitlabInstanceUrl, client);
          }
          const snapshot = await client.getProjectSnapshot(stored.gitlabProjectId);
          const liveRepository = snapshot.project.status === "success" ? snapshot.project.data : stored;
          repositoryByKey.set(stored.key, liveRepository);
          if (snapshot.project.status === "success") {
            gitlabSucceeded = true;
          } else {
            appendSourceError(errors, "gitlab", `${stored.gitlabPath}: ${snapshot.project.error.message}`);
          }
          if (snapshot.branches.status === "success") {
            gitlabSucceeded = true;
            branches.push(...snapshot.branches.data);
          } else {
            appendSourceError(errors, "gitlab", `${stored.gitlabPath}: ${snapshot.branches.error.message}`);
          }
          if (snapshot.issues.status === "success") {
            gitlabSucceeded = true;
            workItems.push(...snapshot.issues.data);
          } else {
            appendSourceError(errors, "gitlab", `${stored.gitlabPath}: ${snapshot.issues.error.message}`);
          }
          if (snapshot.mergeRequests.status === "success") {
            gitlabSucceeded = true;
            workItems.push(...snapshot.mergeRequests.data);
          } else {
            appendSourceError(errors, "gitlab", `${stored.gitlabPath}: ${snapshot.mergeRequests.error.message}`);
          }
        } catch (error) {
          appendSourceError(errors, "gitlab", `${stored.gitlabPath}: ${safeError(error, "GitLab refresh failed.")}`);
        }
      }
    }
  }

  if (orgId) {
    let token: string | undefined;
    try {
      token = await credentialStore.getSnykToken();
    } catch (error) {
      errors.snyk = safeError(error, "Could not read the stored Snyk token.");
    }
    if (!token) {
      errors.snyk ??= "Configure Snyk credentials to load the selected organization.";
    } else {
      try {
        const client = new SnykClient({
          baseUrl: config.get<string>("snyk.apiUrl") ?? defaultSnykApiUrl,
          token
        });
        const snapshot = await client.getOrganizationSnapshot(orgId);
        if (snapshot.projects.status === "success") {
          snykSucceeded = true;
        } else {
          appendSourceError(errors, "snyk", snapshot.projects.error.message);
        }
        if (snapshot.issues.status === "success") {
          snykSucceeded = true;
          for (const finding of snapshot.issues.data) {
            const mappingKey = snykMappingKey(orgId, finding.scanItemProjectId ?? "");
            const repositoryKey = mappings[mappingKey];
            if (!repositoryKey || !repositoryByKey.has(repositoryKey)) {
              unmappedFindings += 1;
              continue;
            }
            workItems.push({ ...finding, repositoryKey });
          }
        } else {
          appendSourceError(errors, "snyk", snapshot.issues.error.message);
        }
      } catch (error) {
        errors.snyk = safeError(error, "Snyk refresh failed.");
      }
    }
  }

  const now = new Date();
  const configuredThreshold = config.get<number>("staleBranchThresholdDays", 90);
  const thresholdDays = Number.isFinite(configuredThreshold) && configuredThreshold >= 0
    ? configuredThreshold
    : 90;
  if (thresholdDays !== configuredThreshold) {
    appendSourceError(errors, "gitlab", "Invalid stale-branch threshold; using the 90-day default for this refresh.");
  }
  const staleBranches = detectStaleBranches(branches, now, thresholdDays);
  const ranked = rankRiskItems(workItems, staleBranches, now);
  const dashboardRepositories = new Map<string, DashboardRepository>(
    [...repositoryByKey.values()].map((repository) => [repository.key, toDashboardRepository(repository)])
  );
  for (const rankedRisk of ranked) {
    const risk = dashboardRisk(rankedRisk.item, rankedRisk.reason, rankedRisk.rank, repositoryByKey);
    if (!risk) {
      continue;
    }
    const repositoryKey = rankedRisk.item.kind === "work-item"
      ? rankedRisk.item.workItem.repositoryKey
      : rankedRisk.item.branch.repositoryKey;
    if (repositoryKey) {
      dashboardRepositories.get(repositoryKey)?.risks.push(risk);
    }
  }

  const hasConfiguredSources = selected.length > 0 || Boolean(orgId);
  const hasSuccess = gitlabSucceeded || snykSucceeded;
  const noDataConfiguredMessage = selected.length === 0 && !orgId
    ? "Add GitLab projects and configure a Snyk organization to get started."
    : undefined;
  const messages = [
    noDataConfiguredMessage,
    hasConfiguredSources && !hasSuccess ? "Refresh could not load data. Check the source errors and retry." : undefined,
    hasSuccess && Object.keys(errors).length > 0 ? "Partial data: successful results are shown." : undefined,
    unmappedFindings > 0 ? `${unmappedFindings} Snyk finding(s) have no explicit GitLab mapping and were not grouped.` : undefined,
    hasSuccess && ranked.length === 0 ? "No risks found for successfully loaded sources." : undefined
  ].filter((entry): entry is string => Boolean(entry));
  const message = messages.join(" ");
  const status: DashboardState["status"] = hasConfiguredSources && !hasSuccess
    ? "error"
    : hasSuccess && Object.keys(errors).length > 0
      ? "partial"
      : "ready";
  provider.setState({
    status,
    repositories: [...dashboardRepositories.values()].sort((a, b) => a.path.localeCompare(b.path)),
    lastRefreshed: now.toISOString(),
    errors,
    ...(message ? { message } : {})
  });
}

function dashboardRisk(
  item: RiskItem,
  reason: string,
  rank: number,
  repositories: Map<string, Repository>
): DashboardRisk | undefined {
  if (item.kind === "stale-branch") {
    const repository = repositories.get(item.branch.repositoryKey);
    const externalUrl = repository
      ? `${repository.gitlabWebUrl.replace(/\/+$/, "")}/-/tree/${encodeURIComponent(item.branch.name)}`
      : undefined;
    return {
      id: `risk-${rank}`,
      rank,
      type: "stale-branch",
      title: `Stale branch: ${item.branch.name}`,
      reason,
      ...(externalUrl && safeHttpsUrl(externalUrl) ? { externalUrl } : {})
    };
  }
  const workItem = item.workItem;
  return {
    id: `risk-${rank}`,
    rank,
    type: workItem.source,
    title: workItem.title,
    reason,
    ...(workItem.severity ? { severity: workItem.severity } : {}),
    ...(workItem.externalUrl && safeHttpsUrl(workItem.externalUrl) ? { externalUrl: workItem.externalUrl } : {})
  };
}

function toDashboardRepository(repository: Repository): DashboardRepository {
  return {
    key: repository.key,
    name: repository.name,
    path: repository.gitlabPath,
    externalUrl: safeHttpsUrl(repository.gitlabWebUrl) ? repository.gitlabWebUrl : "",
    risks: []
  };
}

function appendSourceError(errors: { gitlab?: string; snyk?: string }, source: "gitlab" | "snyk", message: string): void {
  errors[source] = errors[source] ? `${errors[source]}\n${message}` : message;
}

function snykMappingKey(orgId: string, projectId: string): string {
  return JSON.stringify([orgId, projectId]);
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getSelectedProjects(context: vscode.ExtensionContext): Repository[] {
  return context.globalState.get<Repository[]>(selectedProjectsKey, []);
}

async function addGitLabProject(context: vscode.ExtensionContext, credentials: CredentialStore): Promise<void> {
  const identifier = await vscode.window.showInputBox({
    title: "Add GitLab project",
    prompt: "Enter a GitLab project ID or full path (for example, team/service).",
    placeHolder: "team/service or 12345",
    ignoreFocusOut: true,
    validateInput: (value) => validationMessage(() => validateProjectIdentifier(value))
  });
  if (identifier === undefined) {
    return;
  }
  try {
    const token = await credentials.getGitLabToken();
    if (!token) {
      throw new Error("Configure GitLab credentials before selecting a project.");
    }
    const config = vscode.workspace.getConfiguration("commandCenter");
    const client = new GitLabClient({
      baseUrl: config.get<string>("gitlab.baseUrl") ?? defaultGitLabUrl,
      token
    });
    const project = await client.getProject(validateProjectIdentifier(identifier));
    const selected = getSelectedProjects(context);
    if (selected.some((item) => item.key === project.key)) {
      void vscode.window.showInformationMessage(`${project.gitlabPath} is already selected.`);
      return;
    }
    await context.globalState.update(selectedProjectsKey, [...selected, project]);
    void vscode.window.showInformationMessage(`Added ${project.gitlabPath} to Command Center.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not add GitLab project: ${safeError(error, "Unknown error.")}`);
  }
}

async function removeGitLabProject(context: vscode.ExtensionContext): Promise<void> {
  const selected = getSelectedProjects(context);
  if (!selected.length) {
    void vscode.window.showInformationMessage("No GitLab projects are selected.");
    return;
  }
  const choice = await vscode.window.showQuickPick(
    selected.map((project) => ({ label: project.gitlabPath, description: String(project.gitlabProjectId), key: project.key })),
    { title: "Remove selected GitLab project", placeHolder: "Choose a project to remove" }
  );
  if (!choice) {
    return;
  }
  await context.globalState.update(selectedProjectsKey, selected.filter((project) => project.key !== choice.key));
  const mappings = context.globalState.get<SnykMapping>(snykMappingsKey, {});
  const remaining = Object.fromEntries(Object.entries(mappings).filter(([, repositoryKey]) => repositoryKey !== choice.key));
  await context.globalState.update(snykMappingsKey, remaining);
  void vscode.window.showInformationMessage(`Removed ${choice.label} and its explicit Snyk mappings.`);
}

async function setSnykOrganization(context: vscode.ExtensionContext): Promise<void> {
  const orgId = await vscode.window.showInputBox({
    title: "Set Snyk organization",
    prompt: "Enter the Snyk organization ID (not its display name).",
    placeHolder: "Organization ID",
    value: context.globalState.get<string>(snykOrgIdKey, ""),
    ignoreFocusOut: true,
    validateInput: (value) => validationMessage(() => validateIdentifier(value, "Snyk organization ID"))
  });
  if (orgId === undefined) {
    return;
  }
  await context.globalState.update(snykOrgIdKey, validateIdentifier(orgId, "Snyk organization ID"));
  void vscode.window.showInformationMessage("Snyk organization ID saved in VS Code global state.");
}

async function mapSnykProjects(context: vscode.ExtensionContext, credentials: CredentialStore): Promise<void> {
  const selectedRepositories = getSelectedProjects(context);
  if (!selectedRepositories.length) {
    void vscode.window.showErrorMessage("Add a GitLab project before creating a Snyk mapping.");
    return;
  }
  const orgId = context.globalState.get<string>(snykOrgIdKey, "").trim();
  if (!orgId) {
    void vscode.window.showErrorMessage("Set a Snyk organization ID before creating a mapping.");
    return;
  }
  let token: string | undefined;
  try {
    token = await credentials.getSnykToken();
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read the stored Snyk token: ${safeError(error, "Unknown error.")}`);
    return;
  }
  if (!token) {
    void vscode.window.showErrorMessage("Configure Snyk credentials before creating a mapping.");
    return;
  }
  let projects: SnykProject[] = [];
  try {
    const config = vscode.workspace.getConfiguration("commandCenter");
    const client = new SnykClient({
      baseUrl: config.get<string>("snyk.apiUrl") ?? defaultSnykApiUrl,
      token
    });
    projects = await client.getOrganizationProjects(orgId);
  } catch (error) {
    void vscode.window.showWarningMessage(`Could not fetch Snyk projects: ${safeError(error, "Unknown error.")} You can enter project IDs manually.`);
  }

  let projectIds: string[] = [];
  let manualEntryRequested = projects.length === 0;
  if (projects.length) {
    const choices = projects.map((project) => ({
      label: project.name,
      description: project.id,
      id: project.id
    }));
    const manualChoice = {
      label: "Enter project IDs manually…",
      description: "Enter exact Snyk project IDs not selected above",
      id: "__commandcenter_manual__"
    };
    const selected = await vscode.window.showQuickPick([...choices, manualChoice], {
      title: "Choose Snyk projects to map",
      placeHolder: "Select projects or choose manual ID entry",
      canPickMany: true,
      ignoreFocusOut: true
    });
    if (selected?.length) {
      manualEntryRequested = selected.some((project) => project.id === manualChoice.id);
      projectIds = selected
        .filter((project) => project.id !== manualChoice.id)
        .map((project) => project.id);
    } else if (selected === undefined) {
      return;
    }
  }
  if (manualEntryRequested || !projectIds.length) {
    const entered = await vscode.window.showInputBox({
      title: "Enter Snyk project IDs",
      prompt: projectIds.length
        ? "Add exact Snyk project IDs separated by commas."
        : "Enter one or more exact Snyk project IDs separated by commas.",
      ignoreFocusOut: true,
      validateInput: (value) => validationMessage(() => parseProjectIds(value))
    });
    if (entered === undefined) {
      return;
    }
    projectIds = [...new Set([...projectIds, ...parseProjectIds(entered)])];
  }

  const repository = await vscode.window.showQuickPick(
    selectedRepositories.map((item) => ({ label: item.gitlabPath, description: String(item.gitlabProjectId), key: item.key })),
    { title: "Choose the GitLab repository for this explicit mapping", ignoreFocusOut: true }
  );
  if (!repository) {
    return;
  }
  const names = projectIds.map((id) => projects.find((project) => project.id === id)?.name ?? id);
  const confirmation = await vscode.window.showWarningMessage(
    `Map Snyk project(s) ${names.join(", ")} to GitLab repository ${repository.label}? No name-based matching will be used.`,
    { modal: true },
    "Confirm Mapping"
  );
  if (confirmation !== "Confirm Mapping") {
    return;
  }
  const mappings = { ...context.globalState.get<SnykMapping>(snykMappingsKey, {}) };
  for (const id of projectIds) {
    mappings[snykMappingKey(orgId, id)] = repository.key;
  }
  await context.globalState.update(snykMappingsKey, mappings);
  void vscode.window.showInformationMessage(`Saved ${projectIds.length} explicit Snyk project mapping(s).`);
}

function validateProjectIdentifier(value: string): string {
  const identifier = value.trim();
  if (!identifier || /[\u0000-\u001f\u007f]/.test(identifier)) {
    throw new Error("Enter a project ID or full project path.");
  }
  return identifier;
}

function validateIdentifier(value: string, label: string): string {
  const identifier = value.trim();
  if (!identifier || /[\u0000-\u001f\u007f]/.test(identifier)) {
    throw new Error(`Enter a valid ${label}.`);
  }
  return identifier;
}

function parseProjectIds(value: string): string[] {
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids.length || ids.some((id) => /[\u0000-\u001f\u007f]/.test(id))) {
    throw new Error("Enter one or more valid project IDs separated by commas.");
  }
  return [...new Set(ids)];
}

interface ConfigureCredentialsOptions {
  name: string;
  urlPrompt: string;
  urlPlaceholder: string;
  urlDefault: string;
  tokenPrompt: string;
  save: (url: string, token: string) => Promise<void>;
}

async function configureCredentials(options: ConfigureCredentialsOptions): Promise<void> {
  const url = await vscode.window.showInputBox({
    title: `Configure ${options.name}`,
    prompt: options.urlPrompt,
    placeHolder: options.urlPlaceholder,
    value: options.urlDefault,
    ignoreFocusOut: true,
    validateInput: (value) => validationMessage(() => validateServiceUrl(value))
  });
  if (url === undefined) {
    return;
  }
  const token = await vscode.window.showInputBox({
    title: options.tokenPrompt,
    prompt: options.tokenPrompt,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => validationMessage(() => validateToken(value))
  });
  if (token === undefined) {
    return;
  }
  try {
    await options.save(url, token);
    void vscode.window.showInformationMessage(
      `${options.name} URL and token saved. The token is stored in VS Code SecretStorage.`
    );
  } catch {
    void vscode.window.showErrorMessage(
      `Could not save ${options.name} credentials. Verify VS Code SecretStorage and settings access, then retry.`
    );
  }
}

function validationMessage(validate: () => unknown): string | undefined {
  try {
    validate();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a valid value.";
  }
}

async function clearToken(name: string, clear: () => Thenable<void>): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    `Remove the stored ${name} token?`,
    { modal: true },
    "Remove Token"
  );
  if (confirmation !== "Remove Token") {
    return;
  }
  try {
    await clear();
    void vscode.window.showInformationMessage(`${name} token removed from VS Code SecretStorage.`);
  } catch {
    void vscode.window.showErrorMessage(`Could not remove the stored ${name} token. Try again.`);
  }
}
