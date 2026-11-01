# AgentConductor Core IPC protocol v1

Status: frozen contract for incremental TypeScript-to-Rust migration. This is the private local Core API boundary between the TypeScript shell/client and the Rust Core. A transport supplies authenticated peer identity and message framing; Electron renderer-to-main IPC and Rust types are not part of the wire format. `orchestrator-ipc` remains a technical protocol identifier pending the separate naming migration in ORC-53.

The approved AgentConductor mission is a durable local control plane for autonomous software engineering: typed workers, deterministic orchestration, governed actions, isolated Git workspaces, evidence-backed completion, and crash-safe recovery. This contract serves the approved three-plane architecture: the trusted Core owns lifecycle, policy, routing, scheduling, reconciliation, evidence, telemetry, SQLite, and outbox; the Worker Plane produces untrusted claims through adapters; and the Source Plane owns Git repositories, per-attempt worktree leases, and artifacts. One active Worker remains the v0.1 limit.

ORC-33 freezes the Core API and TS↔Rust IPC. It does not define the separate Worker SDK wire protocol or the Electron renderer bridge. Worker command/event/request/response envelopes, worker capability negotiation, adapter conformance, and transport variants belong to ORC-50. Core methods named `workers.*` are service operations used by trusted adapters/clients; they never grant workers direct SQLite access or new execution authority. The Rust stack, SQLite WAL ownership and incremental cutover remain unchanged.

## Framing and limits

The v1 protocol uses UTF-8 JSON frames, each prefixed by a 4-byte unsigned big-endian byte length. The length is the JSON body's UTF-8 byte count, excluding the prefix. Zero-length frames, invalid UTF-8, invalid JSON, and frames over 1,048,576 bytes fail closed before dispatch. EOF between frames is normal shutdown; EOF within a prefix/body is a truncated-frame error. One frame contains exactly one JSON value.

Payloads over the limit must be stored as artifacts and represented by an artifact reference (`artifactId`, `uri`, `sha256`, `sizeBytes`, `mediaType`). Receivers verify the hash and size when reading. A local path is metadata, not authorization to read arbitrary files.

## Version and compatibility

`protocolVersion` is the integer major version (`1`). A peer must reject a different major with `UNSUPPORTED_VERSION`. New optional fields and new capabilities may be added within major version 1. Receivers ignore unknown object fields, but senders must not make an unknown field necessary to preserve safety or meaning. New method names and event types are not silently ignored: an unknown method returns `METHOD_NOT_FOUND`; an unknown event type is surfaced as `UNKNOWN_EVENT` and is not applied. Changes to existing field meaning, requiredness, enum values, ordering, idempotency, or lifecycle behavior require a new major version. A new major may coexist only through explicit handshake negotiation; no implicit downgrade is permitted.

Arrays preserve their specified order. Objects have no ordering guarantee. Timestamps are canonical UTC RFC 3339 strings with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Durations are positive integer milliseconds. Identifiers are opaque printable ASCII strings (U+0020–U+007E), 1–200 characters; clients must not infer structure from them.

## Shared envelope fields

Requests, responses, events, and hello messages contain `protocolVersion`, `messageId`, `correlationId`, `causationId` (string or null), and `sender: { id, role }`. IDs are opaque. The transport authenticates the peer separately; the `sender` field is correlation metadata and must match that authenticated identity. Applicable task/run/attempt/lease IDs, `expectedRevision`, `deadlineAt`, and `sequence` are explicit fields, never hidden in transport state. Optional `traceContext: { traceparent, tracestate? }` carries W3C trace context unchanged; it is observability metadata and grants no authority. V1 accepts version-00 traceparent values with nonzero 32-hex trace IDs and 16-hex span IDs; optional `tracestate` is limited to 512 printable ASCII bytes. Invalid trace context rejects the envelope.

All messages are JSON objects. Unknown fields are ignored for v1 only after known fields have been validated. `extensions` is the preferred namespace for optional producer metadata. Receivers must preserve safety checks even when extension data is present.

## Request and response

Request: `{ protocolVersion, kind:"request", messageId, correlationId, causationId, sender, method, taskId?, runId?, attemptId?, leaseId?, expectedRevision?, deadlineAt?, payload }`.

Response: `{ protocolVersion, kind:"response", messageId, correlationId, causationId, sender, inReplyTo, ok:true, result }` or `{ ..., inReplyTo, ok:false, error:{ code, message, retryable, details? } }`. `inReplyTo` is the request's `messageId`. Error messages are safe summaries; secrets, provider payloads, SQL and arbitrary exception text must not be returned. `details` is optional structured JSON with a stable schema for that error code.

The initial method registry is grouped by domain:

