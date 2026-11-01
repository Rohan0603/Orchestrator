/** Language-neutral local backend wire contract v1. Transport identity is supplied separately. */
export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_NAME = "orchestrator-ipc" as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const SUPPORTED_SCHEMA_VERSION = 1 as const;

export const METHODS = [
  "system.health", "system.shutdown", "projects.create", "projects.get", "projects.list",
  "tasks.create", "tasks.update", "tasks.get", "tasks.list", "tasks.runs.list",
  "tasks.revisions.list", "tasks.dependencies.add", "tasks.dependencies.list", "workers.register", "skills.install",
  "mcp.servers.install", "plugins.install",
  "workers.claim", "leases.heartbeat", "leases.release", "workers.message", "workers.report",
  "messages.dispatch", "runs.cancel", "runs.reconcile", "policy.evaluate", "approvals.request",
  "verification.get", "review.request", "acceptance.get", "events.subscribe", "events.replay",
  "providers.streamTask", "mcp.tools.list", "mcp.tools.call", "plugins.execute", "capabilities.list", "artifacts.get"
] as const;
export type Method = typeof METHODS[number];
export const EVENT_TYPES = [
  "task.created", "task.updated", "task.progress", "run.started", "run.state_changed", "worker.message",
  "review.requested", "review.completed", "acceptance.decided", "recovery.required", "recovery.reconciled"
] as const;
const EVENT_SET = new Set<string>(EVENT_TYPES);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Sender { readonly id: string; readonly role: string; }
interface Common {
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly sender: Sender;
  readonly traceContext?: { readonly traceparent: string; readonly tracestate?: string };
}
export interface Request extends Common {
  readonly kind: "request";
  readonly method: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly leaseId?: string;
  readonly expectedRevision?: number;
  readonly deadlineAt?: string;
  readonly payload: Record<string, unknown>;
}
export interface ProtocolError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}
export type Response = Common & {
  readonly kind: "response";
  readonly inReplyTo: string;
} & ({ readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: ProtocolError });
export interface Event extends Common {
  readonly kind: "event";
  readonly eventType: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly occurredAt: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly expectedRevision?: number;
  readonly payload: Record<string, unknown>;
}
export interface Capability {
  readonly name: string;
  readonly state: "supported" | "unsupported" | "conditional" | "unverified";
  readonly reason?: string;
  readonly prerequisites?: readonly string[];
  readonly satisfiedPrerequisites?: readonly string[];
}
export interface Hello extends Common {
  readonly kind: "hello";
  readonly minimumProtocol: number;
  readonly maximumProtocol: number;
  readonly clientVersion: string;
  readonly schemaVersion: number;
  readonly requiredCapabilities: readonly string[];
}
export interface Welcome extends Common {
  readonly kind: "welcome";
  readonly selectedProtocol: number;
  readonly backendVersion: string;
  readonly buildId: string;
  readonly schemaVersion: number;
  readonly databaseSchemaVersion: number;
  readonly processSupervision: string;
  readonly ready: boolean;
  readonly capabilities: readonly Capability[];
}
export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ProtocolError };
const ID = /^[\x20-\x7e]+$/;
const METHODS_SET = new Set<string>(METHODS);
const ERROR = (code: string, message: string, retryable = false, details?: Record<string, unknown>): ProtocolError => ({
  code, message, retryable, ...(details ? { details } : {})
});
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 200 && ID.test(value);
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validTraceContext(value: unknown): boolean {
  if (!record(value) || typeof value.traceparent !== "string" ||
      !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value.traceparent)) return false;
  const [, traceId, spanId] = value.traceparent.split("-");
  if (!traceId || /^0+$/.test(traceId) || !spanId || /^0+$/.test(spanId)) return false;
  return value.tracestate === undefined || typeof value.tracestate === "string" && Buffer.byteLength(value.tracestate, "utf8") <= 512 && /^[\x20-\x7e]*$/.test(value.tracestate);
}
function common(value: Record<string, unknown>): boolean {
  return value.protocolVersion === PROTOCOL_VERSION && validId(value.messageId) && validId(value.correlationId) &&
    (value.causationId === null || validId(value.causationId)) && record(value.sender) &&
    validId(value.sender.id) && validId(value.sender.role) && (value.traceContext === undefined || validTraceContext(value.traceContext));
}
function fail<T>(code: string, message: string, details?: Record<string, unknown>): ParseResult<T> {
  return { ok: false, error: ERROR(code, message, false, details) };
}
function objectPayload(value: unknown): value is Record<string, unknown> { return record(value); }
function validPayload(method: string, payload: Record<string, unknown>): boolean {
  const required: Partial<Record<Method, readonly string[]>> = {
    "projects.create": ["name"], "projects.get": ["projectId"], "tasks.create": ["title", "description", "acceptanceCriteria", "riskTier"],
    "tasks.update": ["taskId", "content"], "tasks.get": ["taskId"], "tasks.runs.list": ["taskId"],
    "tasks.revisions.list": ["taskId"], "tasks.dependencies.add": ["taskId", "dependsOnTaskId"],
    "tasks.dependencies.list": ["taskId"], "workers.register": ["name"], "workers.claim": ["workerId"],
    "skills.install": ["name", "version", "sourcePath", "instructions"],
    "mcp.servers.install": ["name", "transport"], "plugins.install": ["name", "version", "entrypoint"],
    "leases.heartbeat": ["leaseId", "leaseToken"], "leases.release": ["leaseId", "leaseToken", "outcome"],
    "workers.message": ["leaseToken", "kind", "sequence", "payload"],
    "workers.report": ["leaseToken", "sequence", "outcome", "summary", "source"],
    "runs.cancel": ["runId", "reason", "deadlineAt"], "runs.reconcile": ["runId", "observation"],
    "policy.evaluate": ["action", "target", "context"], "approvals.request": ["action", "target", "context"],
    "verification.get": ["runId"], "review.request": ["runId", "evidenceIds"], "acceptance.get": ["taskId", "runId"],
    "providers.streamTask": ["taskId"], "mcp.tools.list": ["workerId", "leaseToken", "serverId"],
    "mcp.tools.call": ["workerId", "leaseToken", "serverId", "toolName", "arguments", "sequence"],
    "plugins.execute": ["workerId", "leaseToken", "pluginId", "capability", "input", "sequence"],
    "artifacts.get": ["artifactId"]
  };
  const keys = required[method as Method] ?? [];
  if (!keys.every((key) => key in payload)) return false;
  const stringFields: Partial<Record<Method, readonly string[]>> = {
    "projects.create": ["name"], "projects.get": ["projectId"], "tasks.update": ["taskId"], "tasks.get": ["taskId"],
    "tasks.runs.list": ["taskId"], "tasks.revisions.list": ["taskId"], "tasks.dependencies.add": ["taskId", "dependsOnTaskId"],
    "tasks.dependencies.list": ["taskId"], "workers.register": ["name"], "workers.claim": ["workerId"],
    "skills.install": ["name", "version", "sourcePath", "instructions"], "mcp.servers.install": ["name", "transport"],
    "plugins.install": ["name", "version", "entrypoint"], "leases.heartbeat": ["leaseId", "leaseToken"],
    "leases.release": ["leaseId", "leaseToken", "outcome"], "workers.message": ["leaseToken", "kind"],
    "workers.report": ["leaseToken", "outcome", "summary"], "runs.cancel": ["runId", "reason", "deadlineAt"],
    "runs.reconcile": ["runId"], "verification.get": ["runId"], "review.request": ["runId"],
    "acceptance.get": ["taskId", "runId"], "providers.streamTask": ["taskId"],
    "mcp.tools.list": ["workerId", "leaseToken", "serverId"], "mcp.tools.call": ["workerId", "leaseToken", "serverId", "toolName"],
    "plugins.execute": ["workerId", "leaseToken", "pluginId", "capability"], "artifacts.get": ["artifactId"]
  };
  if (!(stringFields[method as Method] ?? []).every((key) => typeof payload[key] === "string" && (payload[key] as string).trim().length > 0)) return false;
  if (method === "leases.release" && !["succeeded", "failed", "cancelled", "inconclusive"].includes(String(payload.outcome))) return false;
  if ((method === "tasks.update" && !record(payload.content)) ||
      (["policy.evaluate", "approvals.request"].includes(method) && (!record(payload.context) || !("action" in payload) || !("target" in payload)))) return false;
  if (["system.health", "system.shutdown", "projects.list", "tasks.list", "messages.dispatch", "events.subscribe", "events.replay", "capabilities.list"].includes(method) && !record(payload)) return false;
  if (method === "tasks.create") return typeof payload.title === "string" && payload.title.trim().length > 0 &&
    typeof payload.description === "string" && Array.isArray(payload.acceptanceCriteria) && payload.acceptanceCriteria.length > 0 &&
    payload.acceptanceCriteria.every((item) => typeof item === "string" && item.trim().length > 0) &&
    typeof payload.riskTier === "number" && [1, 2, 3].includes(payload.riskTier);
  if (method === "workers.message") return validId(payload.leaseToken) && ["progress", "heartbeat", "report", "error"].includes(String(payload.kind)) &&
    Number.isSafeInteger(payload.sequence) && Number(payload.sequence) > 0;
  if (method === "workers.report") return validId(payload.leaseToken) && Number.isSafeInteger(payload.sequence) && Number(payload.sequence) > 0 &&
    ["succeeded", "failed", "cancelled", "inconclusive"].includes(String(payload.outcome)) && typeof payload.summary === "string" &&
    record(payload.source) && validId(payload.source.adapterId) && validId(payload.source.sessionId);
  if (method === "mcp.servers.install" && !["stdio", "http"].includes(String(payload.transport))) return false;
  if (["mcp.tools.call", "plugins.execute"].includes(method) && (!Number.isSafeInteger(payload.sequence) || Number(payload.sequence) <= 0)) return false;
  if (method === "mcp.tools.call" && !record(payload.arguments)) return false;
  if (method === "events.replay") return validId(payload.cursor) && (payload.limit === undefined || Number.isSafeInteger(payload.limit) && Number(payload.limit) > 0);
  if (method === "events.subscribe") return (payload.afterCursor === undefined || validId(payload.afterCursor)) &&
    (payload.taskId === undefined || validId(payload.taskId)) && (payload.runId === undefined || validId(payload.runId));
  if (["providers.streamTask", "system.shutdown"].includes(method) && payload.deadlineAt !== undefined && !validTime(payload.deadlineAt)) return false;
  if (method === "runs.cancel" && !validTime(payload.deadlineAt)) return false;
  return true;
}

