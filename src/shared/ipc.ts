import type { Task } from "./domain";

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
  createTask(input: CreateTaskInput): Promise<IpcResult<Task>>;
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
