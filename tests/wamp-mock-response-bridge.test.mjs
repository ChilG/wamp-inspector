import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const runtimeId = "inspector-test";
const extensionUrl = `chrome-extension://${runtimeId}/`;
const panel = { id: runtimeId, url: `${extensionUrl}src/devtools/panel.html` };
const frame = { tab: { id: 7 }, frameId: 3, documentId: "embed-document" };
const arm = {
  type: "arm-mock-response",
  tabId: frame.tab.id,
  frameId: frame.frameId,
  documentId: frame.documentId,
  socketId: 2,
  callMessageId: 11,
  resultMessageId: 12,
};
const instruction = {
  type: arm.type,
  socketId: arm.socketId,
  callMessageId: arm.callMessageId,
  resultMessageId: arm.resultMessageId,
};
const getSaved = { ...arm, type: "get-mock-response" };
const resultBody = JSON.stringify([["edited"], { score: 25 }]);
const oversizedBody = "[]".padEnd(1_048_577);

let workerId = 0;

async function openWorker({ state = "OPEN", result = {} } = {}) {
  let receive;
  let navigate;
  const routed = [];
  const event = { addListener() {} };
  globalThis.chrome = {
    runtime: {
      id: runtimeId,
      getURL: (path) => `${extensionUrl}${path}`,
      onMessage: { addListener: (listener) => (receive = listener) },
      onConnect: event,
    },
    tabs: {
      onRemoved: event,
      async sendMessage(...args) {
        routed.push(args);
        return { ok: true };
      },
    },
    webNavigation: {
      onCommitted: { addListener: (listener) => (navigate = listener) },
    },
  };
  await import(`../src/capture/background.js?mock-bridge=${++workerId}`);

  function send(message, sender = panel) {
    let response;
    let resolve;
    const reply = new Promise((callback) => (resolve = callback));
    const asynchronous = receive(message, sender, (value) => {
      response = value;
      resolve(value);
    });
    return asynchronous ? reply : response;
  }

  send(
    {
      type: "ws-event",
      payload: {
        id: arm.socketId,
        state,
        protocol: "wamp.2.json",
        eventType: "open",
      },
    },
    frame,
  );
  send(
    {
      type: "ws-message",
      payload: {
        socketId: arm.socketId,
        messageId: arm.callMessageId,
        direction: "sent",
        parsed: [48, 34, {}, "demo.read"],
      },
    },
    frame,
  );
  send(
    {
      type: "ws-message",
      payload: {
        socketId: arm.socketId,
        messageId: arm.resultMessageId,
        direction: "received",
        parsed: [50, 34, {}, ["sample"]],
        ...result,
      },
    },
    frame,
  );
  return { routed, send, navigate };
}

test("only the panel can arm a retained CALL and RESULT in the selected document", async (t) => {
  t.after(() => delete globalThis.chrome);
  const { routed, send } = await openWorker();
  for (const [message, sender] of [
    [arm, { ...panel, id: "other-extension" }],
    [arm, { ...panel, url: `${extensionUrl}src/popup/popup.html` }],
    [{ ...arm, documentId: "other-document" }, panel],
    [{ ...arm, frameId: frame.frameId + 1 }, panel],
    [{ ...arm, resultMessageId: 999 }, panel],
    [{ ...arm, callMessageId: "11" }, panel],
    [{ ...arm, resultBody: [[], {}] }, panel],
    [{ ...arm, resultBody: oversizedBody }, panel],
  ]) {
    assert.deepEqual(await send(message, sender), { ok: false });
  }
  assert.deepEqual(routed, []);

  assert.deepEqual(await send({ ...arm, payload: [50, 1, {}, []] }), {
    ok: true,
  });
  assert.deepEqual(await send({ ...arm, resultBody }), { ok: true });
  assert.deepEqual(routed, [
    [frame.tab.id, instruction, { documentId: frame.documentId }],
    [
      frame.tab.id,
      { ...instruction, resultBody },
      { documentId: frame.documentId },
    ],
  ]);

  chrome.tabs.sendMessage = async () => {
    throw new Error("Document no longer exists");
  };
  assert.deepEqual(await send(arm), { ok: false });
});

test("the worker rejects closed connections, unrelated, progressive, and mocked replies", async (t) => {
  t.after(() => delete globalThis.chrome);
  for (const options of [
    { state: "CLOSED" },
    { result: { parsed: [50, 35, {}, []] } },
    { result: { parsed: [50, 34, { progress: true }, []] } },
    { result: { mocked: true } },
  ]) {
    const { routed, send } = await openWorker(options);
    assert.deepEqual(await send(arm), { ok: false });
    assert.deepEqual(routed, []);
  }
});

