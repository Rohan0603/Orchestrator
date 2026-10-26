import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OpenAICompatibleAdapter,
  readOpenAICompatibleConfig
} from "../../dist/harness/openai-compatible-adapter.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const output = option("--output");
const sourceRevision = option("--source-revision");
const prompt = option("--prompt") ?? "Reply with the single word: ready";
if (!output || !sourceRevision) {
  throw new Error(
    "Usage: node run-freellmapi-smoke.mjs --output <new-json> --source-revision <commit> [--prompt <text>]"
  );
}

const config = readOpenAICompatibleConfig();
if (!config) {
  throw new Error(
    "Set ORCHESTRATOR_OPENAI_BASE_URL, ORCHESTRATOR_OPENAI_API_KEY, and optionally ORCHESTRATOR_OPENAI_MODEL before running the smoke trial"
  );
}

const adapter = new OpenAICompatibleAdapter(config);
const correlation = {
  dispatchId: `freellmapi-${Date.now()}`,
  runId: `freellmapi-${Date.now()}`,
  attemptId: `freellmapi-${Date.now()}`
};
const request = {
  dispatchId: correlation.dispatchId,
  idempotencyKey: correlation.dispatchId,
  authorization: {
    runId: correlation.runId,
    attemptId: correlation.attemptId,
    actionDigest: "freellmapi-smoke",
    approvalId: null,
    policyVersion: "policy-v1"
  },
  taskDescription: prompt,
  deadlineAt: new Date(Date.now() + 120000).toISOString(),
  route: adapter.route
};
const progress = [];
let terminal;
const created = await adapter.createRun(request);
if (!created.ok) throw new Error(created.error.message);
adapter.subscribeProgress(correlation, (event) => progress.push({ kind: event.kind, sequence: event.sequence }));
adapter.subscribeTerminal(correlation, (outcome) => {
  terminal = outcome;
});
for (let attempt = 0; !terminal && attempt < 240; attempt += 1) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
}
if (!terminal) throw new Error("Timed out waiting for freellmapi terminal outcome");

const record = {
  schemaVersion: "trial-result-v1",
  experimentId: "freellmapi-openai-compatible-smoke",
  trialId: `freellmapi-${Date.now()}`,
  sourceRevision,
  adapter: {
    adapterId: adapter.identity.adapterId,
    version: adapter.identity.adapterVersion,
    protocol: "OpenAI-compatible chat completions over SSE",
    route: adapter.route
  },
  invocation: {
    endpoint: `${config.baseUrl}/chat/completions`,
    model: config.model,
    secretsRedacted: true,
    promptRedacted: true
  },
  worker: {
    terminal,
    progressEvents: progress.length,
    usage: adapter.getUsage(correlation)
  },
  validity: {
    valid: terminal.kind === "succeeded",
    reason: "Smoke trial validates HTTP/SSE execution only; it does not qualify cancellation, artifacts, or restart reconciliation"
  }
};
writeFileSync(resolve(output), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${resolve(output)}\n`);
await adapter.close();
