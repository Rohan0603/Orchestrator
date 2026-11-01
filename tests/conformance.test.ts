import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityOrUnverified,
  evaluateRoute,
  HARNESS_ADAPTER_CONTRACT_VERSION,
  validateCapabilityManifest,
  type CapabilityManifest,
  type Correlation,
  type RouteIdentity
} from "../src/harness/adapter-contract";
import { ConformanceFixtureAdapter } from "../src/harness/conformance-fixture";
import { classifyTerminalOutcome, validateProgressEvent } from "../src/dispatch/dispatch-contract";
import {
  mergeOpenAIUsage,
  OpenAICompatibleAdapter,
  parseOpenAIStreamLine,
  readOpenAICompatibleConfig
} from "../src/harness/openai-compatible-adapter";

const correlation: Correlation = {
  dispatchId: "dispatch",
  runId: "run",
  attemptId: "attempt"
};

const route: RouteIdentity = {
  routeId: "fixture-route",
  provider: { state: "known", name: "fixture-provider" },
  model: { state: "known", name: "fixture-model" },
  reportedBy: "adapter"
};

function manifest(capabilities: CapabilityManifest["capabilities"]): CapabilityManifest {
  return {
    contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
    adapterId: "fixture-adapter",
    generatedAt: "2026-01-01T00:00:00.000Z",
    capabilities
  };
}

function capability(
  key: "run.create" | "progress.structured" | "terminal.outcome" | "dispatch.idempotency"
) {
  return {
    key,
    state: "supported" as const,
    evidence: ["deterministic-fixture"],
    conditions: [],
    satisfiedPrerequisites: [],
    version: "fixture-v1",
    environment: "test"
  };
}

function errorResult(className: "ambiguous" | "unsupported_capability") {
  return {
    ok: false as const,
    error: {
      class: className,
      code: className.toUpperCase(),
      message: "Fixture error",
      retryable: false,
      correlation
    }
  };
}

test("adapter fixture covers identity, idempotency, events, and missing capabilities", async () => {
  const adapter = new ConformanceFixtureAdapter({
    identity: {
      adapterId: "fixture-adapter",
      harnessName: "deterministic-fixture",
      adapterVersion: "1",
      contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION
    },
    manifest: manifest([
      capability("run.create"),
      capability("progress.structured"),
      capability("terminal.outcome"),
      capability("dispatch.idempotency")
    ]),
    route,
    cancellationResult: errorResult("ambiguous"),
    reconciliationResult: errorResult("unsupported_capability")
  });
  const request = {
    dispatchId: correlation.dispatchId,
    idempotencyKey: "idempotency-key",
    authorization: {
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      actionDigest: "digest",
      approvalId: null,
      policyVersion: "policy-v1"
    },
    taskDescription: "fixture task",
    deadlineAt: "2099-01-01T00:00:00.000Z",
    route
  };

  assert.equal((await adapter.discoverCapabilities()).contractVersion, HARNESS_ADAPTER_CONTRACT_VERSION);
  assert.equal((await adapter.createRun(request)).ok, true);
  const duplicate = await adapter.createRun(request);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.class, "duplicate_dispatch");
  assert.equal((await adapter.requestCancellation(correlation, request.deadlineAt)).ok, false);
  assert.equal((await adapter.reconcile(correlation)).ok, false);

  const blocked = evaluateRoute(
    manifest([capability("run.create")]),
    route,
    {
      routeId: route.routeId,
      allowExplicitFallback: false,
      capabilities: [
        { key: "run.create", mandatory: true, prerequisites: [] },
        { key: "progress.structured", mandatory: true, prerequisites: [] }
      ]
    }
  );
  assert.equal(blocked.decision, "blocked");
  assert.equal(capabilityOrUnverified(manifest([]), "terminal.outcome").state, "unverified");
});

