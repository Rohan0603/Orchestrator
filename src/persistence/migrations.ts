import type Database from "better-sqlite3";

const migrations: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      risk_tier INTEGER NOT NULL CHECK (risk_tier IN (1, 2, 3)),
      status TEXT NOT NULL CHECK (status IN ('intake', 'planned', 'blocked', 'completed')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      state TEXT NOT NULL,
      route_id TEXT,
      recovery_state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      outcome TEXT NOT NULL,
      worker_report TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      action_digest TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      previous_hash TEXT,
      event_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      published_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL,
      uri TEXT NOT NULL,
      content_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recovery (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
      state TEXT NOT NULL,
      reason TEXT,
      observed_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE approvals ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE approvals ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'policy-v1';
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      policy_version TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason TEXT NOT NULL,
      action_json TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      evaluated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_targets (
      id TEXT PRIMARY KEY NOT NULL,
      repository_path TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      confirmed_by_user INTEGER NOT NULL CHECK (confirmed_by_user IN (0, 1)),
      worktree_path TEXT,
      decision TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS dispatch_intents (
      id TEXT PRIMARY KEY NOT NULL,
      dispatch_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      route_json TEXT NOT NULL,
      authorization_json TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress_cursors (
      dispatch_id TEXT PRIMARY KEY NOT NULL REFERENCES dispatch_intents(dispatch_id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      last_sequence INTEGER NOT NULL,
      event_ids TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      dispatch_id TEXT NOT NULL REFERENCES dispatch_intents(dispatch_id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      UNIQUE (dispatch_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS evidence_records (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provenance TEXT NOT NULL,
      uri TEXT,
      content_hash TEXT,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL,
      independently_verified INTEGER NOT NULL CHECK (independently_verified IN (0, 1)),
      completeness_note TEXT
    );
  `
];

export function applyMigrations(database: Database.Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;
  if (currentVersion > migrations.length) {
    throw new Error(`Unsupported database schema version: ${currentVersion}`);
  }
  const migrate = database.transaction(() => {
    for (let index = currentVersion; index < migrations.length; index += 1) {
      database.exec(migrations[index]);
      if (currentVersion === 0 && index === 0) {
        database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(index + 1);
      } else {
        database.prepare("UPDATE schema_version SET version = ?").run(index + 1);
      }
    }
  });
  migrate();
}
