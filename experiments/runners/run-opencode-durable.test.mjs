import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { app } from "electron";
import { OpenCodeCliAdapter } from "../../dist/harness/opencode-cli-adapter.js";
import { executeLocalRun } from "../../dist/execution/local-execution.js";
import { DispatchRepository } from "../../dist/persistence/dispatch-repository.js";
import { openDatabase } from "../../dist/persistence/database.js";
import { TaskRepository } from "../../dist/persistence/task-repository.js";

test("real OpenCode worker completes durable dispatch path", async () => {
  try {
  const fixture = process.env.ORCHESTRATOR_REAL_FIXTURE;
  const output = process.env.ORCHESTRATOR_REAL_OUTPUT;
  const model = process.env.ORCHESTRATOR_REAL_MODEL ?? "opencode/mimo-v2.6-flash-free";
  const sourceRevision = process.env.ORCHESTRATOR_REAL_SOURCE ?? "unknown";
  assert.ok(fixture && output);
  await app.whenReady();
  const databasePath = `${fixture}\\.orchestrator\\run.db`;
  mkdirSync(`${fixture}\\.orchestrator`, { recursive: true });
  const database = openDatabase(databasePath);
  try {
    const task = new TaskRepository(database).create({
      title: "Real OpenCode fixture task",
      description: "Change value.txt from value=1 to value=2.",
      acceptanceCriteria: ["Only value.txt changes", "verify.ps1 passes"],
      riskTier: 1
    });
    const route = {
      routeId: `opencode-cli:${model}`,
      provider: { state: "known", name: model.split("/")[0] },
      model: { state: "known", name: model.slice(model.indexOf("/") + 1) },
      reportedBy: "adapter"
    };
    const adapter = new OpenCodeCliAdapter({
      executable: process.platform === "win32"
        ? `${process.env.APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe`
        : "opencode",
      version: "1.19.0",
      route,
      model
    });
    const result = await executeLocalRun(database, {
      task,
      action: {
        operation: "run-worker",
        context: { operation: "run-worker", target: fixture, arguments: [], payload: null },
        riskTier: 1,
        prohibited: false,
        capabilityVerified: true,
        evidenceComplete: true,
        prerequisitesResolved: true
      },
      approval: null,
      workspace: {
        repositoryPath: fixture,
        targetBranch: "fixture-worker",
        baseBranch: "master",
        confirmedByUser: true,
        worktreePath: fixture,
        prohibitedOperation: false
      },
      manifest: await adapter.discoverCapabilities(),
      route,
      routeRequirements: {
        routeId: route.routeId,
        allowExplicitFallback: false,
        capabilities: ["run.create", "progress.structured", "terminal.outcome", "artifact.provenance", "dispatch.idempotency"]
          .map((key) => ({ key, mandatory: true, prerequisites: [] }))
      },
      deadlineAt: new Date(Date.now() + 300000).toISOString(),
      adapter
    });
    assert.equal(result.status, "verification");
    const diff = execFileSync("git", ["diff", "--binary", "--", "value.txt"], { cwd: fixture, encoding: "utf8" });
    const verifier = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "verify.ps1"], {
      cwd: fixture,
      encoding: "utf8"
    }).trim();
    const dispatch = database.prepare("SELECT dispatch_id, run_id, attempt_id FROM dispatch_intents WHERE attempt_id = ?").get(result.attemptId);
    assert.ok(dispatch);
    const usage = adapter.getUsage({
      dispatchId: dispatch.dispatch_id,
      runId: dispatch.run_id,
      attemptId: dispatch.attempt_id
    });
    writeFileSync(`${output}.diff`, diff, { flag: "wx" });
    new DispatchRepository(database).recordEvidence({
      id: `evidence-${result.attemptId}`,
      kind: "diff",
      correlation: { dispatchId: dispatch.dispatch_id, runId: dispatch.run_id, attemptId: dispatch.attempt_id },
      eventId: "orchestrator-diff-capture",
      provenance: "orchestrator_verified",
      uri: pathToFileURL(`${output}.diff`).toString(),
      contentHash: createHash("sha256").update(diff).digest("hex"),
      capturedAt: new Date().toISOString(),
      status: "present",
      independentlyVerified: true,
      completenessNote: "Captured from git diff after real adapter completion"
    });
    writeFileSync(output, `${JSON.stringify({
      schemaVersion: "trial-result-v1",
      experimentId: "real-opencode-durable",
      trialId: `durable-${Date.now()}`,
      sourceRevision,
      model,
      dispatch: { intentPersistedBeforeWorker: true, ...dispatch },
      execution: result,
      usage,
      verifier: { status: "passed", output: verifier },
      diffSha256: createHash("sha256").update(diff).digest("hex"),
      review: { status: "blocked", reason: "No independent reviewer configured" },
      acceptance: { status: result.acceptance?.decision ?? "blocked", reason: result.acceptance?.reason ?? "No decision" },
      cancellation: { status: "blocked", reason: "Windows process ownership is unverified" }
    }, null, 2)}\n`, { flag: "wx" });
  } finally {
    database?.close();
    app.quit();
  }
  } catch (error) {
    console.error(error);
    throw error;
  }
});
