import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [script, ...argumentsForScript] = process.argv.slice(2);
if (!script) throw new Error("Usage: node scripts/run-electron-script.mjs <script> [args...]");

const electron = path.resolve("node_modules/electron/dist/electron.exe");
const userData = await mkdtemp(path.join(os.tmpdir(), "orchestrator-electron-"));
const child = spawn(
  electron,
  [
    "--no-sandbox",
    "--disable-gpu",
    `--user-data-dir=${userData}`,
    "--require",
    path.resolve("scripts/electron-test-preload.cjs"),
    path.resolve(script),
    ...argumentsForScript
  ],
  { stdio: "inherit", windowsHide: true }
);

child.once("error", (error) => {
  console.error(`Electron script failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  void rm(userData, { recursive: true, force: true });
  if (signal) {
    console.error(`Electron script stopped by signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
