import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const executable = join(repositoryRoot, "target", "debug", process.platform === "win32" ? "orchestrator-core.exe" : "orchestrator-core");

function parseJsonLogLines(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function getEventName(record) {
  return record.event ?? record.fields?.event;
}

function encodeIpcFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function createIpcFrameReader(stream) {
  let buffered = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  let ended = false;
  let failure;
  stream.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length < 1 || length > 1024 * 1024) {
        failure = new Error(`invalid frame length ${length}`);
        break;
      }
      if (buffered.length < length + 4) break;
      frames.push(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(buffered.subarray(4, length + 4))));
      buffered = buffered.subarray(length + 4);
    }
    drain();
  });
  stream.on("end", () => { ended = true; drain(); });
  stream.on("error", (error) => { failure = error; drain(); });

  function drain() {
    while (waiters.length > 0 && (frames.length > 0 || failure || ended)) {
      const waiter = waiters.shift();
      if (frames.length > 0) waiter.resolve(frames.shift());
      else waiter.reject(failure ?? new Error("stdout ended before another frame"));
    }
  }

  return {
    next(timeoutMs = 1000) {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      if (failure || ended) return Promise.reject(failure ?? new Error("stdout ended before another frame"));
      return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectPromise(new Error("timed out waiting for protocol frame"));
        }, timeoutMs);
        const waiter = {
          resolve(value) { clearTimeout(timeout); resolvePromise(value); },
          reject(error) { clearTimeout(timeout); rejectPromise(error); }
        };
        waiters.push(waiter);
      });
    }
  };
}

function hello(requiredCapabilities = ["system.health", "capabilities.list"]) {
  return {
    protocolVersion: 1,
    kind: "hello",
    messageId: "hello-ipc-1",
    correlationId: "startup-ipc-1",
    causationId: null,
    sender: {id: "typescript-client", role: "client"},
    minimumProtocol: 1,
    maximumProtocol: 1,
    clientVersion: "0.1.0",
    schemaVersion: 1,
    requiredCapabilities
  };
}

function request(messageId, method, payload = {}) {
  return {
    protocolVersion: 1,
    kind: "request",
    messageId,
    correlationId: `correlation-${messageId}`,
    causationId: null,
    sender: {id: "typescript-client", role: "client"},
    method,
    payload
  };
}

