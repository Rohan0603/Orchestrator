import { execFileSync } from "node:child_process";
import { openDatabase } from "../persistence/database";
import { CURRENT_SCHEMA_VERSION } from "../persistence/migrations";

export class RustMigrationError extends Error {
  public constructor() {
    super("Rust database migration failed");
    this.name = "RustMigrationError";
  }
}

export function initializeDatabaseWithRustMigration(executablePath: string, databasePath: string) {
  try {
    const output = execFileSync(executablePath, ["migrate", "--database", databasePath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 64 * 1024
    });
    const result: unknown = JSON.parse(output);
    if (!isMigrationResult(result) || result.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new RustMigrationError();
    }
  } catch {
    throw new RustMigrationError();
  }
  return openDatabase(databasePath, {migrate: false});
}

function isMigrationResult(value: unknown): value is {readonly schemaVersion: number} {
  return typeof value === "object" && value !== null && "schemaVersion" in value &&
    typeof value.schemaVersion === "number";
}
