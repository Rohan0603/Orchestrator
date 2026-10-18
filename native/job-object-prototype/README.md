# Windows Job Object prototype

Standalone disposable harness. Not production worker integration.

Build from repository root in an x64 Native Tools command environment:

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\orchestrator-job-object-build" | Out-Null
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"" && cl /nologo /std:c++20 /W4 /EHsc native\job-object-prototype\job_object_harness.cpp /Fe:%TEMP%\orchestrator-job-object-build\job_object_harness.exe /link /subsystem:console"
```

Run:

```powershell
& "$env:TEMP\orchestrator-job-object-build\job_object_harness.exe"
```

Harness creates worker suspended, assigns it to a kill-on-close Job, verifies
membership with `IsProcessInJob`, resumes worker, and verifies worker/child/
grandchild membership. It terminates only its own Job and verifies process
exit plus `QueryInformationJobObject` active-process count zero.

Run controlled failure and cleanup cases:

```powershell
& "$env:TEMP\orchestrator-job-object-build\job_object_harness.exe" --failure-tests
```

This covers process-creation failure, invalid assignment cleanup, query
failure after owner-handle close, injected pre-resume cleanup, repeated
termination, and owner-handle close cleanup.

Harness uses no arbitrary PID input, PID-tree enumeration, `taskkill`, or
production application state. It does not qualify Electron loading, restart
reconciliation, or production cancellation.