test("retains only accepted mock configurations and only exposes them to the panel", async (t) => {
  t.after(() => delete globalThis.chrome);
  const { send } = await openWorker();
  assert.deepEqual(send(getSaved), { saved: null });
  assert.deepEqual(await send(arm), { ok: true });
  assert.deepEqual(send(getSaved), { saved: { resultBody: null } });
  assert.deepEqual(await send({ ...arm, resultBody }), { ok: true });
  assert.deepEqual(send(getSaved), { saved: { resultBody } });

  chrome.tabs.sendMessage = async () => ({ ok: false });
  assert.deepEqual(await send({ ...arm, resultBody: "[]" }), { ok: false });
  assert.deepEqual(send(getSaved), { saved: { resultBody } });
  for (const [request, sender] of [
    [getSaved, { ...panel, id: "different-extension" }],
    [getSaved, { ...panel, url: `${extensionUrl}src/popup/popup.html` }],
    [{ ...getSaved, tabId: arm.tabId + 1 }, panel],
    [{ ...getSaved, frameId: arm.frameId + 1 }, panel],
    [{ ...getSaved, socketId: arm.socketId + 1 }, panel],
    [{ ...getSaved, documentId: "different-document" }, panel],
    [{ ...getSaved, resultMessageId: 999 }, panel],
  ]) {
    assert.deepEqual(send(request, sender), { saved: null });
  }

  send(
    {
      type: "ws-event",
      payload: { id: arm.socketId, state: "CLOSED", eventType: "close" },
    },
    frame,
  );
  assert.deepEqual(send(getSaved), { saved: { resultBody } });
  const { socket } = send({ ...getSaved, type: "get-socket-detail" });
  assert.equal(JSON.stringify(socket).includes("edited"), false);
});

test("pending mock acknowledgements preserve newer captures and do not outlive capture resets", async (t) => {
  t.after(() => delete globalThis.chrome);
  const { send, navigate } = await openWorker();
  const pending = [];
  chrome.tabs.sendMessage = () =>
    new Promise((resolve) => pending.push(() => resolve({ ok: true })));

  const first = send({ ...arm, resultBody: "[]" });
  const second = send({ ...arm, resultBody });
  send(
    {
      type: "ws-message",
      payload: {
        socketId: arm.socketId,
        messageId: 13,
        direction: "received",
        parsed: [36, 1, 1, {}],
        timestamp: "2026-11-23T09:00:00.000Z",
      },
    },
    frame,
  );
  pending[1]();
  assert.deepEqual(await second, { ok: true });
  pending[0]();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(send(getSaved), { saved: { resultBody } });
  assert.equal(
    send({ ...getSaved, type: "get-socket-detail" }).socket.lastMessageAt,
    "2026-11-23T09:00:00.000Z",
  );

  const stale = send(arm);
  navigate({
    tabId: arm.tabId,
    frameId: arm.frameId,
    documentId: "new-document",
  });
  assert.deepEqual(send(getSaved), { saved: null });
  pending[2]();
  assert.deepEqual(await stale, { ok: true });
  assert.deepEqual(send(getSaved), { saved: null });

  const { send: sendFresh } = await openWorker();
  assert.deepEqual(await sendFresh({ ...arm, resultBody }), { ok: true });
  const freshAck = Promise.withResolvers();
  chrome.tabs.sendMessage = () => freshAck.promise;
  const pendingClear = sendFresh(arm);
  sendFresh({ type: "clear-messages", tabId: arm.tabId });
  assert.deepEqual(sendFresh(getSaved), { saved: null });
  freshAck.resolve({ ok: true });
  assert.deepEqual(await pendingClear, { ok: true });
  assert.deepEqual(sendFresh(getSaved), { saved: null });
});

