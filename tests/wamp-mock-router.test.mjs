import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { startMockRouter } from "../tools/mock-wamp/server.mjs";
import { WebSocket } from "ws";

const protocol = "wamp.2.json";

async function routerFor(testContext) {
  const router = await startMockRouter({ port: 0 });
  testContext.after(() => router.close());
  return {
    ...router,
    url: router.origin.replace("http:", "ws:") + "/ws",
  };
}

async function connect(router) {
  const socket = new WebSocket(router.url, protocol, { origin: router.origin });
  await once(socket, "open");
  return socket;
}

async function exchange(socket, frame) {
  const response = once(socket, "message");
  socket.send(JSON.stringify(frame));
  const [data] = await response;
  return JSON.parse(data.toString());
}

test(
  "serves the browser demo and negotiates WAMP JSON for one session",
  { timeout: 5000 },
  async (t) => {
    const router = await routerFor(t);
    const page = await fetch(router.origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.match(await page.text(), /Send CALL/);
    assert.equal((await fetch(router.origin + "/missing")).status, 404);

    const socket = await connect(router);
    assert.equal(socket.protocol, protocol);
    const welcome = await exchange(socket, [
      1,
      "demo",
      { roles: { caller: {} } },
    ]);
    assert.equal(welcome[0], 2);
    assert.ok(Number.isSafeInteger(welcome[1]));
    assert.deepEqual(welcome[2].roles, { dealer: {} });

    const closed = once(socket, "close");
    assert.deepEqual(await exchange(socket, [6, {}, "wamp.close.normal"]), [
      6,
      {},
      "wamp.close.goodbye_and_out",
    ]);
    assert.equal((await closed)[0], 1000);
  },
);

test(
  "correlates success and error and leaves the connection open when omitting a response",
  { timeout: 5000 },
  async (t) => {
    const router = await routerFor(t);
    const socket = await connect(router);
    await exchange(socket, [1, "demo", { roles: { caller: {} } }]);

    const success = await exchange(socket, [48, 1, {}, "demo.success"]);
    assert.equal(success[0], 50);
    assert.equal(success[1], 1);
    assert.deepEqual(await exchange(socket, [48, 2, {}, "demo.error"]), [
      8,
      48,
      2,
      {},
      "com.example.mock_error",
    ]);

    socket.send(JSON.stringify([48, 3, {}, "demo.no_response"]));
    const followUp = await exchange(socket, [48, 4, {}, "demo.success"]);
    assert.equal(followUp[0], 50);
    assert.equal(followUp[1], 4);
    assert.equal(socket.readyState, WebSocket.OPEN);

    assert.deepEqual(await exchange(socket, [48, 5, {}, "demo.unknown"]), [
      8,
      48,
      5,
      {},
      "wamp.error.no_such_procedure",
    ]);
  },
);

test(
  "rejects upgrades from other origins and without the WAMP subprotocol",
  { timeout: 5000 },
  async (t) => {
    const router = await routerFor(t);
    const crossOrigin = new WebSocket(router.url, protocol, {
      origin: "http://127.0.0.1:4321",
    });
    const [originError] = await once(crossOrigin, "error");
    assert.match(originError.message, /403/);

    const missingProtocol = new WebSocket(router.url, "other", {
      origin: router.origin,
    });
    const [protocolError] = await once(missingProtocol, "error");
    assert.match(protocolError.message, /400/);
  },
);

test(
  "closes malformed protocol input and continues serving a new client",
  { timeout: 5000 },
  async (t) => {
    const router = await routerFor(t);
    const malformed = await connect(router);
    const closed = once(malformed, "close");
    malformed.send("{");
    assert.equal((await closed)[0], 1002);

    const socket = await connect(router);
    assert.equal(
      (await exchange(socket, [1, "demo", { roles: { caller: {} } }]))[0],
      2,
    );
  },
);
