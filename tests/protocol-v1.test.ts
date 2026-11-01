import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/persistence/database";
import { createOrchestratorSdk } from "../src/sdk";
import {
  checkExpectedRevision, decodeFrame, encodeFrame, parseEvent, parseRequest, parseResponse,
  validateHandshake, PROTOCOL_VERSION, METHODS, EVENT_TYPES, type Hello, type Welcome
} from "../src/protocol/v1";

const fixtureRoot = path.resolve("tests/fixtures/protocol/v1");
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8")) as unknown;
}
const client = { id: "typescript-client", role: "client" };
type SchemaBranch = {
  if: { properties: { method: { const: string } } };
  then: {
    properties: { payload: { $ref: string }; expectedRevision?: { type: string } };
    required?: string[];
  };
};

test("golden v1 request, response, event and startup handshake validate", () => {
  const request = fixture("request.tasks.list.json");
  const response = fixture("response.tasks.list.json");
  const event = fixture("event.task.progress.json");
  const hello = fixture("hello.json") as Hello;
  const welcome = fixture("welcome.json") as Welcome;
  assert.equal(parseRequest(request, client).ok, true);
  assert.equal(parseRequest({ ...(request as Record<string, unknown>), traceContext: { traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01", tracestate: "vendor=value" } }, client).ok, true);
  assert.equal(parseRequest({ ...(request as Record<string, unknown>), traceContext: { traceparent: "00-00000000000000000000000000000000-0123456789abcdef-01" } }, client).ok, false);
  assert.equal(parseResponse(response).ok, true);
  assert.equal(parseEvent(event).ok, true);
  assert.equal(validateHandshake(hello, welcome).ok, true);
});

test("JSON Schema registry stays aligned with the TypeScript v1 registry", () => {
  const schema = JSON.parse(readFileSync(path.resolve("docs/protocol/v1/schema.json"), "utf8")) as {
    $defs: {
      common: { properties: { protocolVersion: { const: number } } };
      method: { enum: string[] };
      eventType: { enum: string[] };
      methodPayloads: Record<string, { required?: string[] }>;
      requestPayloadValidation: { allOf: SchemaBranch[] };
    }
  };
  assert.equal(schema.$defs.common.properties.protocolVersion.const, PROTOCOL_VERSION);
  assert.deepEqual(schema.$defs.method.enum, METHODS);
  assert.deepEqual(schema.$defs.eventType.enum, EVENT_TYPES);
  assert.deepEqual(Object.keys(schema.$defs.methodPayloads).sort(), [...METHODS].sort());
  const payloadBranches = schema.$defs.requestPayloadValidation.allOf;
  assert.deepEqual(payloadBranches.map((branch) => branch.if.properties.method.const).sort(), [...METHODS].sort());
  for (const branch of payloadBranches) {
    assert.equal(branch.then.properties.payload.$ref, `#/$defs/methodPayloads/${branch.if.properties.method.const}`);
  }
  assert.deepEqual(schema.$defs.methodPayloads["tasks.create"].required, ["title", "description", "acceptanceCriteria", "riskTier"]);
  for (const method of ["tasks.update", "tasks.dependencies.add", "runs.cancel", "runs.reconcile", "review.request"]) {
    const branch = payloadBranches.find((item) => item.if.properties.method.const === method);
    assert.equal(branch?.then.properties.expectedRevision?.type, "integer");
    assert.ok(branch?.then.required?.includes("expectedRevision"));
  }
});

test("4-byte big-endian framing round-trips one UTF-8 JSON message and rejects truncation", () => {
  const input = fixture("request.tasks.list.json");
  const frame = encodeFrame(input);
  assert.equal(frame.ok, true);
  if (!frame.ok) return;
  assert.equal(Buffer.from(frame.value).readUInt32BE(0), frame.value.length - 4);
  assert.deepEqual(decodeFrame(frame.value), { ok: true, value: input });
  assert.equal(encodeFrame(undefined).ok, false);
  assert.equal(decodeFrame(frame.value.slice(0, -1)).ok, false);
  assert.equal(decodeFrame(frame.value.slice(0, 2)).ok, false);
});

test("opaque identifiers match the language-independent printable ASCII limit", () => {
  const base = fixture("request.tasks.list.json") as Record<string, unknown>;
  assert.equal(parseRequest({ ...base, messageId: "i".repeat(200) }, client).ok, true);
  assert.equal(parseRequest({ ...base, messageId: "i".repeat(201) }, client).ok, false);
  assert.equal(parseRequest({ ...base, messageId: "é" }, client).ok, false);
});

test("frame size is checked in UTF-8 bytes, including the full serialized envelope", () => {
  const base = fixture("request.tasks.list.json") as Record<string, unknown>;
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  const message = { ...base, payload: { text: "é".repeat(Math.ceil((1024 * 1024 - overhead) / 2) + 1) } };
  const encoded = encodeFrame(message);
  assert.equal(encoded.ok, false);
  if (!encoded.ok) assert.equal(encoded.error.code, "FRAME_TOO_LARGE");
});

test("requests reject bad version, unknown method, malformed payload and unauthenticated sender", () => {
  const base = fixture("request.tasks.list.json") as Record<string, unknown>;
  assert.equal(parseRequest({ ...base, protocolVersion: 2 }, client).ok, false);
  const unknown = parseRequest({ ...base, method: "future.call" }, client);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "METHOD_NOT_FOUND");
  assert.equal(parseRequest({ ...base, payload: null }, client).ok, false);
  const malformed = parseRequest({ ...base, method: "tasks.create", payload: {} }, client);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "MALFORMED_PAYLOAD");
  for (const [method, payload] of [
    ["workers.report", { leaseToken: "lease-1", sequence: 1, outcome: "succeeded", summary: "done", source: {} }],
    ["mcp.servers.install", { name: "server", transport: "socket" }],
    ["tasks.create", { title: "title", description: "description", acceptanceCriteria: ["done"], riskTier: "1" }]
  ] as const) {
    const invalidPayload = parseRequest({ ...base, method, payload }, client);
    assert.equal(invalidPayload.ok, false, `${method} payload must satisfy the published schema`);
  }
  const unfencedMutation = parseRequest({ ...base, method: "runs.cancel", payload: { runId: "run-1", reason: "cancel", deadlineAt: "2026-11-01T10:00:00.000Z" } }, client);
  assert.equal(unfencedMutation.ok, false);
  if (!unfencedMutation.ok) assert.equal(unfencedMutation.error.code, "MALFORMED_PAYLOAD");
  const unauthorized = parseRequest(base, { id: "other-client", role: "client" });
  assert.equal(unauthorized.ok, false);
  if (!unauthorized.ok) assert.equal(unauthorized.error.code, "UNAUTHORIZED_SENDER");
});

test("stale expected revision is a side-effect-free conformance error", () => {
  const stale = checkExpectedRevision(4, 5);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.code, "STALE_REVISION");
    assert.deepEqual(stale.error.details, { expectedRevision: 4, currentRevision: 5 });
  }
  assert.equal(checkExpectedRevision(5, 5).ok, true);
});

