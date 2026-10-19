import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Task } from "../shared/domain";
import type { CreateTaskInput } from "../shared/ipc";
import { PersistenceError } from "../persistence/database";

export interface GitHubIssue {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly updatedAt: string;
  readonly htmlUrl: string;
}

export interface GitHubProjectItem {
  readonly id: string;
  readonly issue: GitHubIssue;
}

export interface GitHubProjectField {
  readonly id: string;
  readonly name: string;
  readonly options: readonly { id: string; name: string }[];
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly htmlUrl: string;
  readonly headBranch: string;
}

export interface GitHubPort {
  listIssues(repository: string): Promise<readonly GitHubIssue[]>;
  listProjectItems(projectId: string): Promise<readonly GitHubProjectItem[]>;
  listProjectFields(projectId: string): Promise<readonly GitHubProjectField[]>;
  updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void>;
  updateIssue(repository: string, issueNumber: number, state: "open" | "closed"): Promise<GitHubIssue>;
  addComment(repository: string, issueNumber: number, body: string): Promise<void>;
}

export interface GitHubTaskLink {
  readonly taskId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueNodeId: string;
  readonly projectId: string | null;
  readonly projectItemId: string | null;
  readonly remoteUpdatedAt: string;
  readonly remoteState: "open" | "closed";
  readonly branchName: string | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly syncState: "synced" | "conflict" | "error";
  readonly syncError: string | null;
  readonly lastSyncedAt: string | null;
}

interface LinkRow {
  task_id: string;
  repository: string;
  issue_number: number;
  issue_node_id: string;
  project_id: string | null;
  project_item_id: string | null;
  remote_updated_at: string;
  remote_state: "open" | "closed";
  branch_name: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  sync_state: GitHubTaskLink["syncState"];
  sync_error: string | null;
  last_synced_at: string | null;
}

function fromRow(row: LinkRow): GitHubTaskLink {
  return {
    taskId: row.task_id,
    repository: row.repository,
    issueNumber: row.issue_number,
    issueNodeId: row.issue_node_id,
    projectId: row.project_id,
    projectItemId: row.project_item_id,
    remoteUpdatedAt: row.remote_updated_at,
    remoteState: row.remote_state,
    branchName: row.branch_name,
    pullRequestNumber: row.pull_request_number,
    pullRequestUrl: row.pull_request_url,
    syncState: row.sync_state,
    syncError: row.sync_error,
    lastSyncedAt: row.last_synced_at
  };
}

export class GitHubRepository {
  public constructor(private readonly database: Database.Database) {}

  public linkTask(link: GitHubTaskLink): void {
    try {
      this.database.prepare(
        `INSERT INTO github_task_links
          (task_id, repository, issue_number, issue_node_id, project_id, project_item_id,
           remote_updated_at, remote_state, branch_name, pull_request_number, pull_request_url,
           sync_state, sync_error, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           repository = excluded.repository, issue_number = excluded.issue_number,
           issue_node_id = excluded.issue_node_id, project_id = excluded.project_id,
           project_item_id = excluded.project_item_id, remote_updated_at = excluded.remote_updated_at,
           remote_state = excluded.remote_state, branch_name = excluded.branch_name,
           pull_request_number = excluded.pull_request_number, pull_request_url = excluded.pull_request_url,
           sync_state = excluded.sync_state, sync_error = excluded.sync_error,
           last_synced_at = excluded.last_synced_at`
      ).run(
        link.taskId, link.repository, link.issueNumber, link.issueNodeId, link.projectId,
        link.projectItemId, link.remoteUpdatedAt, link.remoteState, link.branchName,
        link.pullRequestNumber, link.pullRequestUrl, link.syncState, link.syncError, link.lastSyncedAt
      );
    } catch (error) {
      throw new PersistenceError("GitHub task link persistence failed", { cause: error });
    }
  }

  public linkForTask(taskId: string): GitHubTaskLink | null {
    try {
      const row = this.database.prepare("SELECT * FROM github_task_links WHERE task_id = ?")
        .get(taskId) as LinkRow | undefined;
      return row ? fromRow(row) : null;
    } catch (error) {
      throw new PersistenceError("GitHub task link lookup failed", { cause: error });
    }
  }

  public linkForIssue(repository: string, issueNumber: number): GitHubTaskLink | null {
    const row = this.database.prepare(
      "SELECT * FROM github_task_links WHERE repository = ? AND issue_number = ?"
    ).get(repository, issueNumber) as LinkRow | undefined;
    return row ? fromRow(row) : null;
  }