| Method | Payload | Result | Baseline status |
| -- | -- | -- | -- |
| `system.health` | `{}` | readiness and backend identity | implemented by TypeScript app status, to be adapted |
| `projects.create` | project metadata | project | TypeScript SDK |
| `projects.get` | `{ projectId }` | project or null | TypeScript SDK |
| `projects.list` | `{}` | project array | TypeScript SDK |
| `tasks.create` | CreateTaskInput | task | TypeScript SDK |
| `tasks.update` | `{ taskId, content }` | task | TypeScript SDK |
| `tasks.get` | `{ taskId }` | task or null | TypeScript SDK |
| `tasks.list` | `{}` | task array | TypeScript SDK |
| `tasks.runs.list` | `{ taskId }` | run/attempt history | TypeScript SDK |
| `tasks.revisions.list` | `{ taskId }` | revision history | TypeScript SDK |
| `tasks.dependencies.add` | `{ taskId, dependsOnTaskId }` | dependency | TypeScript SDK |
| `tasks.dependencies.list` | `{ taskId }` | dependency array | TypeScript SDK |
| `workers.register` | RegisterWorkerInput | registration | TypeScript SDK |
| `skills.install` | InstallSkillInput | skill record | TypeScript SDK |
| `mcp.servers.install` | InstallMcpServerInput | server record | TypeScript SDK |
| `plugins.install` | InstallPluginInput | plugin record | TypeScript SDK |
| `workers.claim` | `{ workerId, leaseDurationMs?, approvalId? }` | assignment or null | TypeScript SDK; policy gates retained; v0.1 allows one active Worker globally |
| `leases.heartbeat` | `{ leaseId, leaseToken, leaseDurationMs? }` | lease | TypeScript SDK |
| `leases.release` | `{ leaseId, leaseToken, outcome }` | released lease | reserved; release semantics require ORC-19 mapping |
| `workers.message` | WorkerMessageInput | ordered message | TypeScript SDK |
| `workers.report` | WorkerReportInput | acknowledgement | TypeScript SDK; report is not acceptance |
| `messages.dispatch` | `{ limit?, now? }` | delivery IDs/dispositions | TypeScript SDK |
| `runs.cancel` | `{ runId, reason, deadlineAt }` | cancellation disposition | TypeScript baseline semantics; qualification remains separate |
| `runs.reconcile` | `{ runId, observation }` | recovery disposition | explicit reconciliation only; never auto-replay |
| `policy.evaluate` | action/target/context | policy decision | adapter to ORC-24 policy services |
| `approvals.request` | exact action/target/payload context | approval request | adapter to ORC-24 policy services |
| `verification.get` | `{ runId }` | verification state/evidence refs | ORC-25 mapping required |
| `review.request` | `{ runId, evidenceIds }` | review request | TypeScript durable intake; not review execution |
| `acceptance.get` | `{ taskId, runId }` | acceptance decision | TypeScript baseline |
| `events.subscribe` | `{ afterCursor?, taskId?, runId? }` | subscription ID and cursor | TypeScript run stream adapter |
| `events.replay` | `{ cursor, limit? }` | ordered events and next cursor | cursor semantics frozen; adapter pending |
| `providers.streamTask` | `{ taskId, deadlineAt?, systemPrompt? }` | stream ID | SDK direct provider path; route qualification remains separate |
| `mcp.tools.list` | `{ workerId, leaseToken, serverId, approvalId? }` | tool descriptors | TypeScript SDK; lease/policy gates retained |
| `mcp.tools.call` | `{ workerId, leaseToken, serverId, toolName, arguments, sequence, idempotencyKey?, approvalId? }` | tool result | TypeScript SDK; lease/policy gates retained |
| `plugins.execute` | `{ workerId, leaseToken, pluginId, capability, input, sequence, idempotencyKey?, approvalId? }` | JSON result | TypeScript SDK; trusted local code and lease/policy gates retained |
| `capabilities.list` | `{}` | capability manifest | baseline adapter pending |
| `artifacts.get` | `{ artifactId }` | verified artifact metadata/reference | repository-specific storage adapter pending |

The registry is closed: a method absent from this table is not callable. A listed method whose baseline adapter is not yet implemented returns `NOT_IMPLEMENTED`, never a guessed success. Tool/plugin execution remains lease-owned, sequence-checked, and policy-gated; no new direct worker-to-provider path is introduced. Worker-provided progress, findings, artifacts, cancellation observations and terminal results remain untrusted input until Core validation, policy, evidence and review rules accept them.

### Payload field shapes

All payloads are JSON objects. `?` means optional; `null` is distinct from an omitted property. Strings and arrays retain their order. These shapes define the wire names and basic JSON types; domain validation and policy remain the same as the TypeScript baseline.

