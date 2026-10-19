import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { RunRepository } from "../persistence/run-repository";
import {
  NativeOwnershipCoordinator,
  resolveHelperPath,
  type OwnedOutputEvent
} from "../execution/native-ownership";
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
  coordinator: NativeOwnershipCoordinator | undefined;
  readonly events: ProgressEvent[];
  readonly progressHandlers: Array<(event: ProgressEvent) => void>;
  readonly terminalHandlers: Array<(outcome: TerminalOutcome) => void>;
  readonly stderr: string[];
  stdoutBuffer: string;
  stderrLength: number;
  malformedEvents: number;
  terminal: TerminalOutcome | null;
  sequence: number;
  usage: OpenCodeUsage | null;
}

export interface OpenCodeCliAdapterOptions {
  readonly executable: string;
  readonly version: string;
  readonly model: string;
  readonly runs: RunRepository;
  readonly helperPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
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

  public readonly route: RouteIdentity;
  private readonly options: OpenCodeCliAdapterOptions;
  private readonly runs = new Map<string, ProcessState>();

  public constructor(options: OpenCodeCliAdapterOptions) {
    this.options = options;
    const separator = options.model.indexOf("/");
    if (separator <= 0 || separator === options.model.length - 1) {
      throw new Error("OpenCode model must use provider/model format");
    }
    this.route = {
      routeId: `opencode-cli:${options.model}`,
      provider: { state: "known", name: options.model.slice(0, separator) },
      model: { state: "known", name: options.model.slice(separator + 1) },
      reportedBy: "adapter"
    };
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
          evidence: ["Real-provider ownership and cancellation qualification is pending"],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "cancellation.ownership",
          state: "unverified" as const,
          evidence: [],
          conditions: ["Requires independent real-provider ownership qualification"],
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
    const state: ProcessState = {
      request,
      coordinator: undefined,
      events: [],
      progressHandlers: [],
      terminalHandlers: [],
      stderr: [],
      stderrLength: 0,
      stdoutBuffer: "",
      malformedEvents: 0,
      terminal: null,
      sequence: 0,
      usage: null
    };
    this.runs.set(runKey, state);
    if (!existsSync(this.options.executable)) {
      this.runs.delete(runKey);
      return error(request, "provider_unavailable", "OPENCODE_EXECUTABLE_MISSING", "OpenCode executable is missing");
    }
    state.coordinator = new NativeOwnershipCoordinator(
      this.options.runs,
      correlation.runId,
      correlation.attemptId,
      this.options.helperPath ?? resolveHelperPath(process.cwd(), false, ""),
      (event) => this.handleOutput(state, correlation, event)
    );
    try {
      const launch = await state.coordinator.launchProcess({
        executable: this.options.executable,
        arguments: [
          "run", "--pure", "--auto", "--format", "json",
          "--model", this.options.model, "--dir", request.workingDirectory,
          request.taskDescription
        ],
        workingDirectory: request.workingDirectory,
        environment: this.controlledEnvironment()
      });
      if (!launch.ownershipVerified || launch.workerExecutedBeforeOwnership) {
        throw new Error("OpenCode ownership was not verified");
      }
      void this.observeOwnedRun(state, correlation);
    } catch (cause) {
      await state.coordinator.close();
      this.finish(state, correlation, {
        kind: "inconclusive",
        correlation,
        reportedAt: new Date().toISOString(),
        evidence: [],
        error: {
          class: "ambiguous",
          code: "OPENCODE_OWNERSHIP_UNVERIFIED",
          message: cause instanceof Error ? cause.message : "OpenCode ownership was not verified",
          retryable: false,
          correlation
        }
      });
      this.runs.delete(runKey);
      return error(
        request,
        "ambiguous",
        "OPENCODE_OWNERSHIP_UNVERIFIED",
        cause instanceof Error ? cause.message : "OpenCode ownership was not verified"
      );
    }
    return {
      ok: true,
      value: {
        correlation,
        status: "accepted",
        route: this.route,
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
    const state = this.runs.get(key(correlation));
    if (!state?.coordinator) {
      return {
        ok: false,
        error: {
          class: "ambiguous",
          code: "PROCESS_OWNERSHIP_UNAVAILABLE",
          message: "OpenCode owner is unavailable",
          retryable: false,
          correlation
        }
      };
    }
    const requestedAt = new Date().toISOString();
    try {
      await state.coordinator.cancel();
      const report: CancellationReport = {
        correlation,
        state: "completed",
        requestedAt,
        observedAt: new Date().toISOString(),
        processOwnershipVerified: true,
        error: null
      };
      this.finish(state, correlation, {
        kind: "cancelled",
        correlation,
        reportedAt: report.observedAt ?? new Date().toISOString(),
        evidence: [],
        error: null
      });
      return { ok: true, value: report };
    } catch (cause) {
      return {
        ok: true,
        value: {
          correlation,
          state: "unverified",
          requestedAt,
          observedAt: new Date().toISOString(),
          processOwnershipVerified: false,
          error: {
            class: "ambiguous",
            code: "OPENCODE_CLEANUP_UNVERIFIED",
            message: cause instanceof Error ? cause.message : "OpenCode cleanup was unverified",
            retryable: false,
            correlation
          }
        }
      };
    }
  }

  public async reconcile(correlation: Correlation): Promise<AdapterResult<ReconciliationReport>> {
    const state = this.runs.get(key(correlation));
    return {
      ok: true,
      value: {
        correlation,
        state: state?.terminal ? "completed" : "unknown",
        route: this.route,
        lastSequence: state?.sequence ?? null,
        evidence: [],
        observedAt: new Date().toISOString()
      }
    };
  }

  public getUsage(correlation: Correlation): OpenCodeUsage | null {
    return this.runs.get(key(correlation))?.usage ?? null;
  }

  public async close(): Promise<void> {
    await Promise.all(
      [...this.runs.values()]
        .map((state) => state.coordinator?.close())
        .filter((close): close is Promise<void> => Boolean(close))
    );
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

  private handleOutput(state: ProcessState, correlation: Correlation, event: OwnedOutputEvent): void {
    if (event.stream === "stderr") {
      if (state.stderrLength >= MAX_STDERR) return;
      const remaining = MAX_STDERR - state.stderrLength;
      state.stderr.push(event.data.slice(0, remaining));
      state.stderrLength += Math.min(event.data.length, remaining);
      return;
    }
    state.stdoutBuffer += event.data;
    let newline = state.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = state.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      state.stdoutBuffer = state.stdoutBuffer.slice(newline + 1);
      this.handleLine(state, correlation, line);
      newline = state.stdoutBuffer.indexOf("\n");
    }
  }

  private async observeOwnedRun(state: ProcessState, correlation: Correlation): Promise<void> {
    if (!state.coordinator) return;
    try {
      while (!state.terminal) {
        const status = await state.coordinator.status();
        if (!status.running) {
          if (!status.outputDrained) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
          await state.coordinator.verifyStopped();
          if (state.stdoutBuffer.trim()) this.handleLine(state, correlation, state.stdoutBuffer);
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
          } else {
            this.finish(state, correlation, {
              kind: status.exitCode === 0 ? "succeeded" : "failed",
              correlation,
              reportedAt: new Date().toISOString(),
              evidence: [],
              error: status.exitCode === 0
                ? null
                : {
                    class: "permanent",
                    code: "OPENCODE_EXIT",
                    message: truncate(
                      `OpenCode exited with status ${status.exitCode}: ${state.stderr.join("").trim()}`,
                      MAX_STDERR
                    ),
                    retryable: false,
                    correlation
                  }
            });
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (cause) {
      this.finish(state, correlation, {
        kind: "inconclusive",
        correlation,
        reportedAt: new Date().toISOString(),
        evidence: [],
        error: {
          class: "ambiguous",
          code: "OPENCODE_OWNER_LOST",
          message: cause instanceof Error ? cause.message : "OpenCode owner was lost",
          retryable: false,
          correlation
        }
      });
    }
  }

  private controlledEnvironment(): Readonly<Record<string, string>> {
    const inheritedKeys = [
      "SystemRoot", "ComSpec", "Path", "TEMP", "TMP", "APPDATA",
      "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
      "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"
    ];
    const environment: Record<string, string> = {};
    for (const key of inheritedKeys) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }
    Object.assign(environment, this.options.environment ?? {});
    return environment;
  }

  private finish(state: ProcessState, correlation: Correlation, outcome: TerminalOutcome): void {
    if (state.terminal) return;
    state.terminal = outcome;
    for (const handler of state.terminalHandlers) handler(outcome);
  }
}
