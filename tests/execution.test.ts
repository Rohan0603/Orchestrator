import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/persistence/database";
import { RunRepository } from "../src/persistence/run-repository";
import { TaskRepository } from "../src/persistence/task-repository";
import { executeLocalRun } from "../src/execution/local-execution";
import { ConformanceFixtureAdapter } from "../src/harness/conformance-fixture";
import {
  HARNESS_ADAPTER_CONTRACT_VERSION,
  type CapabilityManifest,
  type Correlation,
  type RouteIdentity
} from "../src/harness/adapter-contract";

const route: RouteIdentity = {
  routeId: "local-fixture",
  provider: { state: "known", name: "fixture-provider" },
  model: { state: "known", name: "fixture-model" },
  reportedBy: "adapter"
};

const correlation: Correlation = {
  dispatchId: "fixture-dispatch",
  runId: "fixture-run",
  attemptId: "fixture-attempt"
};

const manifest: CapabilityManifest = {
  contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
  adapterId: "fixture-adapter",
  generatedAt: "2026-01-01T00:00:00.000Z",
  capabilities: [
    "run.create",
    "progress.structured",
    "terminal.outcome",
    "dispatch.idempotency"
  ].map((key) => ({
    key,
    state: "supported" as const,
    evidence: ["fixture"],
    conditions: [],
    satisfiedPrerequisites: [],
    version: "fixture-v1",
    environment: "test"
  })) as CapabilityManifest["capabilities"]
};

function action() {
  return {
    operation: "run-fixture",
    context: {
      operation: "run-fixture",
      target: "fixture-worktree",
      arguments: [],
      payload: null
    },
    riskTier: 1 as const,
    prohibited: false,
    capabilityVerified: true,
    evidenceComplete: true,
    prerequisitesResolved: true
  };
}

function adapter(
  terminalKind: "succeeded" | "failed" | null,
  cancellationCompleted = false
) {
  const event = {
    eventId: "progress-1",
    correlation,
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "message" as const,
    message: "fixture progress",
    evidence: []
  };
  return new ConformanceFixtureAdapter({
    identity: {
      adapterId: "fixture-adapter",
      harnessName: "local-fixture",
      adapterVersion: "1",
      contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION
    },
    manifest,
    route,
    progressEvents: [event, event],
    terminalOutcome: terminalKind
      ? {
          kind: terminalKind,
          correlation,
          reportedAt: "2026-01-01T00:00:01.000Z",
          evidence: [],
          error: null
        }
      : undefined,
    cancellationResult: cancellationCompleted
      ? {
          ok: true,
          value: {
            correlation,
            state: "completed",
            requestedAt: "2026-01-01T00:00:00.000Z",
            observedAt: "2026-01-01T00:00:01.000Z",
            processOwnershipVerified: true,
            error: null
          }
        }
      : {
          ok: false,
          error: {
            class: "ambiguous",
            code: "NOT_USED",
            message: "Not used in execution test",
            retryable: false,
            correlation
          }
        },
    reconciliationResult: {
      ok: false,
      error: {
        class: "unsupported_capability",
        code: "NOT_USED",
        message: "Not used in execution test",
        retryable: false,
        correlation
      }
    }
  });

}

function task(database: Database.Database) {
  return new TaskRepository(database).create({
    title: "Fixture task",
    description: "Run local fixture",
    acceptanceCriteria: ["fixture completes"],
    riskTier: 1
  });
}

test("deadline requires verified cancellation before terminal persistence", async () => {
  const scenario = runScenario("succeeded");
  try {
    const result = await executeLocalRun(scenario.database, {
      task: scenario.currentTask,
      action: action(),
      approval: null,
      workspace: workspace(),
      manifest,
      route,
      routeRequirements: requirements(),
      deadlineAt: new Date(Date.now() + 100).toISOString(),
      adapter: adapter(null, true)
    });
    assert.equal(result.status, "verification");
    assert.equal(
      (scenario.database.prepare("SELECT outcome FROM attempts").get() as { outcome: string }).outcome,
      "timed_out"
    );
    assert.deepEqual(
      scenario.database.prepare(
        "SELECT state, process_ownership_verified FROM cancellation_requests"
      ).get(),
      { state: "completed", process_ownership_verified: 1 }
    );
  } finally {
    scenario.database.close();
    rmSync(scenario.directory, { recursive: true, force: true });
  }
});