* `system.health`, `system.shutdown`, `projects.list`, `tasks.list`, `messages.dispatch`, `capabilities.list`: `{}`; shutdown accepts optional `{ deadlineAt }`; dispatch accepts optional `{ now, limit }`.
* `projects.create`: `{ id?, name, description?, repositoryPath?: string|null, defaultBranch?: string|null }`; get: `{ projectId }`.
* `tasks.create`: `{ projectId?: string|null, parentTaskId?: string|null, title, description, acceptanceCriteria: string[], riskTier: 1|2|3, skillIds?: string[], mcpServerIds?: string[], pluginIds?: string[], tokenBudget?: integer|null, idempotencyKey? }`; update: `{ taskId, content: partial task content }`; get: `{ taskId }`.
* `tasks.runs.list`, `tasks.revisions.list`, `tasks.dependencies.list`: `{ taskId }`; dependency add: `{ taskId, dependsOnTaskId }`.
* `workers.register`: `{ id?, name, kind?, capabilities?: { key, version? }[] }`; claim: `{ workerId, leaseDurationMs?, approvalId? }`.
* `skills.install`: `{ id?, name, version, sourcePath, description?, instructions, enabled? }`; `mcp.servers.install`: `{ id?, name, transport: stdio|http, command?: string|null, arguments?: string[], url?: string|null, environment?: string map, description?, enabled? }`; `plugins.install`: `{ id?, name, version, entrypoint, capabilities?: string[], enabled? }`.
* `leases.heartbeat`: `{ leaseId, leaseToken, leaseDurationMs? }`; release: `{ leaseId, leaseToken, outcome }`. `outcome` uses existing worker/lifecycle outcome values; unresolved release transition must preserve ORC-19 behavior and is not permission to declare success.
* `workers.message`: `{ leaseToken, kind: progress|heartbeat|report|error, sequence: positive integer, payload: JSON, idempotencyKey? }`; report: `{ leaseToken, sequence, outcome: succeeded|failed|cancelled|inconclusive, summary, source: { adapterId, sessionId }, evidence?: { kind, uri?, contentHash?, criterionIds? }[] }`.
* `runs.cancel`: `{ runId, reason, deadlineAt }`; reconcile: `{ runId, observation: JSON }`. These commands do not authorize auto-replay.
* `policy.evaluate`: `{ action, target, context }`; `approvals.request`: `{ action, target, context }`. `action` and `target` are opaque JSON values validated by the current policy service; approval remains bound to the exact action, target and payload digest.
* `verification.get`: `{ runId }`; `review.request`: `{ runId, evidenceIds: string[] }`; `acceptance.get`: `{ taskId, runId }`.
* `events.subscribe`: `{ afterCursor?, taskId?, runId? }`; replay: `{ cursor, limit? }`.
* `providers.streamTask`: `{ taskId, deadlineAt?, systemPrompt? }`; capability list and health have empty payloads; artifact get: `{ artifactId }`.
* `mcp.tools.list`: `{ workerId, leaseToken, serverId, approvalId? }`; tool call: `{ workerId, leaseToken, serverId, toolName, arguments: object, sequence: positive integer, idempotencyKey?, approvalId? }`; plugin execute: `{ workerId, leaseToken, pluginId, capability, input: JSON, sequence: positive integer, idempotencyKey?, approvalId? }`.

Unknown payload object fields are ignored for forward compatibility, but invalid values in defined fields are rejected as `MALFORMED_PAYLOAD`. Required field names and primitive shapes are stable for major version 1. Adapters must not coerce invalid values to defaults when doing so changes lifecycle or authorization meaning.

## Events, sequence, and replay

Event: `{ protocolVersion, kind:"event", messageId, correlationId, causationId, sender, eventType, sequence, cursor, occurredAt, taskId?, runId?, attemptId?, expectedRevision?, payload }`.

`sequence` is a positive monotonically increasing integer per `(subscriptionId, runId)` stream. `cursor` is an opaque stable replay token; clients persist the last fully applied cursor and resume after it. Replay is inclusive of the first event after the supplied cursor. Duplicate `messageId` values are ignored only when canonical content hashes match; reuse with different content is `MESSAGE_ID_CONFLICT`. Gaps are reported and require replay; they are never filled by inference. Events expose durable facts only after their transaction commits. A terminal worker report means verification may begin; it never means task acceptance.

## Lifecycle fencing and idempotency

