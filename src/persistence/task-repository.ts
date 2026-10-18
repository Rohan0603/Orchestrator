import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CreateTaskInput } from "../shared/ipc";
import type { Task } from "../shared/domain";
import { PersistenceError } from "./database";

interface TaskRow {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  risk_tier: 1 | 2 | 3;
  status: Task["status"];
  created_at: string;
}

function fromRow(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
    riskTier: row.risk_tier,
    status: row.status,
    createdAt: row.created_at
  };
}

export class TaskRepository {
  public constructor(private readonly database: Database.Database) {}

  public list(): readonly Task[] {
    try {
      const rows = this.database
        .prepare("SELECT * FROM tasks ORDER BY created_at DESC")
        .all() as TaskRow[];
      return rows.map(fromRow);
    } catch (error) {
      throw new PersistenceError("Task listing failed", { cause: error });
    }
  }

  public create(input: CreateTaskInput): Task {
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      acceptanceCriteria: [...input.acceptanceCriteria],
      riskTier: input.riskTier,
      status: "intake",
      createdAt: new Date().toISOString()
    };
    try {
      this.database
        .prepare(
          `INSERT INTO tasks
            (id, title, description, acceptance_criteria, risk_tier, status, created_at)
           VALUES (@id, @title, @description, @acceptanceCriteria, @riskTier, @status, @createdAt)`
        )
        .run({
          id: task.id,
          title: task.title,
          description: task.description,
          acceptanceCriteria: JSON.stringify(task.acceptanceCriteria),
          riskTier: task.riskTier,
          status: task.status,
          createdAt: task.createdAt
        });
      return task;
    } catch (error) {
      throw new PersistenceError("Task creation failed", { cause: error });
    }
  }
}
