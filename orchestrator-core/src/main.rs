use anyhow::Context;
use orchestrator_core::{CoreError, PROTOCOL_VERSION, RuntimeConfig, metadata};
use serde_json::json;
use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, Stdin};
use tokio::signal;
use tracing_subscriber::EnvFilter;

enum Command {
    Metadata,
    Version,
    Help,
    Serve(Option<PathBuf>),
}

#[derive(Clone, Copy)]
enum ShutdownReason {
    StdinEof,
    CtrlC,
}

impl ShutdownReason {
    fn label(self) -> &'static str {
        match self {
            Self::StdinEof => "stdin_eof",
            Self::CtrlC => "ctrl_c",
        }
    }
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
                "orchestrator-core [serve [--config <path>] | --metadata | --version | --help]"
            );
            ExitCode::SUCCESS
        }
        Command::Serve(config_path) => {
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
            match serve().await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    tracing::error!(event = "backend.runtime_failed", error_code = error.code());
                    ExitCode::from(1)
                }
            }
        }
    }
}

fn parse_command(args: impl Iterator<Item = String>) -> Result<Command, CoreError> {
    let args = args.collect::<Vec<_>>();
    if args.is_empty() {
        return Ok(Command::Serve(None));
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

    let mut index = if args.first().is_some_and(|arg| arg == "serve") {
        1
    } else {
        0
    };
    let mut config_path = None;
    while index < args.len() {
        match args[index].as_str() {
            "--config" if index + 1 < args.len() && config_path.is_none() => {
                index += 1;
                config_path = Some(PathBuf::from(&args[index]));
            }
            _ => return Err(CoreError::InvalidArguments),
        }
        index += 1;
    }
    if args.first().is_some_and(|arg| arg == "serve") || args.is_empty() {
        Ok(Command::Serve(config_path))
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

async fn serve() -> Result<(), CoreError> {
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
    tracing::info!(
        event = "backend.ready",
        protocol_version = PROTOCOL_VERSION,
        version = runtime_metadata.version,
        build_revision = runtime_metadata.build_revision,
        state = "ready",
        authoritative_state_mutated = false
    );

    let reason = wait_for_shutdown(tokio::io::stdin()).await?;
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
    Ok(())
}

async fn wait_for_shutdown(mut stdin: Stdin) -> Result<ShutdownReason, CoreError> {
    let mut input_byte = [0_u8; 1];
    tokio::select! {
        signal_result = signal::ctrl_c() => {
            signal_result.map_err(CoreError::Signal)?;
            Ok(ShutdownReason::CtrlC)
        }
        read_result = stdin.read(&mut input_byte) => {
            let read_count = read_result.map_err(CoreError::Input)?;
            if read_count == 0 {
                Ok(ShutdownReason::StdinEof)
            } else {
                Err(CoreError::ProtocolNotReady)
            }
        }
    }
}
