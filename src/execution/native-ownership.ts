import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID as newNonce } from "node:crypto";
import type { RunRepository } from "../persistence/run-repository";
import type { OwnershipRecord } from "../shared/domain";

const PROTOCOL_VERSION = "orchestrator-job-v1";
const MAX_MESSAGE_SIZE = 8192;
const REQUEST_TIMEOUT_MS = 5000;

export interface OwnershipIdentity {
  readonly helperPid: number;
  readonly helperCreationTime: string;
  readonly protocolVersion: string;
}

export interface OwnershipCorrelation {
  readonly runId: string;
  readonly attemptId: string;
  readonly nonce: string;
}

export interface OwnershipLaunchResult {
  readonly identity: OwnershipIdentity;
  readonly correlation: OwnershipCorrelation;
  readonly ownershipVerified: true;
  readonly workerExecutedBeforeOwnership: false;
  readonly workerPid: number;
  readonly workerCreationTime: string;
}

export interface OwnershipCancellationResult {
  readonly cleanupVerified: true;
  readonly activeProcessesAfterCleanup: 0;
}

export interface OwnershipStatus {
  readonly running: boolean;
  readonly activeProcesses: number;
  readonly exitCode: number | null;
  readonly outputDrained: boolean;
  readonly workerPid: number;
  readonly workerCreationTime: string;
}

