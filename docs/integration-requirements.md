# Integration requirements

This document records the verified API capabilities and implementation assumptions for the Command Center MVP. API access and project mappings must be validated against the intended customer accounts before implementation depends on specific response fields.

## Supported environments and access

### GitLab

- **Verified:** GitLab's REST API is hosted at the instance URL under `/api/v4`; GitLab supports GitLab.com, Self-Managed, and Dedicated deployments. Use the configured instance URL rather than hardcoding GitLab.com.
- **Verified:** `read_api` is the read-only API scope and is preferable to the broader `api` scope for this read-only MVP. Returned project data is still limited by the authenticated user's access.
- **Decision required:** Select GitLab deployment type and confirm host reachability, token type, project visibility, and API compatibility.

Sources: [REST API](https://docs.gitlab.com/api/rest/), [REST authentication](https://docs.gitlab.com/api/rest/authentication/), [access-token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/), [Projects API](https://docs.gitlab.com/api/projects/).

### Snyk

- **Verified:** The Snyk REST API requires an Enterprise plan and an API token. Requests must use the account's regional API host; documented regions include US, EU, and AU.
- **Least-privilege recommendation:** Use a Group-level service account with Group Viewer access for read-only usage. Confirm that the account can read the selected organizations, projects, and issues.
- **Decision required:** Confirm the Snyk plan, region, token type, and access to intended organizations/projects.

Sources: [API authentication](https://docs.snyk.io/developer-tools/snyk-api/authentication-for-api.md), [REST API URLs and versioning](https://docs.snyk.io/developer-tools/snyk-api/rest-api/about-the-rest-api.md), [token permissions](https://docs.snyk.io/developer-tools/snyk-api/authentication-for-api/snyk-api-token-permissions-users-can-control.md), [service accounts](https://docs.snyk.io/platform-administration/service-accounts/service-accounts).

## Candidate read endpoints

| Data | Candidate endpoint | Notes |
| --- | --- | --- |
| GitLab projects | `GET /api/v4/projects` | Discover accessible projects, or select by project ID/path. |
| GitLab branches | `GET /api/v4/projects/:id/repository/branches` | Includes branch name, default/protected status, and latest commit details. Proposed stale-activity proxy: latest commit `committed_date`. |
| Open GitLab issues | `GET /api/v4/projects/:id/issues?state=opened` | Scope requests to selected projects. |
| Open GitLab merge requests | `GET /api/v4/projects/:id/merge_requests?state=opened` | Preserve identifiers, title, state, dates, and `web_url`. |
| Snyk projects | `GET /rest/orgs/{org_id}/projects?version={version}` | Use a supported, documented API version. |
| Snyk findings | `GET /rest/orgs/{org_id}/issues?version={version}` | The issue response can relate findings to a Snyk project through `relationships.scan_item.data.id`. Preserve effective severity, title, and problem URL where available. Confirm project filter syntax and fields for the intended account/API version. |

Sources: [GitLab Projects](https://docs.gitlab.com/api/projects/), [Branches](https://docs.gitlab.com/api/branches/), [Issues](https://docs.gitlab.com/api/issues/#list-all-project-issues), [Merge Requests](https://docs.gitlab.com/api/merge_requests/#list-project-merge-requests), [Snyk Projects](https://docs.snyk.io/developer-tools/snyk-api/reference/projects.md), [Snyk Issues](https://docs.snyk.io/developer-tools/snyk-api/reference/issues.md).

## Pagination, rate limits, and errors

- **GitLab:** Follow response `Link` headers (`rel="next"`); standard pagination supports up to 100 items per page. Some GitLab.com responses may omit total/page headers, so do not rely on those headers being present.
- **Snyk:** Follow the cursor-based pagination URL in `links.next`; do not construct cursors.
- **Rate limits:** Honor `Retry-After` when present. GitLab and Snyk can return `429`; use bounded retries/backoff and then report a source-specific error.
- **Error isolation:** Keep GitLab and Snyk refresh results independent. A failure from one source must not discard successful results from the other; expose authentication, permission, rate-limit, and other failures clearly.

Sources: [GitLab pagination](https://docs.gitlab.com/api/rest/#pagination), [GitLab authentication and rate limits](https://docs.gitlab.com/api/rest/authentication/), [GitLab troubleshooting](https://docs.gitlab.com/api/rest/troubleshooting/), [Snyk REST API pagination, errors, and rate limits](https://docs.snyk.io/developer-tools/snyk-api/rest-api/about-the-rest-api.md).

## Representative normalized model

```text
Repository
  key
  gitlabInstanceUrl
  gitlabProjectId
  gitlabPath
  gitlabWebUrl
  snykOrgId?
  snykProjectIds[]

Branch
  repositoryKey
  name
  isDefault
  isProtected
  latestCommitAt

WorkItem
  repositoryKey
  source              // gitlab-issue | gitlab-mr | snyk
  sourceId
  title
  state
  severity?
  createdAt?
  updatedAt?
  externalUrl

Snyk finding attributes
  issueId
  effectiveSeverity
  title
  problemUrl
  scanItemProjectId
```

## Mapping recommendation

Use the GitLab instance URL and stable project ID as the repository identity. Match Snyk projects by exact canonical repository remote/origin URL only when both sources expose a usable value. Require user confirmation for missing or ambiguous matches; do not match by project name alone. Persist selected Snyk organization/project IDs and allow multiple Snyk projects per GitLab repository.

This is a product recommendation, not an API guarantee. Validate which repository identifiers are available on the target Snyk projects.

## Assumptions and decisions to resolve

- The plan's TypeScript extension, cloud-first API use, read-only triage, and 5–20 repository target are assumptions pending user confirmation.
- Confirm GitLab deployment, credential scope and visibility, Snyk plan/region/access, and API host reachability.
- Choose manual project selection or GitLab group/project discovery.
- Confirm whether GitLab↔Snyk mapping is user-confirmed or automated and how ambiguous/multiple mappings are handled.
- Define stale-branch age and exclusions. Using latest commit date as the activity proxy is a proposal; threshold and protected/default branch behavior are product decisions.
- Test Snyk access and confirm issue filters/fields and project mapping against the actual account and enabled products.

## Remaining MVP validation

Before the API clients are finalized, test the selected credentials against representative projects, verify pagination and `429` behavior, and confirm that external URLs resolve to the expected GitLab and Snyk pages.
