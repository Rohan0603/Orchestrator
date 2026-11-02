use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, backup::Backup,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;

pub const SUPPORTED_SCHEMA_VERSION: u32 = 13;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database could not be opened")]
    Open(#[source] rusqlite::Error),
    #[error("database schema is incompatible: {0}")]
    Incompatible(&'static str),
    #[error("database schema validation query failed")]
    Validation(#[source] rusqlite::Error),
    #[error("database operation failed")]
    Operation(#[source] rusqlite::Error),
    #[error("database backup failed")]
    Backup(#[source] rusqlite::Error),
    #[error("backup destination could not be reserved")]
    BackupDestination(#[source] std::io::Error),
    #[error("durable event is malformed")]
    InvalidEvent,
    #[error("event idempotency key was reused with different content")]
    IdempotencyConflict,
    #[error("stored task row is malformed")]
    InvalidTaskRow,
    #[error("task creation payload is malformed")]
    InvalidTaskInput,
    #[error("task command idempotency key points to a missing task")]
    MissingTaskCommand,
}

#[derive(Clone, Debug)]
pub struct DatabaseInfo {
    pub schema_version: u32,
    pub sqlite_version: String,
    pub journal_mode: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEvent {
    pub id: String,
    pub event_type: String,
    pub payload: String,
    pub previous_hash: Option<String>,
    pub event_hash: String,
    pub correlation_json: String,
    pub idempotency_key: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub title: String,
    pub description: String,
    pub acceptance_criteria: Vec<String>,
    pub risk_tier: u8,
    pub status: String,
    pub assigned_worker_id: Option<String>,
    pub skill_ids: Vec<String>,
    pub mcp_server_ids: Vec<String>,
    pub plugin_ids: Vec<String>,
    pub token_budget: Option<i64>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedTask {
    id: String,
    project_id: Option<String>,
    parent_task_id: Option<String>,
    title: String,
    description: String,
    acceptance_criteria: Vec<String>,
    risk_tier: u8,
    status: String,
    assigned_worker_id: Option<String>,
    skill_ids: Vec<String>,
    mcp_server_ids: Vec<String>,
    plugin_ids: Vec<String>,
    token_budget: Option<i64>,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskCommandPayload<'a> {
    project_id: &'a Option<String>,
    parent_task_id: &'a Option<String>,
    title: &'a str,
    description: &'a str,
    acceptance_criteria: &'a [String],
    risk_tier: u8,
    skill_ids: &'a [String],
    mcp_server_ids: &'a [String],
    plugin_ids: &'a [String],
    token_budget: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRevisionSnapshot<'a> {
    task_id: &'a str,
    project_id: &'a Option<String>,
    parent_task_id: &'a Option<String>,
    title: &'a str,
    description: &'a str,
    acceptance_criteria: &'a [String],
    risk_tier: u8,
    skill_ids: &'a [String],
    mcp_server_ids: &'a [String],
    plugin_ids: &'a [String],
    token_budget: Option<i64>,
}

pub struct DatabaseStore {
    connection: Connection,
    info: DatabaseInfo,
}

impl DatabaseStore {
    pub fn open_existing(path: &Path) -> Result<Self, StoreError> {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(StoreError::Open)?;
        connection
            .busy_timeout(Duration::from_millis(250))
            .map_err(StoreError::Open)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(StoreError::Open)?;

        let integrity: String = connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(StoreError::Validation)?;
        if integrity != "ok" {
            return Err(StoreError::Incompatible("integrity check failed"));
        }
        let foreign_key_problem = connection
            .query_row("SELECT * FROM pragma_foreign_key_check LIMIT 1", [], |_| {
                Ok(())
            })
            .optional()
            .map_err(StoreError::Validation)?;
        if foreign_key_problem.is_some() {
            return Err(StoreError::Incompatible("foreign key check failed"));
        }

        let has_version_table = table_exists(&connection, "schema_version")?;
        if !has_version_table {
            return Err(StoreError::Incompatible("schema_version table is missing"));
        }
        let (version_count, version): (i64, Option<i64>) = connection
            .query_row(
                "SELECT count(*), min(version) FROM schema_version",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(StoreError::Validation)?;
        if version_count != 1 {
            return Err(StoreError::Incompatible(
                "schema version must have exactly one row",
            ));
        }
        if version != Some(i64::from(SUPPORTED_SCHEMA_VERSION)) {
            return Err(StoreError::Incompatible("schema version is unsupported"));
        }
        for table in [
            "tasks",
            "runs",
            "attempts",
            "approvals",
            "audit_events",
            "outbox",
            "evidence",
            "recovery",
        ] {
            if !table_exists(&connection, table)? {
                return Err(StoreError::Incompatible("required table is missing"));
            }
        }
        for (table, columns) in [
            ("schema_version", &["version"][..]),
            (
                "tasks",
                &[
                    "id",
                    "title",
                    "description",
                    "acceptance_criteria",
                    "risk_tier",
                    "status",
                    "created_at",
                ],
            ),
            (
                "runs",
                &[
                    "id",
                    "task_id",
                    "state",
                    "route_id",
                    "recovery_state",
                    "created_at",
                ],
            ),
            (
                "attempts",
                &["id", "run_id", "outcome", "worker_report", "created_at"],
            ),
            (
                "approvals",
                &[
                    "id",
                    "run_id",
                    "action_digest",
                    "expires_at",
                    "consumed_at",
                    "context_json",
                    "policy_version",
                ],
            ),
            (
                "audit_events",
                &[
                    "id",
                    "event_type",
                    "payload",
                    "previous_hash",
                    "event_hash",
                    "correlation_json",
                    "idempotency_key",
                    "created_at",
                ],
            ),
            (
                "outbox",
                &[
                    "id",
                    "event_type",
                    "payload",
                    "published_at",
                    "attempt_count",
                    "next_attempt_at",
                    "created_at",
                ],
            ),
            (
                "evidence",
                &["id", "run_id", "kind", "uri", "content_hash", "created_at"],
            ),
            ("recovery", &["run_id", "state", "reason", "observed_at"]),
        ] {
            for column in columns {
                if !column_exists(&connection, table, column)? {
                    return Err(StoreError::Incompatible("required column is missing"));
                }
            }
        }
        let sqlite_version = rusqlite::version().to_owned();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(StoreError::Open)?;
        Ok(Self {
            connection,
            info: DatabaseInfo {
                schema_version: SUPPORTED_SCHEMA_VERSION,
                sqlite_version,
                journal_mode,
            },
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn info(&self) -> &DatabaseInfo {
        &self.info
    }

    pub fn enable_wal(&mut self) -> Result<(), StoreError> {
        let mode: String = self
            .connection
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .map_err(StoreError::Operation)?;
        if mode != "wal" {
            return Err(StoreError::Incompatible("SQLite did not activate WAL mode"));
        }
        self.info.journal_mode = mode;
        Ok(())
    }

    pub fn checkpoint_wal(&mut self) -> Result<(), StoreError> {
        if self.info.journal_mode != "wal" {
            return Err(StoreError::Incompatible("database is not using WAL mode"));
        }
        let (busy, _, _): (i64, i64, i64) = self
            .connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(StoreError::Operation)?;
        if busy != 0 {
            return Err(StoreError::Incompatible("WAL checkpoint was blocked"));
        }
        Ok(())
    }

    pub fn transaction<T>(
        &mut self,
        operation: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Operation)?;
        let result = operation(&transaction).map_err(StoreError::Operation)?;
        transaction.commit().map_err(StoreError::Operation)?;
        Ok(result)
    }

    pub fn backup_into(&self, destination: &Path) -> Result<(), StoreError> {
        let reservation = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(StoreError::BackupDestination)?;
        drop(reservation);

        let backup_result = (|| {
            let mut target = Connection::open(destination).map_err(StoreError::Backup)?;
            let backup = Backup::new(&self.connection, &mut target).map_err(StoreError::Backup)?;
            backup
                .run_to_completion(64, Duration::from_millis(10), None)
                .map_err(StoreError::Backup)
        })();
        if backup_result.is_err() {
            let _ = std::fs::remove_file(destination);
            let mut wal = destination.as_os_str().to_os_string();
            wal.push("-wal");
            let _ = std::fs::remove_file(std::path::PathBuf::from(wal));
            let mut shm = destination.as_os_str().to_os_string();
            shm.push("-shm");
            let _ = std::fs::remove_file(std::path::PathBuf::from(shm));
        }
        backup_result
    }

    pub fn append_durable_event(
        &mut self,
        event_type: &str,
        payload_json: &str,
        created_at: &str,
        correlation_json: &str,
        idempotency_key: Option<&str>,
    ) -> Result<AuditEvent, StoreError> {
        let _payload: serde_json::Value =
            serde_json::from_str(payload_json).map_err(|_| StoreError::InvalidEvent)?;
        let correlation: serde_json::Value =
            serde_json::from_str(correlation_json).map_err(|_| StoreError::InvalidEvent)?;
        if event_type.is_empty() || !correlation.is_object() || created_at.is_empty() {
            return Err(StoreError::InvalidEvent);
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Operation)?;
        if let Some(key) = idempotency_key {
            let previous = transaction
                .query_row(
                    "SELECT id, event_type, payload, previous_hash, event_hash, correlation_json, idempotency_key, created_at FROM audit_events WHERE idempotency_key = ?1",
                    [key],
                    audit_event_from_row,
                )
                .optional()
                .map_err(StoreError::Operation)?;
            if let Some(previous) = previous {
                if previous.event_type != event_type
                    || previous.payload != payload_json
                    || previous.correlation_json != correlation_json
                {
                    return Err(StoreError::IdempotencyConflict);
                }
                return Ok(previous);
            }
        }

        let previous_hash = transaction
            .query_row(
                "SELECT event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StoreError::Operation)?;
        let mut hasher = sha2::Sha256::new();
        hasher.update(previous_hash.as_deref().unwrap_or_default());
        hasher.update(event_type);
        hasher.update(payload_json);
        hasher.update(correlation_json);
        hasher.update(idempotency_key.unwrap_or_default());
        hasher.update(created_at);
        let event_hash = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let event = AuditEvent {
            id: uuid::Uuid::new_v4().to_string(),
            event_type: event_type.to_owned(),
            payload: payload_json.to_owned(),
            previous_hash,
            event_hash,
            correlation_json: correlation_json.to_owned(),
            idempotency_key: idempotency_key.map(str::to_owned),
            created_at: created_at.to_owned(),
        };
        transaction
            .execute(
                "INSERT INTO audit_events (id, event_type, payload, previous_hash, event_hash, correlation_json, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![event.id, event.event_type, event.payload, event.previous_hash, event.event_hash, event.correlation_json, event.idempotency_key, event.created_at],
            )
            .map_err(StoreError::Operation)?;
        transaction
            .execute(
                "INSERT INTO outbox (id, event_type, payload, published_at, attempt_count, next_attempt_at, created_at) VALUES (?1, ?2, ?3, NULL, 0, ?4, ?4)",
                rusqlite::params![event.id, event.event_type, event.payload, event.created_at],
            )
            .map_err(StoreError::Operation)?;
        transaction.commit().map_err(StoreError::Operation)?;
        Ok(event)
    }

    pub fn create_task(&mut self, payload: &Value) -> Result<Value, StoreError> {
        let input = parse_task_create(payload)?;
        let command_payload = TaskCommandPayload {
            project_id: &input.project_id,
            parent_task_id: &input.parent_task_id,
            title: &input.title,
            description: &input.description,
            acceptance_criteria: &input.acceptance_criteria,
            risk_tier: input.risk_tier,
            skill_ids: &input.skill_ids,
            mcp_server_ids: &input.mcp_server_ids,
            plugin_ids: &input.plugin_ids,
            token_budget: input.token_budget,
        };
        let command_payload_json =
            serde_json::to_vec(&command_payload).map_err(|_| StoreError::InvalidTaskInput)?;
        let command_payload_hash = hash_hex(&Sha256::digest(command_payload_json));

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Operation)?;

        if let Some(idempotency_key) = input.idempotency_key.as_deref() {
            let existing = transaction
                .query_row(
                    "SELECT payload_hash, task_id FROM task_commands WHERE idempotency_key = ?1",
                    [idempotency_key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(StoreError::Operation)?;
            if let Some((previous_hash, task_id)) = existing {
                if previous_hash != command_payload_hash {
                    return Err(StoreError::IdempotencyConflict);
                }
                let task = read_created_task(&transaction, &task_id)?
                    .ok_or(StoreError::MissingTaskCommand)?;
                return serde_json::to_value(task).map_err(|_| StoreError::InvalidTaskRow);
            }
        }

        let created_at: String = transaction
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                row.get(0)
            })
            .map_err(StoreError::Operation)?;
        let task = CreatedTask {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: input.project_id,
            parent_task_id: input.parent_task_id,
            title: input.title,
            description: input.description,
            acceptance_criteria: input.acceptance_criteria,
            risk_tier: input.risk_tier,
            status: "intake".to_owned(),
            assigned_worker_id: None,
            skill_ids: input.skill_ids,
            mcp_server_ids: input.mcp_server_ids,
            plugin_ids: input.plugin_ids,
            token_budget: input.token_budget,
            created_at,
        };

        transaction
            .execute(
                "INSERT INTO tasks (id, project_id, parent_task_id, title, description, acceptance_criteria, risk_tier, status, assigned_worker_id, skill_ids, mcp_server_ids, plugin_ids, token_budget, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                rusqlite::params![
                    task.id,
                    task.project_id,
                    task.parent_task_id,
                    task.title,
                    task.description,
                    serde_json::to_string(&task.acceptance_criteria).map_err(|_| StoreError::InvalidTaskInput)?,
                    task.risk_tier,
                    task.status,
                    task.assigned_worker_id,
                    serde_json::to_string(&task.skill_ids).map_err(|_| StoreError::InvalidTaskInput)?,
                    serde_json::to_string(&task.mcp_server_ids).map_err(|_| StoreError::InvalidTaskInput)?,
                    serde_json::to_string(&task.plugin_ids).map_err(|_| StoreError::InvalidTaskInput)?,
                    task.token_budget,
                    task.created_at,
                ],
            )
            .map_err(StoreError::Operation)?;

        let snapshot = TaskRevisionSnapshot {
            task_id: &task.id,
            project_id: &task.project_id,
            parent_task_id: &task.parent_task_id,
            title: &task.title,
            description: &task.description,
            acceptance_criteria: &task.acceptance_criteria,
            risk_tier: task.risk_tier,
            skill_ids: &task.skill_ids,
            mcp_server_ids: &task.mcp_server_ids,
            plugin_ids: &task.plugin_ids,
            token_budget: task.token_budget,
        };
        let snapshot_json =
            serde_json::to_string(&snapshot).map_err(|_| StoreError::InvalidTaskInput)?;
        let snapshot_hash = hash_hex(&Sha256::digest(snapshot_json.as_bytes()));
        transaction
            .execute(
                "INSERT INTO task_revisions (id, task_id, revision, snapshot_json, content_hash, created_at) VALUES (?1, ?2, 1, ?3, ?4, ?5)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task.id, snapshot_json, snapshot_hash, task.created_at],
            )
            .map_err(StoreError::Operation)?;

        if let Some(idempotency_key) = input.idempotency_key.as_deref() {
            transaction
                .execute(
                    "INSERT INTO task_commands (idempotency_key, payload_hash, task_id, created_at) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![idempotency_key, command_payload_hash, task.id, task.created_at],
                )
                .map_err(StoreError::Operation)?;
        }

        let task_json = serde_json::to_string(&task).map_err(|_| StoreError::InvalidTaskInput)?;
        append_event_in_transaction(
            &transaction,
            "task.created",
            &task_json,
            &task.created_at,
            &format!(
                "{{\"taskId\":{}}}",
                serde_json::to_string(&task.id).map_err(|_| StoreError::InvalidTaskInput)?
            ),
            Some(&format!("task.created:{}", task.id)),
        )?;
        let revision_event_json = format!(
            "{{\"taskId\":{},\"revision\":1,\"contentHash\":{}}}",
            serde_json::to_string(&task.id).map_err(|_| StoreError::InvalidTaskInput)?,
            serde_json::to_string(&snapshot_hash).map_err(|_| StoreError::InvalidTaskInput)?
        );
        append_event_in_transaction(
            &transaction,
            "task.revision.created",
            &revision_event_json,
            &task.created_at,
            &format!(
                "{{\"taskId\":{}}}",
                serde_json::to_string(&task.id).map_err(|_| StoreError::InvalidTaskInput)?
            ),
            Some(&format!("task.revision.created:{}:1", task.id)),
        )?;

        transaction.commit().map_err(StoreError::Operation)?;
        serde_json::to_value(task).map_err(|_| StoreError::InvalidTaskRow)
    }

    pub fn list_tasks(&self) -> Result<Vec<TaskRecord>, StoreError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, project_id, parent_task_id, title, description, acceptance_criteria, risk_tier, status, assigned_worker_id, skill_ids, mcp_server_ids, plugin_ids, token_budget, created_at FROM tasks ORDER BY created_at DESC",
            )
            .map_err(StoreError::Operation)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, String>(13)?,
                ))
            })
            .map_err(StoreError::Operation)?;
        let mut tasks = Vec::new();
        for row in rows {
            let (
                id,
                project_id,
                parent_task_id,
                title,
                description,
                criteria_json,
                risk_tier,
                status,
                assigned_worker_id,
                skill_ids_json,
                mcp_server_ids_json,
                plugin_ids_json,
                token_budget,
                created_at,
            ) = row.map_err(StoreError::Operation)?;
            tasks.push(TaskRecord {
                id,
                project_id,
                parent_task_id,
                title,
                description,
                acceptance_criteria: serde_json::from_str(&criteria_json)
                    .map_err(|_| StoreError::InvalidTaskRow)?,
                risk_tier: u8::try_from(risk_tier).map_err(|_| StoreError::InvalidTaskRow)?,
                status,
                assigned_worker_id,
                skill_ids: serde_json::from_str(&skill_ids_json)
                    .map_err(|_| StoreError::InvalidTaskRow)?,
                mcp_server_ids: serde_json::from_str(&mcp_server_ids_json)
                    .map_err(|_| StoreError::InvalidTaskRow)?,
                plugin_ids: serde_json::from_str(&plugin_ids_json)
                    .map_err(|_| StoreError::InvalidTaskRow)?,
                token_budget,
                created_at,
            });
        }
        Ok(tasks)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRecord>, StoreError> {
        let row = self
            .connection
            .query_row(
                "SELECT id, project_id, parent_task_id, title, description, acceptance_criteria, risk_tier, status, assigned_worker_id, skill_ids, mcp_server_ids, plugin_ids, token_budget, created_at FROM tasks WHERE id = ?1",
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, Option<i64>>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                },
            )
            .optional()
            .map_err(StoreError::Operation)?;
        let Some((
            id,
            project_id,
            parent_task_id,
            title,
            description,
            criteria_json,
            risk_tier,
            status,
            assigned_worker_id,
            skill_ids_json,
            mcp_server_ids_json,
            plugin_ids_json,
            token_budget,
            created_at,
        )) = row
        else {
            return Ok(None);
        };
        Ok(Some(TaskRecord {
            id,
            project_id,
            parent_task_id,
            title,
            description,
            acceptance_criteria: serde_json::from_str(&criteria_json)
                .map_err(|_| StoreError::InvalidTaskRow)?,
            risk_tier: u8::try_from(risk_tier).map_err(|_| StoreError::InvalidTaskRow)?,
            status,
            assigned_worker_id,
            skill_ids: serde_json::from_str(&skill_ids_json)
                .map_err(|_| StoreError::InvalidTaskRow)?,
            mcp_server_ids: serde_json::from_str(&mcp_server_ids_json)
                .map_err(|_| StoreError::InvalidTaskRow)?,
            plugin_ids: serde_json::from_str(&plugin_ids_json)
                .map_err(|_| StoreError::InvalidTaskRow)?,
            token_budget,
            created_at,
        }))
    }
}

struct ParsedTaskCreate {
    project_id: Option<String>,
    parent_task_id: Option<String>,
    title: String,
    description: String,
    acceptance_criteria: Vec<String>,
    risk_tier: u8,
    skill_ids: Vec<String>,
    mcp_server_ids: Vec<String>,
    plugin_ids: Vec<String>,
    token_budget: Option<i64>,
    idempotency_key: Option<String>,
}

fn parse_task_create(payload: &Value) -> Result<ParsedTaskCreate, StoreError> {
    let object = payload.as_object().ok_or(StoreError::InvalidTaskInput)?;
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidTaskInput)?
        .trim()
        .to_owned();
    let description = object
        .get("description")
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidTaskInput)?
        .to_owned();
    let criteria = object
        .get("acceptanceCriteria")
        .and_then(Value::as_array)
        .ok_or(StoreError::InvalidTaskInput)?;
    let acceptance_criteria = criteria
        .iter()
        .map(|item| {
            item.as_str()
                .map(|value| value.trim().to_owned())
                .ok_or(StoreError::InvalidTaskInput)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let risk_tier = object
        .get("riskTier")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .filter(|value| (1..=3).contains(value))
        .ok_or(StoreError::InvalidTaskInput)?;
    if title.is_empty()
        || title.encode_utf16().count() > 200
        || description.encode_utf16().count() > 10_000
        || acceptance_criteria.is_empty()
        || acceptance_criteria.iter().any(String::is_empty)
    {
        return Err(StoreError::InvalidTaskInput);
    }

    let optional_string = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .map(|value| value.trim().to_owned())
    };
    let string_array = |name: &str| -> Result<Vec<String>, StoreError> {
        match object.get(name).and_then(Value::as_array) {
            Some(values) if values.iter().all(Value::is_string) => Ok(values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()),
            _ => Ok(Vec::new()),
        }
    };
    let idempotency_key = match object.get("idempotencyKey") {
        Some(value) => {
            let key = value.as_str().ok_or(StoreError::InvalidTaskInput)?.trim();
            if !valid_task_idempotency_key(key) {
                return Err(StoreError::InvalidTaskInput);
            }
            Some(key.to_owned())
        }
        None => None,
    };

    Ok(ParsedTaskCreate {
        project_id: optional_string("projectId"),
        parent_task_id: optional_string("parentTaskId"),
        title,
        description,
        acceptance_criteria,
        risk_tier,
        skill_ids: string_array("skillIds")?,
        mcp_server_ids: string_array("mcpServerIds")?,
        plugin_ids: string_array("pluginIds")?,
        token_budget: object
            .get("tokenBudget")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0),
        idempotency_key,
    })
}

fn valid_task_idempotency_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'))
        && value.len() <= 200
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn hash_hex(hash: &[u8]) -> String {
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_created_task(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<CreatedTask>, StoreError> {
    let row = connection
        .query_row(
            "SELECT id, project_id, parent_task_id, title, description, acceptance_criteria, risk_tier, status, assigned_worker_id, skill_ids, mcp_server_ids, plugin_ids, token_budget, created_at FROM tasks WHERE id = ?1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, String>(13)?,
                ))
            },
        )
        .optional()
        .map_err(StoreError::Operation)?;
    let Some((
        id,
        project_id,
        parent_task_id,
        title,
        description,
        criteria,
        risk_tier,
        status,
        assigned_worker_id,
        skills,
        mcps,
        plugins,
        token_budget,
        created_at,
    )) = row
    else {
        return Ok(None);
    };
    Ok(Some(CreatedTask {
        id,
        project_id,
        parent_task_id,
        title,
        description,
        acceptance_criteria: serde_json::from_str(&criteria)
            .map_err(|_| StoreError::InvalidTaskRow)?,
        risk_tier: u8::try_from(risk_tier).map_err(|_| StoreError::InvalidTaskRow)?,
        status,
        assigned_worker_id,
        skill_ids: serde_json::from_str(&skills).map_err(|_| StoreError::InvalidTaskRow)?,
        mcp_server_ids: serde_json::from_str(&mcps).map_err(|_| StoreError::InvalidTaskRow)?,
        plugin_ids: serde_json::from_str(&plugins).map_err(|_| StoreError::InvalidTaskRow)?,
        token_budget,
        created_at,
    }))
}

