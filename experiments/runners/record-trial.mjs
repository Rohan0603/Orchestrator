import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = option("--config");
const outputPath = option("--output");
const status = option("--status") ?? "blocked";
const reason = option("--reason");
const sourceRevision = option("--source-revision");

if (!configPath || !outputPath || !reason || !sourceRevision) {
  throw new Error(
    "Usage: node record-trial.mjs --config <path> --output <new-json-path> --status <status> --reason <reason> --source-revision <commit>"
  );
}
if (!["accepted", "failed", "blocked", "inconclusive", "invalid", "excluded"].includes(status)) {
  throw new Error(`Invalid trial status: ${status}`);
}
const resolvedConfig = resolve(configPath);
const config = JSON.parse(readFileSync(resolvedConfig, "utf8"));
const resolvedOutput = resolve(outputPath);
if (existsSync(resolvedOutput)) {
  throw new Error(`Refusing to overwrite existing raw result: ${resolvedOutput}`);
}
const trial = {
  schemaVersion: "trial-result-v1",
  experimentId: config.experimentId,
  trialId: `${config.experimentId}-${randomUUID()}`,
  replicate: 1,
  sourceRevision,
  configuration: basename(resolvedConfig),
  status,
  validity: { valid: status !== "invalid", reason },
  prerequisites: {
    adapterId: config.worker?.adapterId ?? null,
    protocol: config.worker?.protocol ?? null,
    externalProviderCalls: config.safety?.externalProviderCalls ?? null
  }
};
mkdirSync(dirname(resolvedOutput), { recursive: true });
writeFileSync(resolvedOutput, `${JSON.stringify(trial, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${resolvedOutput}\n`);
