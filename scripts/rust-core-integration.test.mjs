import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const executable = join(repositoryRoot, "target", "debug", process.platform === "win32" ? "orchestrator-core.exe" : "orchestrator-core");

function parseJsonLogLines(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function getEventName(record) {
  return record.event ?? record.fields?.event;
}

function waitForLogEvent(child, chunks, eventName) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error(`timed out waiting for ${eventName}`)), 5000);
    let partialLine = "";
    child.stderr.on("data", (chunk) => {
      const data = chunk.toString("utf8");
      chunks.push(data);
      partialLine += data;
      const lines = partialLine.split(/\r?\n/);
      partialLine = lines.pop() ?? "";
      try {
        for (const line of lines.filter(Boolean)) {
          const record = JSON.parse(line);
          if (getEventName(record) === eventName) {
            clearTimeout(timeout);
            resolvePromise(record);
            return;
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        rejectPromise(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

test("Rust core reports versioned protocol and capability metadata", () => {
  const output = execFileSync(executable, ["--metadata"], {encoding: "utf8", windowsHide: true});
  const metadata = JSON.parse(output);
  assert.equal(metadata.protocolVersion, 1);
  assert.equal(typeof metadata.version, "string");
  assert.equal(typeof metadata.buildRevision, "string");
  assert.equal(typeof metadata.target, "string");
  assert.ok(metadata.capabilities.some((capability) => capability.name === "system.health" && capability.state === "supported"));
  assert.ok(metadata.capabilities.some((capability) => capability.name === "capabilities.list" && capability.state === "supported"));
  assert.ok(metadata.capabilities.some((capability) => capability.name === "tasks.create" && capability.state === "unverified"));
});

test("Rust core becomes ready without touching state and shuts down cleanly on stdin EOF", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-rust-core-"));
  const configPath = join(directory, "core.json");
  writeFileSync(configPath, JSON.stringify({logLevel: "info"}));
  const stderrChunks = [];
  let stdout = "";
  let child;
  try {
    child = spawn(executable, ["serve", "--config", configPath], {cwd: repositoryRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const readyPromise = waitForLogEvent(child, stderrChunks, "backend.ready");
    const ready = await readyPromise;
    assert.equal(ready.protocol_version ?? ready.fields?.protocol_version, 1);
    assert.equal(stdout, "", "logs and readiness must stay off stdout reserved for framed IPC");
    assert.deepEqual(readdirSync(directory).sort(), ["core.json"], "startup must not create or mutate authoritative state");

    child.stdin.end();
    const [exitCode, signal] = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("Rust core did not shut down within five seconds")), 5000);
      child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
      child.once("close", (code, childSignal) => { clearTimeout(timeout); resolvePromise([code, childSignal]); });
    });
    assert.equal(signal, null);
    assert.equal(exitCode, 0);
    const events = parseJsonLogLines(stderrChunks.join("")).map(getEventName);
    assert.ok(events.includes("backend.stopping"));
    assert.ok(events.includes("backend.stopped"));
    assert.equal(stdout, "");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  }
});

test("Rust core rejects malformed configuration before reporting readiness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentconductor-rust-core-invalid-"));
  const configPath = join(directory, "core.json");
  writeFileSync(configPath, "{ invalid json");
  let stderr = "";
  let stdout = "";
  let child;
  try {
    child = spawn(executable, ["serve", "--config", configPath], {cwd: repositoryRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const [exitCode, signal] = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("invalid Rust core config did not fail within five seconds")), 5000);
      child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
      child.once("close", (code, childSignal) => { clearTimeout(timeout); resolvePromise([code, childSignal]); });
    });
    assert.equal(signal, null);
    assert.equal(exitCode, 2);
    assert.equal(stdout, "");
    const events = parseJsonLogLines(stderr).map(getEventName);
    assert.ok(events.includes("backend.startup_rejected"));
    assert.ok(!events.includes("backend.ready"));
    assert.equal(readFileSync(configPath, "utf8"), "{ invalid json");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  }
});
