# AgentConductor Core IPC protocol v1

Status: frozen contract for incremental TypeScript-to-Rust migration. This is the private local Core API boundary between the TypeScript shell/client and the Rust Core. The selected v1 transport and its process-ownership assumptions are specified below; Electron renderer-to-main IPC and Rust types are not part of the wire format. `orchestrator-ipc` remains a technical protocol identifier pending the separate naming migration in ORC-53.

The approved AgentConductor mission is a durable local control plane for autonomous software engineering: typed workers, deterministic orchestration, governed actions, isolated Git workspaces, evidence-backed completion, and crash-safe recovery. This contract serves the approved three-plane architecture: the trusted Core owns lifecycle, policy, routing, scheduling, reconciliation, evidence, telemetry, SQLite, and outbox; the Worker Plane produces untrusted claims through adapters; and the Source Plane owns Git repositories, per-attempt worktree leases, and artifacts. One active Worker remains the v0.1 limit.

ORC-33 freezes the Core API and TS↔Rust IPC. It does not define the separate Worker SDK wire protocol or the Electron renderer bridge. Worker command/event/request/response envelopes, worker capability negotiation, adapter conformance, and transport variants belong to ORC-50. Core methods named `workers.*` are service operations used by trusted adapters/clients; they never grant workers direct SQLite access or new execution authority. The Rust stack, SQLite WAL ownership and incremental cutover remain unchanged.

## Framing and limits

The v1 protocol uses UTF-8 JSON frames, each prefixed by a 4-byte unsigned big-endian byte length. The length is the JSON body's UTF-8 byte count, excluding the prefix. Zero-length frames, invalid UTF-8, invalid JSON, and frames over 1,048,576 bytes fail closed before dispatch. EOF between frames is normal shutdown; EOF within a prefix/body is a truncated-frame error. One frame contains exactly one JSON value.

### Selected v1 transport: supervised private stdio

The trusted Electron main process (or another trusted local Node host) starts the Rust executable directly with `shell:false` and private inherited stdin/stdout/stderr pipes. Stdout carries protocol frames only; stderr is drained as diagnostics. No TCP listener, named pipe, or renderer-owned process/transport is created. The parent owns the child handle and is responsible for requesting graceful shutdown and terminating that child if its shutdown deadline expires.

The OS trust boundary is the parent process and its private inherited pipe handles. The `sender` tuple is pinned to the identity negotiated in `hello` and checked on every envelope, but it is correlation metadata; it is not treated as independent OS authentication. Any future host that can share a pipe with an untrusted local process must add and qualify a separate OS-authenticated boundary before use.

An interrupted frame, malformed response, request timeout, or unexpected child exit poisons that client instance. It fails all outstanding requests and closes/terminates only the owned child; it does not resume a partial frame, retry a request, or replay a potentially completed effect. Reconnection means starting a new child and completing a fresh handshake. Client queues are bounded to 32 pending requests and 4 MiB of encoded pending request frames by default (both configurable to positive finite limits); each startup, request, and shutdown operation has a finite deadline. Queue saturation is rejected before enqueue. At this migration stage, Rust supports health and capability queries, `tasks.create`, and `tasks.list`; other registered methods remain `NOT_IMPLEMENTED` until their migration issues deliver them.

Payloads over the limit must be stored as artifacts and represented by an artifact reference (`artifactId`, `uri`, `sha256`, `sizeBytes`, `mediaType`). Receivers verify the hash and size when reading. A local path is metadata, not authorization to read arbitrary files.

## Version and compatibility

`protocolVersion` is the integer major version (`1`). A peer must reject a different major with `UNSUPPORTED_VERSION`. New optional fields and new capabilities may be added within major version 1. Receivers ignore unknown object fields, but senders must not make an unknown field necessary to preserve safety or meaning. New method names and event types are not silently ignored: an unknown method returns `METHOD_NOT_FOUND`; an unknown event type is surfaced as `UNKNOWN_EVENT` and is not applied. Changes to existing field meaning, requiredness, enum values, ordering, idempotency, or lifecycle behavior require a new major version. A new major may coexist only through explicit handshake negotiation; no implicit downgrade is permitted.

Arrays preserve their specified order. Objects have no ordering guarantee. Timestamps are canonical UTC RFC 3339 strings with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Durations are positive integer milliseconds. Identifiers are opaque printable ASCII strings (U+0020–U+007E), 1–200 characters; clients must not infer structure from them.

