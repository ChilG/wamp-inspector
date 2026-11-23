import assert from "node:assert/strict";
import { test } from "node:test";
import { bindMcpSharing } from "../src/devtools/panel-mcp-sharing.js";

function setup(t, grant = async () => true) {
  const button = new EventTarget();
  const status = { textContent: "" };
  const page = new EventTarget();
  const ports = [];
  const sent = [];
  const nativePorts = [];
  function mountNativeBridge(pageWindow, onMessage, onDisconnect) {
    assert.equal(pageWindow, page);
    const native = {
      receive: onMessage,
      onDisconnect,
      sent: [],
      send(message) {
        native.sent.push(message);
      },
      close() {
        assert.equal(native.closed, undefined);
        native.closed = true;
      },
    };
    nativePorts.push(native);
    return native;
  }
  t.mock.method(console, "warn", () => {});
  const api = {
    permissions: { request: grant },
    runtime: {
      connect(options) {
        assert.deepEqual(options, { name: "wamp-mcp-share" });
        const port = {
          onMessage: { addListener: (listener) => (port.receive = listener) },
          onDisconnect: {
            addListener: (listener) => (port.onClose = listener),
          },
          postMessage: (message) => sent.push(message),
          disconnect() {
            assert.equal(port.closed, undefined);
            port.closed = true;
            port.onClose();
          },
        };
        ports.push(port);
        return port;
      },
    },
  };
  bindMcpSharing(button, status, 19, api, page, mountNativeBridge);
  return { button, status, page, ports, sent, nativePorts };
}

test("requests permission on click, shares only the inspected tab and can stop", async (t) => {
  const permissions = [];
  const { button, status, ports, sent, nativePorts } = setup(
    t,
    async (request) => {
      permissions.push(request);
      return true;
    },
  );
  assert.equal(button.textContent, "Share with MCP");
  assert.deepEqual(permissions, []);

  button.dispatchEvent(new Event("click"));
  await Promise.resolve();
  assert.deepEqual(permissions, [{ permissions: ["nativeMessaging"] }]);
  assert.deepEqual(sent, [{ type: "share", tabId: 19 }]);
  assert.match(status.textContent, /Connecting/);
  assert.equal(nativePorts.length, 0);

  ports[0].receive({ type: "mcp-share-status", state: "connecting" });
  assert.equal(nativePorts.length, 1);
  nativePorts[0].receive({ type: "ready" });
  assert.deepEqual(sent.at(-1), {
    type: "native-message",
    message: { type: "ready" },
  });
  nativePorts[0].onDisconnect(true);
  assert.deepEqual(sent.at(-1), {
    type: "native-disconnected",
    hadError: true,
  });
  ports[0].receive({ type: "native-response", message: { id: "test" } });
  assert.deepEqual(nativePorts[0].sent, [{ id: "test" }]);

  ports[0].receive({ type: "mcp-share-status", state: "sharing" });
  assert.equal(button.textContent, "Stop sharing");
  assert.match(status.textContent, /metadata/);
  button.dispatchEvent(new Event("click"));
  assert.equal(ports[0].closed, true);
  assert.equal(nativePorts[0].closed, true);
  assert.equal(button.textContent, "Share with MCP");
  assert.match(status.textContent, /stopped/i);
});

test("explains a denied permission and makes no connection", async (t) => {
  const { button, status, ports } = setup(t, async () => false);
  button.dispatchEvent(new Event("click"));
  await Promise.resolve();
  assert.equal(ports.length, 0);
  assert.match(status.textContent, /permission/i);
  assert.equal(button.disabled, false);
});

test("does not reconnect when the bridge closes or the panel is closed", async (t) => {
  const { button, status, ports, page } = setup(t);
  button.dispatchEvent(new Event("click"));
  await Promise.resolve();
  ports[0].receive({ type: "mcp-share-status", state: "sharing" });
  ports[0].onClose();
  assert.match(status.textContent, /disconnected/i);
  assert.equal(ports.length, 1);

  button.dispatchEvent(new Event("click"));
  await Promise.resolve();
  ports[1].receive({
    type: "mcp-share-status",
    state: "error",
    message: "Native host is not installed.",
  });
  assert.equal(status.textContent, "Native host is not installed.");
  assert.equal(ports[1].closed, true);
  button.dispatchEvent(new Event("click"));
  await Promise.resolve();
  page.dispatchEvent(new Event("pagehide"));
  assert.equal(ports[2].closed, true);
});

test("ignores permission resolution after the panel is closed", async (t) => {
  let resolvePermission;
  const { button, page, ports } = setup(
    t,
    () => new Promise((resolve) => (resolvePermission = resolve)),
  );
  button.dispatchEvent(new Event("click"));
  page.dispatchEvent(new Event("pagehide"));
  resolvePermission(true);
  await Promise.resolve();
  assert.equal(ports.length, 0);
});

test("opens Native Messaging in a fresh extension frame and cleans it up", async () => {
  const { mountNativeBridge } =
    await import("../src/devtools/panel-mcp-native.js");
  const frame = new EventTarget();
  const received = [];
  const sent = [];
  const disconnects = [];
  let nativeMessage;
  let nativeDisconnect;
  let connected = false;
  frame.remove = () => (frame.removed = true);
  frame.contentWindow = {
    chrome: {
      runtime: {
        lastError: undefined,
        connectNative(host) {
          assert.equal(host, "com.wamp_inspector.bridge");
          connected = true;
          return {
            onMessage: {
              addListener: (listener) => (nativeMessage = listener),
            },
            onDisconnect: {
              addListener: (listener) => (nativeDisconnect = listener),
            },
            postMessage: (message) => sent.push(message),
            disconnect: () => nativeDisconnect(),
          };
        },
      },
    },
  };
  const page = {
    document: {
      createElement(name) {
        assert.equal(name, "iframe");
        return frame;
      },
      body: { append: (element) => assert.equal(element, frame) },
    },
  };
  const bridge = mountNativeBridge(
    page,
    (message) => received.push(message),
    (hadError) => disconnects.push(hadError),
  );
  assert.equal(frame.hidden, true);
  assert.match(frame.src, /mcp-native\.html$/);
  assert.equal(connected, false);
  frame.dispatchEvent(new Event("load"));
  assert.equal(connected, true);
  nativeMessage({ type: "ready" });
  bridge.send({ id: "request-1" });
  assert.deepEqual(received, [{ type: "ready" }]);
  assert.deepEqual(sent, [{ id: "request-1" }]);
  bridge.close();
  assert.equal(frame.removed, true);
  assert.deepEqual(disconnects, []);
  nativeMessage({ type: "ready" });
  assert.equal(received.length, 1);
});
