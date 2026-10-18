# Recovery results

| Scenario | Status | Evidence/limitation |
|---|---|---|
| Dispatch intent before launch | PASS | retained durable trials |
| Crash before confirmed launch | NOT_TESTED | no safe live fault injection |
| Crash after launch before process identity | BLOCKED | ownership identity unavailable |
| Event persistence interruption | NOT_TESTED | no authorized injection |
| Duplicate terminal event | PASS | deterministic conformance coverage |
| Missing terminal event | BLOCKED | no live owned-process recovery trace |
| Deadline expiration | BLOCKED | cancellation/ownership prerequisite missing |
| Restart while worker runs | BLOCKED | cannot safely reconcile unknown process |
| SQLite backup/restore | PASS limited | schema/task-state disposable test |
| Active-run restore/retention | NOT_TESTED | no evidence |

The adapter conservatively blocks cancellation and unresolved redispatch when
ownership cannot be verified. No process was terminated during this work.

