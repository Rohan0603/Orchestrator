import assert from "node:assert/strict";
import test from "node:test";
import * as protocol from "../src/shared/agent-message";

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: protocol.AGENT_MESSAGE_SCHEMA_VERSION,
    messageId: "message-1", messageType: "review.requested", occurredAt: "2026-11-01T00:00:00.000Z",
    taskId: "task-1", runId: "run-1", attemptId: "attempt-1", expectedRevision: 1,
    correlationId: "run-1", causationId: "report-1",
    sender: { agentId: "orchestrator", role: "orchestrator" }, recipient: { agentId: "review-intake" },
    authorization: { principalId: "orchestrator", delegationChain: [], capabilityGrantId: null },
    payload: { reportMessageId: "report-1", evidenceIds: [] }, ...overrides
  };
}

test("protocol validates typed payloads and classifies rejected input", () => {
  const parse = protocol.parseAgentMessage;
  assert.equal(parse(message()).ok, true);
  for (const [input, error] of [
    [null, "invalid_envelope"], [message({ schemaVersion: "future" }), "unsupported_version"],
    [message({ messageType: "unknown" }), "unknown_type"], [message({ payload: {} }), "invalid_payload"],
    [message({ attemptId: null }), "invalid_envelope"], [message({ expectedRevision: -1 }), "invalid_envelope"],
    [message({ payload: { reportMessageId: "report-1", evidenceIds: [5] } }), "invalid_payload"]
  ] as const) assert.deepEqual(parse(input), { ok: false, error });
  const circular = message(); Object.assign(circular, { circular });
  assert.deepEqual(parse(circular), { ok: false, error: "invalid_envelope" });
});

test("protocol measures the entire serialized envelope in UTF-8 bytes", () => {
  const parse = protocol.parseAgentMessage;
  const input = message({ messageType: "task.progress", payload: { summary: "x" } });
  const overhead = Buffer.byteLength(JSON.stringify(input), "utf8");
  input.payload = { summary: "a".repeat(1024 * 1024 - overhead + 1) };
  assert.equal(parse(input).ok, true);
  input.payload = { summary: "a".repeat(1024 * 1024 - overhead + 1) + "é" };
  assert.deepEqual(parse(input), { ok: false, error: "oversized_message" });
});


test("protocol rejects noncanonical timestamps used in durable scheduling", () => {
  for (const occurredAt of ["2026-11-01T00:00:00Z", "2026-11-01T00:00:00+05:30", "November 1, 2026"]) {
    assert.deepEqual(protocol.parseAgentMessage(message({occurredAt})), {ok: false, error: "invalid_envelope"});
  }
});
