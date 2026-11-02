import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {RustCoreClient} = require("../dist-test/src/main/rust-core-client.js");
const testDirectory = dirname(fileURLToPath(import.meta.url));
const fakeCore = join(testDirectory, "fixtures", "rust-core-client", "fake-core.mjs");
const realCore = resolve("target", "debug", process.platform === "win32" ? "orchestrator-core.exe" : "orchestrator-core");

function request(messageId, payload = {}) {
  return {
    protocolVersion: 1,
    kind: "request",
    messageId,
    correlationId: `correlation-${messageId}`,
    causationId: null,
    sender: {id: "typescript-client", role: "client"},
    method: "system.health",
    payload
  };
}

function fake(scenario, options = {}) {
  return RustCoreClient.start(process.execPath, {
    args: [fakeCore, scenario],
    startupTimeoutMs: 500,
    requestTimeoutMs: 500,
    ...options
  });
}

test("TypeScript client negotiates the real Rust process and correlates framed health/capability responses", async () => {
  const client = await RustCoreClient.start(realCore);
  try {
    const health = await client.request(request("real-health-1"));
    assert.equal(health.ok, true);
    if (health.ok) {
      assert.equal(health.result.ready, true);
      assert.equal(health.result.protocolVersion, 1);
    }
    const capabilities = await client.request({...request("real-capabilities-1"), method: "capabilities.list"});
    assert.equal(capabilities.ok, true);
    if (capabilities.ok) {
      assert.ok(capabilities.result.some((item) => item.name === "tasks.list" && item.state === "supported"));
    }
  } finally {
    await client.close(1000);
  }
  assert.equal(client.state, "closed");
});

test("client fails cleanly when the backend executable is absent", async () => {
  await assert.rejects(
    RustCoreClient.start(resolve("target", "missing", "orchestrator-core.exe"), {startupTimeoutMs: 200}),
    (error) => error.code === "BACKEND_SPAWN_FAILED"
  );
});

test("client rejects incompatible and capability-incomplete handshakes", async () => {
  await assert.rejects(fake("incompatible"), (error) => error.code === "UNSUPPORTED_VERSION");
  await assert.rejects(
    fake("missing-capability", {requiredCapabilities: ["tasks.list"]}),
    (error) => error.code === "CAPABILITY_UNAVAILABLE"
  );
});

test("client startup handshake has a finite deadline", async () => {
  await assert.rejects(fake("startup-hang", {startupTimeoutMs: 80}), (error) => error.code === "HANDSHAKE_TIMEOUT");
});

test("request timeout poisons the stream and fails the owned backend", async () => {
  const client = await fake("hang", {requestTimeoutMs: 80});
  await assert.rejects(client.request(request("timeout-1")), (error) => error.code === "DEADLINE_EXCEEDED");
  assert.equal(client.state, "failed");
  await assert.rejects(client.request(request("timeout-2")), (error) => error.code === "TRANSPORT_CLOSED");
});

test("abrupt backend exit fails every pending request", async () => {
  const client = await fake("exit-on-request");
  await assert.rejects(client.request(request("exit-1")), (error) => error.code === "BACKEND_EXITED");
});

test("duplicate request IDs share one in-flight response and conflicting reuse is rejected", async () => {
  const client = await fake("duplicate");
  try {
    const original = request("duplicate-client-1");
    const first = client.request(original);
    const second = client.request(original);
    assert.equal(first, second);
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.deepEqual(secondResponse, firstResponse);
    assert.deepEqual(firstResponse.result, {requestCount: 1});
    await assert.rejects(
      client.request(request("duplicate-client-1", {different: true})),
      (error) => error.code === "MESSAGE_ID_CONFLICT"
    );
  } finally {
    await client.close(500);
  }
});

test("stale event sequences fail closed before reaching application callbacks", async () => {
  let received = 0;
  let protocolErrorResolve;
  const protocolError = new Promise((resolvePromise) => { protocolErrorResolve = resolvePromise; });
  const client = await fake("stale-event", {
    onEvent: () => { received += 1; },
    onProtocolError: (error) => protocolErrorResolve(error)
  });
  try {
    const error = await protocolError;
    assert.equal(error.code, "SEQUENCE_CONFLICT");
    assert.equal(received, 1);
    assert.equal(client.state, "failed");
  } finally {
    await client.close(500).catch(() => undefined);
  }
});

test("bounded pending requests reject queue saturation without unbounded buffering", async () => {
  const client = await fake("queue-saturation", {maxPendingRequests: 1, requestTimeoutMs: 1000});
  const pending = client.request(request("queue-first"));
  await assert.rejects(client.request(request("queue-second")), (error) => error.code === "QUEUE_FULL");
  await assert.rejects(pending, (error) => error.code === "DEADLINE_EXCEEDED");
});

test("diagnostic stderr is drained independently of protocol frames", async () => {
  let diagnosticLines = 0;
  const client = await fake("stderr-burst", {onDiagnostic: () => { diagnosticLines += 1; }});
  try {
    const response = await client.request(request("stderr-health"));
    assert.equal(response.ok, true);
    assert.ok(diagnosticLines > 100);
  } finally {
    await client.close(500);
  }
});

test("reconnect starts a new process and repeats the mandatory handshake", async () => {
  const first = await RustCoreClient.start(realCore);
  await first.close(1000);
  const second = await RustCoreClient.start(realCore);
  try {
    const response = await second.request(request("reconnected-health"));
    assert.equal(response.ok, true);
  } finally {
    await second.close(1000);
  }
});
