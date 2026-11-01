use crate::storage::DatabaseInfo;
use crate::{PROTOCOL_VERSION, SCHEMA_VERSION, V1_METHODS, metadata};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use thiserror::Error;
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::signal;

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
const RESPONSE_CACHE_LIMIT: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShutdownReason {
    StdinEof,
    CtrlC,
}

impl ShutdownReason {
    pub fn label(self) -> &'static str {
        match self {
            Self::StdinEof => "stdin_eof",
            Self::CtrlC => "ctrl_c",
        }
    }
}

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("protocol input or output failed")]
    Io(#[from] io::Error),
    #[error("frame length is outside the v1 limit")]
    FrameLength,
    #[error("frame is truncated")]
    TruncatedFrame,
    #[error("frame body is not valid UTF-8")]
    InvalidUtf8,
    #[error("frame body is not valid JSON")]
    InvalidJson,
    #[error("hello is missing, malformed, incompatible, or lacks a required capability")]
    HandshakeRejected,
    #[error("protocol response could not be serialized")]
    Serialize,
}

impl IpcError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "IPC_IO_FAILED",
            Self::FrameLength => "FRAME_TOO_LARGE",
            Self::TruncatedFrame => "INVALID_ENVELOPE",
            Self::InvalidUtf8 | Self::InvalidJson => "INVALID_ENVELOPE",
            Self::HandshakeRejected => "CAPABILITY_UNAVAILABLE",
            Self::Serialize => "INTERNAL",
        }
    }
}

#[derive(Clone)]
struct CachedResponse {
    digest: [u8; 32],
    response: Value,
}

pub async fn serve_stdio(database: Option<DatabaseInfo>) -> Result<ShutdownReason, IpcError> {
    let mut stdin = io::stdin();
    let mut stdout = io::stdout();
    let hello = read_frame(&mut stdin)
        .await?
        .ok_or(IpcError::HandshakeRejected)?;
    let Some((sender_id, sender_role, welcome)) = build_welcome(&hello, database.as_ref()) else {
        return Err(IpcError::HandshakeRejected);
    };
    write_frame(&mut stdout, &welcome).await?;
    tracing::info!(
        event = "backend.ready",
        protocol_version = PROTOCOL_VERSION,
        version = env!("CARGO_PKG_VERSION"),
        build_revision = env!("AGENTCONDUCTOR_BUILD_REVISION"),
        state = "ready",
        authoritative_state_mutated = false
    );

    let mut response_sequence = 0_u64;
    let mut response_cache = HashMap::<String, CachedResponse>::new();
    let mut response_order = VecDeque::<String>::new();
    loop {
        let next_frame = tokio::select! {
            signal_result = signal::ctrl_c() => {
                signal_result.map_err(IpcError::Io)?;
                return Ok(ShutdownReason::CtrlC);
            }
            frame_result = read_frame(&mut stdin) => frame_result?,
        };
        let Some(request) = next_frame else {
            return Ok(ShutdownReason::StdinEof);
        };
        response_sequence += 1;

        let request_id = request
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value))
            .map(str::to_owned);
        let canonical = serde_json::to_vec(&request).map_err(|_| IpcError::Serialize)?;
        let digest: [u8; 32] = Sha256::digest(&canonical).into();
        let response = if let Some(request_id) = request_id.as_deref() {
            if let Some(previous) = response_cache.get(request_id) {
                if previous.digest == digest {
                    previous.response.clone()
                } else {
                    error_response(
                        Some(&request),
                        response_sequence,
                        "MESSAGE_ID_CONFLICT",
                        "Message ID was reused with different content",
                        None,
                    )
                }
            } else {
                let response = dispatch_request(
                    &request,
                    &sender_id,
                    &sender_role,
                    response_sequence,
                    database.as_ref(),
                );
                response_order.push_back(request_id.to_owned());
                response_cache.insert(
                    request_id.to_owned(),
                    CachedResponse {
                        digest,
                        response: response.clone(),
                    },
                );
                while response_order.len() > RESPONSE_CACHE_LIMIT {
                    if let Some(expired_id) = response_order.pop_front() {
                        response_cache.remove(&expired_id);
                    }
                }
                response
            }
        } else {
            error_response(
                Some(&request),
                response_sequence,
                "INVALID_ENVELOPE",
                "Request envelope is malformed",
                None,
            )
        };
        write_frame(&mut stdout, &response).await?;
    }
}

