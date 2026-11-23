import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectWampMessages } from "../src/shared/wamp-metadata.js";

function frame(direction, parsed, offset = 0) {
  return {
    direction,
    parsed,
    socketId: 1,
    timestamp: new Date(Date.UTC(2026, 0, 1) + offset).toISOString(),
    rawText: "fixture-secret",
    url: "wss://example.test/?token=fixture-secret",
  };
}

test("pairs calls before filtering and builds metadata without including payloads", () => {
  const frames = [
    frame("sent", [
      48,
      1,
      { token: "fixture-secret" },
      "demo.success",
      ["fixture-secret"],
      { topic: "fixture-secret" },
    ]),
    frame("received", [50, 1, { progress: true }, ["fixture-secret"]], 10),
    frame("received", [50, 1, {}, ["fixture-secret"]], 20),
    frame("sent", [48, 2, {}, "demo.error"], 30),
    frame(
      "received",
      [8, 48, 2, {}, "demo.mock_error", ["fixture-secret"]],
      35,
    ),
    frame("sent", [48, 3, {}, "demo.no_response"], 40),
    frame("received", [5, {}, "fixture-secret"], 45),
  ];

  const result = inspectWampMessages(frames, { type: "CALL" });
  assert.deepEqual(
    result.messages.map(({ requestId, status, latencyMs }) => [
      requestId,
      status,
      latencyMs,
    ]),
    [
      [1, "success", 20],
      [2, "error", 5],
      [3, "pending", null],
    ],
  );
  assert.equal(result.messages[1].errorUri, "demo.mock_error");
  assert.equal(result.messages[0].topic, null);
  assert.equal(
    inspectWampMessages(frames, { type: "ERROR" }).messages[0].requestId,
    2,
  );
  assert.deepEqual(
    inspectWampMessages(frames, { uri: "demo.no_response" }).messages.map(
      ({ requestId }) => requestId,
    ),
    [3],
  );
  assert.equal(
    JSON.stringify(inspectWampMessages(frames, {})).includes("fixture-secret"),
    false,
  );
  const limited = inspectWampMessages(frames, { type: "CALL", limit: 1 });
  assert.equal(limited.truncated, true);
  assert.deepEqual(
    limited.messages.map(({ requestId }) => requestId),
    [3],
  );
});

test("correlates subscription topics and keeps independent request types and directions", () => {
  const frames = [
    frame("sent", [32, 1, { match: "wildcard" }, "demo..updates"]),
    frame("received", [33, 1, 42], 2),
    frame("received", [36, 42, 21, {}, ["fixture-secret"]], 5),
    frame("sent", [48, 2, {}, "demo.call"], 10),
    frame("received", [8, 16, 2, {}, "demo.publish_failed"], 15),
    frame("received", [68, 2, 51, {}], 20),
    frame("sent", [70, 2, {}, ["fixture-secret"]], 25),
  ];

  const event = inspectWampMessages(frames, {
    type: "EVENT",
    uri: "demo..updates",
  }).messages[0];
  assert.equal(event.topic, "demo..updates");
  assert.equal(event.subscriptionId, 42);
  assert.equal(event.publicationId, 21);
  assert.equal(
    inspectWampMessages(frames, { type: "CALL" }).messages[0].status,
    "pending",
  );
  assert.equal(
    inspectWampMessages(frames, { type: "INVOCATION" }).messages[0].status,
    "success",
  );
});

function signal() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
  };
}

function port(name, sender) {
  const messages = [];
  return {
    name,
    sender,
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage: (message) => messages.push(structuredClone(message)),
    messages,
  };
}

let workerId = 0;
const panelUrl = "chrome-extension://test/src/devtools/panel.html";

async function createWorker(getTab = async (id) => ({ id })) {
  const runtime = {
    id: "test",
    onMessage: signal(),
    onConnect: signal(),
    getURL: (path) => "chrome-extension://test/" + path,
  };
  const webNavigation = { onCommitted: signal(), onBeforeNavigate: signal() };
  const tabs = { onRemoved: signal(), get: getTab };
  const permissions = { onRemoved: signal() };
  globalThis.chrome = { runtime, webNavigation, tabs, permissions };
  try {
    await import("../src/capture/background.js?mcp-worker=" + ++workerId);
  } finally {
    delete globalThis.chrome;
  }

  function populate(tabId, frameId, documentId, uri) {
    const sender = { tab: { id: tabId }, frameId, documentId };
    runtime.onMessage.emit(
      {
        type: "ws-event",
        payload: { id: 1, protocol: "wamp.2.json", state: "OPEN" },
      },
      sender,
      () => {},
    );
    runtime.onMessage.emit(
      { type: "ws-message", payload: frame("sent", [48, 1, {}, uri]) },
      sender,
      () => {},
    );
  }

  async function share(tabId, url = panelUrl) {
    const panel = port("wamp-mcp-share", { id: "test", url });
    runtime.onConnect.emit(panel);
    panel.onMessage.emit({ type: "share", tabId });
    await new Promise((resolve) => setImmediate(resolve));
    return panel;
  }

  return { populate, share, webNavigation, tabs, permissions };
}

function receiveNative(panel, message) {
  panel.onMessage.emit({ type: "native-message", message });
}

function request(panel, method, params = {}, id = 1) {
  const before = panel.messages.length;
  receiveNative(panel, { id, method, params });
  if (panel.messages.length === before) return undefined;
  const response = panel.messages.at(-1);
  assert.equal(response.type, "native-response");
  assert.equal(response.message.id, id);
  return response.message;
}

