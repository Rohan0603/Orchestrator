import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  decodeFrame,
  encodeFrame,
  parseEvent,
  parseRequest,
  parseResponse,
  validateHandshake,
  type Event,
  type Request,
  type Response,
  type Welcome
} from "../protocol/v1";

export type RustCoreClientState = "starting" | "ready" | "closing" | "closed" | "failed";

export class RustCoreClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RustCoreClientError";
    this.code = code;
  }
}

export interface RustCoreClientOptions {
  readonly args?: readonly string[];
  readonly clientId?: string;
  readonly clientVersion?: string;
  readonly schemaVersion?: number;
  readonly requiredCapabilities?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly maxPendingBytes?: number;
  readonly onEvent?: (event: Event) => void;
  readonly onDiagnostic?: (line: string) => void;
  readonly onProtocolError?: (error: RustCoreClientError) => void;
}

interface PendingRequest {
  readonly request: Request;
  readonly digest: string;
  readonly frameBytes: number;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: RustCoreClientError) => void;
  readonly promise: Promise<Response>;
  timer: NodeJS.Timeout;
}

interface CompletedRequest {
  readonly digest: string;
  readonly response: Response;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const MAX_RECENT_MESSAGES = 4096;
const DEFAULT_REQUIRED_CAPABILITIES = ["system.health", "capabilities.list"] as const;

function normalizeError(error: unknown, fallbackCode: string, message: string): RustCoreClientError {
  if (error instanceof RustCoreClientError) return error;
  return new RustCoreClientError(fallbackCode, message);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const inheritedPath = process.env.Path ?? process.env.PATH ?? process.env.path;
  if (inheritedPath !== undefined) environment[process.platform === "win32" ? "Path" : "PATH"] = inheritedPath;
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "ORCHESTRATOR_CORE_LOG_LEVEL"
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class RustCoreClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: Required<Pick<
    RustCoreClientOptions,
    "clientId" | "clientVersion" | "schemaVersion" | "startupTimeoutMs" | "requestTimeoutMs" |
    "shutdownTimeoutMs" | "maxPendingRequests" | "maxPendingBytes"
  >> & RustCoreClientOptions;
  private stateValue: RustCoreClientState = "starting";
  private negotiatedWelcome?: Welcome;
  private hello?: Record<string, unknown>;
  private readBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stderrRemainder = "";
  private writeTail: Promise<void> = Promise.resolve();
  private startupTimer?: NodeJS.Timeout;
  private startupResolve?: (welcome: Welcome) => void;
  private startupReject?: (error: RustCoreClientError) => void;
  private failure?: RustCoreClientError;
  private closePromise?: Promise<void>;
  private exitResolve!: (exit: ChildExit) => void;
  private readonly exitPromise: Promise<ChildExit>;
  private readonly pending = new Map<string, PendingRequest>();
  private pendingBytes = 0;
  private readonly completed = new Map<string, CompletedRequest>();
  private readonly completedOrder: string[] = [];
  private readonly eventDigests = new Map<string, string>();
  private readonly eventDigestOrder: string[] = [];
  private readonly eventSequences = new Map<string, number>();

  private constructor(child: ChildProcessWithoutNullStreams, options: RustCoreClientOptions) {
    this.child = child;
    this.options = {
      clientId: "typescript-client",
      clientVersion: "0.1.0",
      schemaVersion: 1,
      startupTimeoutMs: 5000,
      requestTimeoutMs: 30_000,
      shutdownTimeoutMs: 5000,
      maxPendingRequests: 32,
      maxPendingBytes: 4 * 1024 * 1024,
      ...options
    };
    this.exitPromise = new Promise((resolvePromise) => { this.exitResolve = resolvePromise; });
    child.stdout.on("data", (chunk: Buffer | string) => this.receiveStdout(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => this.receiveStderr(chunk));
    child.on("error", (error) => {
      this.fail(new RustCoreClientError("BACKEND_SPAWN_FAILED", `Rust core process could not be started: ${error.message}`));
    });
    child.stdin.on("error", () => this.fail(new RustCoreClientError("BACKEND_EXITED", "Rust core input pipe closed unexpectedly")));
    child.on("close", (code, signal) => this.handleChildClose(code, signal));
  }

  static async start(executablePath: string, options: RustCoreClientOptions = {}): Promise<RustCoreClient> {
    for (const [name, value] of [
      ["startupTimeoutMs", options.startupTimeoutMs ?? 5000],
      ["requestTimeoutMs", options.requestTimeoutMs ?? 30_000],
      ["shutdownTimeoutMs", options.shutdownTimeoutMs ?? 5000],
      ["maxPendingRequests", options.maxPendingRequests ?? 32],
      ["maxPendingBytes", options.maxPendingBytes ?? 4 * 1024 * 1024]
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RustCoreClientError("INVALID_OPTIONS", `${name} must be a positive safe integer`);
      }
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executablePath, [...(options.args ?? ["serve"])], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnvironment()
      }) as ChildProcessWithoutNullStreams;
    } catch {
      throw new RustCoreClientError("BACKEND_SPAWN_FAILED", "Rust core process could not be started");
    }
    const client = new RustCoreClient(child, options);
    try {
      await client.negotiate();
      return client;
    } catch (error) {
      const normalized = normalizeError(error, "HANDSHAKE_FAILED", "Rust core handshake failed");
      client.fail(normalized);
      await Promise.race([client.exitPromise, delay(500)]);
      throw normalized;
    }
  }