test("handshake fails closed for missing, unsupported, unverified or unsatisfied mandatory capabilities", () => {
  const hello = fixture("hello.json") as Hello;
  const welcome = fixture("welcome.json") as Welcome;
  for (const capabilities of [
    [], [{ name: "tasks.list", state: "unsupported" }], [{ name: "tasks.list", state: "unverified" }],
    [{ name: "tasks.list", state: "conditional" }],
    [{ name: "tasks.list", state: "conditional", prerequisites: ["db-ready"], satisfiedPrerequisites: [] }]
  ] as Welcome["capabilities"][]) {
    assert.equal(validateHandshake(hello, { ...welcome, capabilities }).ok, false);
  }
  assert.equal(validateHandshake(hello, { ...welcome, ready: false }).ok, false);
  assert.equal(validateHandshake(hello, { ...welcome, schemaVersion: 2 }).ok, false);
});

test("golden tasks.list request maps to the current TypeScript SDK behavior", () => {
  const database = openDatabase(":memory:");
  try {
    const sdk = createOrchestratorSdk(database);
    sdk.createTask({ title: "Contract task", description: "Golden conformance", acceptanceCriteria: ["listed"], riskTier: 1 });
    const parsed = parseRequest(fixture("request.tasks.list.json"), client);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.method, "tasks.list");
    const response = {
      protocolVersion: parsed.value.protocolVersion,
      kind: "response",
      messageId: "response-from-typescript-baseline",
      correlationId: parsed.value.correlationId,
      causationId: parsed.value.messageId,
      sender: { id: "typescript-baseline", role: "backend" },
      inReplyTo: parsed.value.messageId,
      ok: true,
      result: sdk.listTasks()
    };
    assert.equal(parseResponse(response).ok, true);
    assert.equal((response.result as readonly unknown[]).length, 1);
    assert.equal((response.result as readonly { title: string }[])[0]?.title, "Contract task");
  } finally {
    database.close();
  }
});
