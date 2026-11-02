import { randomUUID } from "node:crypto";
import type { Request, Response } from "../protocol/v1";
import type { Task } from "../shared/domain";
import { RustCoreClient, RustCoreClientError } from "./rust-core-client";

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  const stringArray = (entry: unknown): entry is string[] =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string");
  return typeof task.id === "string" && task.id.length > 0 &&
    (task.projectId === null || typeof task.projectId === "string") &&
    (task.parentTaskId === null || typeof task.parentTaskId === "string") &&
    typeof task.title === "string" && typeof task.description === "string" &&
    stringArray(task.acceptanceCriteria) &&
    (task.riskTier === 1 || task.riskTier === 2 || task.riskTier === 3) &&
    typeof task.status === "string" &&
    (task.assignedWorkerId === null || typeof task.assignedWorkerId === "string") &&
    stringArray(task.skillIds) && stringArray(task.mcpServerIds) && stringArray(task.pluginIds) &&
    (task.tokenBudget === null || typeof task.tokenBudget === "number") &&
    typeof task.createdAt === "string" && Number.isFinite(Date.parse(task.createdAt));
}

export class RustTaskReader {
  public constructor(private readonly core: RustCoreClient) {}

  public async list(): Promise<Task[]> {
    const request: Request = {
      protocolVersion: 1,
      kind: "request",
      messageId: randomUUID(),
      correlationId: randomUUID(),
      causationId: null,
      sender: { id: "typescript-client", role: "client" },
      method: "tasks.list",
      payload: {}
    };
    const response: Response = await this.core.request(request);
    if (!response.ok) {
      throw new RustCoreClientError(response.error.code, response.error.message);
    }
    if (!Array.isArray(response.result) || !response.result.every(isTask)) {
      throw new RustCoreClientError("INVALID_TASK_LIST_RESPONSE", "Rust core returned an invalid task list");
    }
    return response.result;
  }
}
