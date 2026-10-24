# Command Center

A read-only VS Code dashboard for triaging risks across selected GitLab repositories and explicitly mapped Snyk projects.

## Build and run

1. Install dependencies with `npm install`.
2. Compile and run tests with `npm test`.
3. Open this folder in VS Code and press **F5** to launch the Extension Development Host.
4. Open **Command Center** from the Activity Bar.

## Set up

Use the Command Palette:

1. Run **Command Center: Configure GitLab Credentials**. A `read_api`-scoped token is recommended.
2. Run **Command Center: Add GitLab Project** and enter a project ID or full path. The extension fetches and validates the project before storing it. Use **Remove GitLab Project** to unselect one later.
3. Optionally configure Snyk with **Configure Snyk Credentials**, then set the organization ID using **Set Snyk Organization ID**.
4. Run **Map Snyk Projects to GitLab Repository**. The command fetches the selected organization's project list, allows selecting one or more projects, and supports entering exact IDs if the list cannot be fetched. Review and confirm the repository mapping. Project names are never used to infer a mapping.
5. Select **Refresh** in the dashboard or run **Command Center: Refresh Dashboard**.

Tokens are stored only in VS Code `SecretStorage`. Service URLs are HTTPS-only user settings (`commandCenter.gitlab.baseUrl` and `commandCenter.snyk.apiUrl`). Selected GitLab project metadata, the Snyk organization ID, and explicit Snyk project-to-repository mappings are non-secret values stored in VS Code `globalState`; they are not written to workspace settings.

During refresh, credentials are sent over HTTPS to the configured GitLab and Snyk API hosts. Retrieved findings are used to render the dashboard and are not persisted by the extension. The extension stores no API tokens in its ordinary settings or project state.

The dashboard groups ranked risks by GitLab repository and offers repository, severity, and type filters. GitLab and Snyk errors are isolated and shown independently. Findings without a confirmed mapping are not assigned to repositories. Links are opened by the extension host only after HTTPS URL validation. The stale-branch threshold is configurable through `commandCenter.staleBranchThresholdDays` and defaults to 90 days; default and protected branches are excluded.

## Scope and assumptions

The dashboard is read-only; it does not mutate GitLab or Snyk data. Snyk REST access and available data depend on the account plan, token permissions, region, and organization access. GitLab results are limited to projects visible to the configured token. Snyk findings that lack a selected, explicit project mapping are reported as unmapped and omitted from repository groups. See `docs/integration-requirements.md` and `docs/risk-ranking.md` for source/API assumptions and ranking behavior.

## Troubleshooting

- **GitLab returns 401 or 403:** Check that the token is valid, has the recommended `read_api` scope, and can access the selected project. For a self-managed instance, verify `commandCenter.gitlab.baseUrl` is the instance root URL over HTTPS.
- **Snyk returns an authentication or permission error:** Confirm the account has the required API access (the REST API currently requires Enterprise), the token can read the organization, and `commandCenter.snyk.apiUrl` matches the account's region. Verify the organization ID and selected project access.
- **A Snyk finding is not grouped under a repository:** Add or verify its explicit mapping with **Map Snyk Projects to GitLab Repository**. Project names are not used to infer mappings.
- **Credentials need replacing or removal:** Run **Configure GitLab Credentials** or **Configure Snyk Credentials** to replace a token, and **Clear GitLab Token** or **Clear Snyk Token** to remove it from VS Code `SecretStorage`.
- **External links do not open:** Check network access to the GitLab/Snyk host and ensure the service provides an HTTPS link. Unsafe or non-HTTPS links are intentionally rejected.
- **One source fails while the other loads:** Check the source-specific message in the dashboard, then verify that source's host, permissions, and network access before refreshing again. API availability and data may vary by deployment, plan, region, and account permissions; no external account validation has been performed.