## Shared envelope fields

Requests, responses, events, and hello messages contain `protocolVersion`, `messageId`, `correlationId`, `causationId` (string or null), and `sender: { id, role }`. IDs are opaque. For v1 supervised stdio, the peer boundary is the owning parent process and its private inherited pipes; the `sender` field is pinned to the negotiated tuple as correlation metadata, not independent OS authentication. Applicable task/run/attempt/lease IDs, `expectedRevision`, `deadlineAt`, and `sequence` are explicit fields, never hidden in transport state. Optional `traceContext: { traceparent, tracestate? }` carries W3C trace context unchanged; it is observability metadata and grants no authority. V1 accepts version-00 traceparent values with nonzero 32-hex trace IDs and 16-hex span IDs; optional `tracestate` is limited to 512 printable ASCII bytes. Invalid trace context rejects the envelope.

All messages are JSON objects. Unknown fields are ignored for v1 only after known fields have been validated. `extensions` is the preferred namespace for optional producer metadata. Receivers must preserve safety checks even when extension data is present.

## Request and response

Request: `{ protocolVersion, kind:"request", messageId, correlationId, causationId, sender, method, taskId?, runId?, attemptId?, leaseId?, expectedRevision?, deadlineAt?, payload }`.

Response: `{ protocolVersion, kind:"response", messageId, correlationId, causationId, sender, inReplyTo, ok:true, result }` or `{ ..., inReplyTo, ok:false, error:{ code, message, retryable, details? } }`. `inReplyTo` is the request's `messageId`. Error messages are safe summaries; secrets, provider payloads, SQL and arbitrary exception text must not be returned. `details` is optional structured JSON with a stable schema for that error code.

The initial method registry is grouped by domain:

| Method | Payload | Result | Baseline status |
| -- | -- | -- | -- |
| `system.health` | `{}` | readiness and backend identity | Rust v1 transport stub; database fields reflect no database opened |
| `system.shutdown` | `{ deadlineAt }` | shutdown disposition | reserved; initial Rust transport shuts down on parent stdin EOF |
| `projects.create` | project metadata | project | TypeScript SDK |
| `projects.get` | `{ projectId }` | project or null | TypeScript SDK |
| `projects.list` | `{}` | project array | TypeScript SDK |
| `tasks.create` | CreateTaskInput | task | Rust atomic adapter; TypeScript SDK conformance baseline |
| `tasks.update` | `{ taskId, content }` | task | TypeScript SDK |
| `tasks.get` | `{ taskId }` | task or null | TypeScript SDK |
| `tasks.list` | `{}` | task array | Rust full Task projection; TypeScript SDK conformance baseline |
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
| `leases.release` | `{ leaseId, leaseToken, outcome }` | release disposition | reserved; TypeScript baseline returns `NOT_IMPLEMENTED` without side effects |
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
| `events.replay` | `{ cursor, limit? }` | ordered events and next cursor | cursor semantics frozen; adapter pending; unresolved cursor returns `CURSOR_UNAVAILABLE` |
| `providers.streamTask` | `{ taskId, deadlineAt?, systemPrompt? }` | stream ID | SDK direct provider path; route qualification remains separate |
| `mcp.tools.list` | `{ workerId, leaseToken, serverId, approvalId? }` | tool descriptors | TypeScript SDK; lease/policy gates retained |
| `mcp.tools.call` | `{ workerId, leaseToken, serverId, toolName, arguments, sequence, idempotencyKey?, approvalId? }` | tool result | TypeScript SDK; lease/policy gates retained |
| `plugins.execute` | `{ workerId, leaseToken, pluginId, capability, input, sequence, idempotencyKey?, approvalId? }` | JSON result | TypeScript SDK; trusted local code and lease/policy gates retained |
| `capabilities.list` | `{}` | capability manifest | Rust v1 manifest; unmigrated service capabilities remain unverified |
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
* `leases.heartbeat`: `{ leaseId, leaseToken, leaseDurationMs? }`; release: `{ leaseId, leaseToken, outcome: succeeded|failed|cancelled|inconclusive }`. The release method is reserved and currently returns `NOT_IMPLEMENTED` without changing lease, attempt, or run state. `outcome` is an untrusted caller claim, never proof of completion or acceptance. A worker terminal report follows the existing report transaction, which closes the lease as completed and advances the attempt/run; lease expiry closes it as expired and moves the run to `recovery_required` without auto-replay.
* `workers.message`: `{ leaseToken, kind: progress|heartbeat|report|error, sequence: positive integer, payload: JSON, idempotencyKey? }`; report: `{ leaseToken, sequence, outcome: succeeded|failed|cancelled|inconclusive, summary, source: { adapterId, sessionId }, evidence?: { kind, uri?, contentHash?, criterionIds? }[] }`.
* `runs.cancel`: `{ runId, reason, deadlineAt }`; reconcile: `{ runId, observation: JSON }`. These commands do not authorize auto-replay.
* `policy.evaluate`: `{ action, target, context }`; `approvals.request`: `{ action, target, context }`. `action` and `target` are opaque JSON values validated by the current policy service; approval remains bound to the exact action, target and payload digest.
* `verification.get`: `{ runId }`; `review.request`: `{ runId, evidenceIds: string[] }`; `acceptance.get`: `{ taskId, runId }`.
* `events.subscribe`: `{ afterCursor?, taskId?, runId? }`; replay: `{ cursor, limit? }`. `limit` is a positive maximum page size; the default is adapter-defined and must be reported consistently. `nextCursor` is the last returned event cursor, or the input cursor for an empty page.
* `providers.streamTask`: `{ taskId, deadlineAt?, systemPrompt? }`; capability list and health have empty payloads; artifact get: `{ artifactId }`.
* `mcp.tools.list`: `{ workerId, leaseToken, serverId, approvalId? }`; tool call: `{ workerId, leaseToken, serverId, toolName, arguments: object, sequence: positive integer, idempotencyKey?, approvalId? }`; plugin execute: `{ workerId, leaseToken, pluginId, capability, input: JSON, sequence: positive integer, idempotencyKey?, approvalId? }`.