function spawnCore(args = ["serve"]) {
  const child = spawn(executable, args, {cwd: repositoryRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
  const reader = createIpcFrameReader(child.stdout);
  return {child, reader};
}

test("Rust core rejects a missing database without creating it or reporting ready", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-rust-db-missing-"));
  const databasePath = join(directory, "missing.sqlite");
  const {child} = spawnCore(["serve", "--database", databasePath]);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const [exitCode, signal] = await waitForChildClose(child);
    assert.equal(signal, null);
    assert.equal(exitCode, 2);
    assert.equal(stdout, "", "validation failure must happen before a protocol welcome");
    assert.equal(existsSync(databasePath), false, "read-only startup must not create a database");
    const events = parseJsonLogLines(stderr);
    assert.ok(events.some((event) => getEventName(event) === "backend.startup_rejected" && (event.error_code ?? event.fields?.error_code) === "DATABASE_OPEN_FAILED"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  }
});

test("Rust core rejects a malformed database before sending a welcome", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-rust-db-corrupt-"));
  const databasePath = join(directory, "corrupt.sqlite");
  writeFileSync(databasePath, "not a sqlite database");
  const {child} = spawnCore(["serve", "--database", databasePath]);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const [exitCode, signal] = await waitForChildClose(child);
    assert.equal(signal, null);
    assert.equal(exitCode, 2);
    assert.equal(stdout, "", "malformed state must be rejected before IPC readiness");
    assert.equal(readFileSync(databasePath, "utf8"), "not a sqlite database");
    const events = parseJsonLogLines(stderr);
    assert.ok(events.some((event) => getEventName(event) === "backend.startup_rejected" && (event.error_code ?? event.fields?.error_code) === "DATABASE_OPEN_FAILED"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  }
});

async function waitForChildClose(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("Rust core did not exit within the deadline")), timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once("close", (code, childSignal) => { clearTimeout(timeout); resolvePromise([code, childSignal]); });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  await waitForChildClose(child).catch(() => child.kill());
}

function waitForLogEvent(child, chunks, eventName) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error(`timed out waiting for ${eventName}`)), 5000);
    let partialLine = "";
    child.stderr.on("data", (chunk) => {
      const data = chunk.toString("utf8");
      chunks.push(data);
      partialLine += data;
      const lines = partialLine.split(/\r?\n/);
      partialLine = lines.pop() ?? "";
      try {
        for (const line of lines.filter(Boolean)) {
          const record = JSON.parse(line);
          if (getEventName(record) === eventName) {
            clearTimeout(timeout);
            resolvePromise(record);
            return;
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        rejectPromise(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

test("Rust core reports versioned protocol and capability metadata", () => {
  const output = execFileSync(executable, ["--metadata"], {encoding: "utf8", windowsHide: true});
  const metadata = JSON.parse(output);
  assert.equal(metadata.protocolVersion, 1);
  assert.equal(typeof metadata.version, "string");
  assert.equal(typeof metadata.buildRevision, "string");
  assert.equal(typeof metadata.target, "string");
  assert.ok(metadata.capabilities.some((capability) => capability.name === "system.health" && capability.state === "supported"));
  assert.ok(metadata.capabilities.some((capability) => capability.name === "capabilities.list" && capability.state === "supported"));
  assert.ok(metadata.capabilities.some((capability) => capability.name === "tasks.create" && capability.state === "supported"));
});

test("Rust core recognizes tasks.create and fails closed when no authoritative database is configured", async () => {
  const {child, reader} = spawnCore(["serve"]);
  try {
    child.stdin.write(encodeIpcFrame(hello(["tasks.create"])));
    const welcome = await reader.next();
    assert.equal(welcome.kind, "welcome");
    assert.ok(welcome.capabilities.some((capability) => capability.name === "tasks.create" && capability.state === "supported"));

    child.stdin.write(encodeIpcFrame(request("create-without-database", "tasks.create", {
      title: "No database task",
      description: "Must fail closed",
      acceptanceCriteria: ["No state is written"],
      riskTier: 1
    })));
    const response = await reader.next();
    assert.equal(response.kind, "response");
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "DATABASE_UNAVAILABLE");
  } finally {
    await stopChild(child);
  }
});

test("Rust core becomes ready without touching state and shuts down cleanly on stdin EOF", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-rust-core-"));
  const configPath = join(directory, "core.json");
  writeFileSync(configPath, JSON.stringify({logLevel: "info"}));
  const stderrChunks = [];
  const stdoutChunks = [];
  let child;
  try {
    child = spawn(executable, ["serve", "--config", configPath], {cwd: repositoryRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    child.stdout.on("data", (chunk) => { stdoutChunks.push(chunk); });
    const reader = createIpcFrameReader(child.stdout);
    const readyPromise = waitForLogEvent(child, stderrChunks, "backend.ready");
    child.stdin.write(encodeIpcFrame(hello()));
    const welcome = await reader.next();
    assert.equal(welcome.kind, "welcome");
    const ready = await readyPromise;
    assert.equal(ready.protocol_version ?? ready.fields?.protocol_version, 1);
    assert.deepEqual(readdirSync(directory).sort(), ["core.json"], "startup must not create or mutate authoritative state");

    child.stdin.end();
    const [exitCode, signal] = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("Rust core did not shut down within five seconds")), 5000);
      child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
      child.once("close", (code, childSignal) => { clearTimeout(timeout); resolvePromise([code, childSignal]); });
    });
    assert.equal(signal, null);
    assert.equal(exitCode, 0);
    const events = parseJsonLogLines(stderrChunks.join("")).map(getEventName);
    assert.ok(events.includes("backend.stopping"));
    assert.ok(events.includes("backend.stopped"));
    const output = Buffer.concat(stdoutChunks);
    assert.equal(output.readUInt32BE(0), output.length - 4);
    assert.deepEqual(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(output.subarray(4))), welcome);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  }
});

test("Rust core rejects malformed configuration before reporting readiness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-rust-core-invalid-"));
  const configPath = join(directory, "core.json");
  writeFileSync(configPath, "{ invalid json");
  let stderr = "";
  let stdout = "";
  let child;
  try {
    child = spawn(executable, ["serve", "--config", configPath], {cwd: repositoryRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const [exitCode, signal] = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("invalid Rust core config did not fail within five seconds")), 5000);
      child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
      child.once("close", (code, childSignal) => { clearTimeout(timeout); resolvePromise([code, childSignal]); });
    });
    assert.equal(signal, null);
    assert.equal(exitCode, 2);
    assert.equal(stdout, "");
    const events = parseJsonLogLines(stderr).map(getEventName);
    assert.ok(events.includes("backend.startup_rejected"));
    assert.ok(!events.includes("backend.ready"));
    assert.equal(readFileSync(configPath, "utf8"), "{ invalid json");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  }
});

