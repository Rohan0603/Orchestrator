import type Database from "better-sqlite3";
import { PersistenceError } from "./database";

export async function backupDatabase(
  database: Database.Database,
  destinationPath: string
): Promise<void> {
  if (!destinationPath.trim()) {
    throw new PersistenceError("Database backup destination is required");
  }
  try {
    await database.backup(destinationPath);
  } catch (error) {
    throw new PersistenceError("Database backup failed", { cause: error });
  }
}
