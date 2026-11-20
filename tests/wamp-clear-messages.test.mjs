import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeMessages } from "../src/devtools/panel-messages.js";

let workerId = 0;

async function createWorker() {
  let receive;
  let connect;
  let commitNavigation;
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          receive = listener;
        },
      },
      onConnect: {
        addListener(listener) {
          connect = listener;
        },
      },
    },
    webNavigation: {
      onCommitted: {
        addListener(listener) {
          commitNavigation = listener;
        },
      },
    },
    tabs: { onRemoved: { addListener() {} } },
  };
  try {
    await import(`../src/capture/background.js?worker=${++workerId}`);
  } finally {
    delete globalThis.chrome;
  }

  function send(message, sender = {}) {
    let response;
    receive(message, sender, (value) => {
      response = structuredClone(value);
    });
    return response;
  }

  function subscribe(tabId) {
    let receivePortMessage;
    let disconnect;
    const messages = [];
    connect({
      name: "wamp-capture",
      onMessage: {
        addListener(listener) {
          receivePortMessage = listener;
        },
      },
      onDisconnect: {
        addListener(listener) {
          disconnect = listener;
        },
      },
      postMessage(message) {
        messages.push(structuredClone(message));
      },
    });
    receivePortMessage({ type: "subscribe", tabId });
    return {
      messages,
      disconnect,
      ping: () => receivePortMessage({ type: "ping" }),
    };
  }

  return { send, commitNavigation, subscribe };
}

test("Clear messages preserves open and closed sockets and continues capturing on the same live socket", async () => {
  const { send } = await createWorker();
  const open = { tab: { id: 7 }, frameId: 0 };
  const closed = { tab: { id: 7 }, frameId: 3 };
  const other = { tab: { id: 8 }, frameId: 0 };
  const url = "wss://example.test/feed";

  for (const [sender, state] of [
    [open, "OPEN"],
    [closed, "CLOSED"],
    [other, "OPEN"],
  ]) {
    send(
      {
        type: "ws-event",
        payload: { id: 1, url, state, protocol: "wamp.2.json" },
      },
      sender,
    );
    send(
      {
        type: "ws-message",
        payload: {
          socketId: 1,
          messageId: 1,
          timestamp: "2026-01-01T00:00:00Z",
        },
      },
      sender,
    );
  }

  const list = (tabId) => send({ type: "get-sockets", tabId }).sockets;
  const detail = (frameId) =>
    send({ type: "get-socket-detail", tabId: 7, frameId, socketId: 1 }).socket;
  const before = list(7);
  const otherBefore = list(8);
  assert.deepEqual(send({ type: "clear-messages", tabId: 7 }), { ok: true });
  assert.deepEqual(
    list(7),
    before.map((socket) => ({ ...socket, messageCount: 0, lastMessageAt: "" })),
  );
  assert.deepEqual(list(8), otherBefore);
  assert.deepEqual(detail(0).messages, []);
  assert.deepEqual(detail(3).messages, []);

  const fresh = {
    socketId: 1,
    messageId: 2,
    timestamp: "2026-01-01T00:00:02Z",
  };
  send({ type: "ws-message", payload: fresh }, open);
  assert.deepEqual(detail(0).messages, [fresh]);
  assert.equal(detail(0).state, "OPEN");
  assert.equal(detail(0).protocol, "wamp.2.json");
  assert.deepEqual(detail(3).messages, []);
});

test("an iframe navigation keeps reused local socket IDs in separate document histories", async () => {
  const { send, commitNavigation } = await createWorker();
  const first = { tab: { id: 7 }, frameId: 3, documentId: "first-document" };
  const next = { ...first, documentId: "next-document" };
  const open = { id: 1, state: "OPEN", protocol: "wamp.2.json" };
  const yieldFrame = { socketId: 1, messageId: 1, parsed: [70, 24, {}] };
  const callFrame = {
    socketId: 1,
    messageId: 1,
    parsed: [48, 25, {}, "fixture.call"],
  };

  send({ type: "ws-event", payload: open }, first);
  send({ type: "ws-message", payload: yieldFrame }, first);
  commitNavigation({
    tabId: 7,
    frameId: 3,
    documentId: next.documentId,
    documentLifecycle: "active",
  });
  send({ type: "ws-event", payload: open }, next);
  send({ type: "ws-message", payload: callFrame }, next);
  // A commit or socket event delivered again must not merge or reopen the old capture.
  commitNavigation({
    tabId: 7,
    frameId: 3,
    documentId: next.documentId,
    documentLifecycle: "active",
  });
  send({ type: "ws-event", payload: open }, first);

  const sockets = send({ type: "get-sockets", tabId: 7 }).sockets;
  assert.deepEqual(
    sockets.map(({ documentId, state }) => [documentId, state]),
    [
      [first.documentId, "CLOSED"],
      [next.documentId, "OPEN"],
    ],
  );
  for (const [sender, frame] of [
    [first, yieldFrame],
    [next, callFrame],
  ]) {
    const response = send({
      type: "get-socket-detail",
      tabId: 7,
      frameId: 3,
      documentId: sender.documentId,
      socketId: 1,
    });
    assert.deepEqual(response.socket.messages, [frame]);
  }
});

