import { NativeOwnershipService } from "../execution/native-ownership";
import type { RunRepository } from "../persistence/run-repository";

export async function reconcileUnresolvedOwnership(
  runRepository: RunRepository,
  helperPath: string
): Promise<void> {
  const unresolved = runRepository.listUnresolvedOwnership();
  for (const record of unresolved) {
    const service = new NativeOwnershipService(helperPath);
    try {
      if (record.workerPid === null || record.workerCreationTime === null || !record.nonce) {
        throw new Error("Persisted worker identity is incomplete");
      }
      await service.start();
      const correlation = {
        runId: record.runId,
        attemptId: record.attemptId,
        nonce: record.nonce
      };
      const status = await service.reconcile(
        correlation,
        record.workerPid,
        record.workerCreationTime
      );
      const observedExited = !status.running && status.activeProcesses === 0;
      let cleanupVerified = observedExited;
      if (status.running || status.activeProcesses > 0) {
        cleanupVerified = (await service.cancel(correlation)).cleanupVerified;
      }
      if (!observedExited && !cleanupVerified) {
        throw new Error("Reconciled ownership did not prove cleanup");
      }
      const reconciledAt = new Date().toISOString();
      runRepository.recordOwnership({
        ...record,
        state: observedExited ? "exited_observed" : "cleanup_verified",
        lastStatus: observedExited ? "restart_observed_exited" : "restart_reconciled",
        cleanupVerified: !observedExited,
        uncertaintyReason: null,
        updatedAt: reconciledAt
      });
      runRepository.recordRecoveryOutcome(
        record.runId,
        "reconciled",
        observedExited
          ? "Owned process identity matched and worker was already exited after restart"
          : "Owned process identity matched and cleanup was verified after restart",
        reconciledAt
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Restart ownership reconciliation failed";
      const observedAt = new Date().toISOString();
      try {
        runRepository.recordOwnership({
          ...record,
          state: "uncertain",
          lastStatus: "restart_reconciliation_unverified",
          cleanupVerified: false,
          uncertaintyReason: reason,
          updatedAt: observedAt
        });
        runRepository.recordRecoveryOutcome(record.runId, "recovery_required", reason, observedAt);
      } catch (persistenceError) {
        console.error("Restart ownership recovery persistence failed", persistenceError);
      }
      console.error("Restart ownership reconciliation failed", {
        runId: record.runId,
        reason
      });
    } finally {
      await service.close();
    }
  }
}