fn build_welcome(
    hello: &Value,
    database: Option<&DatabaseInfo>,
) -> Option<(String, String, Value)> {
    let hello = hello.as_object()?;
    if !common_envelope(hello)
        || hello.get("kind")?.as_str()? != "hello"
        || hello.get("protocolVersion")?.as_u64()? != u64::from(PROTOCOL_VERSION)
    {
        return None;
    }
    let minimum = hello.get("minimumProtocol")?.as_u64()?;
    let maximum = hello.get("maximumProtocol")?.as_u64()?;
    if minimum > maximum
        || u64::from(PROTOCOL_VERSION) < minimum
        || u64::from(PROTOCOL_VERSION) > maximum
        || hello.get("schemaVersion")?.as_u64()? != u64::from(SCHEMA_VERSION)
        || hello.get("clientVersion")?.as_str()?.is_empty()
    {
        return None;
    }
    let sender = hello.get("sender")?.as_object()?;
    let sender_id = sender.get("id")?.as_str()?.to_owned();
    let sender_role = sender.get("role")?.as_str()?.to_owned();
    if sender_role != "client" {
        return None;
    }
    let required_capabilities = hello.get("requiredCapabilities")?.as_array()?;
    if required_capabilities.iter().any(|item| {
        item.as_str()
            .is_none_or(|name| !valid_id(name) || !is_supported_capability(name))
    }) {
        return None;
    }

    let capabilities = metadata().capabilities;
    let welcome = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "welcome",
        "messageId": "core-welcome-1",
        "correlationId": hello.get("correlationId")?,
        "causationId": hello.get("messageId")?,
        "sender": {"id": "orchestrator-core", "role": "backend"},
        "selectedProtocol": PROTOCOL_VERSION,
        "backendVersion": env!("CARGO_PKG_VERSION"),
        "buildId": env!("AGENTCONDUCTOR_BUILD_REVISION"),
        "schemaVersion": SCHEMA_VERSION,
        "databaseSchemaVersion": database.map_or(0, |info| info.schema_version),
        "processSupervision": "parent-owned-stdio",
        "ready": true,
        "capabilities": capabilities
    });
    Some((sender_id, sender_role, welcome))
}

fn dispatch_request(
    request: &Value,
    authenticated_sender_id: &str,
    authenticated_sender_role: &str,
    response_sequence: u64,
    database: Option<&DatabaseInfo>,
) -> Value {
    let Some(envelope) = request.as_object() else {
        return error_response(
            Some(request),
            response_sequence,
            "INVALID_ENVELOPE",
            "Request envelope is malformed",
            None,
        );
    };
    if envelope.get("protocolVersion").and_then(Value::as_u64) != Some(u64::from(PROTOCOL_VERSION))
    {
        return error_response(
            Some(request),
            response_sequence,
            "UNSUPPORTED_VERSION",
            "Protocol major version is unsupported",
            None,
        );
    }
    if !common_envelope(envelope)
        || envelope.get("kind").and_then(Value::as_str) != Some("request")
        || envelope
            .get("method")
            .and_then(Value::as_str)
            .is_none_or(|method| !valid_id(method))
        || !envelope.get("payload").is_some_and(Value::is_object)
    {
        return error_response(
            Some(request),
            response_sequence,
            "INVALID_ENVELOPE",
            "Request envelope is malformed",
            None,
        );
    }
    let sender = &envelope["sender"];
    if sender.get("id").and_then(Value::as_str) != Some(authenticated_sender_id)
        || sender.get("role").and_then(Value::as_str) != Some(authenticated_sender_role)
    {
        return error_response(
            Some(request),
            response_sequence,
            "UNAUTHORIZED_SENDER",
            "Envelope sender does not match the negotiated local peer",
            None,
        );
    }
    let method = envelope["method"].as_str().unwrap_or_default();
    if !V1_METHODS.contains(&method) {
        return error_response(
            Some(request),
            response_sequence,
            "METHOD_NOT_FOUND",
            "Method is not in the v1 registry",
            Some(json!({"method": method})),
        );
    }
    let payload = &envelope["payload"];
    if method == "system.health" && payload.as_object().is_some() {
        let result = json!({
            "ready": true,
            "state": "ready",
            "database": if database.is_some() { "open" } else { "not_open" },
            "databaseSchemaVersion": database.map_or(0, |info| info.schema_version),
            "sqliteVersion": database.map(|info| info.sqlite_version.as_str()),
            "journalMode": database.map(|info| info.journal_mode.as_str()),
            "protocolVersion": PROTOCOL_VERSION,
            "backendVersion": env!("CARGO_PKG_VERSION"),
            "activeRuns": 0,
            "recoveryRequired": 0
        });
        return success_response(request, response_sequence, result);
    }
    if method == "capabilities.list" && payload.as_object().is_some() {
        return success_response(
            request,
            response_sequence,
            serde_json::to_value(metadata().capabilities).unwrap_or(Value::Array(Vec::new())),
        );
    }
    if matches!(method, "system.health" | "capabilities.list") {
        return error_response(
            Some(request),
            response_sequence,
            "MALFORMED_PAYLOAD",
            "Method payload does not match its v1 schema",
            Some(json!({"method": method})),
        );
    }
    error_response(
        Some(request),
        response_sequence,
        "NOT_IMPLEMENTED",
        "The method is specified but not implemented by this backend adapter",
        Some(json!({"method": method})),
    )
}

