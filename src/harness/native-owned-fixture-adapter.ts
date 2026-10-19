import { existsSync } from "node:fs";
import path from "node:path";
import type { RunRepository } from "../persistence/run-repository";
import {
  NativeOwnershipCoordinator,
  resolveHelperPath
} from "../execution/native-ownership";
import type {
  AdapterResult,
  CancellationReport,
  CapabilityDeclaration,
  CapabilityManifest,
  Correlation,
  CreateRunRequest,
  HarnessAdapter,
  HarnessIdentity,
  ProgressEvent,
  ReconciliationReport,
  RunCreated,
  TerminalOutcome
} from "./adapter-contract";

export class NativeOwnedFixtureAdapter implements HarnessAdapter {
  public readonly identity: HarnessIdentity = {
    adapterId: "native-owned-fixture",
    harnessName: "orchestrator-job-helper",
    adapterVersion: "fixture-v1",
    contractVersion: "harness-adapter-v1"
  };
  private readonly progressHandlers = new Set<(event: ProgressEvent) => void>();
  private readonly terminalHandlers = new Set<(outcome: TerminalOutcome) => void>();
  private coordinator: NativeOwnershipCoordinator | undefined;
  private correlation: Correlation | undefined;
  private fixtureDirectory: string | undefined;
  private cancellation: CancellationReport | undefined;

  public constructor(
    private readonly runs: RunRepository,
    private readonly helperPath = resolveHelperPath(process.cwd(), false, "")
  ) {}

  public async discoverCapabilities(): Promise<CapabilityManifest> {
    const supported = [
      "run.create", "progress.structured", "terminal.outcome",
      "cancellation.request", "cancellation.ownership",
      "dispatch.idempotency"
    ] as const;
    const capabilities: CapabilityDeclaration[] = supported.map((key) => ({
      key,
      state: "supported" as const,
      evidence: ["native-owned-fixture-adapter", "job-object-helper"],
      conditions: [],
      satisfiedPrerequisites: [],
      version: this.identity.adapterVersion,
      environment: "windows"
    }));
    capabilities.push({
      key: "restart.reconciliation",
      state: "unverified",
      evidence: [],
      conditions: ["Requires restart with durable owner identity"],
      satisfiedPrerequisites: [],
      version: this.identity.adapterVersion,
      environment: "windows"
    });
    return {
      contractVersion: "harness-adapter-v1",
      adapterId: this.identity.adapterId,
      generatedAt: new Date().toISOString(),
      capabilities
    };
  }

