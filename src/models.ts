export interface Repository {
  key: string;
  gitlabInstanceUrl: string;
  gitlabProjectId: number;
  gitlabPath: string;
  gitlabWebUrl: string;
  name: string;
  description?: string;
  defaultBranch?: string;
}

export interface SnykProject {
  id: string;
  name: string;
  url?: string;
}

export interface Branch {
  repositoryKey: string;
  name: string;
  isDefault: boolean;
  isProtected: boolean;
  latestCommitAt?: string;
}

export type WorkItemSource = "gitlab-issue" | "gitlab-mr" | "snyk";

export interface WorkItem {
  repositoryKey?: string;
  scanItemProjectId?: string;
  source: WorkItemSource;
  sourceId: string;
  title: string;
  state: string;
  severity?: string;
  createdAt?: string;
  updatedAt?: string;
  externalUrl?: string;
}