fn success_response(request: &Value, response_sequence: u64, result: Value) -> Value {
    response_base(request, response_sequence, true, Some(result), None)
}

fn error_response(
    request: Option<&Value>,
    response_sequence: u64,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> Value {
    let error = match details {
        Some(details) => {
            json!({"code": code, "message": message, "retryable": false, "details": details})
        }
        None => json!({"code": code, "message": message, "retryable": false}),
    };
    response_base(
        request.unwrap_or(&Value::Null),
        response_sequence,
        false,
        None,
        Some(error),
    )
}

fn response_base(
    request: &Value,
    response_sequence: u64,
    ok: bool,
    result: Option<Value>,
    error: Option<Value>,
) -> Value {
    let response_id = format!("core-response-{response_sequence}");
    let request_id = request
        .get("messageId")
        .and_then(Value::as_str)
        .filter(|value| valid_id(value));
    let correlation_id = request
        .get("correlationId")
        .and_then(Value::as_str)
        .filter(|value| valid_id(value))
        .unwrap_or(&response_id);
    let causation_id = request_id.map_or(Value::Null, |id| Value::String(id.to_owned()));
    let in_reply_to = request_id.unwrap_or(&response_id);
    let mut response = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "messageId": response_id,
        "correlationId": correlation_id,
        "causationId": causation_id,
        "sender": {"id": "orchestrator-core", "role": "backend"},
        "inReplyTo": in_reply_to,
        "ok": ok
    });
    if let Some(result) = result {
        response
            .as_object_mut()
            .expect("response object")
            .insert("result".to_owned(), result);
    }
    if let Some(error) = error {
        response
            .as_object_mut()
            .expect("response object")
            .insert("error".to_owned(), error);
    }
    response
}

fn common_envelope(envelope: &Map<String, Value>) -> bool {
    let valid_causation = envelope
        .get("causationId")
        .is_some_and(|value| value.is_null() || value.as_str().is_some_and(valid_id));
    let sender_valid = envelope.get("sender").is_some_and(|value| {
        value.as_object().is_some_and(|sender| {
            sender
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(valid_id)
                && sender
                    .get("role")
                    .and_then(Value::as_str)
                    .is_some_and(valid_id)
        })
    });
    envelope
        .get("messageId")
        .and_then(Value::as_str)
        .is_some_and(valid_id)
        && envelope
            .get("correlationId")
            .and_then(Value::as_str)
            .is_some_and(valid_id)
        && valid_causation
        && sender_valid
        && envelope.get("traceContext").is_none_or(valid_trace_context)
}