export interface OwnedProcessSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface OwnedOutputEvent {
  readonly runId: string;
  readonly attemptId: string;
  readonly nonce: string;
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

interface HelperResponse {
  readonly version: string;
  readonly id: string;
  readonly status: "ok" | "running" | "idle" | "cleanup_verified" | "error";
  readonly detail?: string;
  readonly helperPid?: number;
  readonly helperCreationTime?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly nonce?: string;
  readonly ownershipVerified?: boolean;
  readonly workerExecutedBeforeOwnership?: boolean;
  readonly activeProcessesKnown?: boolean;
  readonly activeProcesses?: number;
  readonly outputDrained?: boolean;
  readonly workerPid?: number;
  readonly workerCreationTime?: string;
  readonly exitCode?: number;
}

interface HelperOutputEvent {
  readonly version: string;
  readonly event: "output";
  readonly runId: string;
  readonly attemptId: string;
  readonly nonce: string;
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export function validateOwnershipStatusResponse(
  response: Pick<
    HelperResponse,
    | "status"
    | "runId"
    | "attemptId"
    | "nonce"
    | "activeProcessesKnown"
    | "activeProcesses"
    | "outputDrained"
    | "workerPid"
    | "workerCreationTime"
    | "exitCode"
  >,
  correlation: OwnershipCorrelation
): OwnershipStatus {
  const workerPid = response.workerPid;
  const workerCreationTime = response.workerCreationTime;
  if (
    !["running", "idle"].includes(response.status) ||
    response.runId !== correlation.runId ||
    response.attemptId !== correlation.attemptId ||
    response.nonce !== correlation.nonce ||
    response.activeProcessesKnown !== true ||
    typeof response.activeProcesses !== "number" ||
    typeof response.outputDrained !== "boolean" ||
    typeof workerPid !== "number" ||
    !Number.isInteger(workerPid) ||
    workerPid <= 0 ||
    !workerCreationTime ||
    (response.status === "idle" && typeof response.exitCode !== "number")
  ) {
    throw new Error("Native ownership status is unverified");
  }
  return {
    running: response.status === "running",
    activeProcesses: response.activeProcesses,
    exitCode: response.exitCode ?? null,
    outputDrained: response.outputDrained,
    workerPid,
    workerCreationTime
  };
}

export function resolveHelperPath(
  appPath: string,
  isPackaged: boolean,
  resourcesPath: string
): string {
  return isPackaged
    ? path.join(resourcesPath, "job-object-helper.exe")
    : path.resolve(appPath, "dist-native", "job-object-helper.exe");
}

export class NativeOwnershipService {
  private helper: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private expectedExit = false;
  private readonly pending = new Map<
    string,
    { resolve: (response: HelperResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private identity: OwnershipIdentity | undefined;
  private correlation: OwnershipCorrelation | undefined;
  private pendingCorrelation: OwnershipCorrelation | undefined;
  private readonly onOutput: (event: OwnedOutputEvent) => void;

  public constructor(
    private readonly helperPath: string,
    private readonly onUncertain: (reason: string) => void = () => undefined,
    onOutput: (event: OwnedOutputEvent) => void = () => undefined
  ) {
    this.onOutput = onOutput;
  }

  public async start(): Promise<OwnershipIdentity> {
    if (this.helper) return this.identity ?? this.fail("Helper identity is unavailable");
    if (!existsSync(this.helperPath)) {
      throw new Error("Native ownership helper is missing");
    }

    const helper = spawn(this.helperPath, [], {
      cwd: path.dirname(this.helperPath),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.helper = helper;
    helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", (chunk: string) => this.receive(chunk));
    helper.on("error", (error) => this.failPending(`Helper process error: ${error.message}`));
    helper.on("close", (code, signal) => {
      this.helper = undefined;
      if (!this.expectedExit) this.failPending(`Helper exited before cleanup (code=${code}, signal=${signal})`);
    });
    const response = await this.request({ operation: "handshake" });
    const helperPid = response.helperPid;
    const helperCreationTime = response.helperCreationTime;
    if (
      response.status !== "ok" ||
      response.version !== PROTOCOL_VERSION ||
      typeof helperPid !== "number" ||
      !Number.isInteger(helperPid) ||
      helperPid <= 0 ||
      !helperCreationTime
    ) {
      await this.close();
      throw new Error("Native ownership helper handshake is invalid");
    }
    const identity: OwnershipIdentity = {
      helperPid,
      helperCreationTime,
      protocolVersion: response.version
    };
    this.identity = identity;
    return identity;
  }

  public async launch(
    executable: string,
    correlation: OwnershipCorrelation
  ): Promise<OwnershipLaunchResult> {
    const identity = this.identity ?? (await this.start());
    if (this.correlation) throw new Error("Native ownership helper already owns a run");
    if (!path.isAbsolute(executable) || executable.length > 4096) {
      throw new Error("Worker executable path is invalid");
    }
    const response = await this.request({
      operation: "launch",
      executable,
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      nonce: correlation.nonce
    });
    const workerPid = response.workerPid;
    const workerCreationTime = response.workerCreationTime;
    if (
      response.status !== "running" ||
      response.runId !== correlation.runId ||
      response.attemptId !== correlation.attemptId ||
      response.nonce !== correlation.nonce ||
      response.ownershipVerified !== true ||
      response.workerExecutedBeforeOwnership !== false ||
      typeof workerPid !== "number" ||
      !Number.isInteger(workerPid) ||
      workerPid <= 0 ||
      !workerCreationTime
    ) {
      this.onUncertain("Helper launch acknowledgement was invalid or ambiguous");
      throw new Error("Native ownership launch was not verified");
    }
    this.correlation = correlation;
    return {
      identity,
      correlation,
      ownershipVerified: true,
      workerExecutedBeforeOwnership: false,
      workerPid,
      workerCreationTime
    };
  }

  public async launchProcess(
    spec: OwnedProcessSpec,
    correlation: OwnershipCorrelation
  ): Promise<OwnershipLaunchResult> {
    const identity = this.identity ?? (await this.start());
    if (this.correlation) throw new Error("Native ownership helper already owns a run");
    if (
      !path.isAbsolute(spec.executable) ||
      !path.isAbsolute(spec.workingDirectory) ||
      spec.executable.length > 4096 ||
      spec.workingDirectory.length > 4096 ||
      spec.arguments.length > 128 ||
      spec.arguments.some((argument) => argument.length > 8192)
    ) {
      throw new Error("Owned process launch specification is invalid");
    }
    const environmentEntries = Object.entries(spec.environment);
    if (
      environmentEntries.length > 128 ||
      environmentEntries.some(([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 128 || value.length > 32768
      )
    ) {
      throw new Error("Owned process environment is invalid");
    }
    this.pendingCorrelation = correlation;
    let response: HelperResponse;
    try {
      response = await this.request({
        operation: "launch",
        executable: spec.executable,
        arguments: JSON.stringify(spec.arguments),
        workingDirectory: spec.workingDirectory,
        environment: JSON.stringify(spec.environment),
        runId: correlation.runId,
        attemptId: correlation.attemptId,
        nonce: correlation.nonce
      });
    } finally {
      this.pendingCorrelation = undefined;
    }
    const workerPid = response.workerPid;
    const workerCreationTime = response.workerCreationTime;
    if (
      response.status !== "running" ||
      response.runId !== correlation.runId ||
      response.attemptId !== correlation.attemptId ||
      response.nonce !== correlation.nonce ||
      response.ownershipVerified !== true ||
      response.workerExecutedBeforeOwnership !== false ||
      typeof workerPid !== "number" ||
      !Number.isInteger(workerPid) ||
      workerPid <= 0 ||
      !workerCreationTime
    ) {
      this.onUncertain("Owned process launch acknowledgement was invalid or ambiguous");
      throw new Error("Owned process launch was not verified");
    }
    this.correlation = correlation;
    return {
      identity,
      correlation,
      ownershipVerified: true,
      workerExecutedBeforeOwnership: false,
      workerPid,
      workerCreationTime
    };
  }

  public async launchFixture(
    fixtureDirectory: string,
    correlation: OwnershipCorrelation
  ): Promise<OwnershipLaunchResult> {
    if (!path.isAbsolute(fixtureDirectory) || fixtureDirectory.length > 4096) {
      throw new Error("Fixture directory is invalid");
    }
    const identity = this.identity ?? (await this.start());
    if (this.correlation) throw new Error("Native ownership helper already owns a run");
    const response = await this.request({
      operation: "launch",
      executable: this.helperPath,
      fixtureDirectory,
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      nonce: correlation.nonce
    });
    const workerPid = response.workerPid;
    const workerCreationTime = response.workerCreationTime;
    if (
      response.status !== "running" ||
      response.runId !== correlation.runId ||
      response.attemptId !== correlation.attemptId ||
      response.nonce !== correlation.nonce ||
      response.ownershipVerified !== true ||
      response.workerExecutedBeforeOwnership !== false ||
      typeof workerPid !== "number" ||
      !Number.isInteger(workerPid) ||
      workerPid <= 0 ||
      !workerCreationTime
    ) {
      this.onUncertain("Fixture launch acknowledgement was invalid or ambiguous");
      throw new Error("Native fixture ownership was not verified");
    }
    this.correlation = correlation;
    return {
      identity,
      correlation,
      ownershipVerified: true,
      workerExecutedBeforeOwnership: false,
      workerPid,
      workerCreationTime
    };
  }

  public async cancel(correlation: OwnershipCorrelation): Promise<OwnershipCancellationResult> {
    if (!this.correlation || !sameCorrelation(this.correlation, correlation)) {
      throw new Error("Native ownership correlation does not match active run");
    }
    const response = await this.request({
      operation: "cancel",
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      nonce: correlation.nonce
    });
    if (
      response.status !== "cleanup_verified" ||
      response.activeProcessesKnown !== true ||
      response.activeProcesses !== 0
    ) {
      this.onUncertain("Native ownership cleanup was not verified");
      throw new Error("Native ownership cleanup is unverified");
    }
    this.correlation = undefined;
    return { cleanupVerified: true, activeProcessesAfterCleanup: 0 };
  }

  public async status(correlation: OwnershipCorrelation): Promise<OwnershipStatus> {
    if (!this.correlation || !sameCorrelation(this.correlation, correlation)) {
      throw new Error("Native ownership correlation does not match active run");
    }
    const response = await this.request({
      operation: "status",
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      nonce: correlation.nonce
    });
    try {
      return validateOwnershipStatusResponse(response, correlation);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.onUncertain("Native ownership status was invalid");
      throw error;
    }
  }

  public async reconcile(
    correlation: OwnershipCorrelation,
    workerPid: number,
    workerCreationTime: string
  ): Promise<OwnershipStatus> {
    const identity = this.identity ?? (await this.start());
    if (this.correlation) throw new Error("Native ownership helper already owns a run");
    if (!Number.isInteger(workerPid) || workerPid <= 0 || !workerCreationTime) {
      throw new Error("Persisted worker identity is invalid");
    }
    const response = await this.request({
      operation: "reconcile",
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      nonce: correlation.nonce,
      workerPid: String(workerPid),
      workerCreationTime
    });
    const status = validateOwnershipStatusResponse(response, correlation);
    this.identity = identity;
    this.correlation = correlation;
    return status;
  }

  public async close(): Promise<void> {
    const helper = this.helper;
    if (!helper) return;
    this.expectedExit = true;
    if (helper.stdin.writable) {
      try {
        await this.request({ operation: "shutdown" });
      } catch {
        this.onUncertain("Native ownership helper shutdown was not acknowledged");
      }
    }
    helper.stdin.end();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, REQUEST_TIMEOUT_MS);
      helper.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited && !helper.killed) {
      helper.kill();
      await new Promise<void>((resolve) => helper.once("close", resolve));
    }
    this.helper = undefined;
    this.identity = undefined;
    this.correlation = undefined;
  }

  private request(payload: Record<string, string>): Promise<HelperResponse> {
    const helper = this.helper;
    if (!helper || !helper.stdin.writable) return Promise.reject(new Error("Helper channel is unavailable"));
    const id = randomUUID();
    const line = JSON.stringify({ version: PROTOCOL_VERSION, id, ...payload });
    if (line.length > MAX_MESSAGE_SIZE) return Promise.reject(new Error("Helper request is too large"));
    return new Promise<HelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.onUncertain("Native ownership request timed out");
        reject(new Error("Native ownership request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      helper.stdin.write(`${line}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          this.onUncertain(`Helper request failed: ${error.message}`);
          reject(error);
        }
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_MESSAGE_SIZE * 2) {
      this.buffer = "";
      this.failPending("Helper protocol buffer is too large");
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > MAX_MESSAGE_SIZE) {
        this.failPending("Helper response is too large");
        return;
      }
      this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failPending("Helper response is malformed");
      return;
    }
    if (isOutputEvent(parsed) && parsed.version === PROTOCOL_VERSION) {
      if (
        (this.correlation && sameCorrelation(this.correlation, parsed)) ||
        (this.pendingCorrelation && sameCorrelation(this.pendingCorrelation, parsed))
      ) {
        this.onOutput({
          runId: parsed.runId,
          attemptId: parsed.attemptId,
          nonce: parsed.nonce,
          stream: parsed.stream,
          data: parsed.data
        });
      } else {
        this.onUncertain("Helper output event correlation was invalid");
      }
      return;
    }
    if (!isResponse(parsed) || parsed.version !== PROTOCOL_VERSION) {
      this.failPending("Helper response is invalid");
      return;
    }

    function isOutputEvent(value: unknown): value is HelperOutputEvent {
      if (!value || typeof value !== "object") return false;
      const event = value as Partial<HelperOutputEvent>;
      return (
        event.event === "output" &&
        typeof event.version === "string" &&
        typeof event.runId === "string" &&
        typeof event.attemptId === "string" &&
        typeof event.nonce === "string" &&
        (event.stream === "stdout" || event.stream === "stderr") &&
        typeof event.data === "string"
      );
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      this.failPending("Helper response correlation is unknown");
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    pending.resolve(parsed);
  }

  private failPending(reason: string): void {
    this.onUncertain(reason);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private fail(message: string): never {
    throw new Error(message);
  }
}

export class NativeOwnershipCoordinator {
  private readonly nonce = newNonce();
  private readonly service: NativeOwnershipService;

  public constructor(
    private readonly runs: RunRepository,
    private readonly runId: string,
    private readonly attemptId: string,
    private readonly helperPath: string,
    onOutput: (event: OwnedOutputEvent) => void = () => undefined
  ) {
    this.service = new NativeOwnershipService(helperPath, (reason) => {
      this.record("uncertain", "uncertain", false, reason);
    }, onOutput);
  }

  public async launch(executable: string): Promise<OwnershipLaunchResult> {
    this.record("starting", "starting", false, null);
    const correlation = {
      runId: this.runId,
      attemptId: this.attemptId,
      nonce: this.nonce
    };
    try {
      const result = await this.service.launch(executable, correlation);
      this.record("running", "running", false, null, result.identity, result.workerPid, result.workerCreationTime);
      return result;
    } catch (error) {
      this.record(
        "uncertain",
        "launch_failed",
        false,
        error instanceof Error ? error.message : "Launch failed"
      );
      throw error;
    }

  }

  public async launchFixture(fixtureDirectory: string): Promise<OwnershipLaunchResult> {
    this.record("starting", "starting", false, null);
    const correlation = {
      runId: this.runId,
      attemptId: this.attemptId,
      nonce: this.nonce
    };
    try {
      const result = await this.service.launchFixture(fixtureDirectory, correlation);
      this.record("running", "running", false, null, result.identity, result.workerPid, result.workerCreationTime);
      return result;
    } catch (error) {
      this.record(
        "uncertain",
        "launch_failed",
        false,
        error instanceof Error ? error.message : "Launch failed"
      );
      throw error;
    }
  }

  public async launchProcess(spec: OwnedProcessSpec): Promise<OwnershipLaunchResult> {
    this.record("starting", "starting", false, null);
    const correlation = {
      runId: this.runId,
      attemptId: this.attemptId,
      nonce: this.nonce
    };
    try {
      const result = await this.service.launchProcess(spec, correlation);
      this.record("running", "running", false, null, result.identity, result.workerPid, result.workerCreationTime);
      return result;
    } catch (error) {
      this.record(
        "uncertain",
        "launch_failed",
        false,
        error instanceof Error ? error.message : "Launch failed"
      );
      throw error;
    }
  }

  public async cancel(): Promise<OwnershipCancellationResult> {
    try {
      const result = await this.service.cancel({
        runId: this.runId,
        attemptId: this.attemptId,
        nonce: this.nonce
      });
      this.record("cleanup_verified", "cleanup_verified", true, null);
      return result;
    } catch (error) {
      this.record(
        "uncertain",
        "cleanup_unverified",
        false,
        error instanceof Error ? error.message : "Cleanup failed"
      );
      throw error;
    }
  }

  public async status(): Promise<OwnershipStatus> {
    return this.service.status({
      runId: this.runId,
      attemptId: this.attemptId,
      nonce: this.nonce
    });
  }

  public async verifyStopped(): Promise<void> {
    const status = await this.status();
    if (status.running || status.activeProcesses !== 0) {
      throw new Error("Native ownership still has active processes");
    }
    this.record("cleanup_verified", "exited_verified", true, null);
  }

  public async close(): Promise<void> {
    await this.service.close();
  }

  private record(
    state: OwnershipRecord["state"],
    lastStatus: string,
    cleanupVerified: boolean,
    uncertaintyReason: string | null,
    identity?: OwnershipIdentity,
    workerPid: number | null = null,
    workerCreationTime: string | null = null
  ): void {
    this.runs.recordOwnership({
      runId: this.runId,
      attemptId: this.attemptId,
      helperPid: identity?.helperPid ?? null,
      helperCreationTime: identity?.helperCreationTime ?? null,
      workerPid,
      workerCreationTime,
      helperExecutable: this.helperPath,
      protocolVersion: PROTOCOL_VERSION,
      nonce: this.nonce,
      state,
      lastStatus,
      cleanupVerified,
      uncertaintyReason,
      updatedAt: new Date().toISOString()
    });
  }
}

function sameCorrelation(left: OwnershipCorrelation, right: OwnershipCorrelation): boolean {
  return left.runId === right.runId && left.attemptId === right.attemptId && left.nonce === right.nonce;
}

function isResponse(value: unknown): value is HelperResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === "string" &&
    typeof candidate.id === "string" &&
    ["ok", "running", "idle", "cleanup_verified", "error"].includes(String(candidate.status))
  );
}