test("coalesces connection changes and frames into one update scoped to the subscribed tab", async ({
  mock,
}) => {
  const { send, subscribe } = await createWorker();
  mock.timers.enable({ apis: ["setTimeout"] });
  const firstPanel = subscribe(7);
  const secondPanel = subscribe(7);
  const otherPanel = subscribe(8);
  assert.deepEqual(firstPanel.messages, [{ type: "capture-ready" }]);

  const sender = { tab: { id: 7 }, frameId: 3, documentId: "embedded" };
  send(
    {
      type: "ws-event",
      payload: { id: 1, state: "OPEN", protocol: "wamp.2.json" },
    },
    sender,
  );
  for (const messageId of [1, 2, 3]) {
    send({ type: "ws-message", payload: { socketId: 1, messageId } }, sender);
  }
  send({ type: "ws-message", payload: { socketId: 2, messageId: 4 } }, sender);
  mock.timers.tick(31);
  assert.equal(firstPanel.messages.length, 1);
  mock.timers.tick(1);
  assert.equal(firstPanel.messages.length, 2);
  assert.equal(secondPanel.messages.length, 2);
  const update = {
    type: "capture-updated",
    connections: true,
    allMessages: false,
    socketKeys: ["3:1:embedded", "3:2:embedded"],
  };
  assert.deepEqual(firstPanel.messages.at(-1), update);
  assert.deepEqual(secondPanel.messages.at(-1), update);
  assert.deepEqual(otherPanel.messages, [{ type: "capture-ready" }]);

  firstPanel.disconnect();
  send({ type: "clear-messages", tabId: 7 });
  secondPanel.ping();
  mock.timers.tick(32);
  assert.equal(firstPanel.messages.length, 2);
  assert.deepEqual(secondPanel.messages.at(-1), {
    type: "capture-updated",
    connections: false,
    allMessages: true,
    socketKeys: [],
  });
  assert.equal(secondPanel.messages.length, 3);
});

test("keeps the latest 1,000 frames of each type per socket in capture order", async () => {
  const { send } = await createWorker();
  const sender = { tab: { id: 7 }, frameId: 0 };
  const timestamp = "2026-01-01T00:00:00Z";
  let messageId = 0;
  function capture(parsed, direction = "received", socketId = 1) {
    const payload = {
      socketId,
      messageId: ++messageId,
      timestamp,
      parsed,
      direction,
    };
    send({ type: "ws-message", payload }, sender);
    return payload;
  }
  function detail(socketId = 1) {
    return send({ type: "get-socket-detail", tabId: 7, socketId }).socket;
  }
  for (const id of [1, 2]) {
    send(
      {
        type: "ws-event",
        payload: { id, state: "OPEN", protocol: "wamp.2.json" },
      },
      sender,
    );
  }

  const hello = capture([1, "fixture", {}], "sent");
  const otherEvent = capture([36, 17, 1, {}], "received", 2);
  const calls = [];
  const results = [];
  const events = [];
  for (let id = 1; id <= 1002; id++) {
    calls.push(capture([48, id, {}, "fixture.call"], "sent"));
    results.push(capture([50, id, {}, [id]]));
    if (id <= 1001) events.push(capture([36, 17, id, {}]));
  }

  const { messages, messageCount } = detail();
  assert.equal(messageCount, 3001);
  const expected = [
    hello,
    ...calls.slice(-1000),
    ...results.slice(-1000),
    ...events.slice(-1000),
  ];
  assert.deepEqual(
    messages,
    expected.sort((first, second) => first.messageId - second.messageId),
  );
  assert.deepEqual(detail(2).messages, [otherEvent]);
  const { rows, pendingCount } = analyzeMessages(messages);
  assert.equal(pendingCount, 0);
  assert.equal(
    rows.filter(
      ({ type, responseType }) => type === "CALL" && responseType === "RESULT",
    ).length,
    1000,
  );
  assert.deepEqual(
    send({ type: "get-sockets", tabId: 7 }).sockets.map(
      ({ messageCount }) => messageCount,
    ),
    [3001, 1],
  );

  send({ type: "clear-messages", tabId: 7 });
  const fresh = capture([36, 17, 1002, {}]);
  assert.deepEqual(detail().messages, [fresh]);
  assert.equal(detail().messageCount, 1);
});

test("shares one capped fallback for unknown type codes and classifies legacy JSON", async () => {
  const { send } = await createWorker();
  const sender = { tab: { id: 7 }, frameId: 0 };
  const socket = { id: 1, state: "OPEN", protocol: "wamp.2.json" };
  send({ type: "ws-event", payload: socket }, sender);

  const call = {
    socketId: 1,
    direction: "sent",
    rawText: '[48,1,{},"fixture.legacy"]',
  };
  send({ type: "ws-message", payload: call }, sender);
  send(
    {
      type: "ws-event",
      payload: { ...socket, eventType: "open", history: null },
    },
    sender,
  );
  for (let code = 10_000; code <= 11_000; code++) {
    send(
      { type: "ws-message", payload: { socketId: 1, parsed: [code] } },
      sender,
    );
  }

  const { messages, messageCount } = send({
    type: "get-socket-detail",
    tabId: 7,
    socketId: 1,
  }).socket;
  assert.equal(messageCount, 1001);
  assert.deepEqual(messages[0], call);
  assert.deepEqual(messages[1].parsed, [10_001]);
  const { rows } = analyzeMessages(messages);
  assert.deepEqual(
    rows.slice(0, 2).map(({ type }) => type),
    ["CALL", "TYPE_10001"],
  );
});