test("Rust core negotiates v1 before serving health and capabilities requests", async () => {
  const {child, reader} = spawnCore();
  try {
    child.stdin.write(encodeIpcFrame(hello()));
    const welcome = await reader.next();
    assert.equal(welcome.kind, "welcome");
    assert.equal(welcome.selectedProtocol, 1);
    assert.equal(welcome.schemaVersion, 1);
    assert.equal(welcome.ready, true);
    assert.deepEqual(welcome.capabilities.filter((item) => item.state === "supported").map((item) => item.name).sort(), [
      "capabilities.list",
      "system.health",
      "tasks.create"
    ]);

    child.stdin.write(encodeIpcFrame(request("health-1", "system.health")));
    const health = await reader.next();
    assert.equal(health.kind, "response");
    assert.equal(health.inReplyTo, "health-1");
    assert.equal(health.ok, true);
    assert.equal(health.result.ready, true);
    assert.equal(health.result.protocolVersion, 1);

    child.stdin.write(encodeIpcFrame(request("capabilities-1", "capabilities.list")));
    const capabilities = await reader.next();
    assert.equal(capabilities.inReplyTo, "capabilities-1");
    assert.equal(capabilities.ok, true);
    assert.ok(capabilities.result.some((item) => item.name === "tasks.list" && item.state === "unverified"));

    const goldenTaskListRequest = JSON.parse(readFileSync(
      join(repositoryRoot, "tests/fixtures/protocol/v1/request.tasks.list.json"),
      "utf8"
    ));
    child.stdin.write(encodeIpcFrame(goldenTaskListRequest));
    const notImplemented = await reader.next();
    assert.equal(notImplemented.inReplyTo, "msg-list-1");
    assert.equal(notImplemented.ok, false);
    assert.equal(notImplemented.error.code, "NOT_IMPLEMENTED");

    child.stdin.write(encodeIpcFrame(request("unknown-method-1", "future.call")));
    const unknown = await reader.next();
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "METHOD_NOT_FOUND");
  } finally {
    await stopChild(child);
  }
});

test("Rust core rejects requests before a compatible hello", async () => {
  const {child, reader} = spawnCore();
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("binary"); });
  try {
    child.stdin.write(encodeIpcFrame(request("early-health-1", "system.health")));
    child.stdin.end();
    const [exitCode, signal] = await waitForChildClose(child);
    assert.equal(signal, null);
    assert.notEqual(exitCode, 0);
    assert.equal(stdout, "", "no protocol response or privileged request is allowed before negotiation");
    await assert.rejects(reader.next(), /stdout ended/);
  } finally {
    await stopChild(child);
  }
});

test("Rust core rejects incompatible versions and missing mandatory capabilities", async () => {
  for (const invalidHello of [
    {...hello(), minimumProtocol: 2, maximumProtocol: 2},
    hello(["tasks.list"])
  ]) {
    const {child, reader} = spawnCore();
    try {
      child.stdin.write(encodeIpcFrame(invalidHello));
      child.stdin.end();
      const [exitCode, signal] = await waitForChildClose(child);
      assert.equal(signal, null);
      assert.notEqual(exitCode, 0);
      await assert.rejects(reader.next(), /stdout ended/);
    } finally {
      await stopChild(child);
    }
  }
});

test("Rust core rejects truncated, oversized, empty, invalid UTF-8 and malformed JSON frames", async () => {
  const cases = [
    Buffer.from([0, 0]),
    Buffer.from([0, 0, 0, 5, 123, 125]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 16, 0, 1]),
    Buffer.from([0, 0, 0, 2, 0xc3, 0x28]),
    Buffer.from([0, 0, 0, 1, 0x7b])
  ];
  for (const frame of cases) {
    const {child, reader} = spawnCore();
    try {
      child.stdin.write(frame);
      child.stdin.end();
      const [exitCode, signal] = await waitForChildClose(child);
      assert.equal(signal, null);
      assert.notEqual(exitCode, 0);
      await assert.rejects(reader.next(), /stdout ended/);
    } finally {
      await stopChild(child);
    }
  }
});

test("Rust core replays an identical request ID and rejects conflicting reuse", async () => {
  const {child, reader} = spawnCore();
  try {
    child.stdin.write(encodeIpcFrame(hello()));
    await reader.next();
    const original = request("duplicate-id-1", "system.health", {probe: "first"});
    child.stdin.write(encodeIpcFrame(original));
    const firstResponse = await reader.next();
    child.stdin.write(encodeIpcFrame(original));
    const replayedResponse = await reader.next();
    assert.deepEqual(replayedResponse, firstResponse);

    child.stdin.write(encodeIpcFrame({...original, payload: {probe: "different"}}));
    const conflict = await reader.next();
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "MESSAGE_ID_CONFLICT");
  } finally {
    await stopChild(child);
  }
});
