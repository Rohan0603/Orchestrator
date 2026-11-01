import type { AgentMessage } from "../shared/agent-message";
import { DeliveryFailure, MessageDeliveryRepository } from "../persistence/message-delivery-repository";

export type DatabaseMessageConsumer = (message: AgentMessage) => void;
export class InternalMessageDispatcher {
  public constructor(private readonly repository: MessageDeliveryRepository,
    private readonly consumers: Readonly<Record<string, DatabaseMessageConsumer>>, private readonly owner = "local-dispatcher") {}

  public dispatchDue(now: string, limit = 100): readonly string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid dispatch batch bound");
    const dispositions: string[] = [];
    for (let index = 0; index < limit; index++) {
      const step = this.repository.claimStep(this.owner, now);
      if (step.disposition) { dispositions.push(step.disposition); continue; }
      const claim = step.claim;
      if (!claim) break;
      try {
        const consumer = Object.hasOwn(this.consumers, claim.consumer_id) ? this.consumers[claim.consumer_id] : undefined;
        if (!consumer) throw new DeliveryFailure("permanent", "impossible_destination");
        const disposition = this.repository.consume(claim, now, consumer);
        this.repository.complete(claim, now);
        dispositions.push(disposition);
      } catch (error) {
        // consume() has rolled back its synchronous database transaction before throwing.
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        const classified = error instanceof DeliveryFailure ? error :
          code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ? new DeliveryFailure("transient", "sqlite_busy") :
          new DeliveryFailure("uncertain", "unclassified_consumer_failure");
        this.repository.fail(claim, now, classified);
        dispositions.push(classified.classification);
      }
    }
    return dispositions;
  }
}
