# Rust SQLite Compatibility and Cutover Record

## Current support boundary

`orchestrator-core` uses `rusqlite` 0.41.1 with bundled SQLite. Its `serve`
command accepts only schema version 13 stored in the `schema_version` table.
Electron first invokes the Rust `migrate` command to create or upgrade the
database, then opens it through TypeScript in validation-only mode. The Rust
serve process does not migrate the database or use PRAGMA user_version as a
second schema authority. Opening a configured database
requires an existing file, a successful SQLite quick check and foreign-key
check, one schema version row with value 13, and the core task/lifecycle, audit,
outbox, evidence, and recovery tables.
The compatibility gate also checks the columns consumed by the storage and
parity operations, including the event correlation/idempotency fields and
outbox retry fields.

The Rust migration command validates and applies the shared versioned SQL
migrations transactionally. After it succeeds, TypeScript opens the existing
database without applying migrations and checks that exactly one current
schema-version row is present. Electron then starts the Rust service against
that path. The Rust process owns one SQLite connection, enables foreign keys
on that connection, and sets a 250 ms busy timeout. The configured database is
rejected before protocol readiness when validation fails. The hello reports
the validated application schema version; `system.health` additionally reports
the bundled SQLite source version and journal mode.

The core's standalone default remains the database's existing journal mode.
The Electron application and headless CLI pass `--enable-wal`; Rust changes the
mode only after the existing-file compatibility gate has passed. The packaged
Windows x64 compatibility smoke verified default-mode open, explicit WAL,
checkpoint/reopen behavior, task create/list and SQLite 3.54.1 under Electron
44.9.3/ABI 149. `DatabaseStore::checkpoint_wal` uses a truncating checkpoint
and fails closed if SQLite reports a blocked checkpoint. Once enabled,
SQLite's journal mode persists in the database; the Electron and CLI startup
flags reassert WAL on each open.

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
then uses SQLite's online backup API. The Rust `backup` CLI validates the source,
creates the copy, reopens and validates the result, and reports the schema
version only after validation succeeds. It never replaces an existing target
and attempts to remove its own incomplete target and sidecars after a failed
copy. If the operating system refuses that cleanup, remove the incomplete
destination before retrying. The restored copy must pass `PRAGMA integrity_check`
and retain the expected schema and durable rows. The TypeScript backup path
remains available for the current application workflow.

The disposable-database disk-full test uses SQLite's `max_page_count` limit to
force a `SQLITE_FULL`-equivalent write failure and verifies full transaction
rollback. It does not simulate a physically exhausted Windows volume.

## Migration and rollback procedure

1. Stop the Electron application and ensure no process is using its database.
2. Create a new Rust online backup with
   `orchestrator-core backup --database <source> --destination <new-path>`.
   The command refuses an existing destination and validates the completed
   backup before reporting its schema version. Retain the source and backup as
   separate files.
3. On a disposable copy, run the Rust `migrate --database <path>` command and
   then the packaged Rust compatibility check. Confirm schema version 13,
   bundled SQLite source version, journal mode, and integrity checks before
   selecting any Rust-owned service.
4. The first cutover responsibility is `tasks.create`: Electron UI, GitHub
   issue import, and headless CLI requests go through Rust IPC. Rust atomically
   writes the task, revision 1, optional command key, audit facts and outbox
   rows. There is no TypeScript fallback on Rust startup, request, or database
   failure.
5. Electron `tasks.list` uses the Rust read projection and returns the full
   frozen v1 Task shape. The direct TypeScript SDK remains the read-conformance
   baseline. If the core is unavailable, the desktop list operation fails
   closed instead of querying through a second backend.
6. Electron fixture execution and GitHub import/sync entrypoints use Rust
   `tasks.get` for the full v1 Task projection; missing IDs return `null`, and
   startup requires the capability before those entrypoints can run. The
   legacy direct TypeScript SDK remains the conformance baseline.
7. Other lifecycle writes remain TypeScript-owned until their ordered issue
   migrations. The legacy direct TypeScript SDK remains a conformance
   baseline; the production desktop and CLI task-create entrypoints do not use
   its `TaskRepository.create` implementation.
8. To roll back these bounded responsibilities, stop the application so Rust has
   closed its connection, then run the previous application revision against
   the same schema-13 database. The TypeScript create implementation recognizes
   an existing command key and the same durable rows. If the backup or parity
   check fails, restore the verified pre-cutover backup. Never run both writers
   for task creation at once.

## Production cutover status

ORC-37 transfers startup schema migration ownership and bounded
`tasks.create`, Electron `tasks.list`, and Electron fixture/GitHub `tasks.get`
responsibilities.
The core advertises each frozen v1 method as supported only after implementing
its behavior. Electron startup fails closed if the core executable or required
handshake is unavailable; task creation, listing, and fixture/GitHub task lookup
never fall back to TypeScript. The legacy direct SDK remains a conformance
baseline pending ORC-43;
do not use it as an alternate production writer during this migration.

The task-create tests prove TypeScript-compatible task command hashing, task
and revision projections, audit hash chaining, persistent idempotent retry
after Rust restart, conflict rejection, and full rollback when a later audit
insert fails. Rust task-reader tests prove exact full-projection reads and
null-on-missing behavior; the Electron fixture and GitHub paths use that reader.
GitHub status writes remain on the TypeScript lifecycle baseline until their
ordered migration. The next service migrations must preserve the same sequence:
define one responsibility, prove parity on separate database copies, qualify
the restart/failure path, then route it to Rust while disabling the TypeScript
writer for that responsibility. The Rust process tests now kill a worker with
an open transaction after its audit/outbox writes and confirm both roll back;
the production IPC test submits a real `tasks.create` frame, observes its
committed idempotency record without reading stdout, kills the Rust Core, then
retries through a fresh Rust Core and confirms one task, revision, audit pair,
and outbox pair. These deterministic checks cover storage rollback and
client-visible response loss after commit. The IPC test does not instrument the
exact `write_frame` instruction boundary. WAL-default selection, the remaining
lifecycle repositories, exact response-write timing, and full release cutover
remain open gates.

The Windows x64 packaged compatibility smoke was run with Electron 44.9.3 and
Node ABI 149. The packaged Rust executable reported bundled SQLite 3.54.1,
opened the TypeScript-created schema-13 fixture in default `delete` journal
mode, then opened it with explicit WAL selection and reported `wal`. WAL remained
readable on the next open. This qualifies the packaged WAL primitive on the
tested local Windows environment; it does not select WAL for the application.
