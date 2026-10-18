import type {
  AdapterResult,
  CancellationReport,
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

export interface ConformanceFixturePlan {
  readonly identity: HarnessIdentity;
  readonly manifest: CapabilityManifest;
  readonly route: ReconciliationReport["route"];
  readonly progressEvents?: readonly ProgressEvent[];
  readonly terminalOutcome?: TerminalOutcome;
  readonly cancellationResult: AdapterResult<CancellationReport>;
  readonly reconciliationResult: AdapterResult<ReconciliationReport>;
}

export class ConformanceFixtureAdapter implements HarnessAdapter {
  public readonly identity: HarnessIdentity;
  private readonly seenIdempotencyKeys = new Set<string>();
  private readonly plan: ConformanceFixturePlan;

  public constructor(plan: ConformanceFixturePlan) {
    this.identity = plan.identity;
    this.plan = plan;
  }

  public async discoverCapabilities(): Promise<CapabilityManifest> {
    return this.plan.manifest;
  }

  public async createRun(request: CreateRunRequest): Promise<AdapterResult<RunCreated>> {
    if (this.seenIdempotencyKeys.has(request.idempotencyKey)) {
      return {
        ok: false,
        error: {
          class: "duplicate_dispatch",
          code: "DUPLICATE_IDEMPOTENCY_KEY",
          message: "Fixture rejected duplicate idempotency key",
          retryable: false,
          correlation: {
            dispatchId: request.dispatchId,
            runId: request.authorization.runId,
            attemptId: request.authorization.attemptId
          }
        }
      };
    }
    this.seenIdempotencyKeys.add(request.idempotencyKey);
    return {
      ok: true,
      value: {
        correlation: {
          dispatchId: request.dispatchId,
          runId: request.authorization.runId,
          attemptId: request.authorization.attemptId
        },
        status: "accepted",
        route: request.route,
        acceptedAt: "2026-01-01T00:00:00.000Z"
      }
    };
  }

  public subscribeProgress(
    correlation: Correlation,
    handler: (event: ProgressEvent) => void
  ): () => void {
    for (const event of this.plan.progressEvents ?? []) {
      if (
        event.correlation.dispatchId === correlation.dispatchId &&
        event.correlation.runId === correlation.runId &&
        event.correlation.attemptId === correlation.attemptId
      ) {
        handler(event);
      }
    }
    return () => undefined;
  }

  public subscribeTerminal(
    correlation: Correlation,
    handler: (outcome: TerminalOutcome) => void
  ): () => void {
    const outcome = this.plan.terminalOutcome;
    if (
      outcome &&
      outcome.correlation.dispatchId === correlation.dispatchId &&
      outcome.correlation.runId === correlation.runId &&
      outcome.correlation.attemptId === correlation.attemptId
    ) {
      handler(outcome);
    }
    return () => undefined;
  }

  public async requestCancellation(
    _correlation: Correlation,
    _deadlineAt: string
  ): Promise<AdapterResult<CancellationReport>> {
    return this.plan.cancellationResult;
  }

  public async reconcile(
    _correlation: Correlation
  ): Promise<AdapterResult<ReconciliationReport>> {
    return this.plan.reconciliationResult;
  }
}
