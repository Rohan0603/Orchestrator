use std::env;
use std::process::Command;

fn main() {
    let target = env::var("TARGET").unwrap_or_else(|_| "unknown".to_owned());
    println!("cargo:rustc-env=AGENTCONDUCTOR_BUILD_TARGET={target}");
    println!("cargo:rerun-if-env-changed=ORCHESTRATOR_BUILD_REVISION");

    let revision = env::var("ORCHESTRATOR_BUILD_REVISION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["describe", "--always", "--dirty", "--abbrev=12"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=AGENTCONDUCTOR_BUILD_REVISION={revision}");
}
