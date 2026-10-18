# Reuse-first decisions

Audit date: 2026-10-18  
Checkout reviewed: `6e1d3c5`  
Scope: Orchestrator v0.1 MVP

Research sources reviewed:

- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), Microsoft Learn, accessed 2026-10-18.
- [Node.js child_process](https://nodejs.org/api/child_process.html), Node.js documentation, accessed 2026-10-18.

| Subsystem | Decision | Existing solution | Reason |
|---|---|---|---|
| Electron security and IPC | `USE_EXISTING` | Electron `contextIsolation`, sandbox, `nodeIntegration: false`, `contextBridge`, `ipcMain.handle` | Native controls already enforce the required boundary; adding a wrapper would duplicate policy. |
| Payload validation | `USE_EXISTING` | Typed TypeScript guards in `src/shared/ipc.ts` | Current IPC surface is small; main-process validation is authoritative and dependency-free. |
| SQLite persistence | `USE_EXISTING` | `better-sqlite3`, explicit migrations, transactions, backup API | Existing dependency covers synchronous transactions, migrations, and disposable backup tests. |
| Test execution | `USE_EXISTING` | Node `node:test` plus Electron test processes | Existing suite covers deterministic, conformance, execution, SQLite, IPC, and UI paths without another runner. |
| Windows process ownership | `DEFER` | Windows Job Objects are the platform mechanism; Node `ChildProcess` is only the direct child handle | Reviewed `@vscode/windows-process-tree` 0.8.0 (MIT, maintained, native Toolhelp32 parent-PID tree only; no Job Object ownership or termination) and `node-windows-process` 0.1.4 (MIT, last release 2022; single-PID liveness check only). Neither provides `CreateJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`, or verified ownership. No suitable maintained binding was established; native integration needs separate authorization and implementation evidence. |
| Worker protocol | `ADOPT` | Project-owned adapter contract with OpenCode CLI JSON adapter | Existing adapter is the only route with retained durable trials; SDK/server and ACP remain unqualified. |
| Packaging | `USE_EXISTING` | `@electron/packager` | Existing package script creates the Windows artifact; signing and clean-machine launch remain separate gates. |
| Logging and audit | `USE_EXISTING` | Existing explicit audit/evidence persistence and `console.error` boundary logging | No evidence shows a new logging framework would improve MVP correctness without added runtime cost. |

## Rejected or deferred candidates

- Schema library: deferred; current boundary has one small payload shape and
  existing guards are test-covered.
- ORM or second database: rejected; SQLite is authoritative and current
  repositories/migrations are sufficient.
- ACP and OpenCode SDK/server: deferred; documented protocol surfaces are not
  qualification evidence and would expand scope without a current use case.
- Native process-management package or FFI: deferred; reviewed candidates do not
  provide Job Objects, and a new native addon would require Electron ABI builds,
  Windows fault tests, packaging, and separate authorization.

No dependency, provider, credential, framework, or native module was added.

## Mission follow-up

The registry candidate `@deepseek-ai/dsh-win32-process@0.1.2-alpha.2` was
reviewed on 2026-10-18. It is MIT-licensed and uses `koffi` to expose
Windows process and Job Object primitives. Its published implementation
assigns a suspended child to a kill-on-close Job before resuming it, but it
does not expose Job membership verification, active-process queries,
termination verification, or durable process identity. It also requires
Electron ABI qualification that is not present in this checkout. It is not
sufficient for Orchestrator's required contract and was not added.

The current shell does not expose `cl`, `csc`, or `dotnet` on `PATH`.
Visual Studio Build Tools 2022 is installed at
`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`; activating
`VC\Auxiliary\Build\vcvars64.bat` exposes MSVC 19.44.35229. Windows SDK
10.0.26100.0 is installed. This removes compiler availability as a blocker,
but does not qualify a native implementation. The explicit mission prohibition
on ad hoc FFI remains, and no complete maintained binding was found.

Additional primary sources reviewed on 2026-10-18:

- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- [Process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)

These sources support suspended launch plus Job assignment and authoritative
Job queries, but do not provide an application implementation or Electron ABI
qualification.

A disposable repository-external probe confirmed the activated compiler and
SDK can compile/link/run basic `CreateJobObjectW`,
`SetInformationJobObject`, and `QueryInformationJobObject` calls. This
supports a future project-owned native boundary investigation, but does not
justify adding an incomplete native wrapper.

The project now owns a standalone test-only harness at
`native\job-object-prototype\job_object_harness.cpp`. It uses Win32 headers
and libraries already installed with the Windows SDK; no runtime dependency or
FFI package was added. The harness proves suspended assignment,
`IsProcessInJob` membership, ordinary child/grandchild containment, Job
termination, process exit, and zero active-process accounting. It is
intentionally not connected to Electron or production dispatch.
