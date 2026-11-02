# Rust SQLite Compatibility and Cutover Record

## Current support boundary

`orchestrator-core` uses `rusqlite` 0.41.1 with bundled SQLite. This slice
accepts only the existing TypeScript schema version 13 stored in the
`schema_version` table. It does not create, migrate, or rewrite a database on
startup and does not use `PRAGMA user_version` as a second schema authority.
Opening a configured database requires an existing file, a successful SQLite
quick check and foreign-key check, one schema version row with value 13, and the
core task/lifecycle, audit, outbox, evidence, and recovery tables.
The compatibility gate also checks the columns consumed by the storage and
parity operations, including the event correlation/idempotency fields and
outbox retry fields.

The Rust process owns one SQLite connection. It enables foreign keys on that
connection and sets a 250 ms busy timeout. The configured database is rejected
before protocol readiness when validation fails. The hello reports the
validated application schema version; `system.health` additionally reports the
bundled SQLite source version and journal mode.

WAL is off by default. The explicit `--enable-wal` startup option changes the
database journal mode only after the existing-file compatibility gate has
passed. `DatabaseStore::checkpoint_wal` uses a truncating checkpoint and fails
closed if SQLite reports a blocked checkpoint. Packaged Windows x64 validation
is required before application configuration selects this option by default.
Once explicitly enabled, SQLite's journal mode persists in the database; a
later startup without the flag leaves that mode intact.

## Transaction and backup behavior

`DatabaseStore::transaction` begins with `TransactionBehavior::Immediate` and
commits only when the operation returns successfully. Any operation or commit
error drops the transaction and leaves its writes rolled back. The durable
event primitive writes the append-order audit hash and outbox row in one such
transaction; a fixed fixture shared with the TypeScript baseline pins its JSON,
idempotency key, and expected SHA-256 hash.

`DatabaseStore::list_tasks` reads the schema-13 task projection in the same
`created_at DESC` order as the TypeScript `TaskRepository.list()` baseline. A
shared task fixture pins task identity, content, acceptance criteria, risk,
status, and timestamp for the isolated read parity tests.

`DatabaseStore::backup_into` reserves a destination with create-new semantics,
then uses SQLite's online backup API. It never replaces an existing target and
removes its own incomplete target and sidecars after a failed copy. The restored
copy must pass `PRAGMA integrity_check` and retain the expected schema and
durable rows. This primitive is not yet exposed as an Electron user or operator
workflow, so the TypeScript backup path remains the application procedure.

The disposable-database disk-full test uses SQLite's `max_page_count` limit to
force a `SQLITE_FULL`-equivalent write failure and verifies full transaction
rollback. It does not simulate a physically exhausted Windows volume.

## Migration and rollback procedure

1. Stop the Electron application and ensure no process is using its database.
2. Create and verify a backup through the currently supported TypeScript
   backup workflow. Retain the source and backup as separate files.
3. Run the packaged Rust compatibility check against a disposable copy first.
   Confirm schema version 13, bundled SQLite source version, journal mode, and
   integrity checks before selecting any Rust-owned service.
4. Keep the TypeScript backend as the only application writer until the
   matching service migration has passed parity and fault qualification.
5. For a future approved service cutover, stop the application, back up the
   database, switch that responsibility to Rust, then verify restart and
   rollback on the disposable copy before using the new owner on user data.
6. To roll back before any Rust-owned production writes, stop Rust and reopen
   the unchanged database through the TypeScript backend. If a future Rust
   owner has written production rows, restore the pre-cutover backup or use an
   explicitly qualified reverse migration; do not run both writers against
   the same responsibility.

## Production cutover status

No Electron application responsibility is transferred by ORC-37. Electron
continues to create and own the application database through TypeScript. Rust
can validate an existing database, report metadata, and exercise storage
primitives in isolated tests, but the Electron shell does not pass its live
database path to Rust and the v1 IPC registry has no Rust storage-write
operation. There is therefore no application dual-writer period and no claim
that lifecycle ownership has cut over. The bounded event operation is a Rust
storage capability for parity evidence; it is not routed into production.

The next service migrations must preserve that boundary: define one responsibility,
prove parity on separate database copies, qualify the restart/failure path, and
only then route it to Rust while disabling the TypeScript writer for that
responsibility. WAL-default selection, an operator-facing Rust backup flow,
full lifecycle repositories, abrupt process-death qualification, and release
cutover remain open gates for the corresponding migration issues.

The Windows x64 packaged compatibility smoke was run with Electron 44.9.3 and
Node ABI 149. The packaged Rust executable reported bundled SQLite 3.54.1,
opened the TypeScript-created schema-13 fixture in default `delete` journal
mode, then opened it with explicit WAL selection and reported `wal`. WAL remained
readable on the next open. This qualifies the packaged WAL primitive on the
tested local Windows environment; it does not select WAL for the application.
