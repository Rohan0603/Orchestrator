# Blockers and gaps

1. **Critical — independent review unavailable.** Needed: genuinely separate
   reviewer, frozen rubric, findings, and bounded repair evidence.
2. **Critical — process ownership/cancellation unverified.** Needed: supported
   Windows Job Object or equivalent on the actual Electron stack, with
   ownership, graceful cancellation, escalation, and verified termination.
3. **High — restart/deadline recovery unverified.** Depends on owned process
   identity and safe reconciliation.
4. **High — provider identity not confirmed.** Adapter/configuration identity
   is not provider-confirmed.
5. **Medium — corpus too narrow.** Need multi-file, failed verification,
   forbidden operation, ambiguity, repair, and restart trials.
6. **Medium — operational backup gaps.** Retention, active-run restoration,
   artifact references, and disaster recovery remain untested.
7. **Medium — deployment gaps.** Clean-machine launch, signing, and
   Application Control compatibility remain untested.
8. **Low — SDK/server and ACP unresolved.** No comparative qualification was
   run; CLI JSON remains the only provisional route.
9. **Medium — UI fault injection coverage incomplete.** Normal renderer flow
   passes, but rejected IPC promise paths and restart-visible UI history need
   a deterministic Electron failure harness before they can be marked pass.
10. **Low — subframe IPC behavior unverified.** Main-frame origin and second
    WebContents rejection pass; no safe subframe-specific proof exists.

    The test-runner process cleanup defect was remediated: cleanup now targets only
    the directly spawned child handle. This does not resolve application worker
    ownership or cancellation.
