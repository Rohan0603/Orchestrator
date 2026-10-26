import { randomUUID } from "node:crypto";
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

const MAX_EVENT_LINE = 256 * 1024;
const MAX_PROGRESS_MESSAGE = 4096;
const MAX_ERROR_BODY = 8192;

export interface OpenAIUsage {
  readonly total: number | null;
  readonly input: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly cost: number | null;
}

export interface OpenAIStreamChunk {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: string };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly total_tokens?: number;
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly reasoning_tokens?: number;
  } | null;
  readonly error?: { readonly message?: string; readonly code?: string };
}

export interface OpenAICompatibleAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly providerName?: string;
  readonly version?: string;
  readonly fetchImpl?: typeof fetch;
}

interface ProcessState {
  readonly request: CreateRunRequest;
  readonly controller: AbortController;
  readonly events: ProgressEvent[];
  readonly progressHandlers: Array<(event: ProgressEvent) => void>;
  readonly terminalHandlers: Array<(outcome: TerminalOutcome) => void>;
  terminal: TerminalOutcome | null;
  sequence: number;
  usage: OpenAIUsage | null;
  malformedEvents: number;
  routedVia: string | null;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated]`;
}

function key(correlation: Correlation): string {
  return `${correlation.runId}:${correlation.attemptId}`;
}

function correlationFor(request: CreateRunRequest): Correlation {
  return {
    dispatchId: request.dispatchId,
    runId: request.authorization.runId,
    attemptId: request.authorization.attemptId
  };
}

function error(
  request: CreateRunRequest,
  errorClass: AdapterError["class"],
  code: string,
  message: string,
  retryable = false
): AdapterResult<never> {
  return {
    ok: false,
    error: {
      class: errorClass,
      code,
      message,
      retryable,
      correlation: correlationFor(request)
    }
  };
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenAI-compatible base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("OpenAI-compatible base URL must not contain credentials or query parameters");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) {
    throw new Error("OpenAI-compatible base URL must end with /v1");
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, "");
}

export function parseOpenAIStreamLine(line: string): OpenAIStreamChunk | "done" | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (payload === "[DONE]") return "done";
  if (!payload || payload.length > MAX_EVENT_LINE) return null;
  try {
    return JSON.parse(payload) as OpenAIStreamChunk;
  } catch {
    return null;
  }
}

export function mergeOpenAIUsage(
  previous: OpenAIUsage | null,
  chunk: OpenAIStreamChunk
): OpenAIUsage | null {
  const usage = chunk.usage;
  if (!usage) return previous;
  return {
    total: usage.total_tokens ?? previous?.total ?? null,
    input: usage.prompt_tokens ?? previous?.input ?? null,
    output: usage.completion_tokens ?? previous?.output ?? null,
    reasoning: usage.reasoning_tokens ?? previous?.reasoning ?? null,
    cost: previous?.cost ?? null
  };
}

export function readOpenAICompatibleConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Pick<OpenAICompatibleAdapterOptions, "baseUrl" | "apiKey" | "model" | "providerName"> | null {
  const baseUrl = environment.ORCHESTRATOR_OPENAI_BASE_URL?.trim();
  const apiKey = environment.ORCHESTRATOR_OPENAI_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    model: environment.ORCHESTRATOR_OPENAI_MODEL?.trim() || "auto",
    providerName: environment.ORCHESTRATOR_OPENAI_PROVIDER?.trim() || "freellmapi"
  };
}

export class OpenAICompatibleAdapter implements HarnessAdapter {
  public readonly identity: HarnessIdentity;
  public readonly route: RouteIdentity;

  private readonly options: Required<Pick<OpenAICompatibleAdapterOptions, "baseUrl" | "apiKey" | "model" | "providerName" | "version">> &
    Pick<OpenAICompatibleAdapterOptions, "fetchImpl">;
  private readonly runs = new Map<string, ProcessState>();
  private readonly completedUsage = new Map<string, OpenAIUsage>();

  public constructor(options: OpenAICompatibleAdapterOptions) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!options.apiKey.trim()) throw new Error("OpenAI-compatible API key is required");
    if (!options.model.trim()) throw new Error("OpenAI-compatible model is required");
    const providerName = options.providerName?.trim() || "openai-compatible";
    this.options = {
      baseUrl,
      apiKey: options.apiKey.trim(),
      model: options.model.trim(),
      providerName,
      version: options.version?.trim() || "1",
      fetchImpl: options.fetchImpl
    };
    this.identity = {
      adapterId: "openai-compatible-chat-completions",
      harnessName: "OpenAI-compatible chat completions",
      adapterVersion: this.options.version,
      contractVersion: "harness-adapter-v1"
    };
    this.route = {
      routeId: `openai-compatible:${providerName}:${this.options.model}:${this.options.baseUrl}`,
      provider: { state: "known", name: providerName },
      model: { state: "known", name: this.options.model },
      reportedBy: "adapter"
    };
  }

  public async discoverCapabilities(): Promise<CapabilityManifest> {
    const environment = `OpenAI-compatible HTTP API ${this.options.baseUrl}`;
    const supported = ["run.create", "progress.structured", "terminal.outcome", "dispatch.idempotency"] as const;
    return {
      contractVersion: this.identity.contractVersion,
      adapterId: this.identity.adapterId,
      generatedAt: new Date().toISOString(),
      capabilities: [
        ...supported.map((key) => ({
          key,
          state: "supported" as const,
          evidence: ["POST /v1/chat/completions", "OpenAI-compatible SSE streaming"],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        })),
        {
          key: "cancellation.request" as const,
          state: "conditional" as const,
          evidence: ["AbortController aborts the local HTTP request"],
          conditions: ["Does not prove that a remote provider stopped processing"],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "cancellation.ownership" as const,
          state: "unsupported" as const,
          evidence: ["HTTP API exposes no qualified process-ownership contract"],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "deadline.enforcement" as const,
          state: "conditional" as const,
          evidence: ["Local HTTP request can be aborted at the deadline"],
          conditions: ["Safe remote termination requires provider-side cancellation evidence"],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "artifact.provenance" as const,
          state: "unsupported" as const,
          evidence: ["Chat completions do not produce repository artifact provenance"],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "reconnect" as const,
          state: "unsupported" as const,
          evidence: ["Chat completions have no qualified reconnect contract"],
          conditions: [],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        },
        {
          key: "restart.reconciliation" as const,
          state: "unverified" as const,
          evidence: [],
          conditions: ["Requires a provider-side request/session status API"],
          satisfiedPrerequisites: [],
          version: this.options.version,
          environment
        }
      ]
    };
  }

  public async createRun(request: CreateRunRequest): Promise<AdapterResult<RunCreated>> {
    const correlation = correlationFor(request);
    const runKey = key(correlation);
    if (this.runs.has(runKey)) return error(request, "duplicate_dispatch", "DUPLICATE_DISPATCH", "Run correlation already exists");
    if (request.route.routeId !== this.route.routeId) return error(request, "invalid_request", "ROUTE_MISMATCH", "Request route does not match adapter route");

    const state: ProcessState = {
      request,
      controller: new AbortController(),
      events: [],
      progressHandlers: [],
      terminalHandlers: [],
      terminal: null,
      sequence: 0,
      usage: null,
      malformedEvents: 0,
      routedVia: null
    };
    this.runs.set(runKey, state);
    void this.observeRun(state, correlation);
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

  public subscribeProgress(correlation: Correlation, handler: (event: ProgressEvent) => void): () => void {
    const state = this.runs.get(key(correlation));
    if (!state) return () => undefined;
    for (const event of state.events) handler(event);
    state.progressHandlers.push(handler);
    return () => {
      const index = state.progressHandlers.indexOf(handler);
      if (index >= 0) state.progressHandlers.splice(index, 1);
    };
  }

  public subscribeTerminal(correlation: Correlation, handler: (outcome: TerminalOutcome) => void): () => void {
    const state = this.runs.get(key(correlation));
    if (!state) return () => undefined;
    if (state.terminal) handler(state.terminal);
    else state.terminalHandlers.push(handler);
    return () => {
      const index = state.terminalHandlers.indexOf(handler);
      if (index >= 0) state.terminalHandlers.splice(index, 1);
    };
  }

  public async requestCancellation(correlation: Correlation, _deadlineAt: string): Promise<AdapterResult<CancellationReport>> {
    const state = this.runs.get(key(correlation));
    if (!state) {
      return {
        ok: false,
        error: {
          class: "ambiguous",
          code: "REQUEST_STATE_UNAVAILABLE",
          message: "OpenAI-compatible request state is unavailable",
          retryable: false,
          correlation
        }
      };
    }
    const requestedAt = new Date().toISOString();
    state.controller.abort();
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
          code: "REMOTE_CANCELLATION_UNVERIFIED",
          message: "The local HTTP request was aborted, but remote provider termination was not verified",
          retryable: false,
          correlation
        }
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
        route: this.route,
        lastSequence: state?.sequence ?? null,
        evidence: [],
        observedAt: new Date().toISOString()
      }
    };
  }

  public getUsage(correlation: Correlation): OpenAIUsage | null {
    return this.runs.get(key(correlation))?.usage ?? this.completedUsage.get(key(correlation)) ?? null;
  }

  public async close(): Promise<void> {
    for (const state of this.runs.values()) state.controller.abort();
    this.runs.clear();
    this.completedUsage.clear();
  }

  private async observeRun(state: ProcessState, correlation: Correlation): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    try {
      if (!fetchImpl) throw new Error("Fetch is unavailable in this runtime");
      const response = await fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [{ role: "user", content: state.request.taskDescription }],
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: state.controller.signal
      });
      state.routedVia = response.headers.get("x-routed-via");
      if (!response.ok) {
        const body = truncate(await response.text(), MAX_ERROR_BODY);
        this.finish(state, correlation, {
          kind: "failed",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: {
            class: response.status === 401 || response.status === 403 ? "authorization_failed" : response.status === 404 ? "model_unavailable" : response.status >= 500 ? "provider_unavailable" : "permanent",
            code: `HTTP_${response.status}`,
            message: body || `OpenAI-compatible endpoint returned HTTP ${response.status}`,
            retryable: response.status === 429 || response.status >= 500,
            correlation
          }
        });
        return;
      }
      if (!response.body) throw new Error("OpenAI-compatible response did not include a body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneSeen = false;
      while (!doneSeen) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseOpenAIStreamLine(line);
          if (parsed === "done") {
            doneSeen = true;
            break;
          }
          if (!parsed) {
            if (line.trim() && line.trim().startsWith("data:") && line.length <= MAX_EVENT_LINE) state.malformedEvents += 1;
            continue;
          }
          if (parsed.error) {
            this.finish(state, correlation, {
              kind: "inconclusive",
              correlation,
              reportedAt: new Date().toISOString(),
              evidence: [],
              error: {
                class: "incomplete_evidence",
                code: parsed.error.code ?? "STREAM_ERROR",
                message: parsed.error.message ?? "OpenAI-compatible stream returned an error",
                retryable: false,
                correlation
              }
            });
            return;
          }
          state.usage = mergeOpenAIUsage(state.usage, parsed);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) this.emitProgress(state, correlation, "message", truncate(content, MAX_PROGRESS_MESSAGE));
        }
        if (chunk.done) break;
      }
      if (buffer.trim()) {
        const parsed = parseOpenAIStreamLine(buffer);
        if (parsed && parsed !== "done") {
          state.usage = mergeOpenAIUsage(state.usage, parsed);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) this.emitProgress(state, correlation, "message", truncate(content, MAX_PROGRESS_MESSAGE));
        } else if (buffer.trim()) {
          state.malformedEvents += 1;
        }
      }
      if (state.malformedEvents > 0) {
        this.finish(state, correlation, {
          kind: "inconclusive",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: {
            class: "incomplete_evidence",
            code: "MALFORMED_SSE",
            message: `OpenAI-compatible endpoint emitted ${state.malformedEvents} malformed SSE event(s)`,
            retryable: false,
            correlation
          }
        });
      } else {
        this.finish(state, correlation, {
          kind: "succeeded",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: null
        });
      }
    } catch (cause) {
      if (state.controller.signal.aborted) {
        this.finish(state, correlation, {
          kind: "cancelled",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: null
        });
      } else {
        this.finish(state, correlation, {
          kind: "failed",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: {
            class: "provider_unavailable",
            code: "HTTP_REQUEST_FAILED",
            message: cause instanceof Error ? cause.message : "OpenAI-compatible request failed",
            retryable: true,
            correlation
          }
        });
      }
    }
  }

  private emitProgress(state: ProcessState, correlation: Correlation, kind: ProgressEvent["kind"], message: string): void {
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
    const runKey = key(correlation);
    if (state.usage) this.completedUsage.set(runKey, state.usage);
    if (this.runs.get(runKey) === state) this.runs.delete(runKey);
  }
}
