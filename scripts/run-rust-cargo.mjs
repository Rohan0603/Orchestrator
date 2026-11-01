import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const userCargo = join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const executable = process.env.CARGO || (existsSync(userCargo) ? userCargo : "cargo");
const environment = {...process.env};
if (!environment.ORCHESTRATOR_BUILD_REVISION) {
  try {
    environment.ORCHESTRATOR_BUILD_REVISION = execFileSync(
      "git",
      ["describe", "--always", "--dirty", "--abbrev=12"],
      {encoding: "utf8"},
    ).trim();
  } catch {
    // The build script falls back to the available Git revision or "unknown".
  }
}
const result = spawnSync(executable, process.argv.slice(2), {stdio: "inherit", windowsHide: true, env: environment});

if (result.error) {
  console.error(`Cargo could not be started from ${executable}: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
