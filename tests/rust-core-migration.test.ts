import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabaseWithRustMigration, RustMigrationError } from "../src/main/rust-core-migration";
import { openDatabase, PersistenceError } from "../src/persistence/database";

const repositoryRoot = process.cwd();
const executablePath = join(repositoryRoot, "target", "debug", process.platform === "win32" ? "orchestrator-core.exe" : "orchestrator-core");

test("Rust startup migration creates schema 13 and is idempotent before TypeScript opens the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-startup-migration-"));
  const databasePath = join(directory, "fresh.sqlite");
  try {
    const first = initializeDatabaseWithRustMigration(executablePath, databasePath);
    assert.equal((first.prepare("SELECT version FROM schema_version").get() as {version: number}).version, 13);
    first.close();

    const second = initializeDatabaseWithRustMigration(executablePath, databasePath);
    assert.equal((second.prepare("SELECT version FROM schema_version").get() as {version: number}).version, 13);
    second.close();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test("Rust migration failure is sanitized and TypeScript does not create the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-startup-migration-fail-"));
  const databasePath = join(directory, "must-not-exist.sqlite");
  try {
    assert.throws(
      () => initializeDatabaseWithRustMigration(join(directory, "missing-core.exe"), databasePath),
      (error: unknown) => error instanceof RustMigrationError && error.message === "Rust database migration failed"
    );
    assert.equal(existsSync(databasePath), false);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test("TypeScript validation mode rejects an old schema without applying migrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-startup-schema-"));
  const databasePath = join(directory, "old.sqlite");
  try {
    const database = openDatabase(databasePath);
    database.prepare("UPDATE schema_version SET version = 12").run();
    database.close();

    assert.throws(() => openDatabase(databasePath, {migrate: false}), PersistenceError);
    const inspection = new Database(databasePath, {readonly: true});
    try {
      assert.equal((inspection.prepare("SELECT version FROM schema_version").get() as {version: number}).version, 12);
    } finally {
      inspection.close();
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test("TypeScript validation mode does not create a missing database", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-startup-missing-"));
  const databasePath = join(directory, "must-not-be-created.sqlite");
  try {
    assert.throws(() => openDatabase(databasePath, {migrate: false}), PersistenceError);
    assert.equal(existsSync(databasePath), false);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
