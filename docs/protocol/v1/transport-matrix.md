# Core IPC v1 transport and fault matrix

This matrix records the behavior exercised by the Rust v1 transport through ORC-37. The core supports health/capability queries and the `tasks.create`/`tasks.get`/`tasks.list` persistence slice; other registered methods remain `NOT_IMPLEMENTED` until their migration issues deliver them.

## Compatibility and fault behavior

| Condition | Evidence | Required observed behavior |
| -- | -- | -- |
| Compatible v1 hello and schema, required capabilities supported | `scripts/rust-core-integration.test.mjs`: handshake/health test; `scripts/rust-core-client.test.mjs`: real process round trip | `welcome` is returned before `start()` resolves; health/capability requests correlate to their responses |
| Incompatible protocol major or missing/unverified required capability | Rust integration and client incompatible-handshake tests | Startup rejects; no request is served |
| Request before hello | Rust integration test | Process rejects the frame and does not dispatch it |
| Zero, oversized, truncated, invalid UTF-8, or malformed JSON frame | Rust integration test | Protocol failure; no dispatch |
| Supported task method without an attached database | `scripts/rust-core-integration.test.mjs`: create and list without database | Structured `DATABASE_UNAVAILABLE`; no TypeScript fallback |
| Registered method without a Rust adapter | Unsupported `tasks.get` mandatory-capability handshake test | Startup rejects the unverified capability; requests cannot be served |
| Unknown method | Rust IPC dispatch implementation | Structured `METHOD_NOT_FOUND` |
| Backend executable missing or startup deadline expires | TypeScript client tests | `start()` rejects and releases any child it created |
| Partial/late request response or request deadline | TypeScript client timeout test | Transport is poisoned, owned child is terminated, and all pending requests fail; no retry |
| Abrupt backend exit | TypeScript client test | Every pending request fails and the client enters failed state |
| Duplicate request message ID with identical content | Rust and TypeScript client duplicate tests | In-flight requests share one result; after completion the cached response is reused |
| Duplicate message ID with different content | Rust and TypeScript client duplicate tests | `MESSAGE_ID_CONFLICT`; no second dispatch |
| Duplicate/stale/gapped event sequence | TypeScript client event test | Event is rejected before application callback; transport fails closed |
| Pending request count or byte budget exhausted | TypeScript client queue test | New request is rejected with `QUEUE_FULL`; the queue remains bounded |
| Large diagnostic stderr output | TypeScript client stderr test | stderr continues to drain and does not corrupt stdout framing |
| Graceful close/reconnect | TypeScript client real-process test | Close ends stdin and waits for the owned child; a new instance starts a new child and repeats handshake |

The Electron IPC security suite confirms that renderer callers cannot invoke arbitrary main-process APIs. ORC-36 deliberately adds no renderer bridge to the Rust client. Wiring application-wide Electron shutdown to this client belongs to the thin-main integration issue ORC-43; the client API's bounded `close()` behavior is covered here.

The 1,000-request Windows x64 run is preserved at `experiments/ipc/2026-11-02-orc-36-rust-stdio-final.json` (implementation SHA `75edb0b8cf5f9d04f266f7de18fa7770bc6c6592`, Node 24.19.0, AMD Ryzen 5 4600H). Sequential real-process IPC measured 1,490 requests/s, p50 0.625 ms and p95 1.004 ms. The codec-only control measured 61,814 encode/decode operations/s, p50 0.014 ms and p95 0.020 ms; observed p50 delta was 0.612 ms. These microbenchmarks are diagnostic and are not product SLOs.

## Transport overhead measurement

Run `npm run build:rust-core`, `npm run build`, then:

```powershell
node scripts/benchmark-rust-ipc.mjs --count 1000 --output experiments/ipc/<new-file>.json --source-revision <tested-git-sha>
```

The JSON artifact records sequential real child-process health round-trip latency alongside a codec-only encode/decode control, p50/p95/min/max/mean, runtime/OS/CPU, count, and source revision. The difference is a local diagnostic comparison, not an end-to-end product SLO or provider benchmark. Use a new output path per run and preserve the raw record.
