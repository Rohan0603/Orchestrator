use orchestrator_core::storage::DatabaseStore;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

static NEXT_DB: AtomicU64 = AtomicU64::new(0);

fn test_dir() -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "agentconductor-orc37-process-{}-{}",
        std::process::id(),
        NEXT_DB.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&directory).expect("create test directory");
    directory
}

fn create_supported_database(path: &std::path::Path) {
    let connection = Connection::open(path).expect("create database");
    connection
        .execute_batch(
            "CREATE TABLE schema_version(version INTEGER NOT NULL);
             INSERT INTO schema_version(version) VALUES (13);
             CREATE TABLE tasks(id TEXT PRIMARY KEY NOT NULL, project_id TEXT, parent_task_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, risk_tier INTEGER NOT NULL, status TEXT NOT NULL, assigned_worker_id TEXT, skill_ids TEXT NOT NULL DEFAULT '[]', mcp_server_ids TEXT NOT NULL DEFAULT '[]', plugin_ids TEXT NOT NULL DEFAULT '[]', token_budget INTEGER, created_at TEXT NOT NULL);
             CREATE TABLE runs(id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL, route_id TEXT, recovery_state TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE attempts(id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), outcome TEXT NOT NULL, worker_report TEXT, created_at TEXT NOT NULL);
             CREATE TABLE approvals(id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), action_digest TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, context_json TEXT NOT NULL DEFAULT '{}', policy_version TEXT NOT NULL DEFAULT 'policy-v1');
             CREATE TABLE audit_events(id TEXT PRIMARY KEY NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, previous_hash TEXT, event_hash TEXT NOT NULL, created_at TEXT NOT NULL, correlation_json TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT);
             CREATE UNIQUE INDEX audit_events_idempotency ON audit_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
             CREATE TABLE outbox(id TEXT PRIMARY KEY NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, published_at TEXT, created_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z');
             CREATE TABLE task_revisions(id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL CHECK(revision > 0), snapshot_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, revision));
             CREATE TABLE task_commands(idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL);
             CREATE TABLE evidence(id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, uri TEXT NOT NULL, content_hash TEXT, created_at TEXT NOT NULL);
             CREATE TABLE recovery(run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id), state TEXT NOT NULL, reason TEXT, observed_at TEXT NOT NULL);",
        )
        .expect("create supported schema fixture");
}

fn write_frame(writer: &mut impl Write, message: &Value) {
    let body = serde_json::to_vec(message).expect("serialize message");
    writer
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|()| writer.write_all(&body))
        .expect("write protocol frame");
}

fn read_frame(reader: &mut impl Read) -> Value {
    let mut header = [0; 4];
    reader.read_exact(&mut header).expect("read frame header");
    let mut body = vec![0; u32::from_be_bytes(header) as usize];
    reader.read_exact(&mut body).expect("read frame body");
    serde_json::from_slice(&body).expect("parse frame")
}

fn run_health(database_path: &std::path::Path, enable_wal: bool) -> (Value, Value) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_orchestrator-core"));
    command.args(["serve", "--database"]).arg(database_path);
    if enable_wal {
        command.arg("--enable-wal");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn Rust core");
    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = child.stdout.take().expect("child stdout");
    write_frame(&mut stdin, &hello());
    let welcome = read_frame(&mut stdout);
    write_frame(
        &mut stdin,
        &json!({
            "protocolVersion": 1,
            "kind": "request",
            "messageId": "health-orc37-1",
            "correlationId": "health-correlation-orc37-1",
            "causationId": null,
            "sender": {"id": "typescript-client", "role": "client"},
            "method": "system.health",
            "payload": {}
        }),
    );
    let health = read_frame(&mut stdout);
    drop(stdin);
    assert!(child.wait().expect("wait for Rust core").success());
    (welcome, health)
}