test("deadline with unverified cancellation remains recovery-required", async () => {
  const scenario = runScenario("succeeded");
  try {
    const result = await executeLocalRun(scenario.database, {
      task: scenario.currentTask,
      action: action(),
      approval: null,
      workspace: workspace(),
      manifest,
      route,
      routeRequirements: requirements(),
      deadlineAt: new Date(Date.now() + 100).toISOString(),
      adapter: adapter(null)
    });
    assert.equal(result.status, "recovery_required");
    assert.equal(
      (scenario.database.prepare("SELECT outcome FROM attempts").get() as { outcome: string }).outcome,
      "inconclusive"
    );
    assert.deepEqual(
      scenario.database.prepare(
        "SELECT state, process_ownership_verified FROM cancellation_requests"
      ).get(),
      { state: "unverified", process_ownership_verified: 0 }
    );
  } finally {
    scenario.database.close();
    rmSync(scenario.directory, { recursive: true, force: true });
  }
});

function workspace() {
  return {
    repositoryPath: "C:\\fixture-repository",
    targetBranch: "feature/fixture",
    baseBranch: "master",
    confirmedByUser: true,
    worktreePath: "C:\\fixture-worktree",
    prohibitedOperation: false
  };
}

function requirements() {
  return {
    routeId: route.routeId,
    allowExplicitFallback: false,
    capabilities: [
      { key: "run.create" as const, mandatory: true, prerequisites: [] },
      { key: "progress.structured" as const, mandatory: true, prerequisites: [] },
      { key: "terminal.outcome" as const, mandatory: true, prerequisites: [] },
      { key: "dispatch.idempotency" as const, mandatory: true, prerequisites: [] }
    ]
  };
}

function runScenario(terminalKind: "succeeded" | "failed") {
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-execution-"));
  const database = openDatabase(join(directory, "execution.db"));
  return { directory, database, currentTask: task(database), terminalKind };
}

test("local fixture execution persists intent, progress, and verification state", async () => {
  const scenario = runScenario("succeeded");
  try {
    const result = await executeLocalRun(scenario.database, {
      task: scenario.currentTask,
      action: action(),
      approval: null,
      workspace: workspace(),
      manifest,
      route,
      routeRequirements: requirements(),
      deadlineAt: "2099-01-01T00:00:00.000Z",
      adapter: adapter(scenario.terminalKind)
    });
    assert.equal(result.status, "verification");
    assert.equal(result.accepted, false);
    assert.equal(result.progressAccepted, 1);
    assert.equal(result.progressRejected, 1);
    assert.equal(
      (scenario.database.prepare("SELECT count(*) AS count FROM dispatch_intents").get() as { count: number }).count,
      1
    );
    assert.equal(
      (scenario.database.prepare("SELECT count(*) AS count FROM progress_events").get() as { count: number }).count,
      1
    );
    assert.deepEqual(
      scenario.database.prepare("SELECT decision, reason FROM acceptance_decisions").get(),
      {
        decision: "blocked",
        reason: "Independent review is unavailable"
      }
    );
  } finally {
    scenario.database.close();
    rmSync(scenario.directory, { recursive: true, force: true });
  }
});