fn valid_trace_context(value: &Value) -> bool {
    let Some(trace_context) = value.as_object() else {
        return false;
    };
    let Some(traceparent) = trace_context.get("traceparent").and_then(Value::as_str) else {
        return false;
    };
    let parts = traceparent.split('-').collect::<Vec<_>>();
    if parts.len() != 4
        || parts[0] != "00"
        || parts[1].len() != 32
        || parts[2].len() != 16
        || parts[3].len() != 2
        || !parts[1..].iter().all(|part| {
            part.bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        || parts[1].bytes().all(|byte| byte == b'0')
        || parts[2].bytes().all(|byte| byte == b'0')
    {
        return false;
    }
    trace_context.get("tracestate").is_none_or(|state| {
        state.as_str().is_some_and(|state| {
            state.len() <= 512 && state.bytes().all(|byte| (b' '..=b'~').contains(&byte))
        })
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
}

fn is_supported_capability(name: &str) -> bool {
    matches!(name, "system.health" | "capabilities.list")
}

async fn read_frame<R>(reader: &mut R) -> Result<Option<Value>, IpcError>
where
    R: AsyncRead + Unpin,
{
    let mut prefix = [0_u8; 4];
    let first_read = reader.read(&mut prefix[..1]).await?;
    if first_read == 0 {
        return Ok(None);
    }
    reader
        .read_exact(&mut prefix[1..])
        .await
        .map_err(|_| IpcError::TruncatedFrame)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if !(1..=MAX_FRAME_BYTES).contains(&length) {
        return Err(IpcError::FrameLength);
    }
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| IpcError::TruncatedFrame)?;
    std::str::from_utf8(&body).map_err(|_| IpcError::InvalidUtf8)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| IpcError::InvalidJson)
}

async fn write_frame<W>(writer: &mut W, message: &Value) -> Result<(), IpcError>
where
    W: AsyncWrite + Unpin,
{
    let body = serde_json::to_vec(message).map_err(|_| IpcError::Serialize)?;
    if !(1..=MAX_FRAME_BYTES).contains(&body.len()) {
        return Err(IpcError::FrameLength);
    }
    writer.write_all(&(body.len() as u32).to_be_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{build_welcome, common_envelope, is_supported_capability};
    use crate::{V1_METHODS, metadata};
    use serde_json::Value;
    use std::collections::BTreeSet;

    #[test]
    fn rust_method_and_capability_manifests_match_the_frozen_schema() {
        let schema: Value =
            serde_json::from_str(include_str!("../../docs/protocol/v1/schema.json"))
                .expect("frozen schema parses");
        let methods = schema["$defs"]["method"]["enum"]
            .as_array()
            .expect("method registry is an array")
            .iter()
            .map(|method| method.as_str().expect("method is text"))
            .collect::<BTreeSet<_>>();
        assert_eq!(methods, V1_METHODS.iter().copied().collect());
        let capabilities = metadata().capabilities;
        assert_eq!(
            capabilities
                .iter()
                .map(|item| item.name)
                .collect::<BTreeSet<_>>(),
            methods
        );
        assert!(is_supported_capability("system.health"));
        assert!(!is_supported_capability("tasks.list"));
    }

    #[test]
    fn handshake_rejects_an_unverified_required_capability() {
        let hello: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/protocol/v1/hello.json"))
                .expect("golden hello parses");
        let mut hello = hello;
        hello["requiredCapabilities"] = serde_json::json!(["tasks.list"]);
        assert!(build_welcome(&hello, None).is_none());
    }

    #[test]
    fn shared_envelope_accepts_unknown_v1_fields_but_checks_trace_context() {
        let hello: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/protocol/v1/hello.json"))
                .expect("golden hello parses");
        let mut envelope = hello.as_object().expect("hello object").clone();
        envelope.insert("futureOptional".to_owned(), Value::Bool(true));
        assert!(common_envelope(&envelope));
        envelope.insert(
            "traceContext".to_owned(),
            serde_json::json!({"traceparent":"00-00000000000000000000000000000000-0123456789abcdef-01"}),
        );
        assert!(!common_envelope(&envelope));
    }
}
