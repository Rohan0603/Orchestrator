import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CreateTaskInput } from "../shared/ipc";
import type { Task } from "../shared/domain";
import { assertTaskTransition } from "../shared/domain";
import { PersistenceError } from "./database";
import { appendDurableEvent } from "./events";
import { createTaskRevision, type TaskRevisionRecord } from "./task-revisions";

export interface TaskDependencyRecord {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly createdAt: string;
}

interface TaskRow {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  risk_tier: 1 | 2 | 3;
  status: Task["status"];
  assigned_worker_id: string | null;
  skill_ids: string;
  mcp_server_ids: string;
  plugin_ids: string;
  token_budget: number | null;
  created_at: string;
}

function fromRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
    riskTier: row.risk_tier,
    status: row.status,
    assignedWorkerId: row.assigned_worker_id,
    skillIds: JSON.parse(row.skill_ids || "[]") as string[],
    mcpServerIds: JSON.parse(row.mcp_server_ids || "[]") as string[],
    pluginIds: JSON.parse(row.plugin_ids || "[]") as string[],
    tokenBudget: row.token_budget,
    createdAt: row.created_at
  };
}

export class TaskRepository {
  public constructor(private readonly database: Database.Database) {}

  public list(): readonly Task[] {
    try {
      const rows = this.database.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as TaskRow[];
      return rows.map(fromRow);
    } catch (error) {
      throw new PersistenceError("Task listing failed", { cause: error });
    }
  }

  public get(taskId: string): Task | null {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return row ? fromRow(row) : null;
  }

