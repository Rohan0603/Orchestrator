import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import test from "node:test";
import Database from "better-sqlite3";
import { NativeOwnershipService, resolveHelperPath } from "../src/execution/native-ownership";
import { OpenAICompatibleAdapter } from "../src/harness/openai-compatible-adapter";
import { openDatabase } from "../src/persistence/database";
import { createOrchestratorSdk } from "../src/sdk";
import type { Task } from "../src/shared/domain";
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

async function runBaselineBenchmark(): Promise<void> {
  const workers = numberList(process.env.ORCHESTRATOR_BASELINE_WORKERS, [1, 10, 100]);
  const progressMessagesPerWorker = Number(process.env.ORCHESTRATOR_BASELINE_PROGRESS_MESSAGES ?? 3);
  assert.ok(Number.isSafeInteger(progressMessagesPerWorker) && progressMessagesPerWorker >= 1 && progressMessagesPerWorker <= 100);
  console.log(`ORC-34 benchmark starting logical worker scales: ${workers.join(",")}`);

  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
  const workspace = mkdtempSync(join(tmpdir(), "orchestrator-ts-baseline-"));
  const outputPath = resolve(process.env.ORCHESTRATOR_BASELINE_OUTPUT ?? join("experiments", "baselines", `ts-baseline-${runId}.json`));
  const results: Array<Record<string, unknown>> = [];
  let leaseExpiryRecovery: Record<string, unknown> | null = null;
  let providerDisconnect: Record<string, unknown> | null = null;
  let ownedProcessCancellation: Record<string, unknown> | null = null;
  let storagePressure: Record<string, unknown> | null = null;
  let sustainedLockContention: Record<string, unknown> | null = null;

  let workloadFailed = false;
  try {
    for (const logicalWorkerCount of workers) {
      console.log(`ORC-34 benchmark preparing ${logicalWorkerCount} logical workers`);
      const eventLoopDelay = monitorEventLoopDelay({resolution: 10});
      eventLoopDelay.enable();
      const eventLoopProbeStarted = performance.now();
      const eventLoopProbe = new Promise<number>((resolvePromise) => {
        setTimeout(() => resolvePromise(Math.max(0, performance.now() - eventLoopProbeStarted - 10)), 10);
      });
      const databaseInitializationStarted = performance.now();
      const databasePath = join(workspace, `scale-${logicalWorkerCount}.db`);
      const database = openDatabase(databasePath);
      const databaseInitializationMs = performance.now() - databaseInitializationStarted;
      const activeRunCapacity = Math.min(logicalWorkerCount, 100);
      const samples: Samples = {};
      const cpuBefore = process.cpuUsage();
      const memoryBefore = process.memoryUsage();
      const started = performance.now();
      const registrations: Array<{worker: WorkerRegistration; task: Task}> = [];
      const assignments: TaskAssignment[] = [];
      const resultIndex = results.length;
      let databaseClosed = false;
      let duplicateMessages = 0;

      try {
        const sdkInitializationStarted = performance.now();
        const sdk = createOrchestratorSdk(database, {
          maxActiveRuns: activeRunCapacity,
          maxActiveRunsPerWorker: 1
        });
        const sdkReadinessMs = performance.now() - sdkInitializationStarted;
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

        let claimBatchMs = 0;
        let messageBatchMs = 0;
        let reportBatchMs = 0;
        for (let offset = 0; offset < registrations.length; offset += activeRunCapacity) {
          const batch = registrations.slice(offset, offset + activeRunCapacity);
          console.log(`ORC-34 benchmark ${logicalWorkerCount}: processing logical workers ${offset + 1}-${offset + batch.length} with active capacity ${activeRunCapacity}`);
          const claimStarted = performance.now();
          const batchAssignments: TaskAssignment[] = [];
          for (const {worker} of batch) {
            const assignment: TaskAssignment | null = timed<TaskAssignment | null>(samples, "claim_task_ms", () => sdk.claimTask(worker.id, 60_000));
            assert.ok(assignment, `worker ${worker.id} should claim one available task`);
            assignments.push(assignment);
            batchAssignments.push(assignment);
          }
          claimBatchMs += performance.now() - claimStarted;

          const messageStarted = performance.now();
          for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
            const {worker} = batch[batchIndex]!;
            const assignment = batchAssignments[batchIndex]!;
            const workerIndex = offset + batchIndex;
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
          messageBatchMs += performance.now() - messageStarted;

          const reportStarted = performance.now();
          for (let index = 0; index < batch.length; index++) {
            const {worker} = batch[index]!;
            const assignment = batchAssignments[index]!;
            timed(samples, "report_with_inline_review_delivery_ms", () => sdk.reportTask(worker.id, {
              leaseToken: assignment.lease.leaseToken,
              sequence: progressMessagesPerWorker + 2,
              outcome: "succeeded",
              summary: "Synthetic benchmark worker completed.",
              source: {adapterId: "orchestrator-ts-baseline-v1", sessionId: assignment.run.id},
              evidence: [{kind: "artifact", uri: `artifact://baseline/${assignment.run.id}`, contentHash: "a".repeat(64)}]
            }));
          }
          reportBatchMs += performance.now() - reportStarted;
        }
        assert.equal(assignments.length, logicalWorkerCount);
        console.log(`ORC-34 benchmark ${logicalWorkerCount}: all ${Math.ceil(logicalWorkerCount / activeRunCapacity)} bounded claim/message/report batches complete`);
        const elapsedMs = performance.now() - started;
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

        const transactionDatabasePath = join(workspace, `transactions-${logicalWorkerCount}.db`);
        const transactionDatabaseInitializationStarted = performance.now();
        const transactionDatabase = openDatabase(transactionDatabasePath);
        const transactionDatabaseInitializationMs = performance.now() - transactionDatabaseInitializationStarted;
        const transactionSamples: number[] = [];
        let transactionDatabaseCloseMs = 0;
        let sqliteBusyWaitMs = 0;
        try {
          transactionDatabase.exec("CREATE TABLE baseline_transaction_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
          const insertProbe = transactionDatabase.prepare("INSERT INTO baseline_transaction_probe (value) VALUES (?)");
          const insertTransaction = transactionDatabase.transaction((value: string) => insertProbe.run(value)).immediate;
          const transactionSampleCount = Math.max(100, logicalWorkerCount);
          for (let index = 0; index < transactionSampleCount; index++) {
            const transactionStarted = performance.now();
            insertTransaction(`sample-${index}`);
            transactionSamples.push(performance.now() - transactionStarted);
          }

          const contender = new Database(transactionDatabasePath, {timeout: 10});
          const lockOwner = new Database(transactionDatabasePath, {timeout: 10});
          try {
            lockOwner.exec("BEGIN IMMEDIATE");
            const busyStarted = performance.now();
            let busyCode: string | null = null;
            try {
              contender.prepare("INSERT INTO baseline_transaction_probe (value) VALUES (?)").run("contended");
            } catch (error) {
              busyCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
            }
            sqliteBusyWaitMs = performance.now() - busyStarted;
            assert.equal(busyCode, "SQLITE_BUSY", "contending writer must fail explicitly while another writer owns the immediate transaction");
            lockOwner.exec("ROLLBACK");
            const retryStarted = performance.now();
            assert.equal(contender.prepare("INSERT INTO baseline_transaction_probe (value) VALUES (?)").run("retry-after-unlock").changes, 1);
            samples.sqlite_busy_recovery_retry_ms = [performance.now() - retryStarted];
          } finally {
            if (lockOwner.inTransaction) lockOwner.exec("ROLLBACK");
            lockOwner.close();
            contender.close();
          }
        } finally {
          const transactionCloseStarted = performance.now();
          transactionDatabase.close();
          transactionDatabaseCloseMs = performance.now() - transactionCloseStarted;
        }
        const transactionDatabaseBytes = statSync(transactionDatabasePath).size;
        const transactionLatency = quantiles(transactionSamples);
        assert.equal(transactionSamples.length, Math.max(100, logicalWorkerCount));

        const eventLoopTimerDriftMs = await eventLoopProbe;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
        eventLoopDelay.disable();
        const eventLoopDelayMs = {
          sampleCount: eventLoopDelay.count,
          min: eventLoopDelay.count > 0 ? eventLoopDelay.min / 1e6 : null,
          p50: eventLoopDelay.count > 0 ? eventLoopDelay.percentile(50) / 1e6 : null,
          p95: eventLoopDelay.count > 0 ? eventLoopDelay.percentile(95) / 1e6 : null,
          p99: eventLoopDelay.count > 0 ? eventLoopDelay.percentile(99) / 1e6 : null,
          p999: eventLoopDelay.count > 0 ? eventLoopDelay.percentile(99.9) / 1e6 : null,
          max: eventLoopDelay.count > 0 ? eventLoopDelay.max / 1e6 : null,
          samplingResolutionMs: 10
        };

        results.push({
          logicalWorkers: logicalWorkerCount,
          workload: {
            maximumActiveRuns: activeRunCapacity,
            executionBatches: Math.ceil(logicalWorkerCount / activeRunCapacity),
            control: "lease heartbeat",
            progressMessagesPerWorker,
            terminalReports: logicalWorkerCount,
            reviewRequestFanOut: "one review.requested per successful report",
            artifactReferences: true,
            duplicateProgressReplaysPerWorker: 1,
            externalWorkerProcesses: 0
          },
          readiness: {databaseInitializationMs, sdkReadinessMs},
          phaseMilliseconds: {setup: setupMs, claimBatch: claimBatchMs, messageBatch: messageBatchMs, reportAndInlineReviewBatch: reportBatchMs, total: elapsedMs},
          eventLoopDelayMilliseconds: eventLoopDelayMs,
          eventLoopTimerDriftMs,
          sqlite: {
            isolatedImmediateTransactionSamples: transactionSamples.length,
            transactionLatencyMilliseconds: transactionLatency,
            transactionDatabaseInitializationMs,
            transactionDatabaseCloseMs,
            transactionDatabaseBytes,
            busyTimeoutMs: 10,
            busyLockWaitMs: sqliteBusyWaitMs,
            busyErrors: 1,
            retriesAfterUnlock: 1
          },
          operations: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {...quantiles(values), operationsPerSecondContribution: values.length / (elapsedMs / 1000)}])),
          throughput: {allMeasuredOperationsPerSecond: Object.values(samples).reduce((sum, values) => sum + values.length, 0) / (elapsedMs / 1000)},
          cpu: {userMilliseconds: cpu.user / 1000, systemMilliseconds: cpu.system / 1000},
          memoryBytes: {
            rssBefore: memoryBefore.rss, rssAfter: memoryAfter.rss,
            heapUsedBefore: memoryBefore.heapUsed, heapUsedAfter: memoryAfter.heapUsed,
            heapTotalBefore: memoryBefore.heapTotal, heapTotalAfter: memoryAfter.heapTotal
          },
          correctness: {...rows, duplicateReplaysResolvedToOriginal: duplicateMessages},
          databaseBytes: 0,
          databaseCloseMs: 0,
          databaseWalBytesAfterClose: 0,
          instrumentationLimits: [
            "SQLite lock contention is one 10 ms busy-timeout conflict and one successful retry; it does not model sustained multi-connection lock or storage pressure.",
            "Queue depth is sampled after the synchronous report and delivery batch; peak transient depth is not sampled.",
            "Allocation counts are unavailable; before/after heap and RSS are observational and include runtime noise."
          ]
        });
      } finally {
        if (!databaseClosed) {
          const closeStarted = performance.now();
          database.close();
          databaseClosed = true;
          const latestResult = results[resultIndex];
          if (latestResult) {
            latestResult.databaseCloseMs = performance.now() - closeStarted;
            latestResult.databaseBytes = statSync(databasePath).size;
            const walPath = `${databasePath}-wal`;
            latestResult.databaseWalBytesAfterClose = existsSync(walPath) ? statSync(walPath).size : 0;
          }
        }
        eventLoopDelay.disable();
      }
    }

    // Close/reopen the SQLite-backed SDK around an abandoned lease to measure
    // restart reconciliation. This is deliberately a clean close/reopen probe,
    // not evidence of abrupt OS-process crash behavior.
    {
      const databasePath = join(workspace, "lease-recovery.db");
      const firstDatabase = openDatabase(databasePath);
      const firstSdk = createOrchestratorSdk(firstDatabase, {maxActiveRuns: 1, maxActiveRunsPerWorker: 1});
      const worker = firstSdk.registerWorker({name: "baseline-recovery-worker"});
      const task = firstSdk.createTask({
        title: "Baseline expired-lease recovery",
        description: "Synthetic abandoned lease used to measure recovery after SQLite reopen.",
        acceptanceCriteria: ["expired execution is marked recovery-required", "claim is not replayed automatically"],
        riskTier: 1
      });
      const assignment = firstSdk.claimTask(worker.id, 5);
      assert.ok(assignment, "recovery probe worker should claim its task");
      const abandonedRunId = assignment.run.id;
      firstDatabase.close();

      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 15));
      const restartStarted = performance.now();
      const reopenedDatabase = openDatabase(databasePath);
      const databaseReopenMs = performance.now() - restartStarted;
      try {
        const sdkInitializationStarted = performance.now();
        const reopenedSdk = createOrchestratorSdk(reopenedDatabase, {maxActiveRuns: 1, maxActiveRunsPerWorker: 1});
        const sdkInitializationMs = performance.now() - sdkInitializationStarted;
        const recoveryWorker = reopenedSdk.registerWorker({name: "baseline-recovery-worker-after-reopen"});
        const recoveryStarted = performance.now();
        const replacement = reopenedSdk.claimTask(recoveryWorker.id, 60_000);
        const recoveryDurationMs = performance.now() - recoveryStarted;
        assert.equal(replacement, null, "unknown expired execution must not be automatically replayed");
        const recoveredRun = reopenedDatabase.prepare("SELECT state,recovery_state FROM runs WHERE id=?").get(abandonedRunId) as {state: string; recovery_state: string} | undefined;
        const recoveryRecord = reopenedDatabase.prepare("SELECT state FROM recovery WHERE run_id=?").get(abandonedRunId) as {state: string} | undefined;
        assert.deepEqual(recoveredRun, {state: "recovery_required", recovery_state: "recovery_required"});
        assert.deepEqual(recoveryRecord, {state: "recovery_required"});
        assert.equal((reopenedDatabase.prepare("SELECT count(*) AS count FROM runs WHERE task_id=?").get(task.id) as {count: number}).count, 1,
          "reconciliation must not create a replacement run");
        leaseExpiryRecovery = {
          scenario: "SQLite close/reopen with an expired worker lease",
          simulatedBackendRestart: true,
          abruptProcessCrash: false,
          abandonedRunId,
          databaseReopenMs,
          sdkInitializationMs,
          recoveryDurationMs,
          correctness: {runState: recoveredRun.state, recoveryState: recoveredRun.recovery_state, recoveryRecordState: recoveryRecord.state, automaticReplacement: replacement !== null}
        };
      } finally {
        reopenedDatabase.close();
      }
    }

    // Simulate a provider transport dropping after streaming starts. The fake
    // fetch never opens a socket or contacts a real endpoint.
    {
      const database = openDatabase(join(workspace, "provider-disconnect.db"));
      const sdk = createOrchestratorSdk(database);
      const task = sdk.createTask({
        title: "Baseline provider disconnect",
        description: "Synthetic provider stream interruption for baseline fault measurement.",
        acceptanceCriteria: ["interrupted provider execution cannot be accepted"],
        riskTier: 1
      });
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "synthetic-baseline-key",
        model: "baseline-disconnect",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: {get: () => null},
          body: {
            getReader: () => {
              let firstRead = true;
              return {
                read: async () => {
                  if (firstRead) {
                    firstRead = false;
                    return {done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial plan"}}]}\n\n')};
                  }
                  throw new Error("Synthetic provider stream disconnect");
                }
              };
            }
          }
        } as unknown as Response)
      });
      try {
        const started = performance.now();
        const events = [];
        for await (const event of sdk.streamTask(task.id, adapter)) events.push(event);
        const completionMs = performance.now() - started;
        const completed = events.find((event) => event.kind === "completed");
        assert.equal(completed?.kind, "completed");
        assert.equal(completed.outcome, "failed", "provider disconnect must remain a failed execution, not acceptance");
        const storedRun = database.prepare("SELECT state FROM runs WHERE task_id=?").get(task.id) as {state: string} | undefined;
        assert.deepEqual(storedRun, {state: "rejected"});
        assert.equal((database.prepare("SELECT count(*) AS count FROM acceptance_decisions").get() as {count: number}).count, 0);
        providerDisconnect = {
          scenario: "synthetic provider stream disconnect after partial content",
          realNetworkUsed: false,
          completionMs,
          emittedEvents: events.map((event) => event.kind),
          correctness: {runState: storedRun.state, outcome: completed.outcome, acceptanceDecisions: 0}
        };
      } finally {
        await adapter.close();
        database.close();
      }
    }

    if (process.platform === "win32") {
      const helperPath = resolveHelperPath(process.cwd(), false, "");
      if (existsSync(helperPath)) {
        const fixtureDirectory = join(workspace, "owned-cancellation");
        mkdirSync(fixtureDirectory, {recursive: true});
        const service = new NativeOwnershipService(helperPath);
        const correlation = {runId: "baseline-cancel-run", attemptId: "baseline-cancel-attempt", nonce: runId};
        try {
          await service.start();
          await service.launchFixture(fixtureDirectory, correlation);
          const markerNames = ["worker.started", "child.started", "grandchild.started"];
          const markerDeadline = Date.now() + 2000;
          while (markerNames.some((name) => !existsSync(join(fixtureDirectory, name))) && Date.now() < markerDeadline) {
            await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
          }
          assert.ok(markerNames.every((name) => existsSync(join(fixtureDirectory, name))), "owned process tree should be running before cancellation");
          const cancellationStarted = performance.now();
          const cancellation = await service.cancel(correlation);
          const cancellationLatencyMs = performance.now() - cancellationStarted;
          assert.equal(cancellation.cleanupVerified, true);
          assert.equal(cancellation.activeProcessesAfterCleanup, 0);
          ownedProcessCancellation = {
            scenario: "native Windows Job Object cancellation of one worker process tree",
            cancellationLatencyMs,
            verifiedCleanup: cancellation.cleanupVerified,
            activeProcessesAfterCleanup: cancellation.activeProcessesAfterCleanup,
            observedProcessesBeforeCancellation: markerNames.length,
            cancellationStorm: false
          };
        } finally {
          await service.close();
        }
      }
    }

    // Bound a throwaway SQLite database and fill it until SQLite reports
    // SQLITE_FULL. The benchmark database and product data are not involved.
    {
      const databasePath = join(workspace, "storage-pressure.db");
      const database = openDatabase(databasePath);
      try {
        database.exec("CREATE TABLE baseline_storage_pressure (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
        const startPageCount = Number((database.pragma("page_count", {simple: true}) as number));
        const pageLimit = startPageCount + 8;
        database.pragma(`max_page_count = ${pageLimit}`);
        const effectivePageLimit = Number((database.pragma("max_page_count", {simple: true}) as number));
        assert.equal(effectivePageLimit, pageLimit, "SQLite should apply the disposable database page cap");
        const insert = database.prepare("INSERT INTO baseline_storage_pressure (payload) VALUES (?)");
        let committedRows = 0;
        let fullErrorCode: string | null = null;
        const pressureStarted = performance.now();
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            database.transaction(() => insert.run(Buffer.alloc(16 * 1024, 0x5a))).immediate();
            committedRows++;
          } catch (error) {
            fullErrorCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
            break;
          }
        }
        const pressureDurationMs = performance.now() - pressureStarted;
        assert.ok(committedRows > 0, "storage pressure should allow writes before reaching the cap");
        assert.equal(fullErrorCode, "SQLITE_FULL", "bounded database should fail explicitly when the page limit is reached");
        const integrity = (database.pragma("integrity_check", {simple: true}) as string);
        assert.equal(integrity, "ok", "failed full-database write must not corrupt the disposable database");
        storagePressure = {
          scenario: "disposable SQLite database capped at eight pages above schema size",
          pageSizeBytes: Number(database.pragma("page_size", {simple: true})),
          startPageCount,
          pageLimit: effectivePageLimit,
          committedRows,
          attemptedPayloadBytes: committedRows * 16 * 1024,
          fullErrorCode,
          pressureDurationMs,
          integrity
        };
      } finally {
        database.close();
      }
    }

    // Hold a write lock while a second connection exhausts a bounded series of
    // busy timeouts, then verify the same writer can commit after release.
    {
      const databasePath = join(workspace, "sustained-lock-contention.db");
      const database = openDatabase(databasePath);
      const lockOwner = new Database(databasePath, {timeout: 10});
      const contender = new Database(databasePath, {timeout: 10});
      const conflicts: number[] = [];
      try {
        database.exec("CREATE TABLE baseline_contention_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        const insert = contender.prepare("INSERT INTO baseline_contention_probe (value) VALUES (?)");
        lockOwner.exec("BEGIN IMMEDIATE");
        for (let attempt = 0; attempt < 10; attempt++) {
          const conflictStarted = performance.now();
          let errorCode: string | null = null;
          try {
            contender.transaction(() => insert.run(`blocked-${attempt}`)).immediate();
          } catch (error) {
            errorCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
          }
          conflicts.push(performance.now() - conflictStarted);
          assert.equal(errorCode, "SQLITE_BUSY", `contender attempt ${attempt + 1} should fail explicitly while lock is held`);
        }
        assert.equal((database.prepare("SELECT count(*) AS count FROM baseline_contention_probe").get() as {count: number}).count, 0,
          "busy attempts must not partially commit rows");
        lockOwner.exec("ROLLBACK");
        const retryStarted = performance.now();
        assert.equal(contender.transaction(() => insert.run("retry-after-contention")).immediate().changes, 1);
        const retryAfterContentionMs = performance.now() - retryStarted;
        const committedRows = (database.prepare("SELECT count(*) AS count FROM baseline_contention_probe").get() as {count: number}).count;
        assert.equal(committedRows, 1, "only the explicit post-unlock retry should commit");
        sustainedLockContention = {
          scenario: "ten SQLite writer timeouts while one connection holds BEGIN IMMEDIATE",
          busyTimeoutMs: 10,
          contentionAttempts: conflicts.length,
          conflictWaitMs: quantiles(conflicts),
          retryAfterContentionMs,
          busyErrors: conflicts.length,
          committedRows,
          correctness: "all contended transactions rolled back; one explicit retry committed after lock release"
        };
      } finally {
        if (lockOwner.inTransaction) lockOwner.exec("ROLLBACK");
        contender.close();
        lockOwner.close();
        database.close();
      }
    }
  } catch (error) {
    workloadFailed = true;
    throw error;
  } finally {
    try {
      rmSync(workspace, {recursive: true, force: true});
    } catch (cleanupError) {
      console.error("ORC-34 temporary workspace cleanup failed:", cleanupError);
      if (!workloadFailed) throw cleanupError;
    }
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
    eventLoopDelayMethod: "Node perf_hooks.monitorEventLoopDelay with 10 ms resolution plus one 10 ms timer-drift probe per scale; histogram percentiles and timer drift are descriptive single-run observations, not cross-run confidence intervals",
    scales: results,
    recovery: leaseExpiryRecovery,
    providerDisconnect,
    ownedProcessCancellation,
    storagePressure,
    sustainedLockContention,
    confidence: {
      repetitionsPerScale: 1,
      variance: "No repeat trials are included; this run does not estimate run-to-run variance.",
      quantiles: "Latency quantiles are empirical over operations in one run. For low operation counts (especially one worker), p95/p99/p99.9 reduce to one or a few observations and are not stable distribution estimates."
    },
    interpretation: "Synthetic in-process workload. Logical workers are SDK records, not 1/10/100/1000 external worker processes. The current SDK caps active runs at 100, so larger scales are executed in bounded claim/message/report batches rather than pretending all logical workers are concurrently active. Results are a local baseline only and do not establish production capacity or an SLA. Correctness assertions run before timing results are saved.",
    unmeasured: [
      "Electron renderer responsiveness under backend load (no renderer interaction in this SDK-only harness).",
      "Cancellation storms and SDK-wide cancellation (one native worker process tree is measured; concurrent cancellation stress is not).",
      "Live external provider disconnect/reconnect behavior; only an injected synthetic mid-stream disconnect is measured, with no network call.",
      "Abrupt backend process termination/restart and recovery duration (this is not a process-level crash harness).",
      "OS-level disk-full behavior and extended SQLite lock contention beyond ten bounded conflicts; storage pressure and ten 10 ms lock timeouts use disposable database simulations.",
      "Peak queue depth and allocation counts; database initialization, SDK construction, and database close are measured, but full Electron readiness is not."
    ]
  };
  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {flag: "wx"});
  console.log(`ORC-34 raw benchmark evidence: ${outputPath}`);
}

test("TypeScript backend baseline benchmark preserves lifecycle correctness", {timeout: 600_000}, async () => {
  try {
    await runBaselineBenchmark();
  } catch (error) {
    console.error("ORC-34 benchmark failed before retaining evidence:", error);
    throw error;
  }
});
