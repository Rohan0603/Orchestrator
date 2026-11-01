# ORC-36 Local IPC and Handshake Implementation Plan

> **For agentic workers:** implement each task with the existing TDD workflow; each step ends with a focused verification before proceeding.

**Goal:** Establish a bounded, supervised TypeScript-to-Rust local transport using only the frozen protocol v1 contract.

**Architecture:** Use private child-owned stdio pipes: Electron main/Node launches `orchestrator-core` with `shell: false`, stdout carries 4-byte big-endian length-prefixed JSON only, and stderr is drained as diagnostics. Rust accepts one compatible hello before serving requests; the initial skeleton serves only health and capability queries and returns `NOT_IMPLEMENTED` for all other registered operations. Restart creates a new child and repeats negotiation; an interrupted frame or timeout poisons and terminates that transport instance.

**Tech Stack:** Tokio, serde/serde_json, TypeScript, Node.js 24 child_process streams, existing protocol v1 schemas and validator.

**Spec:** `docs/protocol/v1/contract.md`, `docs/protocol/v1/schema.json`, Linear ORC-36.

## Global Constraints

- Protocol v1 frames are UTF-8 JSON preceded by a 4-byte unsigned big-endian byte length.
- The JSON body is 1..1,048,576 bytes; reject zero, oversized, truncated, invalid UTF-8, and invalid JSON frames before dispatch.
- Handshake requires a common protocol major, matching schema version, `ready: true`, and every required capability supported or explicitly satisfied conditional.
- Only Electron main / trusted Node code owns the child process and transport. Renderer/preload do not expose arbitrary process or pipe access.
- stdout is protocol-only; structured logs stay on stderr. No remote listener, gRPC, database migration, or TypeScript service deletion.
- Queue size and request timeouts are finite. A timed-out read/write cannot resume on the same process; close it and fail all pending requests.

## Review Focus

1. EOF after a complete frame is clean shutdown; EOF within a prefix/body is a protocol failure.
2. A frame timeout after partial I/O poisons the process; no continuation or automatic replay occurs.
3. Duplicate IDs cannot cross-match concurrent responses or cause a second effect.
4. Invalid/missing capabilities and incompatible protocol/schema versions prevent all requests.
5. Child stderr saturation, queue saturation, and abrupt exit cannot hang shutdown or leak pending promises.

---

### Task 1: Rust framed protocol server and handshake

**Files:** Modify `orchestrator-core/src/lib.rs`, `orchestrator-core/src/main.rs`, `orchestrator-core/Cargo.toml`; test `scripts/rust-core-integration.test.mjs` and Rust unit tests.

**Interfaces:** First inbound frame is `hello`; first outbound frame is `welcome`. After successful handshake accept JSON `request` frames. Implement `system.health` and `capabilities.list`; return safe `NOT_IMPLEMENTED` for registered but unimplemented methods and `METHOD_NOT_FOUND` for unknown methods.

- [x] Add failing real-process tests for handshake success, no pre-handshake request handling, supported capability calls, unsupported method behavior, truncated/oversized/malformed frames, and duplicate request IDs.
- [x] Run `npm run test:rust-core` and confirm the new assertions fail for the expected protocol gaps.
- [x] Implement bounded frame reading/writing, UTF-8/JSON validation, common-envelope checks, sender pinning to the negotiated stdio peer, version/schema/capability negotiation, response matching fields, and per-process duplicate tracking without opening SQLite.
- [x] Re-run focused Rust unit and Node integration tests; verify stdout contains only framed bytes and stderr contains structured diagnostics.

### Task 2: TypeScript supervised client and bounded request handling

**Files:** Create `src/main/rust-core-client.ts`, test `scripts/rust-core-client.test.mjs` against the `dist-test` TypeScript output; update the canonical `package.json` test script.

**Interfaces:** `RustCoreClient.start(executablePath, options)` launches a child with private stdio and performs mandatory hello/welcome validation before returning. `request(request)` validates v1 envelopes, tracks pending replies by `messageId`, enforces deadline and bounded pending queue, and rejects malformed/mismatched responses. `close(deadlineMs)` ends stdin, waits for child close, then terminates only the owned child on deadline. No renderer API is added.

- [ ] Add failing tests using the real Rust executable for hello + health/capability request/response and a fake protocol child for absent child, incompatible welcome, request timeout, abrupt exit, duplicate IDs, stale event sequence, and bounded queue saturation.
- [ ] Run the focused suite and confirm each failure is caused by missing client behavior.
- [ ] Implement one streaming frame decoder, a serialized bounded writer honoring `write()`/`drain`, pending request correlation checks, capability gate, timeout poisoning, ordered event sequence tracking, stderr draining, and deterministic close/reconnect.
- [ ] Re-run focused tests; run the Electron IPC security suite to confirm renderer cannot reach the client or spawn path.

### Task 3: Integration evidence, compatibility matrix, and final verification

**Files:** Update `docs/protocol/v1/contract.md` with the selected supervised-stdio path and identity/supervision assumptions; update `README.md` and Rust core test command counts if needed; Linear ORC-36 evidence.

- [ ] Add a compatibility/fault matrix that maps each handshake/frame/process/queue failure to its observed fail-closed behavior.
- [ ] Add a small repeatable real-transport overhead benchmark using the frozen health request; record raw revision-tagged output under a new `experiments/` path.
- [ ] Run `cargo fmt --all --check`, `npm run build`, focused Rust IPC tests, `npm test`, and Windows packaging; verify package includes the same Rust executable revision.
- [ ] Record the exact commands, counts, representative redacted trace, measurements, source SHA and remaining unverified conditions in ORC-36; only then mark Done.
