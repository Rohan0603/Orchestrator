import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface TaskRevisionSnapshot {
  readonly taskId: string;
  readonly projectId: string | null;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly riskTier: 1 | 2 | 3;
  readonly skillIds: readonly string[];
  readonly mcpServerIds: readonly string[];
  readonly pluginIds: readonly string[];
  readonly tokenBudget: number | null;
}

export interface TaskRevisionRecord {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly snapshotJson: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export function createTaskRevision(database: Database.Database, snapshot: TaskRevisionSnapshot, revision: number, createdAt: string): TaskRevisionRecord {
  const snapshotJson = JSON.stringify(snapshot);
  const record: TaskRevisionRecord = {
    id: randomUUID(), taskId: snapshot.taskId, revision, snapshotJson,
    contentHash: createHash("sha256").update(snapshotJson).digest("hex"), createdAt
  };
  database.prepare(`INSERT INTO task_revisions (id,task_id,revision,snapshot_json,content_hash,created_at)
    VALUES (?,?,?,?,?,?)`).run(record.id, record.taskId, record.revision, record.snapshotJson, record.contentHash, record.createdAt);
  return record;
}

export function backfillTaskRevisions(database: Database.Database): void {
  const rows = database.prepare(`SELECT t.* FROM tasks t LEFT JOIN task_revisions r ON r.task_id=t.id
    WHERE r.task_id IS NULL ORDER BY t.created_at,t.id`).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const snapshot: TaskRevisionSnapshot = {
      taskId: String(row.id), projectId: row.project_id ? String(row.project_id) : null,
      parentTaskId: row.parent_task_id ? String(row.parent_task_id) : null,
      title: String(row.title), description: String(row.description),
      acceptanceCriteria: JSON.parse(String(row.acceptance_criteria)) as string[],
      riskTier: Number(row.risk_tier) as TaskRevisionSnapshot["riskTier"],
      skillIds: JSON.parse(String(row.skill_ids ?? "[]")) as string[],
      mcpServerIds: JSON.parse(String(row.mcp_server_ids ?? "[]")) as string[],
      pluginIds: JSON.parse(String(row.plugin_ids ?? "[]")) as string[],
      tokenBudget: row.token_budget === null || row.token_budget === undefined ? null : Number(row.token_budget)
    };
    createTaskRevision(database, snapshot, 1, String(row.created_at));
  }
}
