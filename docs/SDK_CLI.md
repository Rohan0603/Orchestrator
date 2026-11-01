# Orchestrator headless SDK CLI

The CLI is a thin client of the same SDK services and SQLite database used by
the desktop app. It runs under the project's Electron runtime so the native
SQLite binding matches Electron's ABI. It creates no database in the repository
unless you explicitly choose a repository path.

## Run the disposable fixture

In PowerShell, choose a new temporary database path:

```powershell
$dbPath = Join-Path $env:TEMP 'orchestrator-sdk-demo.sqlite'
npm run cli -- --db $dbPath fixture demo
```

The fixture creates a labelled demo project and task, claims it with a local
fixture worker, records progress, report and a content-hashed fixture artifact,
then prints the SQLite-backed timeline. The report ends in `verification`;
the fixture does not represent real work or claim acceptance. Reuse the database
to inspect it with `task list`, `task show <id>`, `run list`, `run show <id>`, or
`run trace <id>`. To avoid claiming unrelated work, `fixture demo` refuses to
seed a database that already has a dispatchable task; use a fresh temporary
database for each demo.

## Commands

```text
npm run cli -- --db <path> help
npm run cli -- --db <path> project list
npm run cli -- --db <path> project show <project-id>
npm run cli -- --db <path> project create --name <name> [--description <text>]
npm run cli -- --db <path> task list [--project <project-id>]
npm run cli -- --db <path> task show <task-id>
npm run cli -- --db <path> task create --project <project-id> --title <title> --criteria <criterion|criterion> [--description <text>] [--risk-tier 1]
npm run cli -- --db <path> run list [--task <task-id>]
npm run cli -- --db <path> run show <run-id>
npm run cli -- --db <path> run trace <run-id>
npm run cli -- --db <path> fixture demo
```

Set `ORCHESTRATOR_DB` to use one database path instead of passing `--db`.
Output is JSON for scripting. Task/run views include revisions, dependencies,
attempts, assignment leases, persisted evidence/artifact references and timeline
events where applicable.