fn spawn_crash_worker(
    mode: &str,
    database_path: &std::path::Path,
    payload: Option<&Value>,
    marker: &str,
) -> std::process::Child {
    let mut command =
        Command::new(std::env::current_exe().expect("resolve integration test executable"));
    command
        .args(["--exact", "crash_worker_entrypoint", "--nocapture"])
        .env("ORC37_CRASH_WORKER_MODE", mode)
        .env("ORC37_CRASH_WORKER_DATABASE", database_path);
    if let Some(payload) = payload {
        command.env(
            "ORC37_CRASH_WORKER_PAYLOAD",
            serde_json::to_string(payload).expect("serialize crash worker task payload"),
        );
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn Rust crash worker");
    let stdout = child.stdout.take().expect("capture crash worker stdout");
    let (sender, receiver) = mpsc::channel();
    let expected_marker = marker.to_owned();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line == expected_marker {
                let _ = sender.send(());
                return;
            }
        }
    });
    if receiver.recv_timeout(Duration::from_secs(10)).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("crash worker did not reach {marker}");
    }
    child
}

fn run_task_create(database_path: &std::path::Path, payload: &Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_orchestrator-core"))
        .args(["serve", "--database"])
        .arg(database_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn Rust core for idempotent replay");
    let mut stdin = child.stdin.take().expect("take Rust core stdin");
    let mut stdout = child.stdout.take().expect("take Rust core stdout");
    write_frame(&mut stdin, &hello());
    assert_eq!(read_frame(&mut stdout)["kind"], "welcome");
    write_frame(
        &mut stdin,
        &json!({
            "protocolVersion": 1,
            "kind": "request",
            "messageId": "task-create-after-crash",
            "correlationId": "task-create-after-crash-correlation",
            "causationId": null,
            "sender": {"id": "typescript-client", "role": "client"},
            "method": "tasks.create",
            "payload": payload
        }),
    );
    let response = read_frame(&mut stdout);
    drop(stdin);
    assert!(child.wait().expect("wait for Rust core replay").success());
    response
}

fn hello() -> Value {
    json!({
        "protocolVersion": 1,
        "kind": "hello",
        "messageId": "hello-orc37-1",
        "correlationId": "correlation-orc37-1",
        "causationId": null,
        "sender": {"id": "typescript-client", "role": "client"},
        "minimumProtocol": 1,
        "maximumProtocol": 1,
        "clientVersion": "0.1.0",
        "schemaVersion": 1,
        "requiredCapabilities": ["system.health", "capabilities.list"]
    })
}

#[test]
fn crash_worker_entrypoint() {
    let Ok(mode) = std::env::var("ORC37_CRASH_WORKER_MODE") else {
        return;
    };
    let database_path = std::path::PathBuf::from(
        std::env::var("ORC37_CRASH_WORKER_DATABASE").expect("crash worker database path"),
    );
    match mode.as_str() {
        "before_commit" => {
            let mut store =
                DatabaseStore::open_existing(&database_path).expect("open crash worker database");
            let result: Result<(), _> = store.transaction(|transaction| {
                transaction.execute(
                    "INSERT INTO audit_events (id, event_type, payload, previous_hash, event_hash, created_at, correlation_json, idempotency_key) VALUES ('crash-before-commit', 'crash.test', '{}', NULL, 'crash-hash', '2026-11-02T00:00:00.000Z', '{}', NULL)",
                    [],
                )?;
                transaction.execute(
                    "INSERT INTO outbox (id, event_type, payload, published_at, attempt_count, next_attempt_at, created_at) VALUES ('crash-before-commit', 'crash.test', '{}', NULL, 0, '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z')",
                    [],
                )?;
                println!("ORC37_BEFORE_COMMIT_WRITES_READY");
                std::io::stdout().flush().expect("flush crash marker");
                loop {
                    thread::sleep(Duration::from_secs(1));
                }
            });
            panic!("crash worker unexpectedly left its transaction: {result:?}");
        }
        "after_commit" => {
            let payload: Value = serde_json::from_str(
                &std::env::var("ORC37_CRASH_WORKER_PAYLOAD").expect("crash worker task payload"),
            )
            .expect("parse crash worker task payload");
            let mut store =
                DatabaseStore::open_existing(&database_path).expect("open crash worker database");
            store
                .create_task(&payload)
                .expect("commit task before suppressing response");
            println!("ORC37_AFTER_COMMIT_RESPONSE_SUPPRESSED");
            std::io::stdout().flush().expect("flush crash marker");
            loop {
                thread::sleep(Duration::from_secs(1));
            }
        }
        _ => panic!("unsupported crash worker mode: {mode}"),
    }
}

#[test]
fn existing_database_is_validated_before_handshake_and_reported_in_health() {
    let directory = test_dir();
    let database_path = directory.join("state.sqlite");
    create_supported_database(&database_path);
    let (welcome, health) = run_health(&database_path, false);
    assert_eq!(welcome["kind"], "welcome");
    assert_eq!(welcome["databaseSchemaVersion"], 13);
    assert_eq!(health["ok"], true);
    assert_eq!(health["result"]["database"], "open");
    assert_eq!(health["result"]["databaseSchemaVersion"], 13);
    assert_eq!(health["result"]["sqliteVersion"], rusqlite::version());
    assert_eq!(health["result"]["journalMode"], "delete");
    let (wal_welcome, wal_health) = run_health(&database_path, true);
    assert_eq!(wal_welcome["databaseSchemaVersion"], 13);
    assert_eq!(wal_health["result"]["journalMode"], "wal");
    fs::remove_dir_all(directory).expect("remove test directory");
}

#[test]
fn tasks_create_writes_task_revision_audit_and_outbox_atomically() {
    let directory = test_dir();
    let database_path = directory.join("state.sqlite");
    create_supported_database(&database_path);
    let mut child = Command::new(env!("CARGO_BIN_EXE_orchestrator-core"))
        .args(["serve", "--database"])
        .arg(&database_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn Rust core");
    let mut stdin = child.stdin.take().expect("child stdin");
    let mut stdout = child.stdout.take().expect("child stdout");
    write_frame(&mut stdin, &hello());
    let welcome = read_frame(&mut stdout);
    assert_eq!(welcome["kind"], "welcome");

    write_frame(
        &mut stdin,
        &json!({
            "protocolVersion": 1,
            "kind": "request",
            "messageId": "task-create-orc37-1",
            "correlationId": "task-create-correlation-orc37-1",
            "causationId": null,
            "sender": {"id": "typescript-client", "role": "client"},
            "method": "tasks.create",
            "payload": {
                "title": "Rust-owned creation",
                "description": "Create one task through the Rust core",
                "acceptanceCriteria": ["task, revision, audit and outbox commit together"],
                "riskTier": 1,
                "idempotencyKey": "orc37-task-create-1"
            }
        }),
    );
    let response = read_frame(&mut stdout);
    assert_eq!(response["ok"], true, "unexpected core response: {response}");
    let task_id = response["result"]["id"].as_str().expect("task id");
    assert_eq!(response["result"]["title"], "Rust-owned creation");

    write_frame(
        &mut stdin,
        &json!({
            "protocolVersion": 1,
            "kind": "request",
            "messageId": "task-list-orc37-1",
            "correlationId": "task-list-correlation-orc37-1",
            "causationId": null,
            "sender": {"id": "typescript-client", "role": "client"},
            "method": "tasks.list",
            "payload": {}
        }),
    );
    let list_response = read_frame(&mut stdout);
    assert_eq!(
        list_response["ok"], true,
        "unexpected core response: {list_response}"
    );
    assert_eq!(list_response["result"], json!([response["result"].clone()]));

    write_frame(
        &mut stdin,
        &json!({
            "protocolVersion": 1,
            "kind": "request",
            "messageId": "task-get-orc37-1",
            "correlationId": "task-get-correlation-orc37-1",
            "causationId": null,
            "sender": {"id": "typescript-client", "role": "client"},
            "method": "tasks.get",
            "payload": {"taskId": task_id}
        }),
    );
    let get_response = read_frame(&mut stdout);
    assert_eq!(
        get_response["ok"], true,
        "unexpected core response: {get_response}"
    );
    assert_eq!(get_response["result"], response["result"]);

    write_frame(
        &mut stdin,
        &json!({
            "protocolVersion": 1,
            "kind": "request",
            "messageId": "task-get-missing-orc37-1",
            "correlationId": "task-get-missing-correlation-orc37-1",
            "causationId": null,
            "sender": {"id": "typescript-client", "role": "client"},
            "method": "tasks.get",
            "payload": {"taskId": "task-does-not-exist"}
        }),
    );
    let missing_response = read_frame(&mut stdout);
    assert_eq!(
        missing_response["ok"], true,
        "unexpected core response: {missing_response}"
    );
    assert_eq!(missing_response["result"], Value::Null);

    drop(stdin);
    assert!(child.wait().expect("wait for Rust core").success());
    let connection = Connection::open(&database_path).expect("read task database");
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM tasks WHERE id=?1", [task_id], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM task_revisions WHERE task_id=?1 AND revision=1",
                [task_id],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM task_commands WHERE idempotency_key='orc37-task-create-1'",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(connection.query_row("SELECT count(*) FROM audit_events WHERE event_type IN ('task.created','task.revision.created')", [], |row| row.get::<_, u32>(0)).unwrap(), 2);
    assert_eq!(connection.query_row("SELECT count(*) FROM outbox WHERE event_type IN ('task.created','task.revision.created')", [], |row| row.get::<_, u32>(0)).unwrap(), 2);
    drop(connection);
    fs::remove_dir_all(directory).expect("remove test directory");
}

#[test]
fn process_death_before_commit_rolls_back_audit_and_outbox_intent() {
    let directory = test_dir();
    let database_path = directory.join("state.sqlite");
    create_supported_database(&database_path);
    DatabaseStore::migrate_existing(&database_path)
        .unwrap_or_else(|error| panic!("fixture migration failed: {error:?}"));

    let mut child = spawn_crash_worker(
        "before_commit",
        &database_path,
        None,
        "ORC37_BEFORE_COMMIT_WRITES_READY",
    );
    child.kill().expect("kill Rust process before commit");
    assert!(
        !child
            .wait()
            .expect("wait for killed Rust process")
            .success()
    );

    let connection = Connection::open(&database_path).expect("reopen after pre-commit death");
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM audit_events WHERE id='crash-before-commit'",
                [],
                |row| row.get::<_, u32>(0),
            )
            .unwrap(),
        0,
        "uncommitted audit event must not survive process death"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM outbox WHERE id='crash-before-commit'",
                [],
                |row| row.get::<_, u32>(0),
            )
            .unwrap(),
        0,
        "uncommitted outbox intent must not survive process death"
    );
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(connection);
    fs::remove_dir_all(directory).expect("remove test directory");
}