Unknown payload object fields are ignored for forward compatibility, but invalid values in defined fields are rejected as `MALFORMED_PAYLOAD`. Required field names and primitive shapes are stable for major version 1. Adapters must not coerce invalid values to defaults when doing so changes lifecycle or authorization meaning.

## Events, sequence, and replay

Event: `{ protocolVersion, kind:"event", messageId, correlationId, causationId, sender, eventType, sequence, cursor, occurredAt, taskId?, runId?, attemptId?, expectedRevision?, payload }`.

`sequence` is a positive monotonically increasing integer per `(subscriptionId, runId)` stream. `cursor` is an opaque stable replay token; clients persist the last fully applied cursor and resume strictly after it. Replay pages are ordered and exclusive of the supplied cursor; `nextCursor` advances to the last returned event, and an empty page preserves the input cursor. Durable event rows are retained by the current TypeScript baseline with no automatic TTL or pruning. V1 defines no retention horizon and does not imply that data may be deleted. If a cursor cannot be resolved (including after an external restore or a future explicitly approved retention policy), the adapter returns `CURSOR_UNAVAILABLE` with no events and does not silently reset to the head or tail; the client must surface a recovery decision. Duplicate `messageId` values are ignored only when canonical content hashes match; reuse with different content is `MESSAGE_ID_CONFLICT`. Gaps are reported and require replay; they are never filled by inference. Events expose durable facts only after their transaction commits. A terminal worker report means verification may begin; it never means task acceptance.

## Lifecycle fencing and idempotency

Snapshot-based client mutations `tasks.update`, `tasks.dependencies.add`, `runs.cancel`, `runs.reconcile`, and `review.request` include the current `expectedRevision`. The Core compares it with the authoritative persisted revision in the same transaction as the mutation; mismatch returns `STALE_REVISION` and has no side effect. Revision is a non-negative safe integer and increments on an accepted lifecycle state change. Other operations preserve their existing atomic preconditions: `workers.claim` checks current task state and global capacity in the claim transaction; lease heartbeat/release requires the current lease token; worker message/report requires lease ownership plus strictly increasing per-run sequence; outbox/inbox consumption uses its persisted claim token and dedupe identity. These are not weakened or replaced with a caller-supplied revision. Retry-safe commands additionally carry an idempotency key; reusing a key with identical canonical input returns the prior result, while different input returns `IDEMPOTENCY_CONFLICT`. Worker messages use `messageId`, lease ownership, and strictly increasing per-run sequence; duplicates and out-of-order messages retain ORC-19/22 dispositions.