  public recordSyncEvent(taskId: string, kind: string, remoteUpdatedAt: string, payload: unknown): void {
    try {
      this.database.prepare(
        `INSERT INTO github_sync_events
          (event_id, task_id, kind, remote_updated_at, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), taskId, kind, remoteUpdatedAt, JSON.stringify(payload), new Date().toISOString());
    } catch (error) {
      throw new PersistenceError("GitHub sync event persistence failed", { cause: error });
    }

  }

  public recordPullRequest(taskId: string, branchName: string, number: number, url: string): GitHubTaskLink {
    const link = this.linkForTask(taskId);
    if (!link) throw new PersistenceError("GitHub task link not found");
    const updated = { ...link, branchName, pullRequestNumber: number, pullRequestUrl: url };
    this.linkTask(updated);
    return updated;
  }

  public listSyncEvents(taskId: string): readonly { kind: string; payload: string }[] {
    return this.database.prepare(
      "SELECT kind, payload_json AS payload FROM github_sync_events WHERE task_id = ? ORDER BY created_at"
    ).all(taskId) as { kind: string; payload: string }[];
  }
}

export interface GitHubSyncResult {
  readonly task: Task;
  readonly link: GitHubTaskLink;
  readonly action: "imported" | "synced" | "conflict";
}

export class GitHubSyncService {
  public constructor(
    private readonly port: GitHubPort,
    private readonly tasks: {
      create(input: CreateTaskInput): Task;
      get(taskId: string): Task | null;
      updateStatus(taskId: string, status: Task["status"]): Task;
    },
    private readonly links: GitHubRepository
  ) {}

  public async importIssue(repository: string, issue: GitHubIssue, projectId: string | null, projectItemId: string | null): Promise<GitHubSyncResult> {
    const existing = this.links.linkForIssue(repository, issue.number);
    if (existing) {
      const task = this.tasks.get(existing.taskId);
      if (!task) throw new Error("Linked Orchestrator task was not found");
      return { task, link: existing, action: "synced" };
    }
    const task = this.tasks.create({
      title: issue.title,
      description: issue.body,
      acceptanceCriteria: ["Complete implementation and verification"],
      riskTier: 1
    });
    const link: GitHubTaskLink = {
      taskId: task.id,
      repository,
      issueNumber: issue.number,
      issueNodeId: issue.id,
      projectId,
      projectItemId,
      remoteUpdatedAt: issue.updatedAt,
      remoteState: issue.state,
      branchName: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      syncState: "synced",
      syncError: null,
      lastSyncedAt: new Date().toISOString()
    };
    this.links.linkTask(link);
    this.links.recordSyncEvent(task.id, "github.issue_imported", issue.updatedAt, { repository, issue });
    return { task, link, action: "imported" };
  }

  public async syncTask(task: Task, progress: string | null = null): Promise<GitHubSyncResult> {
    const existing = this.links.linkForTask(task.id);
    if (!existing) throw new Error("Task has no GitHub link");
    try {
      const issues = await this.port.listIssues(existing.repository);
      const issue = issues.find((candidate) => candidate.number === existing.issueNumber);
      if (!issue) throw new Error("Linked GitHub issue was not found");
      if (new Date(issue.updatedAt).getTime() > new Date(existing.remoteUpdatedAt).getTime()) {
        const conflict = { ...existing, syncState: "conflict" as const, syncError: "Remote issue changed after last sync" };
        this.links.linkTask(conflict);
        this.links.recordSyncEvent(task.id, "github.sync_conflict", issue.updatedAt, { issue });
        return { task, link: conflict, action: "conflict" };
      }
      const desiredState = task.status === "completed" ? "closed" : "open";
      const updated = issue.state === desiredState ? issue : await this.port.updateIssue(
        existing.repository, existing.issueNumber, desiredState
      );
      if (progress) await this.port.addComment(existing.repository, existing.issueNumber, progress);
      const link = {
        ...existing,
        remoteUpdatedAt: updated.updatedAt,
        remoteState: updated.state,
        syncState: "synced" as const,
        syncError: null,
        lastSyncedAt: new Date().toISOString()
      };
      this.links.linkTask(link);
      this.links.recordSyncEvent(task.id, "github.synced", updated.updatedAt, { state: desiredState, progress });
      return { task, link, action: "synced" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub synchronization failed";
      const failed = { ...existing, syncState: "error" as const, syncError: message };
      this.links.linkTask(failed);
      this.links.recordSyncEvent(task.id, "github.sync_failed", existing.remoteUpdatedAt, { message });
      throw error;
    }
  }
}

export class GitHubApiClient implements GitHubPort {
  private readonly baseUrl: string;

  public constructor(
    private readonly token: string,
    baseUrl = "https://api.github.com"
  ) {
    if (!token.trim()) throw new Error("GitHub token is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  public async listIssues(repository: string): Promise<readonly GitHubIssue[]> {
    const value = await this.request(`/repos/${repositoryPath(repository)}/issues?state=all&per_page=100`);
    if (!Array.isArray(value)) throw new Error("GitHub issues response was invalid");
    return value.filter((issue): issue is Record<string, unknown> => typeof issue === "object" && issue !== null)
      .filter((issue) => typeof issue.number === "number" && typeof issue.id === "number")
      .map((issue) => ({
        id: String(issue.id),
        number: issue.number as number,
        title: String(issue.title ?? ""),
        body: String(issue.body ?? ""),
        state: issue.state === "closed" ? "closed" : "open",
        updatedAt: String(issue.updated_at ?? ""),
        htmlUrl: String(issue.html_url ?? "")
      }));
  }

  public async listProjectItems(projectId: string): Promise<readonly GitHubProjectItem[]> {
    const value = await this.request("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `query($id:ID!) {
          node(id:$id) {
            ... on ProjectV2 {
              items(first:100) {
                nodes {
                  id
                  content {
                    ... on Issue { id number title body state updatedAt url }
                  }
                }
              }
            }
          }
        }`,
        variables: { id: projectId }
      })
    }) as { data?: { node?: { items?: { nodes?: unknown[] } } }; errors?: unknown[] };
    if (value.errors?.length || !value.data?.node?.items?.nodes) {
      throw new Error("GitHub project items response was invalid");
    }
    return value.data.node.items.nodes.flatMap((node): GitHubProjectItem[] => {
      if (typeof node !== "object" || node === null) return [];
      const item = node as { id?: unknown; content?: Record<string, unknown> };
      const content = item.content;
      if (typeof item.id !== "string" || !content || typeof content.id !== "string" ||
          typeof content.number !== "number") return [];
      return [{
        id: item.id,
        issue: {
          id: content.id,
          number: content.number,
          title: String(content.title ?? ""),
          body: String(content.body ?? ""),
          state: content.state === "CLOSED" ? "closed" : "open",
          updatedAt: String(content.updatedAt ?? ""),
          htmlUrl: String(content.url ?? "")
        }
      }];
    });
  }

  public async listProjectFields(projectId: string): Promise<readonly GitHubProjectField[]> {
    const value = await this.request("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `query($id:ID!) {
          node(id:$id) {
            ... on ProjectV2 {
              fields(first:100) {
                nodes {
                  ... on ProjectV2Field { id name }
                  ... on ProjectV2SingleSelectField {
                    id name options { id name }
                  }
                }
              }
            }
          }
        }`,
        variables: { id: projectId }
      })
    }) as { data?: { node?: { fields?: { nodes?: unknown[] } } }; errors?: unknown[] };
    if (value.errors?.length || !value.data?.node?.fields?.nodes) {
      throw new Error("GitHub project fields response was invalid");
    }
    return value.data.node.fields.nodes.flatMap((field): GitHubProjectField[] => {
      if (typeof field !== "object" || field === null) return [];
      const candidate = field as { id?: unknown; name?: unknown; options?: unknown };
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
      const options = Array.isArray(candidate.options)
        ? candidate.options.flatMap((option) => {
          if (typeof option !== "object" || option === null) return [];
          const item = option as { id?: unknown; name?: unknown };
          return typeof item.id === "string" && typeof item.name === "string"
            ? [{ id: item.id, name: item.name }]
            : [];
        })
        : [];
      return [{ id: candidate.id, name: candidate.name, options }];
    });
  }

  public async updateProjectSingleSelect(
    projectId: string,
    itemId: string,
    fieldId: string,
    optionId: string
  ): Promise<void> {
    if (![projectId, itemId, fieldId, optionId].every((value) => value.trim().length > 0)) {
      throw new Error("GitHub project field identifiers are required");
    }
    const value = await this.request("/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `mutation($input:UpdateProjectV2ItemFieldValueInput!) {
          updateProjectV2ItemFieldValue(input:$input) {
            projectV2Item { id }
          }
        }`,
        variables: {
          input: {
            projectId,
            itemId,
            fieldId,
            value: { singleSelectOptionId: optionId }
          }
        }
      })
    }) as { data?: { updateProjectV2ItemFieldValue?: { projectV2Item?: { id?: unknown } } }; errors?: unknown[] };
    if (value.errors?.length || value.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) {
      throw new Error("GitHub project field update was not confirmed");
    }
  }

  public async updateIssue(repository: string, issueNumber: number, state: "open" | "closed"): Promise<GitHubIssue> {
    const value = await this.request(`/repos/${repositoryPath(repository)}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ state })
    });
    if (typeof value !== "object" || value === null) throw new Error("GitHub issue update response was invalid");
    const issue = value as Record<string, unknown>;
    return {
      id: String(issue.id), number: Number(issue.number), title: String(issue.title ?? ""),
      body: String(issue.body ?? ""), state: issue.state === "closed" ? "closed" : "open",
      updatedAt: String(issue.updated_at ?? ""), htmlUrl: String(issue.html_url ?? "")
    };
  }

  public async addComment(repository: string, issueNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
    return response.json();
  }
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new Error("GitHub repository must use owner/name format");
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}
