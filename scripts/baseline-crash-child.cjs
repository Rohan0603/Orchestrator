const path = require("node:path");

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Expected disposable SQLite path");

const { openDatabase } = require(path.resolve("dist-test/src/persistence/database.js"));
const { createOrchestratorSdk } = require(path.resolve("dist-test/src/sdk/index.js"));
const database = openDatabase(databasePath);
const sdk = createOrchestratorSdk(database, { maxActiveRuns: 1, maxActiveRunsPerWorker: 1 });
const worker = sdk.registerWorker({ name: "baseline-crash-worker" });
const task = sdk.createTask({
  title: "Baseline abrupt backend restart",
  description: "Disposable task committed before terminating the benchmark child process.",
  acceptanceCriteria: ["interrupted execution requires recovery", "startup never replays automatically"],
  riskTier: 1
});
const assignment = sdk.claimTask(worker.id, 60_000);
if (!assignment) throw new Error("Benchmark child failed to claim its disposable task");

process.stdout.write(`${JSON.stringify({ ready: true, taskId: task.id, runId: assignment.run.id })}\n`);
setInterval(() => undefined, 1000);
