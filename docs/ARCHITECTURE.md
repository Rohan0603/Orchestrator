# Implemented architecture

## Boundaries

Electron main owns SQLite, filesystem, Git, process, and future provider
operations. Sandboxed renderer code receives only typed preload methods.
Context isolation, disabled Node integration, restrictive CSP, sender/frame
validation, and payload validation remain required boundaries.

## Durable state

SQLite stores tasks, runs, attempts, approvals, policy decisions, dispatch
intents, progress cursors/events, evidence, acceptance decisions, audit events,
outbox records, and recovery state. Schema changes use versioned migrations.
Filesystem and Git hold source, diffs, and artifacts; they are not security
boundaries.

## Execution flow

Task intake -> policy evaluation -> route/capability evaluation -> exact
approval when required -> durable dispatch intent -> adapter execution ->
ordered progress and terminal outcome -> orchestrator verification/review ->
bounded repair or acceptance/rejection. Unknown or ambiguous outcomes enter
`recovery_required`; they are not replayed automatically.

## Current implementation boundary

The deterministic fixture adapter exercises lifecycle and persistence behavior.
OpenCode CLI JSON is provisionally qualified as one live provider route.
Real Windows process ownership,
cancellation, independent review execution, and commercial packaging remain
separate qualification work. Missing mandatory capability or identity blocks
dispatch.