/** Encode a single JSON body with the frozen 4-byte big-endian length prefix. */
export function encodeFrame(message: unknown): ParseResult<Uint8Array> {
  let body: string;
  try { body = JSON.stringify(message); } catch { return fail("INVALID_ENVELOPE", "Message cannot be serialized as JSON"); }
  if (typeof body !== "string") return fail("INVALID_ENVELOPE", "Message cannot be serialized as a JSON value");
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return fail("FRAME_TOO_LARGE", "Frame length is outside the v1 limit");
  const output = Buffer.allocUnsafe(4 + bytes.length);
  output.writeUInt32BE(bytes.length, 0);
  bytes.copy(output, 4);
  return { ok: true, value: output };
}

/** Decode exactly one complete frame; partial or trailing bytes are rejected. */
export function decodeFrame(frame: Uint8Array): ParseResult<unknown> {
  if (frame.byteLength < 4) return fail("INVALID_ENVELOPE", "Frame prefix is truncated");
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = bytes.readUInt32BE(0);
  if (length === 0 || length > MAX_FRAME_BYTES) return fail("FRAME_TOO_LARGE", "Frame length is outside the v1 limit");
  if (bytes.length !== length + 4) return fail("INVALID_ENVELOPE", "Frame body is truncated or has trailing data");
  try { return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4))) as unknown }; }
  catch { return fail("INVALID_ENVELOPE", "Frame is not valid UTF-8 JSON"); }
}