test("reads only the chosen tab, isolates iframe histories and revokes on navigation", async () => {
  const { populate, share, webNavigation } = await createWorker();
  populate(7, 0, "main-doc", "demo.main");
  populate(7, 3, "iframe-doc", "demo.iframe");
  populate(8, 0, "separate-doc", "demo.other");

  const unauthorized = await share(8, "https://fixture.test");
  receiveNative(unauthorized, { type: "ready" });
  assert.equal(request(unauthorized, "list_wamp_connections"), undefined);
  assert.equal(unauthorized.messages.length, 0);

  const panel = await share(7);
  assert.equal(panel.messages.at(-1).state, "connecting");
  receiveNative(panel, { type: "ready" });
  assert.equal(panel.messages.at(-1).state, "sharing");
  const busy = await share(8);
  assert.equal(busy.messages.at(-1).state, "error");
  receiveNative(busy, { type: "ready" });
  assert.equal(request(busy, "list_wamp_connections"), undefined);

  const {
    result: { connections },
  } = request(panel, "list_wamp_connections");
  assert.equal(connections.length, 2);
  assert.equal(connections[0].protocol, "wamp.2.json");
  assert.notEqual(connections[0].connectionId, connections[1].connectionId);
  const procedures = connections.map(
    ({ connectionId }) =>
      request(panel, "inspect_wamp_messages", { connectionId }).result
        .messages[0].procedure,
  );
  assert.deepEqual(procedures, ["demo.main", "demo.iframe"]);
  assert.equal(
    request(panel, "inspect_wamp_messages", { connectionId: "bogus" }).error
      .code,
    "unknown_connection",
  );
  assert.equal(request(panel, "clear-messages").error.code, "invalid_request");

  webNavigation.onCommitted.emit({
    tabId: 7,
    frameId: 3,
    documentId: "new-iframe-doc",
  });
  assert.equal(
    request(panel, "list_wamp_connections").result.connections.length,
    2,
  );

  webNavigation.onCommitted.emit({
    tabId: 7,
    frameId: 0,
    documentId: "new-doc",
  });
  assert.equal(panel.messages.at(-1).state, "stopped");
  assert.equal(request(panel, "list_wamp_connections"), undefined);
});

test("closes on panel disconnect, Native Messaging errors, permission removal, or tab removal", async () => {
  const { share, tabs, permissions } = await createWorker();
  const panel = await share(4);
  receiveNative(panel, { type: "ready" });
  panel.onDisconnect.emit();
  assert.equal(request(panel, "list_wamp_connections"), undefined);

  const secondPanel = await share(4);
  receiveNative(secondPanel, {
    type: "error",
    message: "Companion already in use.",
  });
  assert.equal(secondPanel.messages.at(-1).state, "error");
  assert.equal(
    secondPanel.messages.at(-1).message,
    "Companion already in use.",
  );

  const thirdPanel = await share(4);
  receiveNative(thirdPanel, { type: "ready" });
  permissions.onRemoved.emit({ permissions: ["nativeMessaging"] });
  assert.equal(thirdPanel.messages.at(-1).state, "stopped");
  assert.equal(request(thirdPanel, "list_wamp_connections"), undefined);

  const fourthPanel = await share(4);
  receiveNative(fourthPanel, { type: "ready" });
  tabs.onRemoved.emit(4);
  assert.equal(fourthPanel.messages.at(-1).state, "stopped");
  assert.equal(request(fourthPanel, "list_wamp_connections"), undefined);

  const fifthPanel = await share(4);
  fifthPanel.onMessage.emit({ type: "native-disconnected", hadError: true });
  assert.equal(fifthPanel.messages.at(-1).state, "error");
});

test("a timed-out companion cannot read before or after its handshake deadline", async ({
  mock,
}) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { populate, share } = await createWorker();
  populate(7, 0, "main-doc", "demo.main");
  const panel = await share(7);
  assert.equal(request(panel, "list_wamp_connections"), undefined);
  mock.timers.tick(5_000);
  assert.equal(panel.messages.at(-1).state, "error");

  const nextPanel = await share(7);
  receiveNative(panel, { type: "ready" });
  assert.equal(nextPanel.messages.at(-1).state, "connecting");
  assert.equal(request(panel, "list_wamp_connections"), undefined);

  receiveNative(nextPanel, { type: "ready" });
  const { connections } = request(nextPanel, "list_wamp_connections").result;
  assert.equal(connections.length, 1);
  assert.equal(
    request(nextPanel, "inspect_wamp_messages", {
      connectionId: connections[0].connectionId,
      limit: 201,
    }).error.code,
    "invalid_request",
  );
  nextPanel.onDisconnect.emit();
});

test("cannot begin a relay before the tab check finishes", async () => {
  const pendingTab = Promise.withResolvers();
  const { share } = await createWorker(() => pendingTab.promise);
  const panel = await share(7);
  receiveNative(panel, { type: "ready" });
  assert.equal(request(panel, "list_wamp_connections"), undefined);
  assert.deepEqual(panel.messages, []);

  pendingTab.resolve({ id: 7 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panel.messages.at(-1).state, "connecting");
  assert.equal(request(panel, "list_wamp_connections"), undefined);

  receiveNative(panel, { type: "ready" });
  assert.deepEqual(
    request(panel, "list_wamp_connections").result.connections,
    [],
  );
  panel.onDisconnect.emit();
});
