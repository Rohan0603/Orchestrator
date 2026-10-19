import type { AcceptanceRecord, Run, Attempt, Task } from "./domain";
import type { GitHubSyncResult } from "../integrations/github";

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly riskTier: 1 | 2 | 3;
}

export interface ApplicationStatus {
  readonly state: "ready" | "persistence_error";
  readonly database: "connected" | "unavailable";
}

export interface FixtureRunSummary {
  readonly runId: string;
  readonly attemptId: string;
  readonly status: "blocked" | "rejected" | "verification" | "recovery_required";
  readonly accepted: false;
  readonly progressAccepted: number;
  readonly progressRejected: number;
  readonly acceptance: AcceptanceRecord | null;
}

export interface OwnedFixtureRunSummary {
  readonly runId: string;
  readonly attemptId: string;
  readonly ownershipVerified: true;
  readonly workerExecutedBeforeOwnership: false;
  readonly childContained: true;
  readonly grandchildContained: true;
  readonly cleanupVerified: true;
  readonly activeProcessesAfterCleanup: 0;
}

export interface RunHistoryEntry {
  readonly run: Run;
  readonly attempt: Attempt;
}

export interface IpcSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface IpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export interface OrchestratorApi {
  getStatus(): Promise<IpcResult<ApplicationStatus>>;
  listTasks(): Promise<IpcResult<readonly Task[]>>;
  listRuns(taskId: string): Promise<IpcResult<readonly RunHistoryEntry[]>>;
  createTask(input: CreateTaskInput): Promise<IpcResult<Task>>;
  runFixture(taskId: string): Promise<IpcResult<FixtureRunSummary>>;
  runOwnedFixture(taskId: string): Promise<IpcResult<OwnedFixtureRunSummary>>;
  importGitHubIssue(repository: string, projectId: string, issueNumber: number): Promise<IpcResult<GitHubSyncResult>>;
  syncGitHubTask(taskId: string, progress: string | null): Promise<IpcResult<GitHubSyncResult>>;
  updateGitHubProjectField(
    projectId: string,
    itemId: string,
    fieldId: string,
    optionId: string
  ): Promise<IpcResult<null>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isRecord(value)) {
    throw new Error("Task payload must be an object");
  }
  const { title, description, acceptanceCriteria, riskTier } = value;
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.length > 200 ||
    typeof description !== "string" ||
    description.length > 10000 ||
    !Array.isArray(acceptanceCriteria) ||
    acceptanceCriteria.length === 0 ||
    acceptanceCriteria.some(
      (criterion) => typeof criterion !== "string" || criterion.trim().length === 0
    ) ||
    (riskTier !== 1 && riskTier !== 2 && riskTier !== 3)
  ) {
    throw new Error("Invalid task payload");
  }
  return {
    title: title.trim(),
    description,
    acceptanceCriteria: acceptanceCriteria.map((criterion) => criterion.trim()),
    riskTier
  };
}
