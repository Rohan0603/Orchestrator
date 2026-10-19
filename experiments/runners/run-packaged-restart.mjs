import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const electron = path.resolve(root, "node_modules/electron/dist/electron.exe");
const trialDirectory = mkdtempSync(path.join(tmpdir(), "orchestrator-packaged-restart-"));
const helperSeed = path.join(trialDirectory, "helper-seed.mjs");
const databaseSeed = path.join(trialDirectory, "database-seed.mjs");
const query = path.join(trialDirectory, "query.mjs");
const env = { ...process.env, ORCHESTRATOR_TRIAL_DIR: trialDirectory, ORCHESTRATOR_ROOT: root };

writeFileSync(helperSeed, String.raw`
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
const directory = process.env.ORCHESTRATOR_TRIAL_DIR;
const root = process.env.ORCHESTRATOR_ROOT;
const helperPath = path.join(root, "dist-native", "job-object-helper.exe");
const workerPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "ping.exe");
const helper = spawn(helperPath, [], { cwd: path.dirname(helperPath), detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
let buffer = "";
const responses = new Map();
helper.stdout.setEncoding("utf8");
helper.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const response = JSON.parse(line);
      responses.get(response.id)?.(response);
    }
    newline = buffer.indexOf("\n");
  }
});
const request = (operation, fields = {}) => {
  const id = operation + "-" + Math.random();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(operation + " timed out")), 5000);
    responses.set(id, (response) => { clearTimeout(timer); responses.delete(id); resolve(response); });
    helper.stdin.write(JSON.stringify({ version: "orchestrator-job-v1", id, operation, ...fields }) + "\n");
  });
};
const handshake = await request("handshake");
const runId = randomUUID();
const attemptId = randomUUID();
const nonce = randomUUID();
const launched = await request("launch", {
  executable: workerPath,
  arguments: JSON.stringify(["-n", "30", "127.0.0.1"]),
  workingDirectory: root,
  environment: JSON.stringify({ SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }),
  runId, attemptId, nonce
});
writeFileSync(path.join(directory, "ownership.json"), JSON.stringify({
  helperPid: handshake.helperPid,
  helperCreationTime: handshake.helperCreationTime,
  workerPid: launched.workerPid,
  workerCreationTime: launched.workerCreationTime,
  runId, attemptId, nonce, helperPath
}));
helper.stdin.end();
helper.stdout.destroy();
helper.unref();
`, "utf8");

const electronTest = (body) => `import { app } from "electron";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
const root = process.env.ORCHESTRATOR_ROOT;
${body}`;

writeFileSync(databaseSeed, electronTest(`
test("seed packaged restart database", async () => {
  const directory = process.env.ORCHESTRATOR_TRIAL_DIR;
  app.setPath("userData", directory);
  await app.whenReady();
  const { openDatabase } = await import(pathToFileURL(path.join(root, "dist/persistence/database.js")));
  const { TaskRepository } = await import(pathToFileURL(path.join(root, "dist/persistence/task-repository.js")));
  const { RunRepository } = await import(pathToFileURL(path.join(root, "dist/persistence/run-repository.js")));
  const ownership = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(directory, "ownership.json"), "utf8"));
  const database = openDatabase(path.join(directory, "orchestrator.db"));
  const task = new TaskRepository(database).create({ title: "Packaged restart trial", description: "Disposable recovery trial", acceptanceCriteria: ["cleanup"], riskTier: 1 });
  const runs = new RunRepository(database);
  const createdAt = new Date().toISOString();
  database.prepare("INSERT INTO runs (id, task_id, state, route_id, recovery_state, created_at) VALUES (?, ?, 'running', ?, 'none', ?)").run(ownership.runId, task.id, "packaged-restart-trial", createdAt);
  database.prepare("INSERT INTO attempts (id, run_id, outcome, worker_report, created_at) VALUES (?, ?, 'pending', NULL, ?)").run(ownership.attemptId, ownership.runId, createdAt);
  runs.recordOwnership({ runId: ownership.runId, attemptId: ownership.attemptId, helperPid: ownership.helperPid, helperCreationTime: ownership.helperCreationTime, workerPid: ownership.workerPid, workerCreationTime: ownership.workerCreationTime, helperExecutable: ownership.helperPath, protocolVersion: "orchestrator-job-v1", nonce: ownership.nonce, state: "running", lastStatus: "running", cleanupVerified: false, uncertaintyReason: null, updatedAt: createdAt });
  database.close();
});
`), "utf8");

writeFileSync(query, electronTest(`
test("query packaged restart database", async () => {
  const directory = process.env.ORCHESTRATOR_TRIAL_DIR;
  app.setPath("userData", directory);
  await app.whenReady();
  const Database = (await import(pathToFileURL(path.join(root, "node_modules/better-sqlite3/lib/database.js")))).default;
  const database = new Database(path.join(directory, "orchestrator.db"));
  const ownership = database.prepare("SELECT state, cleanup_verified, last_status, uncertainty_reason FROM ownership_records").all();
  const runs = database.prepare("SELECT recovery_state FROM runs").all();
  database.close();
  await writeFile(path.join(directory, "query-result.json"), JSON.stringify({ ownership, runs }));
});
`), "utf8");

try {
  execFileSync(process.execPath, [helperSeed], { cwd: root, env, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/run-electron-tests.mjs", "--expected=1", databaseSeed], { cwd: root, env, stdio: "inherit" });
  const packaged = spawn(path.join(root, "out", "Orchestrator-win32-x64", "Orchestrator.exe"), ["--disable-gpu", `--user-data-dir=${trialDirectory}`], { windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const packagedAlive = packaged.exitCode === null;
  if (packagedAlive) packaged.kill();
  await new Promise((resolve) => packaged.once("close", resolve));
  execFileSync(process.execPath, ["scripts/run-electron-tests.mjs", "--expected=1", query], { cwd: root, env, stdio: "inherit" });
  const result = { trial: "packaged-restart", date: new Date().toISOString(), packagedAlive, ...JSON.parse(readFileSync(path.join(trialDirectory, "query-result.json"), "utf8")) };
  const output = path.resolve(process.env.ORCHESTRATOR_TRIAL_OUTPUT ?? path.join(root, "experiments", "results", `packaged-restart-${Date.now()}.json`));
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  rmSync(trialDirectory, { recursive: true, force: true });
}
