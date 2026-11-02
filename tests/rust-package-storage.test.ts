import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import { openDatabase } from "../src/persistence/database";

const packagedCore = resolve("out/Orchestrator-win32-x64/resources/orchestrator-core.exe");

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const result = Buffer.alloc(4 + body.length);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

function nextFrame(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let bytes = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("packaged Rust core did not send an IPC frame"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (bytes.length < length + 4) return;
      clearTimeout(timeout);
      resolvePromise(JSON.parse(bytes.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

async function inspectPackagedDatabase(databasePath: string, enableWal: boolean) {
  const args = ["serve", "--database", databasePath];
  if (enableWal) args.push("--enable-wal");
  const child = spawn(packagedCore, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const firstFrame = nextFrame(child);
  child.stdin.write(frame({
    protocolVersion: 1,
    kind: "hello",
    messageId: "package-storage-hello",
    correlationId: "package-storage-correlation",
    causationId: null,
    sender: { id: "typescript-client", role: "client" },
    minimumProtocol: 1,
    maximumProtocol: 1,
    clientVersion: "0.1.0",
    schemaVersion: 1,
    requiredCapabilities: ["system.health", "capabilities.list", "tasks.create"]
  }));
  const welcome = await firstFrame;
  const healthFrame = nextFrame(child);
  child.stdin.write(frame({
    protocolVersion: 1,
    kind: "request",
    messageId: "package-storage-health",
    correlationId: "package-storage-health-correlation",
    causationId: null,
    sender: { id: "typescript-client", role: "client" },
    method: "system.health",
    payload: {}
  }));
  const health = await healthFrame;
  const createFrame = nextFrame(child);
  child.stdin.write(frame({
    protocolVersion: 1,
    kind: "request",
    messageId: "package-storage-create-task",
    correlationId: "package-storage-create-correlation",
    causationId: null,
    sender: { id: "typescript-client", role: "client" },
    method: "tasks.create",
    payload: {
      title: "Packaged Rust task",
      description: "Verify task creation through the packaged core",
      acceptanceCriteria: ["Persist through Rust"],
      riskTier: 1
    }
  }));
  const created = await createFrame;
  const listFrame = nextFrame(child);
  child.stdin.write(frame({
    protocolVersion: 1,
    kind: "request",
    messageId: "package-storage-list-tasks",
    correlationId: "package-storage-list-correlation",
    causationId: null,
    sender: { id: "typescript-client", role: "client" },
    method: "tasks.list",
    payload: {}
  }));
  const listed = await listFrame;
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code));
  });
  assert.equal(exitCode, 0);
  return { welcome, health, created, listed };
}

test("packaged Rust storage validates schema 13 and supports explicitly selected WAL", async () => {
  assert.ok(Database, "Electron-targeted SQLite binding must load under the package test runner");
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-packaged-rust-storage-"));
  const databasePath = join(directory, "state.sqlite");
  const database = openDatabase(databasePath);
  database.close();
  try {
    const normal = await inspectPackagedDatabase(databasePath, false);
    assert.equal((normal.welcome as { databaseSchemaVersion: number }).databaseSchemaVersion, 13);
    assert.equal((normal.health as { result: { sqliteVersion: string; journalMode: string } }).result.journalMode, "delete");
    assert.equal(normal.created.ok, true);
    assert.equal(normal.listed.ok, true);
    assert.deepEqual(normal.listed.result, [normal.created.result]);
    const normalDatabase = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(
        normalDatabase.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
        { count: 1 }
      );
      assert.deepEqual(
        normalDatabase.prepare("SELECT COUNT(*) AS count FROM task_revisions").get(),
        { count: 1 }
      );
      assert.deepEqual(
        normalDatabase.prepare("SELECT COUNT(*) AS count FROM outbox").get(),
        { count: 2 }
      );
    } finally {
      normalDatabase.close();
    }
    const wal = await inspectPackagedDatabase(databasePath, true);
    assert.equal(wal.listed.ok, true);
    assert.ok((wal.listed.result as unknown[]).some((task) => JSON.stringify(task) === JSON.stringify(wal.created.result)));
    const walResult = (wal.health as { result: { sqliteVersion: string; journalMode: string } }).result;
    assert.equal(walResult.journalMode, "wal");
    assert.equal(walResult.sqliteVersion, (normal.health as { result: { sqliteVersion: string } }).result.sqliteVersion);
    assert.equal((wal.welcome as { databaseSchemaVersion: number }).databaseSchemaVersion, 13);
    const reopenedWal = await inspectPackagedDatabase(databasePath, false);
    assert.equal((reopenedWal.health as { result: { journalMode: string } }).result.journalMode, "wal");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
