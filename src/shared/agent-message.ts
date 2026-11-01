// Transport-independent protocol. Only registry entries with concrete payload schemas are supported.
export const AGENT_MESSAGE_SCHEMA_VERSION = "orchestrator-agent-v1" as const;
// Reuses the existing local protocol/capability-runtime 1 MiB convention.
export const MAX_AGENT_MESSAGE_BYTES = 1024 * 1024;
export const AGENT_MESSAGE_TYPES = ["review.requested", "task.progress"] as const;
export type AgentMessageType = typeof AGENT_MESSAGE_TYPES[number];

interface Envelope {
  readonly schemaVersion: typeof AGENT_MESSAGE_SCHEMA_VERSION;
  readonly messageId: string;
  readonly occurredAt: string;
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly expectedRevision: number;
  readonly correlationId: string;
  readonly causationId: string;
  readonly sender: { readonly agentId: string; readonly role: string };
  readonly recipient: { readonly agentId: string };
  readonly authorization: { readonly principalId: string; readonly delegationChain: readonly string[]; readonly capabilityGrantId: string | null };
}
export type ReviewRequestedMessage = Envelope & {
  readonly messageType: "review.requested";
  readonly payload: { readonly reportMessageId: string; readonly evidenceIds: readonly string[] };
};
export type TaskProgressMessage = Envelope & {
  readonly messageType: "task.progress";
  readonly payload: { readonly summary: string };
};
export type AgentMessage = ReviewRequestedMessage | TaskProgressMessage;
export type MessageValidationError = "invalid_envelope" | "unsupported_version" | "unknown_type" | "invalid_payload" | "oversized_message";
export type MessageParseResult = { readonly ok: true; readonly message: AgentMessage } | { readonly ok: false; readonly error: MessageValidationError };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }

export function parseAgentMessage(value: unknown): MessageParseResult {
  const fail = (error: MessageValidationError): MessageParseResult => ({ ok: false, error });
  // Normalize once to JSON so getters, toJSON, prototypes, and mutable caller objects cannot
  // make validation and the eventual durable representation disagree.
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return fail("invalid_envelope");
    if (new TextEncoder().encode(serialized).byteLength > MAX_AGENT_MESSAGE_BYTES) return fail("oversized_message");
    value = JSON.parse(serialized) as unknown;
  } catch { return fail("invalid_envelope"); }
  if (!record(value)) return fail("invalid_envelope");
  if (value.schemaVersion !== AGENT_MESSAGE_SCHEMA_VERSION) return fail("unsupported_version");
  if (!AGENT_MESSAGE_TYPES.includes(value.messageType as AgentMessageType)) return fail("unknown_type");
  if (![value.messageId, value.taskId, value.runId, value.attemptId, value.correlationId, value.causationId].every(id) ||
      !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 ||
      typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt)) || new Date(value.occurredAt).toISOString() !== value.occurredAt ||
      !record(value.sender) || !id(value.sender.agentId) || !id(value.sender.role) ||
      !record(value.recipient) || !id(value.recipient.agentId) ||
      !record(value.authorization) || !id(value.authorization.principalId) ||
      !Array.isArray(value.authorization.delegationChain) || !value.authorization.delegationChain.every(id) ||
      !(value.authorization.capabilityGrantId === null || id(value.authorization.capabilityGrantId))) return fail("invalid_envelope");
  if (!record(value.payload)) return fail("invalid_payload");
  if (value.messageType === "review.requested") {
    if (!id(value.payload.reportMessageId) || !Array.isArray(value.payload.evidenceIds) || !value.payload.evidenceIds.every(id)) return fail("invalid_payload");
    return { ok: true, message: value as unknown as ReviewRequestedMessage };
  }
  if (typeof value.payload.summary !== "string" || !value.payload.summary.trim()) return fail("invalid_payload");
  return { ok: true, message: value as unknown as TaskProgressMessage };
}

export function validateAgentMessage(value: unknown): boolean {
  return parseAgentMessage(value).ok;
}
