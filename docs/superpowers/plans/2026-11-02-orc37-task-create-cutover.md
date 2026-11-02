# ORC-37 Task Creation Cutover Plan

> ORC-37 incremental cutover work. Execute test-first; keep ORC-38 blocked until acceptance evidence is complete.

**Goal:** Route the production `tasks.create` responsibility through the Rust core, preserving task, revision, idempotency, audit and outbox semantics, with fail-closed behavior and no TypeScript fallback.

**Architecture:** Keep the frozen IPC v1 method and payload contract. Rust owns the atomic task-create write set. Electron main starts one Rust child against the existing schema-13 database and routes UI and GitHub imports through it; legacy TypeScript SDK code remains the conformance baseline, not an alternate production writer.

**Tech Stack:** Rust 2024, rusqlite 0.41.1 with bundled SQLite, serde_json, Electron 44, TypeScript 5.9, framed local stdio IPC v1.

**Spec:** Linear ORC-37 and frozen `docs/protocol/v1/schema.json`.

## Constraints

- Do not alter the frozen IPC v1 schema or silently widen Rust authority beyond `tasks.create`.
- Do not run TypeScript fallback after Rust startup, request, or persistence failure.
- Keep task row, revision-1 row, optional task command key, two durable events, and their outbox rows atomic.
- Preserve TypeScript's canonical validation, command payload hashing, revision snapshot hashing, event payloads and idempotency behavior.
- Existing DB must be schema 13; startup fails closed on unsupported or invalid schema.
- Keep other lifecycle writes on the existing path until their ordered migration issue.
- Do not claim provider-backed/live task qualification from fixture tests.

## Review Focus

1. Duplicate idempotency key with changed payload must fail without mutation.
2. A failed later insert must roll back task, revision, command, events and outbox together.
3. Rust unavailable or IPC timeout must not invoke TypeScript task creation.
4. App startup/quit must not leak the core process or its DB connection.
5. GitHub issue import must use the same Rust-owned creator as UI task intake.

## Tasks

### 1. Rust storage parity

Add failing tests for task row/revision/event/outbox projection, idempotent retry and conflict, and rollback after an injected constraint failure. Implement `DatabaseStore::create_task` with an immediate transaction and deterministic TypeScript-compatible JSON/hash inputs.

### 2. IPC operation and capability

Add protocol process tests proving `tasks.create` is advertised and writes only through the open Rust store, including fail-closed malformed/no-database behavior and retry identity. Keep request deduplication and persisted idempotency distinct.

### 3. Electron routing

Add tests first for main-process Rust startup/client wiring and no fallback. Route renderer task creation and GitHub issue import through one Rust task-creation client. Keep the TS SDK baseline unchanged and document it as non-authoritative in the cutover mode.

### 4. Recovery, packaging and evidence

Test Rust restart and idempotent retry against the same DB, packaged executable resolution, orderly shutdown, and rollback instructions. Run canonical tests, package and smoke checks. Record RED/GREEN, command exits, test counts, environment, hashes, revision and gaps in evidence and Linear.

### 5. Handoff

Commit and push the feature branch, merge to `master` only after verification and review, read back Linear, and unblock ORC-38 only if ORC-37 acceptance is actually met.