test("local fixture failure is rejected and never accepted", async () => {
  const scenario = runScenario("failed");
  try {
    const result = await executeLocalRun(scenario.database, {
      task: scenario.currentTask,
      action: action(),
      approval: null,
      workspace: workspace(),
      manifest,
      route,
      routeRequirements: requirements(),
      deadlineAt: "2099-01-01T00:00:00.000Z",
      adapter: adapter(scenario.terminalKind)
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.accepted, false);
    assert.equal(
      (scenario.database.prepare("SELECT outcome FROM attempts").get() as { outcome: string }).outcome,
      "failed"
    );
  } finally {
    scenario.database.close();
    rmSync(scenario.directory, { recursive: true, force: true });
  }
});

test("local execution blocks before dispatch when mandatory capability is missing", async () => {
  const scenario = runScenario("succeeded");
  try {
    const result = await executeLocalRun(scenario.database, {
      task: scenario.currentTask,
      action: action(),
      approval: null,
      workspace: workspace(),
      manifest: {
        ...manifest,
        capabilities: manifest.capabilities.filter((capability) => capability.key !== "terminal.outcome")
      },
      route,
      routeRequirements: requirements(),
      deadlineAt: "2099-01-01T00:00:00.000Z",
      adapter: adapter(scenario.terminalKind)
    });
    assert.equal(result.status, "blocked");
    assert.equal(
      (scenario.database.prepare("SELECT count(*) AS count FROM dispatch_intents").get() as { count: number }).count,
      0
    );
  } finally {
    scenario.database.close();
    rmSync(scenario.directory, { recursive: true, force: true });
  }
});

test("injected uncertain boundaries require recovery and do not replay dispatch", async () => {
  for (const failureInjection of ["after_intent", "after_launch", "before_terminal_persist"] as const) {
    const scenario = runScenario("succeeded");
    try {
      const result = await executeLocalRun(scenario.database, {
        task: scenario.currentTask,
        action: action(),
        approval: null,
        workspace: workspace(),
        manifest,
        route,
        routeRequirements: requirements(),
        deadlineAt: "2099-01-01T00:00:00.000Z",
        adapter: adapter(scenario.terminalKind),
        failureInjection
      });
      assert.equal(result.status, "recovery_required");
      assert.equal(
        (scenario.database.prepare("SELECT count(*) AS count FROM dispatch_intents").get() as { count: number }).count,
        1
      );
      assert.equal(
        (scenario.database.prepare("SELECT outcome FROM attempts").get() as { outcome: string }).outcome,
        "inconclusive"
      );
    } finally {
      scenario.database.close();
      rmSync(scenario.directory, { recursive: true, force: true });
    }
  }
});

test("crash boundaries survive restart and block replay", async () => {
  for (const failureInjection of [
    "crash_after_intent",
    "crash_after_launch",
    "crash_before_terminal_persist"
  ] as const) {
    const scenario = runScenario("succeeded");
    const databasePath = join(scenario.directory, "execution.db");
    const fixture = adapter(scenario.terminalKind);
    try {
      await assert.rejects(
        executeLocalRun(scenario.database, {
          task: scenario.currentTask,
          action: action(),
          approval: null,
          workspace: workspace(),
          manifest,
          route,
          routeRequirements: requirements(),
          deadlineAt: "2099-01-01T00:00:00.000Z",
          adapter: fixture,
          failureInjection
        }),
        new RegExp(`Injected crash`)
      );
      const intentCount = (scenario.database.prepare(
        "SELECT count(*) AS count FROM dispatch_intents"
      ).get() as { count: number }).count;
      assert.equal(intentCount, 1);
      assert.equal(fixture.createRunCalls, failureInjection === "crash_after_intent" ? 0 : 1);
      scenario.database.close();

      const restarted = openDatabase(databasePath);
      try {
        const reconciled = new RunRepository(restarted).reconcileInterruptedRuns(
          "2026-01-01T00:02:00.000Z"
        );
        assert.equal(reconciled.length, 1);
        assert.equal(reconciled[0].state, "recovery_required");
        assert.equal(
          (restarted.prepare("SELECT outcome FROM attempts").get() as { outcome: string }).outcome,
          "disconnected"
        );
        assert.equal(
          (restarted.prepare("SELECT count(*) AS count FROM dispatch_intents").get() as { count: number }).count,
          1
        );
        assert.equal(
          new RunRepository(restarted).reconcileInterruptedRuns("2026-01-01T00:03:00.000Z").length,
          0
        );
        assert.equal(
          (restarted.prepare(
            "SELECT count(*) AS count FROM audit_events WHERE event_type = 'run.recovery_required'"
          ).get() as { count: number }).count,
          1
        );
      } finally {
        restarted.close();
      }
    } finally {
      if (scenario.database.open) scenario.database.close();
      rmSync(scenario.directory, { recursive: true, force: true });
    }
  }
});