export function parseRequest(input: unknown, authenticatedPeer: Sender): ParseResult<Request> {
  if (record(input) && input.protocolVersion !== PROTOCOL_VERSION) return fail("UNSUPPORTED_VERSION", "Protocol major version is unsupported");
  if (!record(input) || !common(input) || input.kind !== "request" || !validId(input.method) || !objectPayload(input.payload)) {
    return fail("INVALID_ENVELOPE", "Request envelope is malformed");
  }
  const sender = input.sender as Record<string, unknown>;
  if (!validId(authenticatedPeer.id) || !validId(authenticatedPeer.role) || sender.id !== authenticatedPeer.id || sender.role !== authenticatedPeer.role) {
    return fail("UNAUTHORIZED_SENDER", "Envelope sender does not match the authenticated peer");
  }
  if (!METHODS_SET.has(input.method)) return fail("METHOD_NOT_FOUND", "Method is not in the v1 registry", { method: input.method });
  if (!validPayload(input.method, input.payload)) return fail("MALFORMED_PAYLOAD", "Method payload does not match its v1 schema", { method: input.method });
  for (const key of ["taskId", "runId", "attemptId", "leaseId"] as const) {
    if (input[key] !== undefined && !validId(input[key])) return fail("INVALID_ENVELOPE", `${key} is invalid`);
  }
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) {
    return fail("INVALID_ENVELOPE", "expectedRevision must be a non-negative safe integer");
  }
  if (input.deadlineAt !== undefined && !validTime(input.deadlineAt)) return fail("INVALID_ENVELOPE", "deadlineAt must be canonical UTC RFC 3339 with millisecond precision");
  if (["tasks.update", "tasks.dependencies.add", "runs.cancel", "runs.reconcile", "review.request"].includes(input.method) && input.expectedRevision === undefined) {
    return fail("MALFORMED_PAYLOAD", "Mutating request requires expectedRevision", { method: input.method });
  }
  return { ok: true, value: input as unknown as Request };
}