fn append_event_in_transaction(
    transaction: &Transaction<'_>,
    event_type: &str,
    payload_json: &str,
    created_at: &str,
    correlation_json: &str,
    idempotency_key: Option<&str>,
) -> Result<(), StoreError> {
    let previous_hash = transaction
        .query_row(
            "SELECT event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StoreError::Operation)?;
    let mut hasher = Sha256::new();
    hasher.update(previous_hash.as_deref().unwrap_or_default());
    hasher.update(event_type);
    hasher.update(payload_json);
    hasher.update(correlation_json);
    hasher.update(idempotency_key.unwrap_or_default());
    hasher.update(created_at);
    let event_hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let event_id = uuid::Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO audit_events (id, event_type, payload, previous_hash, event_hash, correlation_json, idempotency_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![event_id, event_type, payload_json, previous_hash, event_hash, correlation_json, idempotency_key, created_at],
        )
        .map_err(StoreError::Operation)?;
    transaction
        .execute(
            "INSERT INTO outbox (id, event_type, payload, published_at, attempt_count, next_attempt_at, created_at) VALUES (?1, ?2, ?3, NULL, 0, ?4, ?4)",
            rusqlite::params![event_id, event_type, payload_json, created_at],
        )
        .map_err(StoreError::Operation)?;
    Ok(())
}

fn audit_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditEvent> {
    Ok(AuditEvent {
        id: row.get(0)?,
        event_type: row.get(1)?,
        payload: row.get(2)?,
        previous_hash: row.get(3)?,
        event_hash: row.get(4)?,
        correlation_json: row.get(5)?,
        idempotency_key: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(StoreError::Validation)
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )
        .map_err(StoreError::Validation)
}

#[cfg(test)]
mod tests {
    use super::{DatabaseStore, SUPPORTED_SCHEMA_VERSION, StoreError};
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static NEXT_DB: AtomicU64 = AtomicU64::new(0);

    fn new_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "agentconductor-orc37-{label}-{}-{}.sqlite",
            std::process::id(),
            NEXT_DB.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn create_schema(path: &PathBuf, versions: &[u32], omit_outbox: bool) {
        let connection = Connection::open(path).expect("create fixture database");
        connection.execute_batch(
            "CREATE TABLE schema_version(version INTEGER NOT NULL);
             CREATE TABLE tasks(id TEXT PRIMARY KEY NOT NULL, project_id TEXT, parent_task_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, risk_tier INTEGER NOT NULL, status TEXT NOT NULL, assigned_worker_id TEXT, skill_ids TEXT NOT NULL DEFAULT '[]', mcp_server_ids TEXT NOT NULL DEFAULT '[]', plugin_ids TEXT NOT NULL DEFAULT '[]', token_budget INTEGER, created_at TEXT NOT NULL);
             CREATE TABLE runs(id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL, route_id TEXT, recovery_state TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE attempts(id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), outcome TEXT NOT NULL, worker_report TEXT, created_at TEXT NOT NULL);
             CREATE TABLE approvals(id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), action_digest TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, context_json TEXT NOT NULL DEFAULT '{}', policy_version TEXT NOT NULL DEFAULT 'policy-v1');
             CREATE TABLE audit_events(id TEXT PRIMARY KEY NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, previous_hash TEXT, event_hash TEXT NOT NULL, created_at TEXT NOT NULL, correlation_json TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT);
             CREATE UNIQUE INDEX audit_events_idempotency ON audit_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
             CREATE TABLE evidence(id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, uri TEXT NOT NULL, content_hash TEXT, created_at TEXT NOT NULL);
             CREATE TABLE recovery(run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id), state TEXT NOT NULL, reason TEXT, observed_at TEXT NOT NULL);"
        ).expect("create fixture schema");
        if !omit_outbox {
            connection.execute_batch("CREATE TABLE outbox(id TEXT PRIMARY KEY NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, published_at TEXT, created_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z');").expect("create outbox");
        }
        for version in versions {
            connection
                .execute("INSERT INTO schema_version(version) VALUES (?1)", [version])
                .expect("insert schema version");
        }
    }

    #[test]
    fn opens_supported_schema_without_changing_its_version() {
        let path = new_path("supported");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        assert_eq!(
            store
                .connection()
                .query_row("SELECT version FROM schema_version", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            SUPPORTED_SCHEMA_VERSION
        );
        assert_eq!(
            store
                .connection()
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert!(
            store
                .connection()
                .execute(
                    "INSERT INTO runs(id, task_id) VALUES ('orphan-run', 'missing-task')",
                    [],
                )
                .is_err(),
            "foreign-key enforcement must be enabled on the owned connection"
        );
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn missing_database_is_not_created() {
        let path = new_path("missing");
        assert!(matches!(
            DatabaseStore::open_existing(&path),
            Err(StoreError::Open(_))
        ));
        assert!(!path.exists());
    }

    #[test]
    fn rejects_unsupported_future_duplicate_and_missing_required_schema() {
        for (label, versions, missing_outbox) in [
            ("zero", vec![0], false),
            ("older-unsupported", vec![12], false),
            ("future", vec![SUPPORTED_SCHEMA_VERSION + 1], false),
            (
                "duplicate",
                vec![SUPPORTED_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSION],
                false,
            ),
            ("missing-table", vec![SUPPORTED_SCHEMA_VERSION], true),
            ("missing-column", vec![SUPPORTED_SCHEMA_VERSION], false),
        ] {
            let path = new_path(label);
            create_schema(&path, &versions, missing_outbox);
            if label == "missing-column" {
                let connection = Connection::open(&path).expect("open schema fixture");
                connection
                    .execute_batch("ALTER TABLE audit_events DROP COLUMN correlation_json")
                    .expect("remove required column");
            }
            assert!(
                DatabaseStore::open_existing(&path).is_err(),
                "{label} fixture must be rejected"
            );
            std::fs::remove_file(path).expect("remove fixture");
        }
    }

    #[test]
    fn rejects_corrupt_database_and_preexisting_foreign_key_violations() {
        let corrupt = new_path("corrupt");
        std::fs::write(&corrupt, b"not a sqlite database").expect("write corrupt fixture");
        assert!(DatabaseStore::open_existing(&corrupt).is_err());
        std::fs::remove_file(corrupt).expect("remove corrupt fixture");

        let path = new_path("foreign-key-violation");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let connection = Connection::open(&path).expect("open violating fixture");
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .expect("disable foreign keys for corruption fixture");
        connection
            .execute(
                "INSERT INTO runs(id, task_id, state, recovery_state, created_at) VALUES ('orphan', 'missing-task', 'created', 'none', 'now')",
                [],
            )
            .expect("seed violation with foreign keys disabled");
        drop(connection);
        assert!(DatabaseStore::open_existing(&path).is_err());
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn store_keeps_one_owned_connection() {
        let path = new_path("ownership");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        assert_eq!(store.connection().is_autocommit(), true);
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn immediate_transaction_commits_and_rolls_back() {
        let path = new_path("transaction");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let mut store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        store
            .transaction(|transaction| {
                transaction.execute("INSERT INTO tasks(id, title, description, acceptance_criteria, risk_tier, status, created_at) VALUES ('committed', 'title', 'description', '[]', 1, 'intake', 'now')", [])?;
                Ok(())
            })
            .expect("commit transaction");
        assert_eq!(
            store
                .connection()
                .query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert!(
            store
                .transaction::<()>(|transaction| {
                    transaction.execute("INSERT INTO tasks(id, title, description, acceptance_criteria, risk_tier, status, created_at) VALUES ('rolled-back', 'title', 'description', '[]', 1, 'intake', 'now')", [])?;
                    Err(rusqlite::Error::InvalidQuery)
                })
                .is_err()
        );
        assert_eq!(
            store
                .connection()
                .query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            1
        );
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn wal_is_explicit_and_survives_checkpoint_and_reopen() {
        let path = new_path("wal");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let mut store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        assert_ne!(store.info().journal_mode, "wal", "WAL must not be implicit");
        store.enable_wal().expect("enable WAL explicitly");
        assert_eq!(store.info().journal_mode, "wal");
        store
            .transaction(|transaction| {
                transaction.execute("INSERT INTO tasks(id, title, description, acceptance_criteria, risk_tier, status, created_at) VALUES ('persisted', 'title', 'description', '[]', 1, 'intake', 'now')", [])?;
                Ok(())
            })
            .expect("write WAL transaction");
        store.checkpoint_wal().expect("checkpoint WAL");
        drop(store);
        let reopened = DatabaseStore::open_existing(&path).expect("reopen WAL database");
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT count(*) FROM tasks WHERE id='persisted'",
                    [],
                    |row| row.get::<_, u32>(0)
                )
                .unwrap(),
            1
        );
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let mut file = path.as_os_str().to_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(file));
        }
    }

    #[test]
    fn busy_database_fails_after_a_bounded_timeout() {
        let path = new_path("busy");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let mut store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        let lock = Connection::open(&path).expect("open competing connection");
        lock.execute_batch("BEGIN IMMEDIATE")
            .expect("take writer lock");
        let started = Instant::now();
        let result = store.transaction(|transaction| {
            transaction.execute("INSERT INTO tasks(id, title, description, acceptance_criteria, risk_tier, status, created_at) VALUES ('blocked', 'title', 'description', '[]', 1, 'intake', 'now')", [])?;
            Ok(())
        });
        assert!(result.is_err(), "second writer should time out");
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(started.elapsed() < Duration::from_secs(2));
        lock.execute_batch("ROLLBACK").expect("release writer lock");
        drop(lock);
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn sqlite_full_simulation_rolls_back_the_whole_transaction() {
        let path = new_path("disk-full");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let mut store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        let page_count: u32 = store
            .connection()
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        store
            .connection()
            .pragma_update(None, "max_page_count", page_count)
            .expect("cap the disposable database at its current size");
        let large_text = "x".repeat(32 * 1024);
        let result = store.transaction(|transaction| {
            for index in 0..32 {
                transaction.execute(
                    "INSERT INTO tasks(id, title, description, acceptance_criteria, risk_tier, status, created_at) VALUES (?1, ?2, ?3, '[]', 1, 'intake', 'now')",
                    rusqlite::params![format!("full-{index}"), large_text, large_text],
                )?;
            }
            Ok(())
        });
        assert!(result.is_err(), "the page cap should simulate SQLITE_FULL");
        assert_eq!(
            store
                .connection()
                .query_row("SELECT count(*) FROM tasks", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            0,
            "all rows from the failed transaction must roll back"
        );
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn backup_restores_integrity_and_never_overwrites_destination() {
        let path = new_path("backup-source");
        let destination = new_path("backup-destination");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let mut store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        store
            .transaction(|transaction| {
                transaction.execute("INSERT INTO tasks(id, title, description, acceptance_criteria, risk_tier, status, created_at) VALUES ('backed-up', 'title', 'description', '[]', 1, 'intake', 'now')", [])?;
                Ok(())
            })
            .expect("write before backup");
        store
            .backup_into(&destination)
            .expect("create consistent backup");
        let backup = Connection::open(&destination).expect("open backup");
        assert_eq!(
            backup
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            backup
                .query_row("SELECT id FROM tasks", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "backed-up"
        );
        drop(backup);
        let collision = new_path("backup-collision");
        std::fs::write(&collision, b"leave this destination alone").expect("create sentinel");
        assert!(store.backup_into(&collision).is_err());
        assert_eq!(
            std::fs::read(&collision).unwrap(),
            b"leave this destination alone"
        );
        drop(store);
        std::fs::remove_file(path).expect("remove source");
        std::fs::remove_file(destination).expect("remove backup");
        std::fs::remove_file(collision).expect("remove collision fixture");
    }

    fn golden_event() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/persistence/durable-event-v1.json"
        ))
        .expect("parse durable-event fixture")
    }

    #[test]
    fn task_rows_match_the_typescript_golden_read_projection() {
        let path = new_path("task-read-parity");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/persistence/task-read-v1.json"
        ))
        .expect("parse task-read fixture");
        let setup = Connection::open(&path).expect("open task fixture");
        setup.execute(
            "INSERT INTO tasks(id, project_id, parent_task_id, title, description, acceptance_criteria, risk_tier, status, assigned_worker_id, skill_ids, mcp_server_ids, plugin_ids, token_budget, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                fixture["id"].as_str().unwrap(),
                fixture["projectId"].as_str(),
                fixture["parentTaskId"].as_str(),
                fixture["title"].as_str().unwrap(),
                fixture["description"].as_str().unwrap(),
                serde_json::to_string(&fixture["acceptanceCriteria"]).unwrap(),
                fixture["riskTier"].as_i64().unwrap(),
                fixture["status"].as_str().unwrap(),
                fixture["assignedWorkerId"].as_str(),
                serde_json::to_string(&fixture["skillIds"]).unwrap(),
                serde_json::to_string(&fixture["mcpServerIds"]).unwrap(),
                serde_json::to_string(&fixture["pluginIds"]).unwrap(),
                fixture["tokenBudget"].as_i64(),
                fixture["createdAt"].as_str().unwrap(),
            ],
        ).expect("insert golden task");
        drop(setup);
        let store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        let tasks = store.list_tasks().expect("read task rows");
        assert_eq!(tasks.len(), 1);
        assert_eq!(serde_json::to_value(&tasks[0]).unwrap(), fixture);
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn durable_event_matches_the_typescript_golden_hash_and_replay_is_idempotent() {
        let path = new_path("event-parity");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let fixture = golden_event();
        let mut store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        let event = store
            .append_durable_event(
                fixture["eventType"].as_str().unwrap(),
                fixture["payloadJson"].as_str().unwrap(),
                fixture["createdAt"].as_str().unwrap(),
                fixture["correlationJson"].as_str().unwrap(),
                fixture["idempotencyKey"].as_str(),
            )
            .expect("append event");
        assert_eq!(
            event.event_hash,
            fixture["expectedEventHash"].as_str().unwrap()
        );
        assert_eq!(event.previous_hash, None);
        let replay = store
            .append_durable_event(
                fixture["eventType"].as_str().unwrap(),
                fixture["payloadJson"].as_str().unwrap(),
                fixture["createdAt"].as_str().unwrap(),
                fixture["correlationJson"].as_str().unwrap(),
                fixture["idempotencyKey"].as_str(),
            )
            .expect("idempotent replay");
        assert_eq!(replay, event);
        assert_eq!(
            store
                .connection()
                .query_row("SELECT count(*) FROM audit_events", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .connection()
                .query_row("SELECT count(*) FROM outbox", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            1
        );
        let persisted = store
            .connection()
            .query_row(
                "SELECT a.id, a.event_type, a.payload, a.previous_hash, a.event_hash, a.correlation_json, a.idempotency_key, a.created_at, o.published_at, o.attempt_count, o.next_attempt_at FROM audit_events a JOIN outbox o ON o.id = a.id",
                [],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, u32>(9)?,
                    row.get::<_, String>(10)?,
                )),
            )
            .unwrap();
        assert_eq!(
            persisted,
            (
                event.id.clone(),
                fixture["eventType"].as_str().unwrap().to_owned(),
                fixture["payloadJson"].as_str().unwrap().to_owned(),
                None,
                fixture["expectedEventHash"].as_str().unwrap().to_owned(),
                fixture["correlationJson"].as_str().unwrap().to_owned(),
                Some(fixture["idempotencyKey"].as_str().unwrap().to_owned()),
                fixture["createdAt"].as_str().unwrap().to_owned(),
                None,
                0,
                fixture["createdAt"].as_str().unwrap().to_owned(),
            )
        );
        assert!(
            store
                .append_durable_event(
                    "fixture.other",
                    fixture["payloadJson"].as_str().unwrap(),
                    fixture["createdAt"].as_str().unwrap(),
                    fixture["correlationJson"].as_str().unwrap(),
                    fixture["idempotencyKey"].as_str(),
                )
                .is_err(),
            "reusing the key for another event must fail closed"
        );
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn durable_event_outbox_failure_rolls_back_the_audit_chain() {
        let path = new_path("event-rollback");
        create_schema(&path, &[SUPPORTED_SCHEMA_VERSION], false);
        let fixture = golden_event();
        let mut store = DatabaseStore::open_existing(&path).expect("supported schema should open");
        store
            .connection()
            .execute_batch(
                "CREATE TRIGGER reject_fixture_outbox BEFORE INSERT ON outbox
             WHEN NEW.event_type = 'fixture.event'
             BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END;",
            )
            .expect("install fault trigger");
        assert!(
            store
                .append_durable_event(
                    fixture["eventType"].as_str().unwrap(),
                    fixture["payloadJson"].as_str().unwrap(),
                    fixture["createdAt"].as_str().unwrap(),
                    fixture["correlationJson"].as_str().unwrap(),
                    fixture["idempotencyKey"].as_str(),
                )
                .is_err()
        );
        assert_eq!(
            store
                .connection()
                .query_row("SELECT count(*) FROM audit_events", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .connection()
                .query_row("SELECT count(*) FROM outbox", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            0
        );
        drop(store);
        std::fs::remove_file(path).expect("remove fixture");
    }
}
