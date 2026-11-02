# ORC-37 Rust SQLite Storage and Cutover Plan

> **For agentic workers:** execute task-by-task with TDD; keep Linear ORC-37 updated as scope and evidence change.

**Goal:** Add a Rust-owned SQLite storage boundary that opens, validates, and exercises the supported TypeScript schema without allowing an unqualified production dual-writer cutover.

**Architecture:** `orchestrator-core` owns one `rusqlite` connection for each process lifetime. It validates the existing schema version, required tables, and consumed columns before readiness, enables foreign keys, and exposes explicit transaction/backup primitives for later service migrations. The TypeScript backend stays the conformance oracle; Rust and TypeScript read/write parity tests use separate disposable databases with shared fixed fixtures, and app-wide ownership cutover remains behind service parity gates.

**Tech Stack:** Rust 2024, rusqlite 0.41.1 with bundled SQLite, Tokio stdio IPC v1, existing TypeScript `better-sqlite3` schema/migration baseline.

**Spec:** Linear ORC-37, ORC-TECH-001, `docs/ARCHITECTURE.md`, `src/persistence/migrations.ts`, `src/persistence/database.ts`, `src/persistence/backup.ts`.

## Global Constraints

- Preserve the TypeScript baseline's `schema_version` table and current version 13; do not introduce a competing `PRAGMA user_version` authority in this slice.
- Do not rewrite existing schema or mutate production data without a compatibility gate and backup/rollback procedure.
- Rust enables `foreign_keys`; WAL is opt-in until Windows packaged compatibility is exercised.
- No application path may write one authoritative responsibility through TypeScript and Rust at the same time.
- Workers, renderer code, and the TypeScript process never receive the Rust SQLite connection.
- SQLite files, backups, WAL artifacts, credentials, and runtime data are not committed.

## Review Focus

1. Missing database path must not create a new empty file by accident.
2. Empty, malformed, future-version, duplicate-version, or missing-required-table databases fail before ready.
3. A failed transaction leaves domain rows, audit chain, and outbox unchanged.
4. Busy/locked and WAL sidecar behavior remain bounded and reopen safely on Windows.
5. Backup destination collision/failure never overwrites the source or reports success.

---

### Task 1: Rust database open and schema compatibility gate

**Files:** Add `orchestrator-core/src/storage.rs`; modify `orchestrator-core/src/lib.rs`, `orchestrator-core/src/main.rs`, and `orchestrator-core/src/ipc.rs`; add Rust and real-process tests.

**Interfaces:** `DatabaseStore::open_existing(path)` opens without `SQLITE_OPEN_CREATE`, sets a finite busy timeout and foreign keys, checks integrity/schema version 13, required tables, and consumed columns, and returns a store with one owned `Connection`. Rust `serve --database <path>` passes the validated schema version and SQLite build version into hello/health metadata; omission preserves the no-database skeleton mode.

- [x] Write failing tests for a current-schema database, missing path, schema versions 0/unsupported/future, duplicate version rows, missing required tables, foreign-key enforcement, and connection ownership.
- [x] Confirm the tests fail against the current runtime.
- [x] Implement existing-file open/validation and bounded startup error reporting. Do not create or migrate a file at startup.
- [x] Run focused Rust unit and Node real-process tests; verify no protocol response is sent on failed database validation.

### Task 2: Explicit WAL, transaction, and backup primitives

**Files:** Modify `orchestrator-core/src/storage.rs` and the Rust integration suite; add Windows-compatible disposable-database fixtures.

**Interfaces:** WAL activation is an explicit opt-in after the existing-file gate. `DatabaseStore::transaction` uses `TransactionBehavior::Immediate`, commits only on success, and rolls back on every error/drop path. `DatabaseStore::backup_into(destination)` writes a consistent SQLite snapshot to a new destination and never replaces an existing file.

- [x] Add failing tests for WAL mode, foreign-key rejection, immediate-transaction rollback/commit, busy timeout, checkpoint/reopen, backup/restore/integrity/destination collision, and bounded SQLite-full rollback.
- [x] Confirm each test fails for the missing storage behavior.
- [x] Implement WAL opt-in, transaction helper, and consistent backup using rusqlite-supported APIs.
- [x] Re-run focused tests on Windows x64 and verify the packaged Rust binary reports the same SQLite source version/configuration.

### Task 3: Schema and write parity against the TypeScript baseline

**Files:** Add the smallest Rust persistence operation required by the parity evidence; add an Electron-targeted TypeScript baseline test and Rust storage tests using the same fixed event fixture against separate disposable databases; update `package.json` test counts/scripts.

**Interfaces:** Add `DatabaseStore::list_tasks() -> Result<Vec<TaskRecord>, StoreError>` and `DatabaseStore::append_durable_event(event_type, payload_json, created_at, correlation_json, idempotency_key) -> Result<AuditEvent, StoreError>`. Shared fixtures pin the task read projection and the exact event JSON/hash. Electron tests create schema-13 databases through `applyMigrations` and verify TypeScript repository projections; Rust reads/writes the same fixtures in isolated schema-13 databases and verifies matching projections. Write operations are not exposed through IPC, so there is no shared live database or concurrent writer. Never open both writers against the same database in parallel.

- [x] Add failing parity tests with a fixed timestamp/payload, including idempotent replay and injected failure rollback.
- [x] Confirm the parity assertions fail before Rust persistence is implemented.
- [x] Implement `append_durable_event` with the TypeScript baseline's append-order hash chain, idempotency conflict behavior, and one transaction for audit + outbox; leave full lifecycle/policy/recovery services to ORC-38 through ORC-40.
- [x] Run focused Electron and Rust parity suites; record exact row/hash/count differences and prove rollback is atomic.

### Task 4: Cutover and rollback evidence

**Files:** Add `docs/persistence/rust-sqlite-cutover.md`; update README/architecture only where current runtime status needs clarification; record evidence in Linear.

- [x] Document supported DB versions, foreign-key/WAL/busy settings, SQLite source version, backup procedure, restart/checkpoint flow, and bounded rollback to TypeScript before any Rust-owned writes.
- [x] State the exact production cutover boundary and record the app-safe responsibility gate as deferred to matching service migration issues; no production writer was transferred.
- [x] Run `cargo fmt --all --check`, `npm run build`, focused Rust/storage parity tests, full `npm test`, and Windows packaging on the final source state; the packaged executable passes default/WAL/reopen smoke tests.
- [ ] Record commands, counts, failure injection results, commit/revision, backup/reopen evidence, and remaining unverified conditions in Linear ORC-37; only then mark Done.