Snapshot-based client mutations `tasks.update`, `tasks.dependencies.add`, `runs.cancel`, `runs.reconcile`, and `review.request` include the current `expectedRevision`. The Core compares it with the authoritative persisted revision in the same transaction as the mutation; mismatch returns `STALE_REVISION` and has no side effect. Revision is a non-negative safe integer and increments on an accepted lifecycle state change. Other operations preserve their existing atomic preconditions: `workers.claim` checks current task state and global capacity in the claim transaction; lease heartbeat/release requires the current lease token; worker message/report requires lease ownership plus strictly increasing per-run sequence; outbox/inbox consumption uses its persisted claim token and dedupe identity. These are not weakened or replaced with a caller-supplied revision. Retry-safe commands additionally carry an idempotency key; reusing a key with identical canonical input returns the prior result, while different input returns `IDEMPOTENCY_CONFLICT`. Worker messages use `messageId`, lease ownership, and strictly increasing per-run sequence; duplicates and out-of-order messages retain ORC-19/22 dispositions.

## Startup handshake and capabilities

Client hello: `{ ..., kind:"hello", minimumProtocol, maximumProtocol, clientVersion, requiredCapabilities, schemaVersion }`.
Backend welcome: `{ ..., kind:"welcome", selectedProtocol, backendVersion, buildId, schemaVersion, databaseSchemaVersion, processSupervision, ready, capabilities }`.

Capabilities are `{ name, state, reason? }`, where state is `supported`, `unsupported`, `conditional`, or `unverified`. A conditional capability names prerequisites. Missing entries are `unverified`. Handshake succeeds only when a common major is explicitly selected, required schema compatibility holds, `ready` is true, and every required capability is `supported` or `conditional` with all prerequisites explicitly satisfied. A missing, unsupported, unverified, malformed, or incompatible mandatory capability fails closed. No provider/model/transport fallback is implied. The welcome reports the actual process-supervision mode; it does not make a safety claim beyond that mode's evidence.

## Structured errors

Stable codes: `INVALID_ENVELOPE`, `UNSUPPORTED_VERSION`, `FRAME_TOO_LARGE`, `MALFORMED_PAYLOAD`, `METHOD_NOT_FOUND`, `NOT_IMPLEMENTED`, `UNAUTHORIZED_SENDER`, `STALE_REVISION`, `DEADLINE_EXCEEDED`, `CANCELLED`, `LEASE_EXPIRED`, `LEASE_MISMATCH`, `SEQUENCE_CONFLICT`, `MESSAGE_ID_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `POLICY_DENIED`, `APPROVAL_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `PERSISTENCE_UNAVAILABLE`, `PERSISTENCE_ERROR`, `RECOVERY_REQUIRED`, `CAPABILITY_UNAVAILABLE`, `INTERNAL`.

`retryable` is explicit. `INTERNAL` and ambiguous external-effect failures default to `retryable:false` until reconciliation establishes whether retry is safe. Unknown exception text is not a protocol code. Unauthorized senders are rejected before payload dispatch or mutation. A stale revision is a conflict with the current revision in sanitized structured details where disclosure is authorized.

## Shutdown and health

`system.health` reports `{ ready, state, database, protocolVersion, backendVersion, activeRuns, recoveryRequired }`; readiness is false until initialization, handshake, and schema checks complete. Graceful shutdown is requested as `system.shutdown` with a deadline; the service stops accepting new work, persists/flushes committed state, reports outstanding/uncertain work, and exits before the deadline when possible. Deadline expiry is reported as incomplete shutdown; it does not convert active work to success or authorize replay.

## Mapping and unresolved baseline seams

The TypeScript SDK (`src/sdk/contracts.ts`, `src/sdk/orchestrator-sdk.ts`, `src/sdk/repositories.ts`) is the behavioral reference. `orchestrator-worker-v1` handoffs and `src/shared/agent-message.ts` are existing internal worker-message contracts, not this backend IPC protocol. Existing methods can be mapped without changing their lifecycle rules. Some v1 methods require a thin adapter over existing ORC-19/22 behavior; release, explicit event replay cursors, capability handshake, and artifact retrieval are not complete in the TypeScript baseline. This issue freezes their wire shape and error semantics; ORC-36 implements transport/handshake, and later migration slices implement services. ORC-24/25 qualification and provider safety gates remain in force.

Compatibility risks reviewed: opaque IDs avoid TS/Rust type coupling; explicit `expectedRevision` and idempotency preserve fencing; unknown methods/events fail closed; unknown fields may be ignored only when safety does not depend on them; no implicit downgrade or provider substitution; event cursors remain opaque; large payloads cannot bypass artifact provenance; error text is sanitized. The release outcome behavior for `leases.release` and detailed event replay retention remain unresolved and must be mapped before service cutover. Worker SDK capability negotiation and its transport-independent conformance suite remain separately tracked in ORC-50.