  public async createRun(request: CreateRunRequest): Promise<AdapterResult<RunCreated>> {
    const correlation = {
      dispatchId: request.dispatchId,
      runId: request.authorization.runId,
      attemptId: request.authorization.attemptId
    };
    if (this.coordinator || this.correlation) {
      return this.error("duplicate_dispatch", "DUPLICATE_DISPATCH", "Fixture run already exists", correlation);
    }
    this.correlation = correlation;
    if (!existsSync(this.helperPath)) {
      return this.error("provider_unavailable", "NATIVE_HELPER_MISSING", "Native helper is missing", correlation);
    }
    if (!request.workingDirectory || !path.isAbsolute(request.workingDirectory)) {
      return this.error("invalid_request", "WORKSPACE_INVALID", "Fixture workspace must be absolute", correlation);
    }
    this.fixtureDirectory = request.workingDirectory;
    this.coordinator = new NativeOwnershipCoordinator(
      this.runs,
      correlation.runId,
      correlation.attemptId,
      this.helperPath
    );
    try {
      const launched = await this.coordinator.launchFixture(request.workingDirectory);
      if (!launched.ownershipVerified || launched.workerExecutedBeforeOwnership) {
        return this.error("ambiguous", "OWNERSHIP_UNVERIFIED", "Worker ownership was not verified", correlation);
      }
      void this.observe(request.deadlineAt);
      return {
        ok: true,
        value: {
          correlation,
          status: "accepted",
          route: request.route,
          acceptedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      return this.error(
        "ambiguous",
        "NATIVE_LAUNCH_UNCERTAIN",
        error instanceof Error ? error.message : "Native launch was uncertain",
        correlation
      );
    }
  }

  public subscribeProgress(_correlation: Correlation, handler: (event: ProgressEvent) => void): () => void {
    this.progressHandlers.add(handler);
    return () => this.progressHandlers.delete(handler);
  }

  public subscribeTerminal(_correlation: Correlation, handler: (outcome: TerminalOutcome) => void): () => void {
    this.terminalHandlers.add(handler);
    return () => this.terminalHandlers.delete(handler);
  }

  public async requestCancellation(
    correlation: Correlation,
    _deadlineAt: string
  ): Promise<AdapterResult<CancellationReport>> {
    if (!this.coordinator || !this.correlation || !sameCorrelation(this.correlation, correlation)) {
      return this.error("ambiguous", "NATIVE_OWNER_MISSING", "Native owner is unavailable", correlation);
    }
    const requestedAt = new Date().toISOString();
    try {
      await this.coordinator.cancel();
      this.cancellation = {
        correlation,
        state: "completed",
        requestedAt,
        observedAt: new Date().toISOString(),
        processOwnershipVerified: true,
        error: null
      };
      return { ok: true, value: this.cancellation };
    } catch (error) {
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
            code: "NATIVE_CLEANUP_UNVERIFIED",
            message: error instanceof Error ? error.message : "Native cleanup was unverified",
            retryable: false,
            correlation
          }
        }
      };
    }
  }

  public async reconcile(correlation: Correlation): Promise<AdapterResult<ReconciliationReport>> {
    if (!this.coordinator || !this.correlation || !sameCorrelation(this.correlation, correlation)) {
      return this.error("ambiguous", "NATIVE_OWNER_MISSING", "Native owner cannot be re-established", correlation);
    }
    try {
      const status = await this.coordinator.status();
      return {
        ok: true,
        value: {
          correlation,
          state: status.running ? "running" : "stopped",
          route: {
            routeId: "native-owned-fixture",
            provider: { state: "known", name: "native-owned-fixture" },
            model: { state: "known", name: "deterministic" },
            reportedBy: "adapter"
          },
          lastSequence: 1,
          evidence: [],
          observedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      return this.error("ambiguous", "NATIVE_RECONCILIATION_UNCERTAIN", error instanceof Error ? error.message : "Reconciliation failed", correlation);
    }
  }

  public async close(): Promise<void> {
    await this.coordinator?.close();
  }

  private async observe(deadlineAt: string): Promise<void> {
    const correlation = this.correlation;
    const coordinator = this.coordinator;
    const fixtureDirectory = this.fixtureDirectory;
    if (!correlation || !coordinator || !fixtureDirectory) return;
    const until = Date.parse(deadlineAt);
    const markersPresent =
      existsSync(path.join(fixtureDirectory, "worker.started")) &&
      existsSync(path.join(fixtureDirectory, "child.started")) &&
      existsSync(path.join(fixtureDirectory, "grandchild.started"));
    let status;
    try {
      status = await coordinator.status();
    } catch (error) {
      this.emitTerminal({
        kind: "inconclusive",
        correlation,
        reportedAt: new Date().toISOString(),
        evidence: [],
        error: {
          class: "ambiguous",
          code: "NATIVE_OWNER_LOST",
          message: error instanceof Error ? error.message : "Native owner was lost during fixture execution",
          retryable: false,
          correlation
        }
      });
      return;
    }
    if (markersPresent && status.running && status.activeProcesses >= 3) {
      try {
        this.emitProgress(correlation);
        const cleanup = await coordinator.cancel();
        this.emitTerminal({
          kind: "succeeded",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: cleanup.cleanupVerified ? null : {
            class: "incomplete_evidence",
            code: "NATIVE_CLEANUP_UNVERIFIED",
            message: "Native cleanup was not verified",
            retryable: false,
            correlation
          }
        });
      } catch (error) {
        this.emitTerminal({
          kind: "inconclusive",
          correlation,
          reportedAt: new Date().toISOString(),
          evidence: [],
          error: {
            class: "ambiguous",
            code: "NATIVE_CLEANUP_UNVERIFIED",
            message: error instanceof Error ? error.message : "Native cleanup was unverified",
            retryable: false,
            correlation
          }
        });
      }
    } else if (Date.now() >= until) {
      this.emitTerminal({
        kind: "timed_out",
        correlation,
        reportedAt: new Date().toISOString(),
        evidence: [],
        error: {
          class: "deadline_exceeded",
          code: "FIXTURE_TIMEOUT",
          message: "Native fixture did not complete before deadline",
          retryable: false,
          correlation
        }
      });
    } else {
      setTimeout(() => void this.observe(deadlineAt), 25);
    }
  }

  private emitProgress(correlation: Correlation): void {
    const event: ProgressEvent = {
      eventId: `${correlation.dispatchId}:started`,
      correlation,
      sequence: 1,
      occurredAt: new Date().toISOString(),
      kind: "started",
      message: "Native-owned fixture started after verified Job assignment",
      evidence: []
    };
    for (const handler of this.progressHandlers) handler(event);
  }

  private emitTerminal(outcome: TerminalOutcome): void {
    for (const handler of this.terminalHandlers) handler(outcome);
  }

  private error<T extends Correlation>(
    className: "invalid_request" | "provider_unavailable" | "ambiguous" | "duplicate_dispatch",
    code: string,
    message: string,
    correlation: T
  ): AdapterResult<never> {
    return {
      ok: false,
      error: { class: className, code, message, retryable: false, correlation }
    };
  }
}

function sameCorrelation(left: Correlation, right: Correlation): boolean {
  return left.dispatchId === right.dispatchId && left.runId === right.runId && left.attemptId === right.attemptId;
}
