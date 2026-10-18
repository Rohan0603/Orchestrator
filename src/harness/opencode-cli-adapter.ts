import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import type {
  AdapterError,
  AdapterResult,
  CancellationReport,
  CapabilityManifest,
  Correlation,
  CreateRunRequest,
  HarnessAdapter,
  HarnessIdentity,
  ProgressEvent,
  ReconciliationReport,
  RouteIdentity,
  RunCreated,
  TerminalOutcome
} from "./adapter-contract";

interface OpenCodeEvent {
  readonly type?: string;
  readonly part?: {
    readonly text?: string;
    readonly tool?: string;
    readonly cost?: number;
    readonly tokens?: {
      readonly total?: number;
      readonly input?: number;
      readonly output?: number;
      readonly reasoning?: number;
    };
  };
  readonly sessionID?: string;
  readonly cost?: number;
  readonly tokens?: {
    readonly total?: number;
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
  };
}

interface ProcessState {
  readonly request: CreateRunRequest;
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  readonly events: ProgressEvent[];
  readonly progressHandlers: Array<(event: ProgressEvent) => void>;
  readonly terminalHandlers: Array<(outcome: TerminalOutcome) => void>;
  readonly stderr: string[];
  stderrLength: number;
  malformedEvents: number;
  terminal: TerminalOutcome | null;
  sequence: number;
  usage: OpenCodeUsage | null;
}

export interface OpenCodeCliAdapterOptions {
  readonly executable: string;
  readonly version: string;
  readonly route: RouteIdentity;
  readonly model: string;
}

export interface OpenCodeUsage {
  readonly total: number | null;
  readonly input: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly cost: number | null;
}

