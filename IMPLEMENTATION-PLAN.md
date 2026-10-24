# Command Center — Implementation Plan

## 1. MVP scope and acceptance criteria

**MVP goal:** Give developers managing 5–20 repositories a quick, ranked view of GitLab and Snyk risks, with direct links to the relevant work.

### Required for v1

- Configure GitLab and Snyk credentials securely.
- Select or configure the GitLab projects to monitor.
- Show a dashboard grouped by repository with:
  - Snyk findings and severity
  - Stale branches
  - Relevant open issues and merge requests
- Rank items using clear, understandable rules, such as severity and age.
- Filter by repository, severity, and item type.
- Open the affected GitLab or Snyk page from an item.
- Refresh data manually and show loading, empty, and error states.

### Acceptance criteria

- Users can configure credentials and choose projects without placing secrets in workspace settings or source files.
- The dashboard displays fetched data for configured projects and identifies the source and last refresh time.
- Risk ranking and stale-branch criteria are documented and consistent.
- GitLab or Snyk request failures are surfaced clearly without hiding errors.
- Dashboard links open the correct external project or finding.
- The interface supports keyboard navigation and VS Code light, dark, and high-contrast themes.

**MVP boundary:** Keep triage actions read-only. Don’t delete branches, change issue state, assign work, or create fix PRs in the first release.

## 2. Main user flows and VS Code APIs

### Set up

1. Open Command Center from the Activity Bar.
2. Enter GitLab and Snyk credentials.
3. Select projects to monitor and set a stale-branch age threshold.
4. Store secrets using VS Code `SecretStorage`; keep non-secret preferences in `workspaceState` or `globalState`, depending on whether they should follow the workspace.

### Daily triage

1. Open the dashboard and review the ranked repository list.
2. Filter to a repository or risk type.
3. Select an item to inspect its details and context.
4. Open the corresponding GitLab or Snyk page from its external link.

### Refresh and troubleshoot

- Refresh manually with a visible loading indicator.
- Show last-updated timestamps and source-specific errors.
- Let users retry a failed source without discarding successful results from another source.

### VS Code contribution points and APIs

- Activity Bar view and `WebviewViewProvider` for the dashboard.
- `commands` for refresh and opening settings.
- `SecretStorage` for API tokens.
- `workspaceState` / `globalState` for project selection and preferences.
- `env.openExternal` for GitLab and Snyk links.
- Configuration contributions for non-secret settings, such as the stale-branch threshold.
- Webview message passing for UI actions; validate incoming messages in the extension host.

## 3. Proposed structure and technology

Assumptions: implement the extension in TypeScript, use React for the dashboard UI, and target GitLab and Snyk cloud APIs first. Confirm that the user’s GitLab and Snyk plans provide the required API access before committing to specific fields or endpoints.

```text
src/
  extension.ts
  commands/
  providers/
    commandCenterViewProvider.ts
  services/
    gitlabClient.ts
    snykClient.ts
    riskScorer.ts
    cache.ts
  models/
  webview/
    App.tsx
    components/
    messages.ts
```

- **Extension host:** TypeScript; owns credentials, API calls, data normalization, and error handling.
- **Webview:** React with a small, focused component set. Use VS Code theme variables and provide accessible labels and keyboard interaction.
- **API clients:** Keep GitLab and Snyk integrations separate so their failures and rate limits can be handled independently.
- **Risk scoring:** Start with explicit, explainable ordering rules; avoid an opaque or configurable scoring system in v1.
- **Dependencies and build tooling:** Follow the repository’s existing conventions where available. If there is no existing setup, use standard VS Code extension and webview bundling patterns.

## 4. Ordered implementation milestones

### 1. Validate integration requirements

- Confirm GitLab deployment type and API access.
- Confirm Snyk API access, available finding data, and project-to-repository mapping.
- Decide how users will identify the initial set of 5–20 projects.
- **Deliverable:** Documented API assumptions and a representative data model in [docs/integration-requirements.md](./docs/integration-requirements.md). Customer-specific access and mapping decisions remain to be validated.

### 2. Scaffold the extension and view

- Add the Activity Bar entry, dashboard view, command registration, and webview build.
- Establish typed messages between the webview and extension host.
- **Deliverable:** A working empty dashboard in the VS Code Extension Development Host.

### 3. Implement configuration and secure credentials

- Add setup and project-selection flows.
- Store API tokens with `SecretStorage`, not normal settings.
- Validate configuration and show actionable errors.
- **Deliverable:** Credentials and preferences persist safely across VS Code restarts.

### 4. Integrate GitLab and Snyk

- Fetch the project, branch, issue/MR, and vulnerability data required by the MVP.
- Normalize results into shared models and handle pagination, rate limits, and source-specific failures.
- **Deliverable:** Each source can be tested independently, and successful results survive failure in the other source.

### 5. Add stale-branch detection and ranking

- Define branch-age behavior, including how to treat protected branches and branches with recent activity.
- Apply the documented ranking rules to repository risks.
- **Deliverable:** Deterministic ranking with test coverage for representative cases, documented in [docs/risk-ranking.md](./docs/risk-ranking.md).

### 6. Build the triage experience

- Add repository grouping, summaries, filters, item details, refresh, timestamps, and external links.
- Implement loading, empty, partial-data, and error states.
- **Deliverable:** Users can complete the daily triage flow from the dashboard.

### 7. Test, package, and prepare release

- Validate behavior in the Extension Development Host and package the extension.
- Add setup instructions, API-permission notes, known limitations, and troubleshooting guidance.
- **Deliverable:** An installable MVP ready for internal testing or Marketplace review.

## 5. Testing, accessibility, and release

- **Unit tests:** API response normalization, risk ordering, stale-branch rules, and error handling.
- **Integration tests:** API client behavior with mocked responses, including pagination, rate limits, invalid credentials, and partial failures.
- **Extension tests:** Command registration, secret storage usage, webview message validation, and view initialization.
- **Manual testing:** Test with representative GitLab/Snyk projects and verify that external links resolve to the intended resources.
- **Accessibility:** Keyboard navigation, visible focus, screen-reader labels, sufficient contrast, and testing with VS Code high-contrast themes.
- **Packaging:** Verify extension metadata, activation behavior, webview resource loading, and packaging with `vsce`. Document required API permissions, token setup, data handling, and supported GitLab/Snyk environments.

## 6. Key risks and decisions to validate

- GitLab and Snyk API access and available data vary by deployment and plan.
- Mapping Snyk projects to GitLab repositories may require a reliable identifier or a small manual mapping step.
- Stale-branch rules need care to avoid flagging protected or intentionally long-lived branches.
- API pagination and rate limits may affect refresh time across 5–20 projects; test early and show per-source refresh status.
- Decide whether project selection is manual or derived from GitLab groups. Manual selection is a simpler MVP default.
- Confirm whether “risk score” should be numeric or a transparent priority ordering. The MVP should prefer explainable ordering over a single opaque number.
