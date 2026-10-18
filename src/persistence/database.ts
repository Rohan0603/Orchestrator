import Database from "better-sqlite3";
import { applyMigrations } from "./migrations";

export class PersistenceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

export function openDatabase(path: string): Database.Database {
  try {
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    applyMigrations(database);
    return database;
  } catch (error) {
    throw new PersistenceError("Database initialization failed", { cause: error });
  }
}
