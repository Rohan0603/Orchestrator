# ORC-37 Rust Schema Migrations Implementation Plan

> **For agentic workers:** Implement this slice in the current session with test-first steps.

**Goal:** Give Rust a transactional migration runner over the existing AgentConductor schema, using the exact migration SQL shared with the TypeScript conformance baseline.

**Architecture:** Move the 13 existing SQL bodies to one JSON resource imported by TypeScript and embedded by Rust. Rust applies pending migrations inside one immediate transaction, updates `schema_version` after each migration, and performs the existing immutable task-revision backfill before commit. Expose a one-shot `migrate --database <path>` command; application startup routing follows after parity evidence.

**Tech Stack:** Rust, rusqlite 0.41.1 with bundled SQLite, serde_json, sha2, uuid, TypeScript, Electron.

**Spec:** ORC-37 and `docs/persistence/rust-sqlite-cutover.md`.

## Global Constraints

- Preserve all 13 historical SQL migrations and schema version semantics.
- Do not add a second schema-version authority; keep `schema_version` as the sole authority.
- Migration DDL, row backfill, and version updates must commit or roll back together.
- Preserve TypeScript as the migration conformance baseline until Rust is routed into production startup.
- Do not modify `MVP_plan.md` or generated build output.

## Review Focus

- Fresh databases and versions 1 through 12 reach schema 13 with equivalent rows.
- Existing schema-13 databases are unchanged by a repeat migration.
- Invalid legacy task JSON fails closed and leaves both version and schema unchanged.
- Task-revision JSON field order, SHA-256, created time, and deterministic row ordering match TypeScript.
- Unsupported future versions and duplicate/missing version records fail without partial changes.

### Task 1: Transactional Rust migration runner

**Files:**
- Create: `src/persistence/migrations.json`
- Modify: `src/persistence/migrations.ts`, `tsconfig.json`
- Modify: `orchestrator-core/src/storage.rs`, `orchestrator-core/src/main.rs`
- Test: `orchestrator-core/src/storage.rs` migration tests

**Interfaces:** `DatabaseStore::migrate_existing(path: &Path) -> Result<u32, StoreError>` and CLI `orchestrator-core migrate --database <path>`.

- [ ] Add schema-12 success and malformed-backfill rollback tests first.
- [ ] Verify RED failure is the missing Rust migration API.
- [ ] Extract the SQL list to shared JSON and keep TypeScript migrations on the same source.
- [ ] Implement all pending migrations and the task-revision backfill in one SQLite transaction.
- [ ] Add the one-shot Rust migration command with sanitized failure output.
- [ ] Run TypeScript migration regressions, Rust tests, canonical suite, packaging, and migration parity checks.
- [ ] Commit, push, merge, update Linear, and leave ORC-37 open for production startup cutover and remaining gates.