export function parseResponse(input: unknown): ParseResult<Response> {
  if (record(input) && input.protocolVersion !== PROTOCOL_VERSION) return fail("UNSUPPORTED_VERSION", "Protocol major version is unsupported");
  if (!record(input) || !common(input) || input.kind !== "response" || !validId(input.inReplyTo) || typeof input.ok !== "boolean") {
    return fail("INVALID_ENVELOPE", "Response envelope is malformed");
  }
  if (input.ok && !("result" in input)) return fail("MALFORMED_PAYLOAD", "Successful response must include result");
  if (!input.ok && (!record(input.error) || !validId(input.error.code) || typeof input.error.message !== "string" ||
      typeof input.error.retryable !== "boolean" || (input.error.details !== undefined && !record(input.error.details)))) {
    return fail("MALFORMED_PAYLOAD", "Failed response must include a structured error");
  }
  return { ok: true, value: input as unknown as Response };
}

export function parseEvent(input: unknown): ParseResult<Event> {
  if (record(input) && input.protocolVersion !== PROTOCOL_VERSION) return fail("UNSUPPORTED_VERSION", "Protocol major version is unsupported");
  if (record(input) && typeof input.eventType === "string" && !EVENT_SET.has(input.eventType)) return fail("UNKNOWN_EVENT", "Event type is not in the v1 registry", { eventType: input.eventType });
  if (!record(input) || !common(input) || input.kind !== "event" || !validId(input.eventType) || !validId(input.cursor) ||
      !Number.isSafeInteger(input.sequence) || Number(input.sequence) <= 0 || !validTime(input.occurredAt) || !objectPayload(input.payload)) {
    return fail("INVALID_ENVELOPE", "Event envelope is malformed");
  }
  for (const key of ["taskId", "runId", "attemptId"] as const) {
    if (input[key] !== undefined && !validId(input[key])) return fail("INVALID_ENVELOPE", `${key} is invalid`);
  }
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) {
    return fail("INVALID_ENVELOPE", "expectedRevision must be a non-negative safe integer");
  }
  return { ok: true, value: input as unknown as Event };
}