## Startup handshake and capabilities

Client hello: `{ ..., kind:"hello", minimumProtocol, maximumProtocol, clientVersion, requiredCapabilities, schemaVersion }`.
Backend welcome: `{ ..., kind:"welcome", selectedProtocol, backendVersion, buildId, schemaVersion, databaseSchemaVersion, processSupervision, ready, capabilities }`.

Capabilities are `{ name, state, reason? }`, where state is `supported`, `unsupported`, `conditional`, or `unverified`. A conditional capability names prerequisites. Missing entries are `unverified`. Handshake succeeds only when a common major is explicitly selected, required schema compatibility holds, `ready` is true, and every required capability is `supported` or `conditional` with all prerequisites explicitly satisfied. A missing, unsupported, unverified, malformed, or incompatible mandatory capability fails closed. No provider/model/transport fallback is implied. The welcome reports the actual process-supervision mode; it does not make a safety claim beyond that mode's evidence.

## Structured errors

Stable codes: `INVALID_ENVELOPE`, `UNSUPPORTED_VERSION`, `FRAME_TOO_LARGE`, `MALFORMED_PAYLOAD`, `METHOD_NOT_FOUND`, `NOT_IMPLEMENTED`, `UNAUTHORIZED_SENDER`, `STALE_REVISION`, `DEADLINE_EXCEEDED`, `CANCELLED`, `LEASE_EXPIRED`, `LEASE_MISMATCH`, `SEQUENCE_CONFLICT`, `MESSAGE_ID_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CURSOR_UNAVAILABLE`, `POLICY_DENIED`, `APPROVAL_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `PERSISTENCE_UNAVAILABLE`, `PERSISTENCE_ERROR`, `RECOVERY_REQUIRED`, `CAPABILITY_UNAVAILABLE`, `INTERNAL`.

`retryable` is explicit. `INTERNAL` and ambiguous external-effect failures default to `retryable:false` until reconciliation establishes whether retry is safe. Unknown exception text is not a protocol code. Unauthorized senders are rejected before payload dispatch or mutation. A stale revision is a conflict with the current revision in sanitized structured details where disclosure is authorized.

## Shutdown and health

`system.health` reports `{ ready, state, database, protocolVersion, backendVersion, activeRuns, recoveryRequired }`; readiness is false until initialization, handshake, and schema checks complete. The full service-level `system.shutdown` operation uses a deadline: the service stops accepting new work, persists/flushes committed state, reports outstanding/uncertain work, and exits before the deadline when possible. It remains reserved in the initial Rust transport slice, which performs orderly shutdown when the owning parent closes stdin; the parent waits for the child and terminates only that owned process if its finite close deadline expires. Deadline expiry is reported as incomplete shutdown; it does not convert active work to success or authorize replay.

## Mapping and baseline seams

The TypeScript SDK (`src/sdk/contracts.ts`, `src/sdk/orchestrator-sdk.ts`, `src/sdk/repositories.ts`) is the behavioral reference. `orchestrator-worker-v1` handoffs and `src/shared/agent-message.ts` are existing internal worker-message contracts, not this backend IPC protocol. Existing methods can be mapped without changing their lifecycle rules. `leases.release` is reserved and returns `NOT_IMPLEMENTED` in the baseline; explicit replay cursors and capability handshake are protocol-defined but await adapters; artifact retrieval remains repository-specific. ORC-36 implements transport/handshake, and later migration slices implement services. ORC-24/25 qualification and provider safety gates remain in force.

Compatibility risks reviewed: opaque IDs avoid TS/Rust type coupling; explicit `expectedRevision` and idempotency preserve fencing; unknown methods/events fail closed; unknown fields may be ignored only when safety does not depend on them; no implicit downgrade or provider substitution; event cursors remain opaque and unrecoverable cursors fail explicitly; large payloads cannot bypass artifact provenance; error text is sanitized. V1 establishes no event-retention horizon; changing this requires an explicit approved policy and cannot silently invalidate cursors. `leases.release` remains non-operational until a later approved slice defines lifecycle behavior. Worker SDK capability negotiation and its transport-independent conformance suite remain separately tracked in ORC-50.
