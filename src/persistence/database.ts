import Database from "better-sqlite3";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "./migrations";

export class PersistenceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

export function openDatabase(path: string, options: {readonly migrate?: boolean} = {}): Database.Database {
  let database: Database.Database | undefined;
  try {
    const migrate = options.migrate ?? true;
    database = new Database(path, migrate ? undefined : {fileMustExist: true});
    database.pragma("foreign_keys = ON");
    if (migrate) {
      applyMigrations(database);
    } else {
      const hasVersionTable = database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"
      ).get();
      if (!hasVersionTable) throw new Error("Database schema is not initialized");
      const versions = database.prepare("SELECT version FROM schema_version").all() as {version: number}[];
      if (versions.length !== 1 || versions[0].version !== CURRENT_SCHEMA_VERSION) {
        throw new Error("Database schema version is incompatible");
      }
    }
    return database;
  } catch (error) {
    database?.close();
    throw new PersistenceError("Database initialization failed", { cause: error });
  }
}