test("saved configurations stay bounded by count and body size within a socket", async (t) => {
  t.after(() => delete globalThis.chrome);
  const { send } = await openWorker();

  async function saveSample(requestId, configuredBody) {
    const callMessageId = requestId * 2 + arm.resultMessageId;
    const resultMessageId = callMessageId + 1;
    const source = { callMessageId, resultMessageId };
    for (const [messageId, direction, parsed] of [
      [callMessageId, "sent", [48, requestId, {}, "demo.read"]],
      [resultMessageId, "received", [50, requestId, {}, ["sample"]]],
    ]) {
      send(
        {
          type: "ws-message",
          payload: { socketId: arm.socketId, messageId, direction, parsed },
        },
        frame,
      );
    }
    assert.deepEqual(
      await send({ ...arm, ...source, resultBody: configuredBody }),
      { ok: true },
    );
    return { ...getSaved, ...source };
  }

  assert.deepEqual(await send(arm), { ok: true });
  let latest;
  for (let index = 1; index <= 64; index++) latest = await saveSample(index);
  assert.deepEqual(send(getSaved), { saved: null });
  assert.deepEqual(send(latest), { saved: { resultBody: null } });

  const fullBody = JSON.stringify([["x".repeat(1_048_570)]]);
  const oldestLarge = await saveSample(65, fullBody);
  for (let index = 66; index <= 69; index++)
    latest = await saveSample(index, fullBody);
  assert.deepEqual(send(oldestLarge), { saved: null });
  assert.equal(send(latest).saved.resultBody.length, fullBody.length);
});

test("the worker publishes armed source changes and clears them on navigation", async (t) => {
  t.after(() => delete globalThis.chrome);
  const { send, navigate } = await openWorker();
  const reportSource = (mockSourceMessageId, sender = frame) =>
    send(
      {
        type: "ws-event",
        payload: {
          id: arm.socketId,
          eventType: "mock-state",
          mockSourceMessageId,
        },
      },
      sender,
    );
  const detail = () =>
    send({
      type: "get-socket-detail",
      tabId: arm.tabId,
      socketId: arm.socketId,
      frameId: arm.frameId,
      documentId: arm.documentId,
    }).socket;

  assert.deepEqual(reportSource(arm.callMessageId), { ok: true });
  assert.equal(detail().mockSourceMessageId, arm.callMessageId);
  assert.equal(detail().eventType, "open");
  const { sockets } = send({ type: "get-sockets", tabId: arm.tabId });
  assert.equal(sockets[0].mockSourceMessageId, arm.callMessageId);
  assert.deepEqual(reportSource(-1), { ok: false });
  assert.deepEqual(reportSource(999, { ...frame, documentId: "other" }), {
    ok: false,
  });
  assert.equal(detail().mockSourceMessageId, arm.callMessageId);

  assert.deepEqual(reportSource(null), { ok: true });
  assert.equal(detail().mockSourceMessageId, null);
  reportSource(arm.callMessageId);
  navigate({
    tabId: arm.tabId,
    frameId: arm.frameId,
    documentId: "new-document",
  });
  assert.equal(detail().state, "CLOSED");
  assert.equal(detail().mockSourceMessageId, null);
  assert.deepEqual(reportSource(arm.callMessageId), { ok: false });
});

test("the content script sends capture IDs and optional edited body on its detached channel", () => {
  const window = new EventTarget();
  const document = new EventTarget();
  const mockChannel = new EventTarget();
  const commands = [];
  let receive;
  const filename = fileURLToPath(
    new URL("../src/capture/content-script.js", import.meta.url),
  );
  runInNewContext(
    readFileSync(filename, "utf8"),
    {
      window,
      document,
      CustomEvent,
      chrome: {
        runtime: {
          id: runtimeId,
          onMessage: { addListener: (listener) => (receive = listener) },
        },
      },
    },
    { filename },
  );

  function send(message = instruction, sender = { id: runtimeId }) {
    let response;
    receive(message, sender, (value) => (response = structuredClone(value)));
    return response;
  }

  assert.deepEqual(send(), { ok: false });
  const connect = new Event("wamp-inspector:mock-channel");
  Object.defineProperty(connect, "relatedTarget", { value: mockChannel });
  document.dispatchEvent(connect);
  assert.deepEqual(send(), { ok: false });

  mockChannel.addEventListener("wamp-inspector:arm", (event) => {
    commands.push(JSON.parse(event.detail));
    event.preventDefault();
  });
  assert.equal(send(instruction, { id: "different-extension" }), undefined);
  assert.equal(send(instruction, { id: runtimeId, tab: frame.tab }), undefined);
  assert.deepEqual(send({ ...instruction, resultMessageId: -1 }), {
    ok: false,
  });
  assert.deepEqual(send({ ...instruction, resultBody: [[], {}] }), {
    ok: false,
  });
  assert.deepEqual(send({ ...instruction, resultBody: oversizedBody }), {
    ok: false,
  });
  assert.deepEqual(send({ ...instruction, payload: ["injected"] }), {
    ok: true,
  });
  assert.deepEqual(send({ ...instruction, resultBody }), { ok: true });
  assert.deepEqual(commands, [
    [arm.socketId, arm.callMessageId, arm.resultMessageId],
    [arm.socketId, arm.callMessageId, arm.resultMessageId, resultBody],
  ]);
});
