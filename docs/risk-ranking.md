# Risk detection and ordering

Stale-branch detection uses each branch's `latestCommitAt` and the caller-supplied reference time. A branch is stale when its last commit is at or before `reference time - threshold days` (the exact threshold boundary is included). Default and protected branches are excluded. Missing or unparseable commit dates are excluded rather than treated as stale. The reference time must be valid and the threshold must be finite and non-negative.

Risk items are ordered by category, then by age:

1. Snyk findings, ordered by severity (`critical`, `high`, `medium`, `low`, then unknown severity); within a severity, older activity comes first.
2. GitLab issues, oldest activity first.
3. GitLab merge requests, oldest activity first.
4. Stale branches, oldest commit first.

For work items, activity is `updatedAt`, falling back to `createdAt`; for branches it is `latestCommitAt`. Missing or invalid activity sorts after known dates. Remaining ties use repository/project key, source ID or branch name, then title, in ordinal lexical order. The ranking function returns a one-based rank and a short reason for each item.
