import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { app } from "electron";
import { OpenCodeCliAdapter } from "../../dist/harness/opencode-cli-adapter.js";
import { executeLocalRun } from "../../dist/execution/local-execution.js";
import { DispatchRepository } from "../../dist/persistence/dispatch-repository.js";
import { openDatabase } from "../../dist/persistence/database.js";
import { TaskRepository } from "../../dist/persistence/task-repository.js";
import { RunRepository } from "../../dist/persistence/run-repository.js";
import { realProviderRouteRequirements } from "../../dist/harness/adapter-contract.js";
import { acceptanceCriterionId } from "../../dist/evidence/criteria.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fixture = option("--fixture");
const model = option("--model");
const output = option("--output");
const sourceRevision = option("--source-revision");
if (!fixture || !model || !output || !sourceRevision) {
  throw new Error(
    "Usage: electron run-opencode-durable.mjs --fixture <git-dir> --model <provider/model> --output <new-json> --source-revision <commit>"
  );
}

await app.whenReady();
let database;
try {
  const fixturePath = fixture;
  database = openDatabase(`${fixturePath}\\.orchestrator\\run.db`);
  const tasks = new TaskRepository(database);
  const runs = new RunRepository(database);
  const task = tasks.create({
    title: "Real OpenCode fixture task",
    description: "Change value.txt from value=1 to value=2.",
    acceptanceCriteria: ["Only value.txt changes", "verify.ps1 passes"],
    riskTier: 1
  });
  const adapter = new OpenCodeCliAdapter({
    executable: process.platform === "win32"
      ? join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
      : "opencode",
    version: "1.19.0",
    model,
    runs
  });
  const route = adapter.route;
  const manifest = await adapter.discoverCapabilities();
  const requiredCapabilities = [
    "run.create",
    "progress.structured",
    "terminal.outcome",
    "artifact.provenance",
    "dispatch.idempotency"
  ];
  const capabilityVerified = requiredCapabilities.every((key) =>
    manifest.capabilities.some((capability) =>
      capability.key === key && capability.state === "supported" && capability.evidence.length > 0
    )
  );
  const prerequisitesResolved = requiredCapabilities.every((key) =>
    manifest.capabilities.some((capability) => capability.key === key)
  );
  const result = await executeLocalRun(database, {
    task,
    action: {
      operation: "run-worker",
      context: {
        operation: "run-worker",
        target: fixturePath,
        arguments: [],
        payload: null
      },
      riskTier: 1,
      prohibited: false,
      capabilityVerified,
      evidenceComplete: capabilityVerified,
      prerequisitesResolved
    },
    approval: null,
    workspace: {
      repositoryPath: fixturePath,
      targetBranch: "fixture-worker",
      baseBranch: "master",
      confirmedByUser: true,
      worktreePath: fixturePath,
      prohibitedOperation: false
    },
    manifest,
    route,
    routeRequirements: realProviderRouteRequirements(route.routeId),
    deadlineAt: new Date(Date.now() + 300000).toISOString(),
    adapter
  });
  if (result.status !== "verification") {
    throw new Error(`Real OpenCode run did not reach verification: ${result.status}`);
  }
  const diff = execFileSync("git", ["diff", "--binary", "--", "value.txt"], {
    cwd: fixturePath,
    encoding: "utf8"
  });
  const verifierOutput = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "verify.ps1"],
    { cwd: fixturePath, encoding: "utf8" }
  ).trim();
  const dispatch = database
    .prepare("SELECT dispatch_id, run_id, attempt_id FROM dispatch_intents WHERE attempt_id = ?")
    .get(result.attemptId);
  if (!dispatch) throw new Error("Durable dispatch intent missing");
  const usage = adapter.getUsage({
    dispatchId: dispatch.dispatch_id,
    runId: dispatch.run_id,
    attemptId: dispatch.attempt_id
  });
  const evidenceUri = pathToFileURL(`${output}.diff`).toString();
  writeFileSync(`${output}.diff`, diff, { flag: "wx" });
  new DispatchRepository(database).recordEvidence({
    id: `evidence-${result.attemptId}`,
    kind: "diff",
    correlation: {
      dispatchId: dispatch.dispatch_id,
      runId: dispatch.run_id,
      attemptId: dispatch.attempt_id
    },
    eventId: "orchestrator-diff-capture",
    provenance: "orchestrator_verified",
    uri: evidenceUri,
    contentHash: createHash("sha256").update(diff).digest("hex"),
    capturedAt: new Date().toISOString(),
    status: "present",
    independentlyVerified: false,
    completenessNote: "Captured by orchestrator after real adapter completion; independent verification pending",
    criterionIds: [acceptanceCriterionId("Only value.txt changes")]
  });
  const counts = {
    intents: database.prepare("SELECT count(*) AS count FROM dispatch_intents").get().count,
    progress: database.prepare("SELECT count(*) AS count FROM progress_events").get().count,
    evidence: database.prepare("SELECT count(*) AS count FROM evidence_records").get().count
  };
  writeFileSync(output, `${JSON.stringify({
    schemaVersion: "trial-result-v1",
    experimentId: "real-opencode-durable",
    trialId: `durable-${Date.now()}`,
    sourceRevision,
    adapter: { id: adapter.identity.adapterId, version: adapter.identity.adapterVersion, model, route },
    dispatch: { intentPersistedBeforeWorker: counts.intents > 0, ...dispatch, counts },
    execution: result,
    usage,
    verifier: { status: "passed", output: verifierOutput },
    diff: { sha256: createHash("sha256").update(diff).digest("hex"), path: evidenceUri },
    review: { status: "blocked", reason: "No independent reviewer configured" },
    acceptance: { status: result.acceptance?.decision ?? "blocked", reason: result.acceptance?.reason ?? "No decision" },
    cancellation: manifest.capabilities.find((capability) => capability.key === "cancellation.request")
      ?? { state: "unreported", evidence: [] }
  }, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${output}\n`);
} finally {
  database?.close();
  app.quit();
}
