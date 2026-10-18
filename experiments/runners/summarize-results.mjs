import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const resultsDirectory = option("--results");
const outputPath = option("--output");
if (!resultsDirectory || !outputPath) {
  throw new Error("Usage: node summarize-results.mjs --results <directory> --output <markdown-path>");
}

const records = readdirSync(resolve(resultsDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(resolve(resultsDirectory, name), "utf8")));
const counts = Object.fromEntries(
  ["accepted", "failed", "blocked", "inconclusive", "invalid", "excluded"]
    .map((status) => [status, records.filter((record) => record.status === status).length])
);
const lines = [
  "# Trial summary",
  "",
  `Records: ${records.length}`,
  "",
  "| Status | Count |",
  "|---|---:|",
  ...Object.entries(counts).map(([status, count]) => `| ${status} | ${count} |`),
  "",
  "## Records",
  "",
  ...records.map((record) =>
    `- \`${record.trialId}\`: **${record.status}** — ${record.validity?.reason ?? "No reason recorded"}`
  ),
  ""
];
writeFileSync(resolve(outputPath), lines.join("\n"), { flag: "w" });
process.stdout.write(`${basename(resolve(outputPath))}\n`);
