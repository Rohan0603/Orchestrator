const scenario = process.argv[2] ?? "reply";
let input = Buffer.alloc(0);
let handshakeComplete = false;
let requestCount = 0;

function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  process.stdout.write(frame);
}

function welcomeFor(hello) {
  const capabilities = [
    {name: "system.health", state: "supported"},
    {name: "capabilities.list", state: "supported"}
  ];
  if (scenario !== "missing-capability") {
    capabilities.push(...hello.requiredCapabilities
      .filter((name) => !capabilities.some((item) => item.name === name))
      .map((name) => ({name, state: "unverified"})));
  }
  return {
    protocolVersion: 1,
    kind: "welcome",
    messageId: "fake-welcome-1",
    correlationId: hello.correlationId,
    causationId: hello.messageId,
    sender: {id: "orchestrator-core", role: "backend"},
    selectedProtocol: scenario === "incompatible" ? 2 : 1,
    backendVersion: "0.1.0",
    buildId: "fake-build",
    schemaVersion: 1,
    databaseSchemaVersion: 0,
    processSupervision: "parent-owned-stdio",
    ready: scenario !== "not-ready",
    capabilities
  };
}

function event(sequence, messageId) {
  return {
    protocolVersion: 1,
    kind: "event",
    messageId,
    correlationId: "fake-correlation",
    causationId: null,
    sender: {id: "orchestrator-core", role: "backend"},
    eventType: "task.progress",
    sequence,
    cursor: `cursor-${sequence}-${messageId}`,
    occurredAt: "2026-11-02T00:00:00.000Z",
    runId: "run-1",
    payload: {subscriptionId: "subscription-1", progress: "fixture"}
  };
}

function processMessage(message) {
  if (!handshakeComplete) {
    if (message.kind !== "hello") return;
    handshakeComplete = true;
    if (scenario === "stderr-burst") process.stderr.write("fake diagnostic\n".repeat(9000));
    if (scenario === "startup-hang") return;
    writeFrame(welcomeFor(message));
    if (scenario === "stale-event") {
      setTimeout(() => {
        writeFrame(event(1, "fake-event-1"));
        writeFrame(event(1, "fake-event-2"));
      }, 10);
    }
    if (scenario === "slow-read") process.stdin.pause();
    return;
  }

  requestCount += 1;
  if (scenario === "hang" || scenario === "queue-saturation" || scenario === "startup-hang") return;
  if (scenario === "exit-on-request") process.exit(23);
  if (scenario === "slow-read") return;
  const respond = () => writeFrame({
    protocolVersion: 1,
    kind: "response",
    messageId: `fake-response-${requestCount}`,
    correlationId: message.correlationId,
    causationId: message.messageId,
    sender: {id: "orchestrator-core", role: "backend"},
    inReplyTo: message.messageId,
    ok: true,
    result: {requestCount}
  });
  if (scenario === "delay" || scenario === "duplicate") setTimeout(respond, 50);
  else respond();
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (length < 1 || length > 1024 * 1024) process.exit(12);
    if (input.length < length + 4) break;
    const message = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(input.subarray(4, length + 4)));
    input = input.subarray(length + 4);
    processMessage(message);
  }
});
process.stdin.on("end", () => process.exit(0));
