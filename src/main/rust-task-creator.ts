import { randomUUID } from "node:crypto";
import type { Request, Response } from "../protocol/v1";
import type { Task } from "../shared/domain";
import { parseCreateTaskInput, type CreateTaskInput } from "../shared/ipc";
import { RustCoreClient, RustCoreClientError } from "./rust-core-client";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && task.id.length > 0 &&
    (task.projectId === null || typeof task.projectId === "string") &&
    (task.parentTaskId === null || typeof task.parentTaskId === "string") &&
    typeof task.title === "string" && typeof task.description === "string" &&
    isStringArray(task.acceptanceCriteria) &&
    (task.riskTier === 1 || task.riskTier === 2 || task.riskTier === 3) &&
    task.status === "intake" && task.assignedWorkerId === null &&
    isStringArray(task.skillIds) && isStringArray(task.mcpServerIds) &&
    isStringArray(task.pluginIds) &&
    (task.tokenBudget === null || typeof task.tokenBudget === "number") &&
    typeof task.createdAt === "string" && Number.isFinite(Date.parse(task.createdAt));
}

export class RustTaskCreator {
  public constructor(private readonly core: RustCoreClient) {}

  public async create(input: CreateTaskInput): Promise<Task> {
    const normalized = parseCreateTaskInput(input);
    const request: Request = {
      protocolVersion: 1,
      kind: "request",
      messageId: randomUUID(),
      correlationId: randomUUID(),
      causationId: null,
      sender: { id: "typescript-client", role: "client" },
      method: "tasks.create",
      payload: {
        projectId: normalized.projectId ?? null,
        parentTaskId: normalized.parentTaskId ?? null,
        title: normalized.title,
        description: normalized.description,
        acceptanceCriteria: [...normalized.acceptanceCriteria],
        riskTier: normalized.riskTier,
        skillIds: [...(normalized.skillIds ?? [])],
        mcpServerIds: [...(normalized.mcpServerIds ?? [])],
        pluginIds: [...(normalized.pluginIds ?? [])],
        tokenBudget: normalized.tokenBudget ?? null,
        ...(normalized.idempotencyKey === undefined ? {} : { idempotencyKey: normalized.idempotencyKey })
      }
    };
    const response: Response = await this.core.request(request);
    if (!response.ok) {
      throw new RustCoreClientError(response.error.code, response.error.message);
    }
    if (!isTask(response.result)) {
      throw new RustCoreClientError("INVALID_TASK_RESPONSE", "Rust core returned an invalid task result");
    }
    return response.result;
  }
}
