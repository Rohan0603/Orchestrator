import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function evaluateRun({ exitCode, resultCount, expected, timedOut = false }) {
  return !timedOut && exitCode === 0 && resultCount === expected;
}

export async function runElectronTests({
  electron = path.resolve("node_modules/electron/dist/electron.exe"),
  testFile,
  expected,
  timeoutMs = 120_000,
  killWaitMs = 5_000
}) {
  const child = spawn(electron, [
    "--no-sandbox",
    "--require",
    path.resolve("scripts/electron-test-preload.cjs"),
    "--test",
    testFile
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  let resultCount = 0;
  let pending = "";
  let timedOut = false;
  let killTimer;

  const consume = (chunk, stream) => {
    const text = chunk.toString();
    output += text;
    stream.write(text);
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    resultCount += lines.filter((line) => /^\s*(?:✔|✖)\s/.test(line)).length;
  };
  child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
  child.stderr.on("data", (chunk) => consume(chunk, process.stderr));

  let timeout;
  const result = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve(value);
    };
    child.once("error", (error) => {
      output += `\nRunner child error: ${error.message}\n`;
      settle({ exitCode: null, resultCount, output, timedOut });
    });
    child.once("close", (exitCode, signal) => {
      resultCount += pending.split(/\r?\n/).filter((line) => /^\s*(?:✔|✖)\s/.test(line)).length;
      settle({ exitCode, signal, resultCount, output, timedOut });
    });
    timeout = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`Electron test timeout after ${timeoutMs}ms; stopping owned child ${child.pid}\n`);
      if (!child.killed) child.kill();
      killTimer = setTimeout(() => {
        if (!settled) {
          process.stderr.write(`Electron test child ${child.pid} did not exit after bounded cleanup\n`);
          settle({ exitCode: null, resultCount, output, timedOut });
        }
      }, killWaitMs);
    }, timeoutMs);
  });
  return { ...result, passed: evaluateRun({ ...result, expected }) };
}

const [expectedArgument, testFile] = process.argv.slice(2);
const expected = Number(expectedArgument?.replace("--expected=", ""));
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!Number.isInteger(expected) || expected < 1 || !testFile) {
    console.error("Usage: node scripts/run-electron-tests.mjs --expected=N test-file");
    process.exit(2);
  }
  const result = await runElectronTests({ testFile, expected });
  if (!result.passed) {
    console.error(
      `Electron suite failed: exitCode=${result.exitCode ?? "unknown"} ` +
      `results=${result.resultCount}/${expected} timedOut=${result.timedOut}`
    );
    process.exitCode = 1;
  }
}
