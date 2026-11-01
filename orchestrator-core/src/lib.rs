use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use thiserror::Error;

pub mod ipc;

pub const PROTOCOL_VERSION: u32 = 1;
pub const SCHEMA_VERSION: u32 = 1;
pub const V1_METHODS: &[&str] = &[
    "system.health",
    "system.shutdown",
    "projects.create",
    "projects.get",
    "projects.list",
    "tasks.create",
    "tasks.update",
    "tasks.get",
    "tasks.list",
    "tasks.runs.list",
    "tasks.revisions.list",
    "tasks.dependencies.add",
    "tasks.dependencies.list",
    "workers.register",
    "skills.install",
    "mcp.servers.install",
    "plugins.install",
    "workers.claim",
    "leases.heartbeat",
    "leases.release",
    "workers.message",
    "workers.report",
    "messages.dispatch",
    "runs.cancel",
    "runs.reconcile",
    "policy.evaluate",
    "approvals.request",
    "verification.get",
    "review.request",
    "acceptance.get",
    "events.subscribe",
    "events.replay",
    "providers.streamTask",
    "mcp.tools.list",
    "mcp.tools.call",
    "plugins.execute",
    "capabilities.list",
    "artifacts.get",
];

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("configuration could not be read")]
    ConfigRead(#[source] std::io::Error),
    #[error("configuration is not valid JSON")]
    ConfigJson(#[source] serde_json::Error),
    #[error("configuration logLevel must be trace, debug, info, warn, error, or off")]
    InvalidLogLevel,
    #[error("command line arguments are invalid")]
    InvalidArguments,
    #[error("stdin data is not accepted before IPC v1 is implemented")]
    ProtocolNotReady,
    #[error("shutdown signal listener could not be installed")]
    Signal(#[source] std::io::Error),
    #[error("runtime input could not be read")]
    Input(#[source] std::io::Error),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConfigRead(_) => "CONFIG_READ_FAILED",
            Self::ConfigJson(_) => "CONFIG_INVALID_JSON",
            Self::InvalidLogLevel => "CONFIG_INVALID_LOG_LEVEL",
            Self::InvalidArguments => "INVALID_ARGUMENTS",
            Self::ProtocolNotReady => "IPC_NOT_IMPLEMENTED",
            Self::Signal(_) => "SHUTDOWN_SIGNAL_FAILED",
            Self::Input(_) => "STDIN_READ_FAILED",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfig {
    pub log_level: String,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            log_level: "info".to_owned(),
        }
    }
}

impl RuntimeConfig {
    pub fn load(
        path: Option<&Path>,
        environment_log_level: Option<String>,
    ) -> Result<Self, CoreError> {
        let mut config = match path {
            Some(path) => {
                let contents = fs::read_to_string(path).map_err(CoreError::ConfigRead)?;
                serde_json::from_str::<Self>(&contents).map_err(CoreError::ConfigJson)?
            }
            None => Self::default(),
        };
        if let Some(log_level) = environment_log_level {
            config.log_level = log_level;
        }
        if !matches!(
            config.log_level.as_str(),
            "trace" | "debug" | "info" | "warn" | "error" | "off"
        ) {
            return Err(CoreError::InvalidLogLevel);
        }
        Ok(config)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: &'static str,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetadata {
    pub protocol_version: u32,
    pub version: &'static str,
    pub build_revision: &'static str,
    pub target: &'static str,
    pub capabilities: Vec<Capability>,
}

pub fn metadata() -> RuntimeMetadata {
    const NOT_MIGRATED: &str =
        "RUST-3 runtime skeleton does not implement this authoritative service";
    RuntimeMetadata {
        protocol_version: PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION"),
        build_revision: env!("AGENTCONDUCTOR_BUILD_REVISION"),
        target: env!("AGENTCONDUCTOR_BUILD_TARGET"),
        capabilities: V1_METHODS
            .iter()
            .map(|name| {
                if matches!(*name, "system.health" | "capabilities.list") {
                    Capability {
                        name,
                        state: "supported",
                        reason: None,
                    }
                } else {
                    Capability {
                        name,
                        state: "unverified",
                        reason: Some(NOT_MIGRATED),
                    }
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::{PROTOCOL_VERSION, RuntimeConfig, metadata};

    #[test]
    fn runtime_metadata_keeps_unimplemented_services_unverified() {
        let manifest = metadata();
        assert_eq!(manifest.protocol_version, PROTOCOL_VERSION);
        assert!(!manifest.target.is_empty());
        assert!(manifest.capabilities.iter().any(
            |capability| capability.name == "tasks.create" && capability.state == "unverified"
        ));
    }

    #[test]
    fn environment_log_level_overrides_file_configuration() {
        let config = RuntimeConfig::load(None, Some("debug".to_owned())).expect("valid log level");
        assert_eq!(config.log_level, "debug");
    }
}
