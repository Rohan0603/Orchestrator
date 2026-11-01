import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { openDatabase } from "../src/persistence/database";
import { createOrchestratorSdk } from "../src/sdk";
import type { TaskAssignment, WorkerMessage, WorkerMessageInput, WorkerRegistration } from "../src/sdk/contracts";

type Samples = Record<string, number[]>;

function timed<T>(samples: Samples, name: string, action: () => T): T {
  const start = performance.now();
  try { return action(); }
  finally { (samples[name] ??= []).push(performance.now() - start); }
}

function quantiles(values: readonly number[]): Record<string, number | null> {
  if (values.length === 0) return {count: 0, p50: null, p95: null, p99: null, p999: null, max: null};
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
  return {count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), p999: at(0.999), max: sorted.at(-1)!};
}

function numberList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const values = value.split(",").map((part) => Number(part.trim()));
  if (values.some((item) => !Number.isSafeInteger(item) || item < 1 || item > 1000)) {
    throw new Error("ORCHESTRATOR_BASELINE_WORKERS must contain comma-separated integers from 1 through 1000");
  }
  return [...new Set(values)];
}

function gitRevision(): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(); }
  catch { return null; }
}

function workingTree(): {dirty: boolean; paths: string[]; trackedDiffSha256: string | null; untrackedFiles: Record<string, string>} {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {encoding: "utf8"});
    const paths = status.split(/\r?\n/).filter(Boolean);
    const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {maxBuffer: 64 * 1024 * 1024});
    const untrackedPaths = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {encoding: "utf8"})
      .split(/\r?\n/).filter((file) => file && file !== "experiments/baselines/README.md");
    const untrackedFiles = Object.fromEntries(untrackedPaths.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
    return {dirty: paths.length > 0, paths, trackedDiffSha256: createHash("sha256").update(diff).digest("hex"), untrackedFiles};
  } catch { return {dirty: true, paths: ["git status unavailable"], trackedDiffSha256: null, untrackedFiles: {}}; }
}

