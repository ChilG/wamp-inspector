import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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

function setup(send = async () => {}) {
  const listeners = new Set();
  const warnings = [];
  let receiveRuntimeMessage;
  const window = {
    addEventListener(_event, listener) {
      listeners.add(listener);
    },
    removeEventListener(_event, listener) {
      listeners.delete(listener);
    },
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: send,
      onMessage: {
        addListener(listener) {
          receiveRuntimeMessage = listener;
        },
      },
    },
  };
  runInNewContext(
    script,
    { window, chrome, console: { warn: (...args) => warnings.push(args) } },
    { filename },
  );
  return {
    chrome,
    listeners,
    warnings,
    async deliver(message = data, source = window) {
      await Promise.all(
        [...listeners].map((listener) => listener({ data: message, source })),
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