test("adapter contract preserves event ordering and uncertain terminal outcomes", () => {
  const event = {
    eventId: "event-1",
    correlation,
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "message" as const,
    message: "fixture",
    evidence: []
  };
  const cursor = { correlation, lastSequence: 0, eventIds: [] };
  const accepted = validateProgressEvent(event, cursor);
  assert.equal(accepted.disposition, "accepted");
  assert.equal(validateProgressEvent(event, accepted.cursor).disposition, "duplicate");
  assert.equal(classifyTerminalOutcome({ kind: "succeeded", correlation, reportedAt: event.occurredAt, evidence: [], error: null }), "verification");
  assert.equal(classifyTerminalOutcome({ kind: "timed_out", correlation, reportedAt: event.occurredAt, evidence: [], error: null }), "inconclusive");
  assert.equal(classifyTerminalOutcome({ kind: "disconnected", correlation, reportedAt: event.occurredAt, evidence: [], error: null }), "recovery_required");
});

test("capability manifests reject duplicate and incomplete declarations", () => {
  const supported = capability("run.create");
  assert.deepEqual(validateCapabilityManifest(manifest([supported, supported])), [
    "Capability run.create is declared more than once"
  ]);
  assert.deepEqual(
    validateCapabilityManifest(
      manifest([{ ...supported, evidence: [], version: null, environment: null }])
    ),
    [
      "Supported capability run.create has no evidence",
      "Supported capability run.create has no version",
      "Supported capability run.create has no environment"
    ]
  );
  const blocked = evaluateRoute(
    manifest([{ ...supported, evidence: [] }]),
    route,
    {
      routeId: route.routeId,
      allowExplicitFallback: false,
      capabilities: [{ key: "run.create", mandatory: true, prerequisites: [] }]
    }
  );
  assert.equal(blocked.decision, "blocked");
});

test("OpenAI-compatible parser quarantines malformed SSE and preserves missing usage fields", () => {
  assert.equal(parseOpenAIStreamLine("data: not-json"), null);
  assert.equal(parseOpenAIStreamLine(`data: ${"x".repeat(256 * 1024 + 1)}`), null);
  assert.equal(parseOpenAIStreamLine("data: [DONE]"), "done");
  const chunk = parseOpenAIStreamLine('data: {"usage":{"prompt_tokens":3}}');
  assert.ok(chunk && chunk !== "done");
  assert.deepEqual(mergeOpenAIUsage(null, chunk), {
    total: null,
    input: 3,
    output: null,
    reasoning: null,
    cost: null
  });
});

test("OpenAI-compatible adapter reports streamed progress and terminal outcome", async () => {
  const encoded = new TextEncoder().encode([
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    "",
    'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n"));
  let reads = 0;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "http://127.0.0.1:31415/v1",
    apiKey: "test-key",
    model: "auto",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => reads++ === 0
            ? { done: false, value: encoded }
            : { done: true, value: undefined }
        })
      }
    } as unknown as Response)
  });
  const request = {
    dispatchId: correlation.dispatchId,
    idempotencyKey: "idempotency-key",
    authorization: {
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      actionDigest: "digest",
      approvalId: null,
      policyVersion: "policy-v1"
    },
    taskDescription: "adapter task",
    deadlineAt: "2099-01-01T00:00:00.000Z",
    route: adapter.route
  };
  const terminal = new Promise((resolve) => {
    adapter.createRun(request).then(() => {
      adapter.subscribeTerminal(correlation, resolve);
    });
  });
  const outcome = await terminal;
  assert.equal((outcome as { kind: string }).kind, "succeeded");
  assert.deepEqual(adapter.getUsage(correlation), {
    total: null,
    input: 2,
    output: 1,
    reasoning: null,
    cost: null
  });
  assert.equal(readOpenAICompatibleConfig({
    ORCHESTRATOR_OPENAI_BASE_URL: "http://127.0.0.1:31415/v1",
    FREELLMAPI_API_KEY: "secret",
    ORCHESTRATOR_OPENAI_MODEL: "auto"
  })?.apiKey, "secret");
  assert.equal(readOpenAICompatibleConfig({
    ORCHESTRATOR_OPENAI_BASE_URL: "http://127.0.0.1:31415/v1",
    FREELLMAPI_API_KEY: "secret",
    ORCHESTRATOR_OPENAI_MODEL: "auto",
    ORCHESTRATOR_OPENAI_PROVIDER: "another-provider"
  }), null);
  await adapter.close();
});
