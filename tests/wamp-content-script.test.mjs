import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const filename = fileURLToPath(
  new URL("../src/capture/content-script.js", import.meta.url),
);
const script = readFileSync(filename, "utf8");
const data = {
  source: "wamp-inspector",
  type: "ws-message",
  payload: { socketId: 1 },
};
const reloadRule = {
  token: "reload-rule",
  endpoint: "ws://fixture.invalid/socket",
  procedure: "fixture.read",
  topic: "fixture.topic",
  resultBody: "[[42]]",
};

function setup(
  send = async () => {},
  lookup = async () => ({ rules: [] }),
  initializeWindow = () => {},
  schedule = setTimeout,
) {
  const listeners = new Set();
  const warnings = [];
  const document = new EventTarget();
  const mockChannel = new EventTarget();
  let receiveRuntimeMessage;
  const window = {
    addEventListener(_event, listener) {
      listeners.add(listener);
    },
    removeEventListener(_event, listener) {
      listeners.delete(listener);
    },
  };
  initializeWindow(window);
  const chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: (message) =>
        message.type === "get-reload-mock" ? lookup(message) : send(message),
      onMessage: {
        addListener(listener) {
          receiveRuntimeMessage = listener;
        },
      },
    },
  };
  runInNewContext(
    script,
    {
      window,
      document,
      CustomEvent,
      setTimeout: schedule,
      chrome,
      console: { warn: (...args) => warnings.push(args) },
    },
    { filename },
  );
  const connect = new Event("wamp-inspector:mock-channel");
  Object.defineProperty(connect, "relatedTarget", { value: mockChannel });
  document.dispatchEvent(connect);
  return {
    chrome,
    listeners,
    mockChannel,
    warnings,
    async deliver(message = data, source = window) {
      await Promise.all(
        [...listeners].map((listener) => listener({ data: message, source })),
      );
    },
    deliverMockState(status) {
      mockChannel.dispatchEvent(
        new CustomEvent("wamp-inspector:mock-state", {
          detail: JSON.stringify(status),
        }),
      );
    },
    request(message, sender = { id: chrome.runtime.id }) {
      let response;
      receiveRuntimeMessage?.(message, sender, (value) => {
        response = structuredClone(value);
      });
      return response;
    },
  };
}

test("requests the pending reload mock during channel handoff and restores it privately", async () => {
  const requests = [];
  const restores = [];
  const bridge = setup(undefined, async (message) => {
    requests.push(structuredClone(message));
    return { rules: [reloadRule] };
  });
  bridge.mockChannel.addEventListener(
    "wamp-inspector:restore-mock",
    (event) => {
      restores.push(JSON.parse(event.detail));
    },
  );
  assert.deepEqual(requests, [{ type: "get-reload-mock" }]);
  await setImmediate();
  assert.deepEqual(restores, [reloadRule]);
});

test("restores the one-shot before all persistent rules and acknowledges each accepted rule", async () => {
  const enabled = {
    ...reloadRule,
    token: "enabled",
    persistent: { enabled: true, revision: 2 },
  };
  const disabled = {
    ...enabled,
    token: "disabled",
    persistent: { enabled: false, revision: 1 },
  };
  const restores = [];
  const messages = [];
  const bridge = setup(
    async (message) => messages.push(structuredClone(message)),
    async () => ({ rules: [enabled, reloadRule, disabled] }),
  );
  bridge.mockChannel.addEventListener(
    "wamp-inspector:restore-mock",
    (event) => {
      restores.push(JSON.parse(event.detail));
      event.preventDefault();
    },
  );
  await setImmediate();
  assert.deepEqual(restores, [reloadRule, enabled, disabled]);
  assert.deepEqual(messages, [
    { type: "mock-reload-readiness", token: reloadRule.token, ready: true },
    {
      type: "mock-reload-readiness",
      token: enabled.token,
      ready: true,
      revision: 2,
    },
    {
      type: "mock-reload-readiness",
      token: disabled.token,
      ready: false,
      revision: 1,
    },
  ]);
});