export function checkExpectedRevision(expected: number, current: number): ParseResult<true> {
  if (!Number.isSafeInteger(expected) || expected < 0 || !Number.isSafeInteger(current) || current < 0) {
    return fail("INVALID_ENVELOPE", "Lifecycle revision must be a non-negative safe integer");
  }
  if (expected !== current) return fail("STALE_REVISION", "Lifecycle revision does not match", { expectedRevision: expected, currentRevision: current });
  return { ok: true, value: true };
}

export function validateHandshake(helloInput: unknown, welcomeInput: unknown): ParseResult<Welcome> {
  if (!record(helloInput) || !record(welcomeInput)) return fail("INVALID_ENVELOPE", "Handshake envelope is malformed");
  if (!common(helloInput) || !common(welcomeInput) || helloInput.kind !== "hello" || welcomeInput.kind !== "welcome" ||
      !Number.isSafeInteger(helloInput.minimumProtocol) || !Number.isSafeInteger(helloInput.maximumProtocol) ||
      typeof helloInput.clientVersion !== "string" || !Number.isSafeInteger(helloInput.schemaVersion) ||
      !Array.isArray(helloInput.requiredCapabilities) || !helloInput.requiredCapabilities.every(validId) ||
      !Number.isSafeInteger(welcomeInput.selectedProtocol) || typeof welcomeInput.backendVersion !== "string" ||
      typeof welcomeInput.buildId !== "string" || !Number.isSafeInteger(welcomeInput.schemaVersion) ||
      !Number.isSafeInteger(welcomeInput.databaseSchemaVersion) || typeof welcomeInput.processSupervision !== "string" ||
      typeof welcomeInput.ready !== "boolean" || !Array.isArray(welcomeInput.capabilities)) {
    return fail("INVALID_ENVELOPE", "Handshake envelope is malformed");
  }
  const hello = helloInput as unknown as Hello;
  const welcome = welcomeInput as unknown as Welcome;
  for (const item of welcome.capabilities) {
    if (!record(item) || !validId(item.name) || !["supported", "unsupported", "conditional", "unverified"].includes(String(item.state)) ||
        (item.prerequisites !== undefined && (!Array.isArray(item.prerequisites) || !item.prerequisites.every(validId))) ||
        (item.satisfiedPrerequisites !== undefined && (!Array.isArray(item.satisfiedPrerequisites) || !item.satisfiedPrerequisites.every(validId)))) {
      return fail("INVALID_ENVELOPE", "Capability manifest is malformed");
    }
  }
  if (hello.minimumProtocol > hello.maximumProtocol || welcome.selectedProtocol < hello.minimumProtocol || welcome.selectedProtocol > hello.maximumProtocol || welcome.selectedProtocol !== PROTOCOL_VERSION) {
    return fail("UNSUPPORTED_VERSION", "No explicitly compatible protocol version was negotiated");
  }
  if (hello.schemaVersion !== welcome.schemaVersion || welcome.databaseSchemaVersion < 0 || !welcome.ready) {
    return fail("CAPABILITY_UNAVAILABLE", "Backend readiness or schema compatibility check failed");
  }
  const capabilities = new Map(welcome.capabilities.map((capability) => [capability.name, capability]));
  for (const name of hello.requiredCapabilities) {
    const capability = capabilities.get(name);
    if (!capability || (capability.state !== "supported" && capability.state !== "conditional") ||
        (capability.state === "conditional" && (!(capability.prerequisites?.length) || !(capability.prerequisites ?? []).every((item) => (capability.satisfiedPrerequisites ?? []).includes(item))))) {
      return fail("CAPABILITY_UNAVAILABLE", "A mandatory capability is missing or unverified", { capability: name });
    }
  }
  return { ok: true, value: welcome };
}

export function notImplemented(method: Method): ProtocolError {
  return ERROR("NOT_IMPLEMENTED", "The method is specified but not implemented by this backend adapter", false, { method });
}
