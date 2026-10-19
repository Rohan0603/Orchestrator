import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/database";
import { TaskRepository } from "../src/persistence/task-repository";
import { RunRepository } from "../src/persistence/run-repository";
import {
  NativeOwnershipCoordinator,
  NativeOwnershipService,
  resolveHelperPath,
  validateOwnershipStatusResponse
} from "../src/execution/native-ownership";

function helperPath(): string {
  return resolveHelperPath(process.cwd(), false, "");
}

test("native ownership rejects unknown process counts", () => {
  assert.throws(
    () =>
      validateOwnershipStatusResponse(
        {
          status: "idle",
          runId: "run",
          attemptId: "attempt",
          nonce: "nonce",
          activeProcessesKnown: false,
          activeProcesses: undefined,
          outputDrained: true,
          workerPid: 123,
          workerCreationTime: "creation-time",
          exitCode: 0
        },
        { runId: "run", attemptId: "attempt", nonce: "nonce" }
      ),
    /Native ownership status is unverified/
  );
});

test("native ownership service verifies helper identity and owned cleanup", async (t) => {
  const executable = helperPath();
  if (!existsSync(executable)) {
    t.skip("native helper is not built");
    return;
  }
  const uncertain: string[] = [];
  const service = new NativeOwnershipService(executable, (reason) => uncertain.push(reason));
  try {
    const identity = await service.start();
    assert.ok(identity.helperPid > 0);
    assert.ok(identity.helperCreationTime.length > 0);
    const correlation = {
      runId: "run-native-test",
      attemptId: "attempt-native-test",
      nonce: "nonce-native-test"
    };
    const launched = await service.launch(path.resolve(executable), correlation);
    assert.equal(launched.ownershipVerified, true);
    const cancellation = await service.cancel(correlation);
    assert.equal(cancellation.cleanupVerified, true);
    assert.deepEqual(uncertain, []);
  } finally {
    await service.close();
  }
});