  get state(): RustCoreClientState {
    return this.stateValue;
  }

  get welcome(): Welcome | undefined {
    return this.negotiatedWelcome;
  }

  request(input: Request): Promise<Response> {
    if (this.stateValue !== "ready") {
      return Promise.reject(new RustCoreClientError("TRANSPORT_CLOSED", "Rust core transport is not ready"));
    }
    const authenticatedSender = {id: this.options.clientId, role: "client"};
    const parsed = parseRequest(input, authenticatedSender);
    if (!parsed.ok) {
      return Promise.reject(new RustCoreClientError(parsed.error.code, parsed.error.message));
    }
    const request = parsed.value;
    const requestDigest = digest(request);
    const existingPending = this.pending.get(request.messageId);
    if (existingPending) {
      return existingPending.digest === requestDigest
        ? existingPending.promise
        : Promise.reject(new RustCoreClientError("MESSAGE_ID_CONFLICT", "Message ID was reused with different content"));
    }
    const completed = this.completed.get(request.messageId);
    if (completed) {
      return completed.digest === requestDigest
        ? Promise.resolve(completed.response)
        : Promise.reject(new RustCoreClientError("MESSAGE_ID_CONFLICT", "Message ID was reused with different content"));
    }
    if (this.pending.size >= this.options.maxPendingRequests) {
      return Promise.reject(new RustCoreClientError("QUEUE_FULL", "Rust core request queue is full"));
    }

    const encoded = encodeFrame(request);
    if (!encoded.ok) {
      return Promise.reject(new RustCoreClientError(encoded.error.code, encoded.error.message));
    }
    const frame = Buffer.from(encoded.value);
    if (this.pendingBytes + frame.length > this.options.maxPendingBytes) {
      return Promise.reject(new RustCoreClientError("QUEUE_FULL", "Rust core request queue byte limit is full"));
    }
    const deadlineMs = this.remainingRequestDeadline(request);
    if (deadlineMs <= 0) {
      return Promise.reject(new RustCoreClientError("DEADLINE_EXCEEDED", "Request deadline has expired"));
    }

    let resolveResponse!: (response: Response) => void;
    let rejectResponse!: (error: RustCoreClientError) => void;
    const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
      resolveResponse = resolvePromise;
      rejectResponse = rejectPromise;
    });
    const pending: PendingRequest = {
      request,
      digest: requestDigest,
      frameBytes: frame.length,
      resolve: resolveResponse,
      reject: rejectResponse,
      promise,
      timer: setTimeout(() => {
        this.fail(new RustCoreClientError("DEADLINE_EXCEEDED", "Rust core request exceeded its deadline"));
      }, Math.min(deadlineMs, this.options.requestTimeoutMs))
    };
    this.pending.set(request.messageId, pending);
    this.pendingBytes += frame.length;
    void this.enqueueFrame(frame).catch((error: unknown) => {
      this.fail(normalizeError(error, "BACKEND_EXITED", "Rust core request could not be written"));
    });
    return promise;
  }

  close(deadlineMs = this.options.shutdownTimeoutMs): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOwnedProcess(deadlineMs);
    return this.closePromise;
  }

  private async negotiate(): Promise<void> {
    const hello = {
      protocolVersion: 1,
      kind: "hello",
      messageId: randomUUID(),
      correlationId: randomUUID(),
      causationId: null,
      sender: {id: this.options.clientId, role: "client"},
      minimumProtocol: 1,
      maximumProtocol: 1,
      clientVersion: this.options.clientVersion,
      schemaVersion: this.options.schemaVersion,
      requiredCapabilities: [...(this.options.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES)]
    };
    this.hello = hello;
    const encoded = encodeFrame(hello);
    if (!encoded.ok) throw new RustCoreClientError(encoded.error.code, encoded.error.message);

    const welcomePromise = new Promise<Welcome>((resolvePromise, rejectPromise) => {
      this.startupResolve = resolvePromise;
      this.startupReject = rejectPromise;
      this.startupTimer = setTimeout(() => {
        this.fail(new RustCoreClientError("HANDSHAKE_TIMEOUT", "Rust core did not complete the startup handshake"));
      }, this.options.startupTimeoutMs);
    });
    await Promise.all([this.enqueueFrame(Buffer.from(encoded.value)), welcomePromise]);
  }

  private remainingRequestDeadline(request: Request): number {
    if (request.deadlineAt === undefined) return this.options.requestTimeoutMs;
    return Math.min(this.options.requestTimeoutMs, Date.parse(request.deadlineAt) - Date.now());
  }

  private enqueueFrame(frame: Buffer): Promise<void> {
    const write = this.writeTail.then(async () => {
      if (this.stateValue === "failed" || this.stateValue === "closed") {
        throw this.failure ?? new RustCoreClientError("TRANSPORT_CLOSED", "Rust core transport is closed");
      }
      const accepted = this.child.stdin.write(frame);
      if (!accepted) await once(this.child.stdin, "drain");
    });
    this.writeTail = write;
    return write;
  }

  private receiveStdout(chunk: Buffer | string): void {
    if (this.stateValue === "failed" || this.stateValue === "closed") return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.readBuffer = this.readBuffer.length === 0 ? bytes : Buffer.concat([this.readBuffer, bytes]);
    while (this.readBuffer.length >= 4) {
      const length = this.readBuffer.readUInt32BE(0);
      if (length < 1 || length > 1024 * 1024) {
        this.fail(new RustCoreClientError("FRAME_TOO_LARGE", "Rust core returned an invalid frame length"));
        return;
      }
      if (this.readBuffer.length < length + 4) break;
      const frame = this.readBuffer.subarray(0, length + 4);
      this.readBuffer = this.readBuffer.subarray(length + 4);
      const decoded = decodeFrame(frame);
      if (!decoded.ok) {
        this.fail(new RustCoreClientError(decoded.error.code, decoded.error.message));
        return;
      }
      this.handleMessage(decoded.value);
      if (["failed"].includes(this.stateValue)) return;
    }
    if (this.readBuffer.length > 1024 * 1024 + 4) {
      this.fail(new RustCoreClientError("FRAME_TOO_LARGE", "Rust core response exceeded the v1 frame limit"));
    }
  }

  private handleMessage(message: unknown): void {
    if (this.stateValue === "starting") {
      if (typeof message !== "object" || message === null || (message as {kind?: unknown}).kind !== "welcome") {
        this.fail(new RustCoreClientError("HANDSHAKE_FAILED", "Rust core did not send a welcome as its first frame"));
        return;
      }
      const result = validateHandshake(this.hello, message);
      if (!result.ok) {
        this.fail(new RustCoreClientError(result.error.code, result.error.message));
        return;
      }
      const welcome = result.value;
      if (welcome.sender.id !== "orchestrator-core" || welcome.sender.role !== "backend" ||
          welcome.processSupervision !== "parent-owned-stdio" ||
          welcome.correlationId !== this.hello?.correlationId ||
          welcome.causationId !== this.hello?.messageId) {
        this.fail(new RustCoreClientError("HANDSHAKE_FAILED", "Rust core identity or process supervision mode is invalid"));
        return;
      }
      this.negotiatedWelcome = welcome;
      this.stateValue = "ready";
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupResolve?.(welcome);
      return;
    }

    if (typeof message !== "object" || message === null || typeof (message as {kind?: unknown}).kind !== "string") {
      this.fail(new RustCoreClientError("INVALID_ENVELOPE", "Rust core sent a malformed protocol message"));
      return;
    }
    const kind = (message as {kind: string}).kind;
    if (kind === "response") {
      this.handleResponse(message);
      return;
    }
    if (kind === "event") {
      this.handleEvent(message);
      return;
    }
    this.fail(new RustCoreClientError("INVALID_ENVELOPE", "Rust core sent an unexpected message kind"));
  }

  private handleResponse(message: unknown): void {
    const parsed = parseResponse(message);
    if (!parsed.ok) {
      this.fail(new RustCoreClientError(parsed.error.code, parsed.error.message));
      return;
    }
    const response = parsed.value;
    if (response.sender.id !== "orchestrator-core" || response.sender.role !== "backend") {
      this.fail(new RustCoreClientError("UNAUTHORIZED_SENDER", "Response sender does not match the negotiated backend"));
      return;
    }
    const pending = this.pending.get(response.inReplyTo);
    if (!pending || response.correlationId !== pending.request.correlationId || response.causationId !== pending.request.messageId) {
      this.fail(new RustCoreClientError("INVALID_ENVELOPE", "Response correlation does not match a pending request"));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(pending.request.messageId);
    this.pendingBytes -= pending.frameBytes;
    this.rememberCompleted(pending.request.messageId, {digest: pending.digest, response});
    pending.resolve(response);
  }

  private handleEvent(message: unknown): void {
    const parsed = parseEvent(message);
    if (!parsed.ok) {
      this.fail(new RustCoreClientError(parsed.error.code, parsed.error.message));
      return;
    }
    const event = parsed.value;
    if (event.sender.id !== "orchestrator-core" || event.sender.role !== "backend") {
      this.fail(new RustCoreClientError("UNAUTHORIZED_SENDER", "Event sender does not match the negotiated backend"));
      return;
    }
    const eventDigest = digest(event);
    const previousDigest = this.eventDigests.get(event.messageId);
    if (previousDigest !== undefined) {
      if (previousDigest !== eventDigest) {
        this.fail(new RustCoreClientError("MESSAGE_ID_CONFLICT", "Event message ID was reused with different content"));
      }
      return;
    }
    this.eventDigests.set(event.messageId, eventDigest);
    this.eventDigestOrder.push(event.messageId);
    if (this.eventDigestOrder.length > MAX_RECENT_MESSAGES) {
      const expiredId = this.eventDigestOrder.shift();
      if (expiredId !== undefined) this.eventDigests.delete(expiredId);
    }
    const subscriptionId = typeof event.payload.subscriptionId === "string" ? event.payload.subscriptionId : "default";
    const scope = `${subscriptionId}:${event.runId ?? ""}`;
    const previousSequence = this.eventSequences.get(scope);
    if (previousSequence !== undefined && event.sequence !== previousSequence + 1) {
      this.fail(new RustCoreClientError("SEQUENCE_CONFLICT", "Rust core event sequence contains a duplicate or gap"));
      return;
    }
    this.eventSequences.set(scope, event.sequence);
    try {
      this.options.onEvent?.(event);
    } catch {
      this.reportProtocolError(new RustCoreClientError("EVENT_HANDLER_FAILED", "A local event handler failed"));
    }
  }

  private receiveStderr(chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const combined = `${this.stderrRemainder}${text}`;
    const lines = combined.split(/\r?\n/);
    this.stderrRemainder = lines.pop() ?? "";
    if (this.stderrRemainder.length > 8192) this.stderrRemainder = this.stderrRemainder.slice(-8192);
    for (const line of lines) {
      if (line.length > 0) {
        try {
          this.options.onDiagnostic?.(line.slice(0, 8192));
        } catch {
          // Diagnostic callbacks cannot block the protocol stream.
        }
      }
    }
  }

  private rememberCompleted(messageId: string, completed: CompletedRequest): void {
    this.completed.set(messageId, completed);
    this.completedOrder.push(messageId);
    while (this.completedOrder.length > MAX_RECENT_MESSAGES) {
      const expiredId = this.completedOrder.shift();
      if (expiredId !== undefined) this.completed.delete(expiredId);
    }
  }

  private handleChildClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitResolve({code, signal});
    if (this.stateValue === "closing") {
      this.stateValue = "closed";
      return;
    }
    if (this.stateValue !== "failed" && this.stateValue !== "closed") {
      this.fail(new RustCoreClientError("BACKEND_EXITED", `Rust core exited unexpectedly (${signal ?? code ?? "unknown"})`), false);
    }
  }

  private fail(error: RustCoreClientError, terminate = true): void {
    if (this.stateValue === "failed" || this.stateValue === "closed") return;
    this.failure = error;
    this.stateValue = "failed";
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupReject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.pendingBytes = 0;
    this.reportProtocolError(error);
    if (terminate && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
  }

  private reportProtocolError(error: RustCoreClientError): void {
    try {
      this.options.onProtocolError?.(error);
    } catch {
      // Error reporting callbacks cannot change transport state.
    }
  }

  private async closeOwnedProcess(deadlineMs: number): Promise<void> {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new RustCoreClientError("INVALID_DEADLINE", "Shutdown deadline must be positive");
    }
    if (this.stateValue === "closed") return;
    if (this.stateValue === "failed") {
      await Promise.race([this.exitPromise, delay(deadlineMs)]);
      return;
    }
    this.stateValue = "closing";
    try {
      await Promise.race([
        this.writeTail,
        delay(deadlineMs).then(() => { throw new RustCoreClientError("SHUTDOWN_TIMEOUT", "Rust core writes did not drain before shutdown"); })
      ]);
      this.child.stdin.end();
      const exit = await Promise.race([
        this.exitPromise,
        delay(deadlineMs).then(() => { throw new RustCoreClientError("SHUTDOWN_TIMEOUT", "Rust core did not stop before the shutdown deadline"); })
      ]);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new RustCoreClientError("TRANSPORT_CLOSED", "Rust core stopped before responding"));
      }
      this.pending.clear();
      this.pendingBytes = 0;
      if (exit.code !== 0 || exit.signal !== null) {
        throw new RustCoreClientError("SHUTDOWN_FAILED", "Rust core did not stop cleanly");
      }
    } catch (error) {
      const shutdownError = normalizeError(error, "SHUTDOWN_FAILED", "Rust core did not stop cleanly");
      this.fail(shutdownError);
      await Promise.race([this.exitPromise, delay(500)]);
      throw shutdownError;
    }
  }
}