  public create(input: CreateTaskInput): Task {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey)) throw new Error("Task idempotency key is invalid");
    const commandPayload = {
      projectId: input.projectId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description,
      acceptanceCriteria: [...input.acceptanceCriteria],
      riskTier: input.riskTier,
      skillIds: [...(input.skillIds ?? [])],
      mcpServerIds: [...(input.mcpServerIds ?? [])],
      pluginIds: [...(input.pluginIds ?? [])],
      tokenBudget: input.tokenBudget ?? null
    };
    const payloadHash = createHash("sha256").update(JSON.stringify(commandPayload)).digest("hex");
    const task: Task = {
      id: randomUUID(),
      projectId: input.projectId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description,
      acceptanceCriteria: [...input.acceptanceCriteria],
      riskTier: input.riskTier,
      status: "intake",
      assignedWorkerId: null,
      skillIds: [...(input.skillIds ?? [])],
      mcpServerIds: [...(input.mcpServerIds ?? [])],
      pluginIds: [...(input.pluginIds ?? [])],
      tokenBudget: input.tokenBudget ?? null,
      createdAt: new Date().toISOString()
    };
    try {
      return this.database.transaction(() => {
        if (idempotencyKey) {
          const command = this.database.prepare("SELECT payload_hash,task_id FROM task_commands WHERE idempotency_key=?").get(idempotencyKey) as {payload_hash: string; task_id: string} | undefined;
          if (command) {
            if (command.payload_hash !== payloadHash) throw new Error("Task create idempotency key reused with different payload");
            const existing = this.database.prepare("SELECT * FROM tasks WHERE id=?").get(command.task_id) as TaskRow | undefined;
            if (!existing) throw new Error("Idempotent task command points to a missing task");
            return fromRow(existing);
          }
        }
        this.database.prepare(
          `INSERT INTO tasks
             (id, project_id, parent_task_id, title, description, acceptance_criteria, risk_tier, status,
              assigned_worker_id, skill_ids, mcp_server_ids, plugin_ids, token_budget, created_at)
            VALUES (@id, @projectId, @parentTaskId, @title, @description, @acceptanceCriteria, @riskTier, @status,
              NULL, @skillIds, @mcpServerIds, @pluginIds, @tokenBudget, @createdAt)`
        ).run({
          id: task.id,
          projectId: input.projectId ?? null,
          parentTaskId: input.parentTaskId ?? null,
          title: task.title,
          description: task.description,
          acceptanceCriteria: JSON.stringify(task.acceptanceCriteria),
          riskTier: task.riskTier,
          status: task.status,
          skillIds: JSON.stringify(input.skillIds ?? []),
          mcpServerIds: JSON.stringify(input.mcpServerIds ?? []),
          pluginIds: JSON.stringify(input.pluginIds ?? []),
          tokenBudget: input.tokenBudget ?? null,
          createdAt: task.createdAt
        });
        const snapshot = {
          taskId: task.id, projectId: task.projectId, parentTaskId: task.parentTaskId, title: task.title,
          description: task.description, acceptanceCriteria: task.acceptanceCriteria, riskTier: task.riskTier,
          skillIds: task.skillIds, mcpServerIds: task.mcpServerIds, pluginIds: task.pluginIds, tokenBudget: task.tokenBudget
        };
        const revision = createTaskRevision(this.database, snapshot, 1, task.createdAt);
        if (idempotencyKey) this.database.prepare("INSERT INTO task_commands (idempotency_key,payload_hash,task_id,created_at) VALUES (?,?,?,?)")
          .run(idempotencyKey, payloadHash, task.id, task.createdAt);
        appendDurableEvent(this.database, "task.created", task, task.createdAt, {
          correlation: { taskId: task.id },
          idempotencyKey: `task.created:${task.id}`
        });
        appendDurableEvent(this.database, "task.revision.created", {taskId: task.id, revision: revision.revision, contentHash: revision.contentHash}, task.createdAt, {
          correlation: {taskId: task.id}, idempotencyKey: `task.revision.created:${task.id}:1`
        });
        return task;
      })();
    } catch (error) {
      throw new PersistenceError(`Task creation failed${error instanceof Error ? `: ${error.message}` : ""}`, { cause: error });
    }
  }

  public revisions(taskId: string): readonly TaskRevisionRecord[] {
    return this.database.prepare("SELECT * FROM task_revisions WHERE task_id=? ORDER BY revision").all(taskId).map((value) => {
      const row = value as {id: string; task_id: string; revision: number; snapshot_json: string; content_hash: string; created_at: string};
      return {id: row.id, taskId: row.task_id, revision: row.revision, snapshotJson: row.snapshot_json, contentHash: row.content_hash, createdAt: row.created_at};
    });
  }

  public dependencies(taskId: string): readonly TaskDependencyRecord[] {
    return this.database.prepare("SELECT task_id,depends_on_task_id,created_at FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id").all(taskId).map((value) => {
      const row = value as {task_id: string; depends_on_task_id: string; created_at: string};
      return {taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id, createdAt: row.created_at};
    });
  }

  public addDependency(taskId: string, dependsOnTaskId: string): TaskDependencyRecord {
    try {
      return this.database.transaction(() => {
        const already = this.database.prepare("SELECT task_id,depends_on_task_id,created_at FROM task_dependencies WHERE task_id=? AND depends_on_task_id=?").get(taskId, dependsOnTaskId) as {task_id: string; depends_on_task_id: string; created_at: string} | undefined;
        if (already) return {taskId: already.task_id, dependsOnTaskId: already.depends_on_task_id, createdAt: already.created_at};
        if (taskId === dependsOnTaskId) throw new Error("Task dependency cycle is not allowed");
        if (!this.database.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId) || !this.database.prepare("SELECT 1 FROM tasks WHERE id=?").get(dependsOnTaskId)) throw new Error("Task dependency references a missing task");
        const cycle = this.database.prepare(`WITH RECURSIVE reachable(id) AS (
          SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?
          UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id=r.id
        ) SELECT 1 FROM reachable WHERE id=? LIMIT 1`).get(dependsOnTaskId, taskId);
        if (cycle) throw new Error("Task dependency cycle is not allowed");
        const record = {taskId, dependsOnTaskId, createdAt: new Date().toISOString()};
        this.database.prepare("INSERT INTO task_dependencies (task_id,depends_on_task_id,created_at) VALUES (?,?,?)").run(taskId, dependsOnTaskId, record.createdAt);
        appendDurableEvent(this.database, "task.dependency.added", record, record.createdAt, {
          correlation: {taskId}, idempotencyKey: `task.dependency.added:${taskId}:${dependsOnTaskId}`
        });
        return record;
      })();
    } catch (error) {
      throw new PersistenceError(`Task dependency creation failed${error instanceof Error ? `: ${error.message}` : ""}`, {cause: error});
    }
  }

  public updateStatus(taskId: string, status: Task["status"]): Task {
    try {
      return this.database.transaction(() => {
        const currentRow = this.database
          .prepare("SELECT * FROM tasks WHERE id = ?")
          .get(taskId) as TaskRow | undefined;
        if (!currentRow) throw new Error("Task not found");
        assertTaskTransition(currentRow.status, status);
        const result = this.database
          .prepare("UPDATE tasks SET status = ? WHERE id = ?")
          .run(status, taskId);
        if (result.changes !== 1) throw new Error("Task not found");
        const task = fromRow({ ...currentRow, status });
        appendDurableEvent(
          this.database,
          "task.state_changed",
          { taskId, from: currentRow.status, to: status },
          undefined,
          { correlation: { taskId } }
        );
        return task;
      })();
    } catch (error) {
      throw new PersistenceError("Task status update failed", { cause: error });
    }
  }
}
