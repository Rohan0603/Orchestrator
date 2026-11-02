import type Database from "better-sqlite3";
import { backfillTaskRevisions } from "./task-revisions";
import migrationSql from "./migrations.json";

const migrations: readonly string[] = migrationSql;

export function applyMigrations(database: Database.Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;
  if (currentVersion > migrations.length) {
    throw new Error(`Unsupported database schema version: ${currentVersion}`);
  }
  const migrate = database.transaction(() => {
    for (let index = currentVersion; index < migrations.length; index += 1) {
      database.exec(migrations[index]);
      if (currentVersion === 0 && index === 0) {
        database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(index + 1);
      } else {
        database.prepare("UPDATE schema_version SET version = ?").run(index + 1);
      }
    }
    if (currentVersion < migrations.length) backfillTaskRevisions(database);
  });
  migrate();
}
