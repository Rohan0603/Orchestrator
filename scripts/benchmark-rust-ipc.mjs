import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cpus, release } from "node:os";
import { performance } from "node:perf_hooks";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const match = /^(--[^=]+)=(.*)$/.exec(process.argv[index]);
  if (match) args.set(match[1], match[2]);
  else if (process.argv[index].startsWith("--") && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    args.set(process.argv[index], process.argv[index + 1]);
    index += 1;
  }
}

const count = Number(args.get("--count") ?? 1000);
const output = args.get("--output");
const sourceRevision = args.get("--source-revision");
if (!Number.isSafeInteger(count) || count < 10 || !output || !/^[0-9a-f]{7,40}$/i.test(sourceRevision ?? "")) {
  throw new Error("Usage: node scripts/benchmark-rust-ipc.mjs --count 1000 --output <new-json-path> --source-revision <git-sha>");
}

const require = createRequire(import.meta.url);
const { RustCoreClient } = require("../dist/main/rust-core-client.js");
const { encodeFrame, decodeFrame } = require("../dist/protocol/v1.js");
const corePath = resolve("target", "debug", process.platform === "win32" ? "orchestrator-core.exe" : "orchestrator-core");
const client = await RustCoreClient.start(corePath);
const health = {
  protocolVersion: 1,
  kind: "request",
  messageId: "benchmark-health",
  correlationId: "benchmark-correlation",
  causationId: null,
  sender: { id: "typescript-client", role: "client" },
  method: "system.health",
  payload: {}
};
const response = {
  protocolVersion: 1,
  kind: "response",
  messageId: "benchmark-response",
  correlationId: "benchmark-correlation",
  causationId: "benchmark-health",
  sender: { id: "orchestrator-core", role: "core" },
  inReplyTo: "benchmark-health",
  ok: true,
  result: { ready: true, protocolVersion: 1 }
};

function percentile(samples, fraction) {
  return samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
    meanMs: Number((sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length).toFixed(4))
  };
}

try {
  for (let index = 0; index < 25; index += 1) {
    await client.request({ ...health, messageId: `warmup-${index}`, correlationId: `warmup-correlation-${index}` });
  }

  const ipcSamples = [];
  const ipcStartedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    const result = await client.request({
      ...health,
      messageId: `benchmark-${index}`,
      correlationId: `benchmark-correlation-${index}`
    });
    if (!result.ok) throw new Error(`Health request failed with ${result.error.code}`);
    ipcSamples.push(performance.now() - startedAt);
  }
  const ipcElapsedMs = performance.now() - ipcStartedAt;

  const codecSamples = [];
  const codecStartedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    const requestFrame = encodeFrame({ ...health, messageId: `codec-${index}`, correlationId: `codec-correlation-${index}` });
    const responseFrame = encodeFrame({ ...response, inReplyTo: `codec-${index}`, causationId: `codec-${index}` });
    if (!requestFrame.ok || !responseFrame.ok || !decodeFrame(requestFrame.value).ok || !decodeFrame(responseFrame.value).ok) {
      throw new Error("Codec-only control failed to encode/decode a v1 frame");
    }
    codecSamples.push(performance.now() - startedAt);
  }
  const codecElapsedMs = performance.now() - codecStartedAt;

  const result = {
    benchmark: "agentconductor-rust-stdio-ipc-v1",
    sourceRevision,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      osRelease: release(),
      nodeVersion: process.version,
      architecture: process.arch,
      cpu: (cpus()[0]?.model ?? process.env.PROCESSOR_IDENTIFIER ?? "unknown").trim()
    },
    transport: {
      type: "private-child-stdio",
      framing: "4-byte-big-endian-length-prefixed-utf8-json",
      requestMode: "sequential-health-roundtrip",
      count,
      codecOnlyControl: "encode-decode-request-and-response",
      ipcElapsedMs: Number(ipcElapsedMs.toFixed(3)),
      ipcRequestsPerSecond: Number((count * 1000 / ipcElapsedMs).toFixed(1)),
      ipcRoundTrip: summarize(ipcSamples),
      codecElapsedMs: Number(codecElapsedMs.toFixed(3)),
      codecOperationsPerSecond: Number((count * 1000 / codecElapsedMs).toFixed(1)),
      codecOnly: summarize(codecSamples),
      p50DeltaMs: Number((percentile([...ipcSamples].sort((a, b) => a - b), 0.5) - percentile([...codecSamples].sort((a, b) => a - b), 0.5)).toFixed(4))
    }
  };
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await client.close();
}