#[test]
fn process_death_after_commit_before_response_replays_one_task_and_event_set() {
    let directory = test_dir();
    let database_path = directory.join("state.sqlite");
    create_supported_database(&database_path);
    DatabaseStore::migrate_existing(&database_path)
        .unwrap_or_else(|error| panic!("fixture migration failed: {error:?}"));
    let payload = json!({
        "title": "Rust crash replay",
        "description": "Commit before response, then retry after process death.",
        "acceptanceCriteria": ["task, revision, audit and outbox do not duplicate"],
        "riskTier": 1,
        "idempotencyKey": "orc37-crash-replay-1"
    });

    let mut child = spawn_crash_worker(
        "after_commit",
        &database_path,
        Some(&payload),
        "ORC37_AFTER_COMMIT_RESPONSE_SUPPRESSED",
    );
    child.kill().expect("kill Rust process before response");
    assert!(
        !child
            .wait()
            .expect("wait for killed Rust process")
            .success()
    );

    let retry = run_task_create(&database_path, &payload);
    assert_eq!(retry["ok"], true, "replay should return the committed task");
    let task_id = retry["result"]["id"].as_str().expect("task id");
    assert_eq!(retry["result"]["title"], payload["title"]);

    let connection = Connection::open(&database_path).expect("inspect crash replay database");
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM tasks WHERE id=?1", [task_id], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM task_revisions WHERE task_id=?1",
                [task_id],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM task_commands WHERE idempotency_key='orc37-crash-replay-1'",
                [],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM audit_events WHERE correlation_json=?1",
                [format!("{{\"taskId\":\"{task_id}\"}}")],
                |row| row.get::<_, u32>(0)
            )
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM outbox WHERE id IN (SELECT id FROM audit_events WHERE correlation_json=?1)", [format!("{{\"taskId\":\"{task_id}\"}}")], |row| row.get::<_, u32>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(connection);
    fs::remove_dir_all(directory).expect("remove test directory");
}