const MAX_EVENT_LINE = 256 * 1024;
const MAX_PROGRESS_MESSAGE = 4096;
const MAX_STDERR = 8192;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated]`;
}

export function parseOpenCodeEvent(line: string): OpenCodeEvent | null {
  if (!line.trim() || line.length > MAX_EVENT_LINE) return null;
  try {
    return JSON.parse(line) as OpenCodeEvent;
  } catch {
    return null;
  }
}

export function mergeOpenCodeUsage(
  previous: OpenCodeUsage | null,
  event: OpenCodeEvent
): OpenCodeUsage | null {
  const tokens = event.tokens ?? event.part?.tokens;
  const cost = event.cost ?? event.part?.cost;
  if (!tokens && cost === undefined) return previous;
  return {
    total: tokens?.total ?? previous?.total ?? null,
    input: tokens?.input ?? previous?.input ?? null,
    output: tokens?.output ?? previous?.output ?? null,
    reasoning: tokens?.reasoning ?? previous?.reasoning ?? null,
    cost: cost ?? previous?.cost ?? null
  };
}

function error(
  request: CreateRunRequest,
  errorClass: AdapterError["class"],
  code: string,
  message: string
): AdapterResult<never> {
  return {
    ok: false,
    error: {
      class: errorClass,
      code,
      message,
      retryable: false,
      correlation: {
        dispatchId: request.dispatchId,
        runId: request.authorization.runId,
        attemptId: request.authorization.attemptId
      }
    }
  };
}

function key(correlation: Correlation): string {
  return `${correlation.runId}:${correlation.attemptId}`;
}

export class OpenCodeCliAdapter implements HarnessAdapter {
  public readonly identity: HarnessIdentity = {
    adapterId: "opencode-cli-json",
    harnessName: "OpenCode CLI JSON",
    adapterVersion: "1.19.0",
    contractVersion: "harness-adapter-v1"
  };

  private readonly options: OpenCodeCliAdapterOptions;
  private readonly runs = new Map<string, ProcessState>();

  public constructor(options: OpenCodeCliAdapterOptions) {
    this.options = options;
  }

  public async discoverCapabilities(): Promise<CapabilityManifest> {
    const environment = `OpenCode ${this.options.version}; executable=${this.options.executable}`;
    const supported = [
      "run.create",
      "progress.structured",
      "terminal.outcome",
      "artifact.provenance",
      "dispatch.idempotency"
    ] as const;
    return {
      contractVersion: this.identity.contractVersion,
      adapterId: this.identity.adapterId,
      generatedAt: new Date().toISOString(),
      capabilities: [
        ...supported.map((key) => ({
          key,
          state: "supported" as const,
          evidence: ["OpenCode CLI --format json", environment],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        })),
        {
          key: "cancellation.request",
          state: "unsupported" as const,
          evidence: ["No verified run-owned Windows Job Object binding"],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "cancellation.ownership",
          state: "unverified" as const,
          evidence: [],
          conditions: ["Requires supported Windows process-group ownership"],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "deadline.enforcement",
          state: "conditional" as const,
          evidence: ["CLI process can report completion"],
          conditions: ["Safe deadline cancellation requires ownership"],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "reconnect",
          state: "unsupported" as const,
          evidence: ["CLI JSON invocation has no qualified reconnect contract"],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "restart.reconciliation",
          state: "unverified" as const,
          evidence: [],
          conditions: ["Requires session reconciliation and process ownership"],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        }
      ]
    };
  }

  public async createRun(request: CreateRunRequest): Promise<AdapterResult<RunCreated>> {
    const correlation: Correlation = {
      dispatchId: request.dispatchId,
      runId: request.authorization.runId,
      attemptId: request.authorization.attemptId
    };
    const runKey = key(correlation);
    if (this.runs.has(runKey)) {
      return error(request, "duplicate_dispatch", "DUPLICATE_DISPATCH", "Run correlation already exists");
    }
    if (!request.workingDirectory) {
      return error(request, "invalid_request", "WORKING_DIRECTORY_REQUIRED", "OpenCode CLI requires a working directory");
    }
    if (this.options.executable.toLowerCase().endsWith(".cmd")) {
      return error(
        request,
        "invalid_request",
        "UNSAFE_SHELL_EXECUTABLE",
        "OpenCode CLI requires a resolved executable; shell command files are not accepted"
      );
    }
    const child = spawn(
      this.options.executable,
      [
        "run",
        "--pure",
        "--auto",
        "--format",
        "json",
        "--model",
        this.options.model,
        "--dir",
        request.workingDirectory,
        request.taskDescription
      ],
      {
        cwd: request.workingDirectory,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const state: ProcessState = {
      request,
      process: child,
      events: [],
      progressHandlers: [],
      terminalHandlers: [],
      stderr: [],
      stderrLength: 0,
      malformedEvents: 0,
      terminal: null,
      sequence: 0,
      usage: null
    };
    this.runs.set(runKey, state);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(state, correlation, line));
    child.stderr.on("data", (chunk: Buffer) => {
      if (state.stderrLength >= MAX_STDERR) return;
      const diagnostic = chunk.toString();
      const remaining = MAX_STDERR - state.stderrLength;
      state.stderr.push(diagnostic.slice(0, remaining));
      state.stderrLength += Math.min(diagnostic.length, remaining);
    });
    child.on("error", (cause: Error) => {
      this.finish(state, correlation, {
        kind: "inconclusive",
        correlation,
        reportedAt: new Date().toISOString(),
        evidence: [],
        error: {
          class: "provider_unavailable",
          code: "OPENCODE_PROCESS_ERROR",
          message: cause.message,
          retryable: false,
          correlation
        }
      });
    });
    child.on("close", (exitCode) => {
      if (state.terminal) return;
      if (state.malformedEvents > 0) {
        this.finish(state, correlation, {
          kind: "inconclusive",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: {
            class: "incomplete_evidence",
            code: "OPENCODE_MALFORMED_JSON",
            message: `OpenCode emitted ${state.malformedEvents} malformed JSON event(s)`,
            retryable: false,
            correlation
          }
        });
        return;
      }
      this.finish(state, correlation, {
        kind: exitCode === 0 ? "succeeded" : "failed",
        correlation,
        reportedAt: new Date().toISOString(),
        evidence: [],
        error: exitCode === 0
          ? null
          : {
              class: "permanent",
              code: "OPENCODE_EXIT",
              message: truncate(
                `OpenCode exited with status ${exitCode}: ${state.stderr.join("").trim()}`,
                MAX_STDERR
              ),
              retryable: false,
              correlation
            }
      });
    });
    return {
      ok: true,
      value: {
        correlation,
        status: "accepted",
        route: request.route,
        acceptedAt: new Date().toISOString()
      }
    };
  }

  public subscribeProgress(
    correlation: Correlation,
    handler: (event: ProgressEvent) => void
  ): () => void {
    const state = this.runs.get(key(correlation));
    if (!state) return () => undefined;
    for (const event of state.events) handler(event);
    state.progressHandlers.push(handler);
    return () => {
      const index = state.progressHandlers.indexOf(handler);
      if (index >= 0) state.progressHandlers.splice(index, 1);
    };
  }

  public subscribeTerminal(
    correlation: Correlation,
    handler: (outcome: TerminalOutcome) => void
  ): () => void {
    const state = this.runs.get(key(correlation));
    if (!state) return () => undefined;
    if (state.terminal) handler(state.terminal);
    else state.terminalHandlers.push(handler);
    return () => {
      const index = state.terminalHandlers.indexOf(handler);
      if (index >= 0) state.terminalHandlers.splice(index, 1);
    };
  }

  public async requestCancellation(
    correlation: Correlation,
    _deadlineAt: string
  ): Promise<AdapterResult<CancellationReport>> {
    return {
      ok: false,
      error: {
        class: "unsupported_capability",
        code: "PROCESS_OWNERSHIP_UNVERIFIED",
        message: `Refusing cancellation for ${correlation.runId}; run-owned Windows process ownership is unverified`,
        retryable: false,
        correlation
      }
    };
  }

  public async reconcile(correlation: Correlation): Promise<AdapterResult<ReconciliationReport>> {
    const state = this.runs.get(key(correlation));
    return {
      ok: true,
      value: {
        correlation,
        state: state?.terminal ? "completed" : "unknown",
        route: this.options.route,
        lastSequence: state?.sequence ?? null,
        evidence: [],
        observedAt: new Date().toISOString()
      }
    };
  }

  public getUsage(correlation: Correlation): OpenCodeUsage | null {
    return this.runs.get(key(correlation))?.usage ?? null;
  }

  private handleLine(state: ProcessState, correlation: Correlation, line: string): void {
    if (!line.trim()) return;
    const event = parseOpenCodeEvent(line);
    if (!event) {
      state.malformedEvents += 1;
      return;
    }
    state.usage = mergeOpenCodeUsage(state.usage, event);
    const message = event.part?.text
      ? truncate(event.part.text, MAX_PROGRESS_MESSAGE)
      : event.part?.tool
        ? `tool:${event.part.tool}`
        : event.type ?? "opencode-event";
    const kind: ProgressEvent["kind"] = event.type === "step_start"
      ? "started"
      : event.type === "step_finish"
        ? "checkpoint"
        : event.part?.tool
          ? "artifact"
          : "message";
    const progress: ProgressEvent = {
      eventId: randomUUID(),
      correlation,
      sequence: state.sequence + 1,
      occurredAt: new Date().toISOString(),
      kind,
      message,
      evidence: []
    };
    state.sequence = progress.sequence;
    state.events.push(progress);
    for (const handler of state.progressHandlers) handler(progress);
  }

  private finish(state: ProcessState, correlation: Correlation, outcome: TerminalOutcome): void {
    if (state.terminal) return;
    state.terminal = outcome;
    for (const handler of state.terminalHandlers) handler(outcome);
  }
}