test("ownership coordinator persists identity and verified cleanup", async (t) => {
  const executable = helperPath();
  if (!existsSync(executable)) {
    t.skip("native helper is not built");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-ownership-"));
  const database = openDatabase(join(directory, "ownership.db"));
  const task = new TaskRepository(database).create({
    title: "Ownership test",
    description: "Test helper persistence",
    acceptanceCriteria: ["cleanup"],
    riskTier: 1
  });
  const created = new RunRepository(database).createRun(task.id, "native-test");
  const runs = new RunRepository(database);
  const coordinator = new NativeOwnershipCoordinator(runs, created.run.id, created.attempt.id, executable);
  try {
    await coordinator.launch(path.resolve(executable));
    assert.equal(runs.ownershipForRun(created.run.id)?.state, "running");
    await coordinator.cancel();
    assert.equal(runs.ownershipForRun(created.run.id)?.cleanupVerified, true);
  } finally {
    await coordinator.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("helper owner loss records uncertainty and does not claim cleanup", async (t) => {
  const executable = helperPath();
  if (!existsSync(executable)) {
    t.skip("native helper is not built");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "orchestrator-owner-loss-"));
  const database = openDatabase(join(directory, "owner-loss.db"));
  let databaseClosed = false;
  const task = new TaskRepository(database).create({
    title: "Owner loss test",
    description: "Crash helper after ownership starts",
    acceptanceCriteria: ["uncertainty"],
    riskTier: 1
  });
  const created = new RunRepository(database).createRun(task.id, "native-test");
  const runs = new RunRepository(database);
  runs.transition(created.run.id, "ready", "none");
  runs.transition(created.run.id, "running", "none");
  const coordinator = new NativeOwnershipCoordinator(runs, created.run.id, created.attempt.id, executable);
  try {
    await coordinator.launchFixture(directory);
    const markerDeadline = Date.now() + 2000;
    while (
      (!existsSync(join(directory, "worker.started")) ||
        !existsSync(join(directory, "child.started")) ||
        !existsSync(join(directory, "grandchild.started"))) &&
      Date.now() < markerDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const fixturePids = ["worker", "child", "grandchild"].map((name) =>
      Number.parseInt(readFileSync(join(directory, `${name}.started`), "utf8").trim(), 10)
    );
    assert.ok(fixturePids.every((pid) => Number.isInteger(pid) && pid > 0));
    const identity = runs.ownershipForRun(created.run.id);
    assert.ok(identity?.helperPid);
    const helper = process.kill.bind(process);
    helper(identity.helperPid!, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of fixturePids) {
      assert.throws(() => process.kill(pid, 0));
    }
    await assert.rejects(() => coordinator.status(), /Helper channel is unavailable|Native ownership/);
    assert.equal(runs.ownershipForRun(created.run.id)?.state, "uncertain");
    assert.equal(runs.ownershipForRun(created.run.id)?.cleanupVerified, false);
    try {
      process.kill(identity.helperPid!, "SIGKILL");
    } catch {
      // Helper may already have exited after the verified owner-loss boundary.
    }
    await coordinator.close();
    database.close();
    databaseClosed = true;
    const reopened = openDatabase(join(directory, "owner-loss.db"));
    try {
      const reconciled = new RunRepository(reopened).reconcileInterruptedRuns(new Date().toISOString());
      assert.equal(reconciled[0]?.state, "recovery_required");
      assert.equal(new RunRepository(reopened).ownershipForRun(created.run.id)?.cleanupVerified, false);
    } finally {
      reopened.close();
    }
  } finally {
    await coordinator.close();
    if (!databaseClosed) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ownership service fails closed for missing helper and duplicate ownership", async (t) => {
  const executable = helperPath();
  if (!existsSync(executable)) {
    t.skip("native helper is not built");
    return;
  }
  await assert.rejects(
    () => new NativeOwnershipService(path.join(path.dirname(executable), "missing-helper.exe")).start(),
    /helper is missing/
  );
  const service = new NativeOwnershipService(executable);
  const correlation = { runId: "duplicate-run", attemptId: "duplicate-attempt", nonce: "duplicate-nonce" };
  try {
    await service.launch(executable, correlation);
    await assert.rejects(
      () => service.launch(executable, { ...correlation, runId: "second-run" }),
      /already owns a run/
    );
    await service.cancel(correlation);
  } finally {
    await service.close();
  }
});

test("native ownership validates and transports a generic owned process", async (t) => {
  const executable = helperPath();
  if (!existsSync(executable)) {
    t.skip("native helper is not built");
    return;
  }
  const output: string[] = [];
  const service = new NativeOwnershipService(executable, undefined, (event) => {
    if (event.stream === "stdout") output.push(event.data);
  });
  const correlation = {
    runId: "generic-run",
    attemptId: "generic-attempt",
    nonce: "generic-nonce"
  };
  try {
    await service.launchProcess(
      {
        executable: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        arguments: ["/d", "/c", "echo", "protocol-output"],
        workingDirectory: process.cwd(),
        environment: {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
        }
      },
      correlation
    );
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("owned output was not observed")), 2000);
      const check = () => {
        if (output.join("").includes("protocol-output")) {
          clearTimeout(deadline);
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
    assert.equal((await service.cancel(correlation)).cleanupVerified, true);
  } finally {
    await service.close();
  }
});

test("worker stdout cannot forge helper protocol responses", async (t) => {
  const helper = helperPath();
  if (!existsSync(helper)) {
    t.skip("native helper is not built");
    return;
  }
  const output: string[] = [];
  const service = new NativeOwnershipService(helper, undefined, (event) => {
    if (event.stream === "stdout") output.push(event.data);
  });
  const correlation = { runId: "forgery-run", attemptId: "forgery-attempt", nonce: "forgery-nonce" };
  const forged = "FORGED_HELPER_RESPONSE";
  try {
    await service.launchProcess(
      {
        executable: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        arguments: ["/d", "/c", "echo", forged],
        workingDirectory: process.cwd(),
        environment: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
      },
      correlation
    );
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("forged output was not observed")), 2000);
      const check = () => {
        if (output.join("").includes(forged)) {
          clearTimeout(deadline);
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
    assert.equal((await service.cancel(correlation)).cleanupVerified, true);
  } finally {
    await service.close();
  }
});

test("native ownership rejects unsafe process specifications before helper launch", async (t) => {
  const executable = helperPath();
  if (!existsSync(executable)) {
    t.skip("native helper is not built");
    return;
  }
  const service = new NativeOwnershipService(executable);
  try {
    await assert.rejects(
      () => service.launchProcess(
        {
          executable: "relative.exe",
          arguments: [],
          workingDirectory: process.cwd(),
          environment: {}
        },
        { runId: "invalid", attemptId: "invalid", nonce: "invalid" }
      ),
      /launch specification is invalid/
    );
    await assert.rejects(
      () => service.launchProcess(
        {
          executable,
          arguments: ["x".repeat(8193)],
          workingDirectory: process.cwd(),
          environment: {}
        },
        { runId: "invalid", attemptId: "invalid", nonce: "invalid" }
      ),
      /launch specification is invalid/
    );
  } finally {
    await service.close();
  }
});

test("native ownership reports provider exit status before cleanup", async (t) => {
  const helper = helperPath();
  if (!existsSync(helper)) {
    t.skip("native helper is not built");
    return;
  }
  const service = new NativeOwnershipService(helper);
  const correlation = { runId: "exit-run", attemptId: "exit-attempt", nonce: "exit-nonce" };
  try {
    await service.launchProcess(
      {
        executable: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        arguments: ["/d", "/c", "exit", "7"],
        workingDirectory: process.cwd(),
        environment: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
      },
      correlation
    );
    let status = await service.status(correlation);
    const deadline = Date.now() + 2000;
    while (status.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await service.status(correlation);
    }
    assert.equal(status.running, false);
    assert.equal(status.exitCode, 7);
    assert.equal(status.outputDrained, true);
    await service.cancel(correlation);
  } finally {
    await service.close();
  }
});

test("native ownership reattaches after helper disconnect with identity checks", async (t) => {
  const helper = helperPath();
  if (!existsSync(helper)) {
    t.skip("native helper is not built");
    return;
  }
  const helperProcess = spawn(helper, [], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true
  });
  let pending = "";
  const responses = new Map<string, (value: Record<string, unknown>) => void>();
  helperProcess.stdout.setEncoding("utf8");
  helperProcess.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        const response = JSON.parse(line) as Record<string, unknown>;
        const id = response.id;
        if (typeof id === "string") responses.get(id)?.(response);
      }
      newline = pending.indexOf("\n");
    }
  });
  const request = (operation: string, fields: Record<string, string> = {}) => {
    const id = `${operation}-${Math.random()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        responses.delete(id);
        reject(new Error(`helper ${operation} timed out`));
      }, 5000);
      responses.set(id, (value) => {
        clearTimeout(timer);
        responses.delete(id);
        resolve(value);
      });
      helperProcess.stdin.write(`${JSON.stringify({
        version: "orchestrator-job-v1",
        id,
        operation,
        ...fields
      })}\n`);
    });
  };
  const correlation = {
    runId: "restart-run",
    attemptId: "restart-attempt",
    nonce: "restart-nonce"
  };
  let workerPid = 0;
  let workerCreationTime = "";
  const unrelated = spawn(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "ping.exe"),
    ["-n", "30", "127.0.0.1"],
    { stdio: "ignore", windowsHide: true }
  );
  try {
    await request("handshake");
    const launched = await request("launch", {
      executable: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "ping.exe"),
      arguments: JSON.stringify(["-n", "30", "127.0.0.1"]),
      workingDirectory: process.cwd(),
      environment: JSON.stringify({ SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }),
      ...correlation
    });
    workerPid = Number(launched.workerPid);
    workerCreationTime = String(launched.workerCreationTime);
    assert.equal(launched.ownershipVerified, true);
    helperProcess.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const service = new NativeOwnershipService(helper);
    try {
      await assert.rejects(
        () => service.reconcile(correlation, workerPid, "wrong-creation-time"),
        /ownership_reconciliation_unverified|Native ownership/
      );
    } finally {
      await service.close();
    }

    const recovered = new NativeOwnershipService(helper);
    try {
      const status = await recovered.reconcile(correlation, workerPid, workerCreationTime);
      assert.equal(status.running, true);
      assert.ok(status.activeProcesses >= 1);
      const cleanup = await recovered.cancel(correlation);
      assert.equal(cleanup.cleanupVerified, true);
      assert.equal(unrelated.exitCode, null);
    } finally {
      await recovered.close();
    }
  } catch (error) {
    console.error("Restart recovery test failed", error);
    throw error;
  } finally {
    if (!helperProcess.killed) helperProcess.kill();
    if (unrelated.exitCode === null) unrelated.kill();
  }
});
