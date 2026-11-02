use rusqlite::Connection;
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

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
