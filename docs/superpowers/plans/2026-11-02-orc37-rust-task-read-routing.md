# ORC-37 Rust Task Read Routing Implementation Plan

> **For agentic workers:** This slice is implemented in the current session with test-first steps.

**Goal:** Use Rust for the Electron owned-fixture task lookup while preserving TypeScript lifecycle writes.

**Architecture:** Extend `RustTaskReader` with the frozen `tasks.get` request and validate either the complete v1 Task projection or `null`. Require the capability during Electron startup and route both fixture runners through the reader.

**Tech Stack:** Rust core IPC v1, TypeScript, Electron, SQLite schema 13.

**Spec:** ORC-37, `docs/persistence/rust-sqlite-cutover.md`, and `docs/protocol/v1/contract.md`.

## Global Constraints

- Rust remains the selected backend runtime authority; TypeScript is the client and conformance baseline.
- SQLite WAL remains enabled; preserve the schema-13 database and frozen v1 `tasks.get` semantics.
- Keep trusted sender checks and fail-closed behavior; do not add a TypeScript read fallback.
- Lifecycle writes remain TypeScript-owned until their ordered migration.

## Review Focus

- Existing task IDs return the exact full Task shape, including optional IDs and token budget.
- Missing task IDs return `null` without converting absence into a persistence error.
- Rust startup/capability failure cannot fall back to the TypeScript task repository.
- Both fixture runners use the Rust read path before performing TypeScript-owned lifecycle work.
- Existing renderer trust checks and task risk-tier gates remain intact.

### Task 1: Rust-backed task lookup in Electron fixture paths

**Files:**
- Modify: `src/main/rust-task-reader.ts`
- Modify: `src/main/main.ts`
- Test: `tests/rust-task-creator.test.ts`
- Regression test: `tests/owned-fixture.test.ts`

**Interfaces:** `RustTaskReader.get(taskId: string): Promise<Task | null>` sends `tasks.get`; main-process fixture handlers await it.

- [x] Extend the existing real-core test to require full projection parity and null-on-missing.
- [x] Run that suite to confirm the new assertion fails because `RustTaskReader.get` is absent.
- [x] Implement the reader method and route both fixture task lookups through it; require `tasks.get` in Electron's handshake.
- [x] Run `npm test`, `npm run package:win`, and the focused Electron fixture/storage suites.
- [ ] Commit, push, merge, and record evidence in ORC-37 without closing the parent issue.
