import * as vscode from "vscode";
import {
  DashboardInitializeMessage,
  DashboardState,
  normalizeDashboardState,
  parseWebviewMessage,
  safeHttpsUrl
} from "./messages";

const initialState: DashboardState = {
  status: "ready",
  repositories: [],
  errors: {},
  message: "Select GitLab projects, configure credentials, then refresh to load risks."
};

export class CommandCenterViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "commandCenter.dashboard";
  private view?: vscode.WebviewView;
  private state: DashboardState = initialState;
  private readonly riskUrls = new Map<string, string>();

  public constructor(
    private readonly onRefresh: () => Promise<void>,
    private readonly onOpenRisk: (url: string) => Promise<void>
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage((value: unknown) => {
      const message = parseWebviewMessage(value);
      if (!message) {
        return;
      }
      if (message.type === "dashboard.ready") {
        this.postState();
      } else if (message.type === "dashboard.refresh") {
        void this.onRefresh();
      } else {
        const url = this.riskUrls.get(message.riskId);
        if (url && safeHttpsUrl(url)) {
          void this.onOpenRisk(url);
        }
      }
    });
  }

  public setState(state: DashboardState): void {
    this.state = normalizeDashboardState(state);
    this.riskUrls.clear();
    for (const repository of this.state.repositories) {
      for (const risk of repository.risks) {
        if (risk.externalUrl && safeHttpsUrl(risk.externalUrl)) {
          this.riskUrls.set(risk.id, risk.externalUrl);
        }
      }
    }
    this.postState();
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    const message: DashboardInitializeMessage = {
      type: "dashboard.initialize",
      state: this.state
    };
    void this.view.webview.postMessage(message);
  }

  private getHtml(): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Command Center Dashboard</title>
  <style nonce="${nonce}">
    body { padding: 0 12px 20px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    h1 { font-size: 1.25em; font-weight: 600; }
    h2 { font-size: 1.1em; margin: 1.4em 0 .4em; }
    .toolbar, .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .toolbar { justify-content: space-between; }
    .filters { margin: 12px 0; }
    button, select { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 4px 8px; font: inherit; }
    button { cursor: pointer; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    label { display: grid; gap: 3px; color: var(--vscode-descriptionForeground); }
    .status { margin: 12px 0; line-height: 1.5; }
    .error { color: var(--vscode-errorForeground); white-space: pre-line; }
    .partial { color: var(--vscode-editorWarning-foreground); }
    .repo { border-top: 1px solid var(--vscode-panel-border); padding: 8px 0; }
    .risk { padding: 7px 0 7px 10px; border-left: 2px solid var(--vscode-editorWarning-foreground); margin: 7px 0; }
    .risk.snyk { border-color: var(--vscode-errorForeground); }
    .meta { color: var(--vscode-descriptionForeground); font-size: .92em; margin-top: 3px; }
    .empty { color: var(--vscode-descriptionForeground); }
    @media (forced-colors: active) { .risk, .repo { border-color: CanvasText; } }
  </style>
</head>
<body>
  <main aria-labelledby="dashboard-title">
    <h1 id="dashboard-title">Command Center</h1>
    <div class="toolbar">
      <p id="refresh-time" class="meta">Not refreshed yet</p>
      <button id="refresh" type="button" aria-label="Refresh GitLab and Snyk risks">Refresh</button>
    </div>
    <p id="status" class="status" role="status" aria-live="polite">Loading dashboard…</p>
    <div id="source-errors" aria-live="polite"></div>
    <section class="filters" aria-label="Dashboard filters">
      <label>Repository<select id="repo-filter" aria-label="Filter by repository"><option value="">All repositories</option></select></label>
      <label>Severity<select id="severity-filter" aria-label="Filter by severity"><option value="">All severities</option><option>critical</option><option>high</option><option>medium</option><option>low</option><option>unknown</option></select></label>
      <label>Type<select id="type-filter" aria-label="Filter by risk type"><option value="">All types</option><option value="snyk">Snyk findings</option><option value="stale-branch">Stale branches</option><option value="gitlab-issue">GitLab issues</option><option value="gitlab-mr">GitLab merge requests</option></select></label>
    </section>
    <section id="repositories" aria-label="Risks grouped by repository"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const status = document.getElementById("status");
    const repositoryFilter = document.getElementById("repo-filter");
    const severityFilter = document.getElementById("severity-filter");
    const typeFilter = document.getElementById("type-filter");
    const section = document.getElementById("repositories");
    const errors = document.getElementById("source-errors");
    const refreshed = document.getElementById("refresh-time");
    let dashboard = { repositories: [] };
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "dashboard.refresh" }));
    [repositoryFilter, severityFilter, typeFilter].forEach((element) => element.addEventListener("change", render));
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object" || message.type !== "dashboard.initialize" ||
          !message.state || typeof message.state !== "object" || !Array.isArray(message.state.repositories)) return;
      dashboard = message.state;
      render();
    });
    function text(tag, content, className) {
      const element = document.createElement(tag);
      element.textContent = content;
      if (className) element.className = className;
      return element;
    }
    function render() {
      const state = dashboard;
      status.textContent = state.status === "loading" ? "Refreshing data…" :
        (state.message || (state.repositories.length ? "Risks are ordered by priority." : "No risks found for selected projects."));
      status.className = "status" + (state.status === "error" ? " error" : state.status === "partial" ? " partial" : "");
      refreshed.textContent = state.lastRefreshed ? "Last refreshed: " + new Date(state.lastRefreshed).toLocaleString() : "Not refreshed yet";
      errors.replaceChildren();
      Object.entries(state.errors || {}).forEach(([source, message]) => errors.append(text("p", source + ": " + message, "error")));
      const previous = repositoryFilter.value;
      repositoryFilter.replaceChildren(new Option("All repositories", ""));
      state.repositories.forEach((repo) => repositoryFilter.add(new Option(repo.name + " (" + repo.path + ")", repo.key)));
      repositoryFilter.value = previous;
      section.replaceChildren();
      let count = 0;
      state.repositories.forEach((repo) => {
        if (repositoryFilter.value && repositoryFilter.value !== repo.key) return;
        const risks = (repo.risks || []).filter((risk) =>
          (!severityFilter.value || (risk.severity ? risk.severity.toLowerCase() : (risk.type === "snyk" ? "unknown" : "")) === severityFilter.value) &&
          (!typeFilter.value || risk.type === typeFilter.value));
        if (!risks.length) return;
        count += risks.length;
        const group = document.createElement("article");
        group.className = "repo";
        const heading = text("h2", repo.name);
        group.append(heading, text("p", repo.path, "meta"));
        risks.forEach((risk) => {
          const card = document.createElement("div");
          card.className = "risk " + risk.type;
          card.append(text("strong", risk.title));
          card.append(text("div", "Priority rank: " + risk.rank, "meta"));
          card.append(text("div", labelFor(risk), "meta"));
          card.append(text("div", risk.reason, "meta"));
          if (risk.externalUrl) {
            const open = document.createElement("button");
            open.type = "button";
            open.textContent = "Open " + labelFor(risk);
            open.setAttribute("aria-label", "Open " + labelFor(risk) + ": " + risk.title);
            open.addEventListener("click", () => vscode.postMessage({ type: "dashboard.openRisk", riskId: risk.id }));
            card.append(open);
          }
          group.append(card);
        });
        section.append(group);
      });
      if (state.status !== "loading" && count === 0) {
        section.append(text("p", state.repositories.length ? "No risks match these filters." : (state.message || "No selected repositories."), "empty"));
      }
    }
    function labelFor(risk) {
      const names = { snyk: "Snyk finding", "stale-branch": "Stale branch", "gitlab-issue": "GitLab issue", "gitlab-mr": "GitLab merge request" };
      return (names[risk.type] || "Risk") + (risk.severity ? " · " + risk.severity : "");
    }
    vscode.postMessage({ type: "dashboard.ready" });
  </script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