test("retries a provisional decline and acknowledges only the rule accepted by the hook", async () => {
  const requests = [];
  const restores = [];
  const messages = [];
  const timers = [];
  const bridge = setup(
    async (message) => messages.push(structuredClone(message)),
    async (message) => {
      requests.push(structuredClone(message));
      return requests.length === 1
        ? { rules: [], retry: true }
        : { rules: [reloadRule] };
    },
    undefined,
    (callback) => timers.push(callback),
  );
  bridge.mockChannel.addEventListener(
    "wamp-inspector:restore-mock",
    (event) => {
      restores.push(JSON.parse(event.detail));
      event.preventDefault();
    },
  );
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.deepEqual(restores, []);
  assert.equal(timers.length, 1);

  timers.shift()();
  await setImmediate();
  assert.equal(requests.length, 2);
  assert.deepEqual(restores, [reloadRule]);
  assert.deepEqual(messages, [
    { type: "mock-reload-readiness", token: reloadRule.token, ready: true },
  ]);
  bridge.mockChannel.dispatchEvent(
    new CustomEvent("wamp-inspector:reload-detached", {
      detail: reloadRule.token,
    }),
  );
  assert.deepEqual(messages.at(-1), {
    type: "mock-reload-readiness",
    token: reloadRule.token,
    ready: false,
  });
});

test("stops a scheduled reload retry when the extension detaches", async () => {
  let requests = 0;
  const timers = [];
  const bridge = setup(
    undefined,
    async () => {
      requests += 1;
      return { rules: [], retry: true };
    },
    undefined,
    (callback) => timers.push(callback),
  );
  await setImmediate();
  assert.equal(timers.length, 1);
  delete bridge.chrome.runtime;
  await bridge.deliver();
  timers.shift()();
  await setImmediate();
  assert.equal(requests, 1);
});

test("stops retrying after the bounded backoff without turning it into a decline", async () => {
  let requests = 0;
  const timers = [];
  const restores = [];
  const bridge = setup(
    undefined,
    async () => {
      requests += 1;
      return { rules: [], retry: true };
    },
    undefined,
    (callback) => timers.push(callback),
  );
  bridge.mockChannel.addEventListener("wamp-inspector:restore-mock", (event) =>
    restores.push(event.detail),
  );
  await setImmediate();
  while (timers.length && requests < 10) {
    timers.shift()();
    await setImmediate();
  }
  assert.equal(requests, 7);
  assert.deepEqual(restores, []);
  assert.deepEqual(timers, []);
});

test("starts lookup and forwards WebSocket traffic independently of iframe position", async () => {
  const requests = [];
  const send = async (message) => requests.push(structuredClone(message));
  const bridge = setup(send, send, (window) => {
    const top = { length: 2, 0: {}, 1: window };
    window.top = top;
    window.parent = top;
  });
  await bridge.deliver({ ...data, type: "ws-event", framePath: [9] });
  await bridge.deliver({ ...data, framePath: [9] });
  assert.deepEqual(requests, [
    { type: "get-reload-mock" },
    { type: "ws-event", payload: data.payload },
    { type: "ws-message", payload: data.payload },
  ]);
});

test("ignores a reload rule arriving after the extension channel is detached", async () => {
  const lookup = Promise.withResolvers();
  const bridge = setup(undefined, () => lookup.promise);
  const restores = [];
  bridge.mockChannel.addEventListener("wamp-inspector:restore-mock", (event) =>
    restores.push(event.detail),
  );
  delete bridge.chrome.runtime;
  await bridge.deliver();
  lookup.resolve({ rules: [reloadRule] });
  await setImmediate();
  assert.deepEqual(restores, []);
});

