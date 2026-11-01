use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use thiserror::Error;

pub const PROTOCOL_VERSION: u32 = 1;

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

#[derive(Debug, Serialize)]
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
        capabilities: vec![
            Capability {
                name: "system.health",
                state: "supported",
                reason: None,
            },
            Capability {
                name: "capabilities.list",
                state: "supported",
                reason: None,
            },
            Capability {
                name: "projects.create",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "tasks.create",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "workers.claim",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "leases.heartbeat",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "messages.dispatch",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "runs.cancel",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "runs.reconcile",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "policy.evaluate",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "review.request",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "acceptance.get",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "providers.streamTask",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "mcp.tools.call",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "plugins.execute",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
            Capability {
                name: "artifacts.get",
                state: "unverified",
                reason: Some(NOT_MIGRATED),
            },
        ],
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