test("TypeScript backend baseline benchmark preserves lifecycle correctness", {timeout: 600_000}, async () => {
  const workers = numberList(process.env.ORCHESTRATOR_BASELINE_WORKERS, [1, 10, 100]);
  const progressMessagesPerWorker = Number(process.env.ORCHESTRATOR_BASELINE_PROGRESS_MESSAGES ?? 3);
  assert.ok(Number.isSafeInteger(progressMessagesPerWorker) && progressMessagesPerWorker >= 1 && progressMessagesPerWorker <= 100);
  console.log(`ORC-34 benchmark starting logical worker scales: ${workers.join(",")}`);

  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
  const workspace = mkdtempSync(join(tmpdir(), "orchestrator-ts-baseline-"));
  const outputPath = resolve(process.env.ORCHESTRATOR_BASELINE_OUTPUT ?? join("experiments", "baselines", `ts-baseline-${runId}.json`));
  const results: Array<Record<string, unknown>> = [];

  try {
    for (const logicalWorkerCount of workers) {
      console.log(`ORC-34 benchmark preparing ${logicalWorkerCount} logical workers`);
      const eventLoopProbeStarted = performance.now();
      const eventLoopProbe = new Promise<number>((resolvePromise) => {
        setTimeout(() => resolvePromise(Math.max(0, performance.now() - eventLoopProbeStarted - 10)), 10);
      });
      const databasePath = join(workspace, `scale-${logicalWorkerCount}.db`);
      const database = openDatabase(databasePath);
      const sdk = createOrchestratorSdk(database, {
        maxActiveRuns: logicalWorkerCount,
        maxActiveRunsPerWorker: 1
      });
      const samples: Samples = {};
      const cpuBefore = process.cpuUsage();
      const memoryBefore = process.memoryUsage();
      const started = performance.now();
      const registrations: Array<{worker: WorkerRegistration; task: ReturnType<typeof sdk.createTask>}> = [];
      const assignments: TaskAssignment[] = [];
      let duplicateMessages = 0;

      try {
        const setupStarted = performance.now();
        for (let index = 0; index < logicalWorkerCount; index++) {
          const worker: WorkerRegistration = timed<WorkerRegistration>(samples, "register_worker_ms", () => sdk.registerWorker({name: `baseline-worker-${index}`}));
          const task = timed(samples, "create_task_ms", () => sdk.createTask({
            title: `Baseline task ${index}`,
            description: "Synthetic local workload for TypeScript backend migration baseline.",
            acceptanceCriteria: ["worker report reaches verification", "review request is consumed exactly once"],
            riskTier: 1
          }));
          registrations.push({worker, task});
        }
        const setupMs = performance.now() - setupStarted;
        console.log(`ORC-34 benchmark ${logicalWorkerCount}: setup complete (${setupMs.toFixed(1)} ms)`);

        const claimStarted = performance.now();
        for (const {worker} of registrations) {
          const assignment: TaskAssignment | null = timed<TaskAssignment | null>(samples, "claim_task_ms", () => sdk.claimTask(worker.id, 60_000));
          assert.ok(assignment, `worker ${worker.id} should claim one available task`);
          assignments.push(assignment);
        }
        const claimBatchMs = performance.now() - claimStarted;
        console.log(`ORC-34 benchmark ${logicalWorkerCount}: claims complete (${claimBatchMs.toFixed(1)} ms)`);

        const messageStarted = performance.now();
        for (let workerIndex = 0; workerIndex < registrations.length; workerIndex++) {
          const {worker} = registrations[workerIndex]!;
          const assignment = assignments[workerIndex]!;
          timed(samples, "heartbeat_ms", () => sdk.heartbeat(assignment.lease.leaseToken, 60_000));
          for (let index = 1; index <= progressMessagesPerWorker; index++) {
            const sequence = index + 1; // sequence 1 is the persisted orchestrator handoff.
            const key = `baseline:${assignment.run.id}:progress:${index}`;
            const input: WorkerMessageInput = {
              leaseToken: assignment.lease.leaseToken,
              kind: "progress" as const,
              sequence,
              payload: {text: `synthetic progress ${sequence}`, artifact: {id: `artifact-${workerIndex}-${sequence}`, sizeBytes: 32}},
              idempotencyKey: key
            };
            const first: WorkerMessage = timed<WorkerMessage>(samples, "progress_message_ms", () => sdk.sendWorkerMessage(worker.id, input));
            const duplicate: WorkerMessage = timed<WorkerMessage>(samples, "duplicate_progress_replay_ms", () => sdk.sendWorkerMessage(worker.id, input));
            assert.equal(duplicate.id, first.id, "idempotent duplicate must resolve to the original message");
            duplicateMessages++;
          }
        }
        const messageBatchMs = performance.now() - messageStarted;
        console.log(`ORC-34 benchmark ${logicalWorkerCount}: progress and duplicate replay complete (${messageBatchMs.toFixed(1)} ms)`);

        const reportStarted = performance.now();
        for (let index = 0; index < registrations.length; index++) {
          const {worker} = registrations[index]!;
          const assignment = assignments[index]!;
          timed(samples, "report_with_inline_review_delivery_ms", () => sdk.reportTask(worker.id, {
            leaseToken: assignment.lease.leaseToken,
            sequence: progressMessagesPerWorker + 2,
            outcome: "succeeded",
            summary: "Synthetic benchmark worker completed.",
            source: {adapterId: "orchestrator-ts-baseline-v1", sessionId: assignment.run.id},
            evidence: [{kind: "artifact", uri: `artifact://baseline/${assignment.run.id}`, contentHash: "a".repeat(64)}]
          }));
        }
        const reportBatchMs = performance.now() - reportStarted;
        console.log(`ORC-34 benchmark ${logicalWorkerCount}: reports complete (${reportBatchMs.toFixed(1)} ms)`);
        const elapsedMs = performance.now() - started;
        const eventLoopTimerDriftMs = await eventLoopProbe;
        const cpu = process.cpuUsage(cpuBefore);
        const memoryAfter = process.memoryUsage();
        const rows = {
          tasks: (database.prepare("SELECT count(*) AS count FROM tasks").get() as {count: number}).count,
          runsInVerification: (database.prepare("SELECT count(*) AS count FROM runs WHERE state='verification'").get() as {count: number}).count,
          progressRows: (database.prepare("SELECT count(*) AS count FROM worker_messages WHERE kind='progress'").get() as {count: number}).count,
          reportRows: (database.prepare("SELECT count(*) AS count FROM worker_messages WHERE kind='report'").get() as {count: number}).count,
          reviewRequests: (database.prepare("SELECT count(*) AS count FROM review_requests").get() as {count: number}).count,
          acknowledgedDeliveries: (database.prepare("SELECT count(*) AS count FROM message_deliveries WHERE status='acknowledged'").get() as {count: number}).count,
          pendingDeliveries: (database.prepare("SELECT count(*) AS count FROM message_deliveries WHERE status='pending'").get() as {count: number}).count,
          queueDepthAfterInlineDelivery: (database.prepare("SELECT count(*) AS count FROM message_deliveries WHERE status IN ('pending','claimed')").get() as {count: number}).count
        };
        console.log(`ORC-34 benchmark ${logicalWorkerCount}: correctness rows ${JSON.stringify(rows)}`);
        assert.deepEqual(rows, {
          tasks: logicalWorkerCount,
          runsInVerification: logicalWorkerCount,
          progressRows: logicalWorkerCount * progressMessagesPerWorker,
          reportRows: logicalWorkerCount,
          reviewRequests: logicalWorkerCount,
          acknowledgedDeliveries: logicalWorkerCount,
          pendingDeliveries: 0,
          queueDepthAfterInlineDelivery: 0
        }, "lifecycle and delivery correctness invariants must hold before timing is considered valid");

        results.push({
          logicalWorkers: logicalWorkerCount,
          workload: {
            control: "lease heartbeat",
            progressMessagesPerWorker,
            terminalReports: logicalWorkerCount,
            reviewRequestFanOut: "one review.requested per successful report",
            artifactReferences: true,
            duplicateProgressReplaysPerWorker: 1,
            externalWorkerProcesses: 0
          },
          phaseMilliseconds: {setup: setupMs, claimBatch: claimBatchMs, messageBatch: messageBatchMs, reportAndInlineReviewBatch: reportBatchMs, total: elapsedMs},
          eventLoopTimerDriftMs,
          operations: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {...quantiles(values), operationsPerSecondContribution: values.length / (elapsedMs / 1000)}])),
          throughput: {allMeasuredOperationsPerSecond: Object.values(samples).reduce((sum, values) => sum + values.length, 0) / (elapsedMs / 1000)},
          cpu: {userMilliseconds: cpu.user / 1000, systemMilliseconds: cpu.system / 1000},
          memoryBytes: {
            rssBefore: memoryBefore.rss, rssAfter: memoryAfter.rss,
            heapUsedBefore: memoryBefore.heapUsed, heapUsedAfter: memoryAfter.heapUsed,
            heapTotalBefore: memoryBefore.heapTotal, heapTotalAfter: memoryAfter.heapTotal
          },
          correctness: {...rows, duplicateReplaysResolvedToOriginal: duplicateMessages},
          databaseBytes: statSync(databasePath).size,
          instrumentationLimits: [
            "Database size is recorded; SQLite transaction-only latency is not isolated from SDK command latency.",
            "Queue depth is sampled after the synchronous report and delivery batch; peak transient depth is not sampled.",
            "Allocation counts are unavailable; before/after heap and RSS are observational and include runtime noise."
          ]
        });
      } finally {
        database.close();
      }
    }
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }

  const artifact = {
    schemaVersion: "orchestrator-ts-backend-baseline-v1",
    runId,
    sourceRevision: gitRevision(),
    workingTree: workingTree(),
    recordedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: process.platform === "win32" ? process.getSystemVersion() : process.version,
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem()
    },
    runtime: {node: process.versions.node, electron: process.versions.electron ?? null, v8: process.versions.v8},
    build: {mode: "compiled TypeScript source executed by Electron Node test runner", sqliteBinding: "better-sqlite3 under Electron ABI"},
    configuration: {logicalWorkerCounts: workers, progressMessagesPerWorker},
    eventLoopDelayMethod: "one 10 ms timer-drift probe per scale; a single sample per scale is not a p95/p99 distribution",
    scales: results,
    confidence: {
      repetitionsPerScale: 1,
      variance: "No repeat trials are included; this run does not estimate run-to-run variance.",
      quantiles: "Latency quantiles are empirical over operations in one run. For low operation counts (especially one worker), p95/p99/p99.9 reduce to one or a few observations and are not stable distribution estimates."
    },
    interpretation: "Synthetic in-process workload. Logical workers are SDK records, not 1/10/100/1000 external worker processes. Results are a local baseline only and do not establish production capacity or an SLA. Correctness assertions run before timing results are saved.",
    unmeasured: [
      "Electron renderer responsiveness under backend load (no renderer interaction in this SDK-only harness).",
      "Native process cancellation latency and cancellation storms (the current SDK does not expose a cancellation command).",
      "Provider disconnect behavior (no provider is called by this local fixture workload).",
      "Abrupt backend process termination and restart (database close/reopen/lease expiry fault harness is a separate qualification step).",
      "SQLite busy/locked contention and storage pressure fault workloads.",
      "Peak queue depth, isolated SQLite transaction latency, allocation counts, and recovery/reconciliation duration."
    ]
  };
  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {flag: "wx"});
  console.log(`ORC-34 raw benchmark evidence: ${outputPath}`);
});