test("returns only the private reload rule acknowledged for the active arm token", () => {
  const bridge = setup();
  const commands = [];
  bridge.mockChannel.addEventListener("wamp-inspector:arm", (event) => {
    const command = JSON.parse(event.detail);
    commands.push(command);
    for (const token of ["wrong-token", reloadRule.token]) {
      bridge.mockChannel.dispatchEvent(
        new CustomEvent("wamp-inspector:reload-armed", {
          detail: JSON.stringify({ ...reloadRule, token }),
        }),
      );
    }
    event.preventDefault();
  });
  const request = {
    type: "arm-mock-response",
    socketId: 1,
    callMessageId: 2,
    resultMessageId: 3,
  };
  assert.deepEqual(bridge.request(request), { ok: true });
  assert.deepEqual(
    bridge.request({ ...request, reloadToken: reloadRule.token }),
    { ok: true, reload: reloadRule },
  );
  assert.deepEqual(bridge.request({ ...request, reloadToken: "" }), {
    ok: false,
  });
  assert.deepEqual(commands, [
    [1, 2, 3],
    [1, 2, 3, null, reloadRule.token],
  ]);
});

test("forwards reload consumption from the detached channel only", async () => {
  const sent = [];
  const bridge = setup(async (message) => sent.push(structuredClone(message)));
  const consumed = { type: "mock-reload-consumed", token: reloadRule.token };
  await bridge.deliver({ source: data.source, ...consumed });
  assert.deepEqual(sent, []);

  for (const token of ["", reloadRule.token]) {
    bridge.mockChannel.dispatchEvent(
      new CustomEvent("wamp-inspector:reload-consumed", { detail: token }),
    );
  }
  assert.deepEqual(sent, [consumed]);
});

test("answers the capture availability probe only from this extension", () => {
  const bridge = setup();
  assert.deepEqual(bridge.request({ type: "capture-availability" }), {
    available: true,
  });
  assert.equal(bridge.request({ type: "other" }), undefined);
  assert.equal(
    bridge.request({ type: "capture-availability" }, { id: "other-extension" }),
    undefined,
  );
});

test("forwards only allowed messages from its own window", async () => {
  const sent = [];
  const bridge = setup(async (message) =>
    sent.push(JSON.parse(JSON.stringify(message))),
  );
  await bridge.deliver(data, {});
  await bridge.deliver({ ...data, source: "other" });
  await bridge.deliver({ ...data, type: "other" });
  await bridge.deliver();
  await bridge.deliver({ ...data, type: "ws-event" });
  assert.deepEqual(sent, [
    { type: "ws-message", payload: { socketId: 1 } },
    { type: "ws-event", payload: { socketId: 1 } },
  ]);
});

test("forwards mock status from the detached channel and ignores public lookalikes", async () => {
  const sent = [];
  const bridge = setup(async (message) => sent.push(structuredClone(message)));
  const status = {
    type: "ws-event",
    payload: { id: 1, eventType: "mock-state", mockSourceMessageId: 9 },
  };
  await bridge.deliver({ source: data.source, ...status });
  assert.deepEqual(sent, []);
  bridge.deliverMockState([1, 9]);
  bridge.deliverMockState([1, null]);
  bridge.deliverMockState([1, "9"]);
  assert.deepEqual(sent, [
    status,
    { ...status, payload: { ...status.payload, mockSourceMessageId: null } },
  ]);
});

test("detaches from an open page when the extension runtime disappears", async () => {
  const bridge = setup();
  delete bridge.chrome.runtime;
  await bridge.deliver();
  assert.equal(bridge.listeners.size, 0);
  assert.equal(bridge.warnings.length, 0);
});

test("detaches when Chrome throws or rejects during invalidation", async () => {
  const invalid = new Error("Extension context invalidated.");
  for (const send of [
    () => {
      throw invalid;
    },
    () => Promise.reject(invalid),
  ]) {
    const bridge = setup(send);
    await bridge.deliver();
    await bridge.deliver();
    assert.equal(bridge.listeners.size, 0);
    assert.equal(bridge.warnings.length, 0);
  }
});

test("keeps listening after a transient send failure and limits repeated warnings", async () => {
  let fail = true;
  let forwarded = 0;
  const bridge = setup(async () => {
    if (fail) throw new Error("Could not establish connection.");
    forwarded += 1;
  });
  await bridge.deliver();
  await bridge.deliver();
  assert.equal(bridge.warnings.length, 1);
  assert.equal(bridge.listeners.size, 1);
  fail = false;
  await bridge.deliver();
  assert.equal(forwarded, 1);
  fail = true;
  await bridge.deliver();
  assert.equal(bridge.warnings.length, 2);
});
