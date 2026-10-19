import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { OpenCodeCliAdapter } from "../../dist/harness/opencode-cli-adapter.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fixture = option("--fixture");
const model = option("--model");
const output = option("--output");
const sourceRevision = option("--source-revision");
if (!fixture || !model || !output || !sourceRevision) {
  throw new Error(
    "Usage: node run-opencode-cli.mjs --fixture <git-dir> --model <provider/model> --output <new-json> --source-revision <commit>"
  );
}

const fixturePath = resolve(fixture);
const outputPath = resolve(output);
const adapter = new OpenCodeCliAdapter({
  executable: process.platform === "win32"
    ? join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
    : "opencode",
  version: "1.19.0",
  model
});
const route = adapter.route;
const correlation = {
  dispatchId: `real-${Date.now()}`,
  runId: `real-${Date.now()}`,
  attemptId: `real-${Date.now()}`
};
const request = {
  dispatchId: correlation.dispatchId,
  idempotencyKey: correlation.dispatchId,
  authorization: {
    runId: correlation.runId,
    attemptId: correlation.attemptId,
    actionDigest: "fixture-action",
    approvalId: null,
    policyVersion: "policy-v1"
  },
  taskDescription:
    "Modify only value.txt. Change exact content from value=1 to value=2. Do not modify verify.ps1, do not commit, do not access network, and do not change files outside this repository. Run .\\verify.ps1 after editing. Report files changed and verification result.",
  deadlineAt: new Date(Date.now() + 300000).toISOString(),
  route,
  workingDirectory: fixturePath
};
const progress = [];
let terminal;
const created = await adapter.createRun(request);
if (!created.ok) throw new Error(created.error.message);
adapter.subscribeProgress(correlation, (event) => progress.push(event));
adapter.subscribeTerminal(correlation, (outcome) => {
  terminal = outcome;
});
for (let attempt = 0; !terminal && attempt < 600; attempt += 1) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
}
if (!terminal) throw new Error("Timed out waiting for OpenCode terminal outcome");

const diff = execFileSync("git", ["diff", "--binary", "--", "value.txt"], {
  cwd: fixturePath,
  encoding: "utf8"
});
let verifierStatus = "failed";
let verifierOutput = "";
try {
  verifierOutput = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "verify.ps1"],
    { cwd: fixturePath, encoding: "utf8" }
  ).trim();
  verifierStatus = "passed";
} catch (error) {
  verifierOutput = error instanceof Error ? error.message : String(error);
}
const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixturePath, encoding: "utf8" }).trim();
const record = {
  schemaVersion: "trial-result-v1",
  experimentId: "real-opencode-cli-json",
  trialId: `real-opencode-${Date.now()}`,
  replicate: 1,
  sourceRevision,
  fixtureBaseline: baseline,
  adapter: {
    adapterId: adapter.identity.adapterId,
    version: adapter.identity.adapterVersion,
    protocol: "CLI JSON",
    executable: process.platform === "win32" ? "opencode.cmd" : "opencode",
    route
  },
  invocation: {
    args: ["run", "--pure", "--auto", "--format", "json", "--model", model, "--dir", fixturePath],
    secretsRedacted: true
  },
  worker: {
    terminal,
    progressEvents: progress.length,
    usage: adapter.getUsage(correlation),
    exitStatus: terminal.kind === "succeeded" ? 0 : "nonzero"
  },
  artifacts: {
    changedFiles: execFileSync("git", ["diff", "--name-only"], { cwd: fixturePath, encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean),
    diffSha256: createHash("sha256").update(diff).digest("hex"),
    diff
  },
  verifier: { status: verifierStatus, output: verifierOutput },
  review: { status: "blocked", reason: "No independent reviewer configured" },
  acceptance: { status: "blocked", reason: "Independent review gate unavailable" },
  validity: {
    valid: terminal.kind === "succeeded" && verifierStatus === "passed",
    reason: "Real worker executed; acceptance remains blocked by review gate"
  }
};
writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${outputPath}\n`);
