import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const filename = fileURLToPath(
  new URL("../tools/mock-wamp/demo.js", import.meta.url),
);
const source = readFileSync(filename, "utf8");

function setup() {
  const sent = [];
  const timers = new Map();
  const result = { textContent: "" };
  const connectionStatus = { textContent: "Connecting…" };
  const scenario = { value: "demo.success" };
  const button = { disabled: true };
  const form = new EventTarget();
  form.querySelector = () => button;
  const elements = {
    "#call-result": result,
    "#connection-status": connectionStatus,
    "#scenario": scenario,
    form,
  };
  let socket;
  let nextTimer = 0;

  class MockSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;

    constructor() {
      super();
      socket = this;
    }

    send(data) {
      if (this.failSend) throw new Error("Send failed");
      sent.push(JSON.parse(data));
    }
  }

  const window = {
    location: { host: "127.0.0.1:8765" },
    setTimeout(callback) {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  runInNewContext(
    source,
    {
      window,
      WebSocket: MockSocket,
      document: { querySelector: (selector) => elements[selector] },
    },
    { filename },
  );

  function receive(frame) {
    socket.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  return {
    button,
    form,
    result,
    scenario,
    sent,
    socket,
    timers,
    sendCall: (procedure) =>
      structuredClone(window.wampInspectorMockDemo.sendCall(procedure)),
    receive,
    connect() {
      socket.readyState = MockSocket.OPEN;
      socket.dispatchEvent(new Event("open"));
      receive([2, 101, {}]);
    },
  };
}

test("DevTools and the demo form share one WAMP session and request sequence", () => {
  const demo = setup();
  demo.connect();

  assert.deepEqual(demo.sendCall("demo.success"), {
    status: "sent",
    requestId: 1,
  });
  assert.equal(demo.button.disabled, true);
  assert.deepEqual(demo.sendCall("demo.error"), { status: "busy" });
  assert.deepEqual(demo.sent[1], [48, 1, {}, "demo.success"]);

  demo.receive([50, 1, {}, ["Mock result"]]);
  assert.equal(demo.button.disabled, false);
  assert.match(demo.result.textContent, /RESULT for request 1/);

  demo.scenario.value = "demo.error";
  demo.form.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(demo.sent[2], [48, 2, {}, "demo.error"]);
  demo.receive([8, 48, 2, {}, "com.example.mock_error"]);
  assert.match(
    demo.result.textContent,
    /com\.example\.mock_error for request 2/,
  );
});

test("only known scenarios are sent once the WAMP session and socket are open", () => {
  const demo = setup();
  assert.deepEqual(demo.sendCall("demo.success"), { status: "not_connected" });
  demo.connect();
  assert.deepEqual(demo.sendCall("app.custom"), { status: "invalid_scenario" });

  demo.socket.readyState = 2;
  assert.deepEqual(demo.sendCall("demo.success"), { status: "not_connected" });
  assert.equal(demo.sent.length, 1);
});

test("a failed send leaves the demo available to retry", () => {
  const demo = setup();
  demo.connect();
  demo.socket.failSend = true;
  assert.deepEqual(demo.sendCall("demo.success"), { status: "unavailable" });
  assert.equal(demo.timers.size, 0);
  assert.equal(demo.button.disabled, false);
  assert.match(demo.result.textContent, /Unable to send/);

  demo.socket.failSend = false;
  assert.deepEqual(demo.sendCall("demo.no_response"), {
    status: "sent",
    requestId: 1,
  });
  assert.equal(demo.scenario.value, "demo.no_response");
  assert.deepEqual(demo.sent[1], [48, 1, {}, "demo.no_response"]);
  const [timeout] = demo.timers.values();
  timeout();
  assert.equal(demo.button.disabled, false);
  assert.match(demo.result.textContent, /Timed out.*request 1/);
});

test("closing the socket clears a pending DevTools call", () => {
  const demo = setup();
  demo.connect();
  assert.equal(demo.sendCall("demo.no_response").status, "sent");

  demo.socket.readyState = 3;
  demo.socket.dispatchEvent(
    Object.assign(new Event("close"), { wasClean: true }),
  );
  assert.equal(demo.timers.size, 0);
  assert.equal(demo.button.disabled, true);
  assert.match(demo.result.textContent, /Connection closed/);
  assert.equal(demo.sendCall("demo.success").status, "not_connected");
});
