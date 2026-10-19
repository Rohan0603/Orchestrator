# Job ownership helper

Standalone Windows helper boundary. It owns one named Job Object and accepts
one JSON object per stdin line:

```json
{"version":"orchestrator-job-v1","id":"1","operation":"handshake"}
{"version":"orchestrator-job-v1","id":"2","operation":"launch","executable":"C:\\path\\worker.exe","runId":"run","attemptId":"attempt","nonce":"random"}
{"version":"orchestrator-job-v1","id":"3","operation":"launch","executable":"C:\\path\\job-object-helper.exe","fixtureDirectory":"C:\\temp\\fixture","runId":"run","attemptId":"attempt","nonce":"random"}
{"version":"orchestrator-job-v1","id":"4","operation":"cancel","runId":"run","attemptId":"attempt","nonce":"random"}
{"version":"orchestrator-job-v1","id":"5","operation":"reconcile","runId":"run","attemptId":"attempt","nonce":"random","workerPid":"1234","workerCreationTime":"..."}
{"version":"orchestrator-job-v1","id":"6","operation":"shutdown"}
```

Responses are JSON lines. Handshake returns helper PID and creation-time
identity. Launch and cancellation echo and validate run, attempt, and nonce
identity. The helper rejects messages over 8192 bytes, unexpected protocol
versions, missing request IDs, and unknown operations. EOF leaves owned
processes recoverable for a bounded interval; a restarted helper can reconcile
the named Job only after matching worker PID and creation time. Launch creates
the worker suspended, assigns it to the helper-owned Job, verifies membership,
then resumes it. `cancel` terminates the complete Job tree and signals the
previous helper to exit. `shutdown` performs orderly cleanup before helper
exit.

Build from an x64 Native Tools command shell:

```powershell
cl /nologo /std:c++20 /W4 /EHsc native\job-object-helper\job_object_helper.cpp /Fe:dist-native\job-object-helper.exe /link /subsystem:console
```

This helper is not wired to live provider dispatch. Production launch and
cancellation remain disabled until Electron integration, restart identity,
authorization validation, packaged owner-loss qualification, and durable
cleanup evidence pass.
