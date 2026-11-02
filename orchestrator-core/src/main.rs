use anyhow::Context;
use orchestrator_core::ipc::{self, ShutdownReason};
use orchestrator_core::storage::DatabaseStore;
use orchestrator_core::{CoreError, PROTOCOL_VERSION, RuntimeConfig, metadata};
use serde_json::json;
use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing_subscriber::EnvFilter;

enum Command {
    Metadata,
    Version,
    Help,
    Migrate {
        database_path: PathBuf,
    },
    Serve {
        config_path: Option<PathBuf>,
        database_path: Option<PathBuf>,
        enable_wal: bool,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    install_panic_hook();
    let command = match parse_command(env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            init_logging("info");
            tracing::error!(
                event = "backend.startup_rejected",
                error_code = error.code()
            );
            return ExitCode::from(2);
        }
    };

    match command {
        Command::Metadata => match write_metadata() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                let _ = write_json_error("METADATA_WRITE_FAILED");
                let _ = error;
                ExitCode::from(1)
            }
        },
        Command::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Command::Help => {
            println!(
                "orchestrator-core [serve [--config <path>] [--database <path> [--enable-wal]] | migrate --database <path> | --metadata | --version | --help]"
            );
            ExitCode::SUCCESS
        }
        Command::Migrate { database_path } => {
            match DatabaseStore::migrate_existing(&database_path) {
                Ok(schema_version) => {
                    println!("{}", json!({"schemaVersion": schema_version}));
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    let _ = write_json_error("DATABASE_MIGRATION_FAILED");
                    let _ = error;
                    ExitCode::from(1)
                }
            }
        }
        Command::Serve {
            config_path,
            database_path,
            enable_wal,
        } => {
            let environment_log_level = env::var("ORCHESTRATOR_CORE_LOG_LEVEL").ok();
            let config = match RuntimeConfig::load(config_path.as_deref(), environment_log_level) {
                Ok(config) => config,
                Err(error) => {
                    init_logging("info");
                    tracing::error!(
                        event = "backend.startup_rejected",
                        error_code = error.code()
                    );
                    return ExitCode::from(2);
                }
            };
            init_logging(&config.log_level);
            let store = match database_path.as_deref() {
                Some(path) => match DatabaseStore::open_existing(path) {
                    Ok(mut store) => {
                        if enable_wal && let Err(error) = store.enable_wal() {
                            tracing::error!(
                                event = "backend.startup_rejected",
                                error_code = CoreError::Database.code()
                            );
                            let _ = error;
                            return ExitCode::from(2);
                        }
                        Some(store)
                    }
                    Err(error) => {
                        tracing::error!(
                            event = "backend.startup_rejected",
                            error_code = CoreError::Database.code()
                        );
                        let _ = error;
                        return ExitCode::from(2);
                    }
                },
                None => None,
            };
            let runtime_metadata = metadata();
            tracing::info!(
                event = "backend.starting",
                protocol_version = PROTOCOL_VERSION,
                version = runtime_metadata.version,
                build_revision = runtime_metadata.build_revision,
                target = runtime_metadata.target,
                state = "starting",
                authoritative_state_mutated = false
            );
            match ipc::serve_stdio(store).await {
                Ok(reason) => {
                    log_stopping(reason);
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    tracing::error!(
                        event = "backend.protocol_rejected",
                        error_code = error.code()
                    );
                    ExitCode::from(1)
                }
            }
        }
    }
}

fn parse_command(args: impl Iterator<Item = String>) -> Result<Command, CoreError> {
    let args = args.collect::<Vec<_>>();
    if args.is_empty() {
        return Ok(Command::Serve {
            config_path: None,
            database_path: None,
            enable_wal: false,
        });
    }
    if args == ["--metadata"] {
        return Ok(Command::Metadata);
    }
    if args == ["--version"] {
        return Ok(Command::Version);
    }
    if args == ["--help"] || args == ["-h"] {
        return Ok(Command::Help);
    }
    if args.first().is_some_and(|arg| arg == "migrate") {
        if args.len() == 3 && args[1] == "--database" && !args[2].is_empty() {
            return Ok(Command::Migrate {
                database_path: PathBuf::from(&args[2]),
            });
        }
        return Err(CoreError::InvalidArguments);
    }

    let mut index = if args.first().is_some_and(|arg| arg == "serve") {
        1
    } else {
        0
    };
    let mut config_path = None;
    let mut database_path = None;
    let mut enable_wal = false;
    while index < args.len() {
        match args[index].as_str() {
            "--config" if index + 1 < args.len() && config_path.is_none() => {
                index += 1;
                config_path = Some(PathBuf::from(&args[index]));
            }
            "--database" if index + 1 < args.len() && database_path.is_none() => {
                index += 1;
                database_path = Some(PathBuf::from(&args[index]));
            }
            "--enable-wal" if !enable_wal => enable_wal = true,
            _ => return Err(CoreError::InvalidArguments),
        }
        index += 1;
    }
    if args.first().is_some_and(|arg| arg == "serve") || args.is_empty() {
        if enable_wal && database_path.is_none() {
            return Err(CoreError::InvalidArguments);
        }
        Ok(Command::Serve {
            config_path,
            database_path,
            enable_wal,
        })
    } else {
        Err(CoreError::InvalidArguments)
    }
}

fn init_logging(log_level: &str) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(log_level));
    let _ = tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_target(false)
        .with_writer(io::stderr)
        .with_env_filter(filter)
        .try_init();
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info.location().map(|location| {
            json!({
                "file": location.file(),
                "line": location.line(),
                "column": location.column()
            })
        });
        let timestamp_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let record = json!({
            "timestampUnixMs": timestamp_unix_ms,
            "level": "ERROR",
            "fields": {
                "event": "backend.panic",
                "message": "panic payload redacted",
                "location": location
            }
        });
        let _ = writeln!(io::stderr().lock(), "{record}");
    }));
}

fn write_metadata() -> anyhow::Result<()> {
    serde_json::to_writer(io::stdout().lock(), &metadata())
        .context("serialize runtime metadata")?;
    println!();
    Ok(())
}

fn write_json_error(error_code: &str) -> io::Result<()> {
    writeln!(
        io::stderr().lock(),
        "{}",
        json!({"level":"ERROR","event":"backend.cli_failed","errorCode":error_code})
    )
}

fn log_stopping(reason: ShutdownReason) {
    tracing::info!(
        event = "backend.stopping",
        reason = reason.label(),
        state = "stopping"
    );
    tracing::info!(
        event = "backend.stopped",
        reason = reason.label(),
        state = "stopped"
    );
}
