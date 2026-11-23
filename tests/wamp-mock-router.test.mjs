import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { startMockRouter } from "../tools/mock-wamp/server.mjs";
import {
  isMockProcedure,
  isMockResponse,
  isMockTopic,
} from "../src/shared/wamp-mock-response.js";
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

async function mockSession(router) {
  const socket = await connect(router);
  const [, , details] = await exchange(socket, [
    1,
    "demo",
    { roles: { caller: {} } },
  ]);
  return { socket, token: details.x_mock_control };
}

function setMock(router, rule, origin = router.origin) {
  return fetch(router.origin + "/mock-response", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(rule),
  });
}

function call(id, procedure, topic = null) {
  const frame = [48, id, {}, procedure];
  return topic === null ? frame : [...frame, [], { topic }];
}

test("validates final WAMP mock response frames and their selectors", () => {
  assert.equal(isMockProcedure("/sports#initialDump"), true);
  assert.equal(isMockProcedure(" "), false);
  assert.equal(isMockTopic(null), true);
  assert.equal(isMockTopic("sports.football"), true);
  assert.equal(isMockTopic("a".repeat(513)), false);
  assert.equal(isMockTopic([]), false);

  for (const response of [
    null,
    [50, 0, {}],
    [50, 9, { progress: false }, [], { sample: true }],
    [8, 48, 22, {}, "demo.error", [], { sample: true }],
  ]) {
    assert.equal(isMockResponse(response), true, JSON.stringify(response));
  }
  for (const response of [
    {},
    [50, 1, { progress: true }],
    [50, 1, {}, {}],
    [50, 1, {}, [], []],
    [50, -1, {}],
    [8, 32, 1, {}, "demo.error"],
    [8, 48, 1, {}, ""],
    [48, 1, {}, "demo.success"],
  ]) {
    assert.equal(isMockResponse(response), false, JSON.stringify(response));
  }
});

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

test(
  "replaces one response on the selected session, procedure, and topic",
  { timeout: 5000 },
  async (t) => {
    const router = await routerFor(t);
    const { socket, token } = await mockSession(router);
    const other = await mockSession(router);
    assert.equal(typeof token, "string");
    assert.notEqual(token, other.token);

    const procedure = "demo.success";
    const extensionOrigin = "chrome-extension://" + "a".repeat(32);
    const rule = {
      token,
      procedure,
      topic: "football",
      response: [50, 90, {}, ["Football"]],
    };
    const installed = await setMock(router, rule, extensionOrigin);
    assert.equal(installed.status, 204);
    assert.equal(
      installed.headers.get("access-control-allow-origin"),
      extensionOrigin,
    );
    assert.deepEqual(await exchange(socket, call(1, procedure, "basketball")), [
      50,
      1,
      {},
      ["Mock result"],
    ]);
    assert.deepEqual(await exchange(socket, call(2, procedure)), [
      50,
      2,
      {},
      ["Mock result"],
    ]);
    assert.deepEqual(
      await exchange(other.socket, call(1, procedure, "football")),
      [50, 1, {}, ["Mock result"]],
    );
    assert.equal(
      (await exchange(socket, call(3, "demo.error", "football")))[0],
      8,
    );
    assert.deepEqual(await exchange(socket, call(4, procedure, "football")), [
      50,
      4,
      {},
      ["Football"],
    ]);
    assert.deepEqual(await exchange(socket, call(5, procedure, "football")), [
      50,
      5,
      {},
      ["Mock result"],
    ]);
  },
);

test(
  "uses the new request ID for CALL errors and can withhold a single result",
  { timeout: 5000 },
  async (t) => {
    const router = await routerFor(t);
    const { socket, token } = await mockSession(router);
    const rule = { token, procedure: "demo.success", topic: null };

    assert.equal(
      (
        await setMock(router, {
          ...rule,
          response: [8, 48, 900, {}, "demo.unavailable", [], { retry: true }],
        })
      ).status,
      204,
    );
    assert.equal(
      (await exchange(socket, call(1, "demo.success", "football")))[0],
      50,
    );
    assert.deepEqual(await exchange(socket, call(2, "demo.success")), [
      8,
      48,
      2,
      {},
      "demo.unavailable",
      [],
      { retry: true },
    ]);

    assert.equal(
      (await setMock(router, { ...rule, response: null })).status,
      204,
    );
    socket.send(JSON.stringify(call(3, "demo.success")));
    assert.deepEqual(await exchange(socket, call(4, "demo.success")), [
      50,
      4,
      {},
      ["Mock result"],
    ]);
  },
);

test(
  "rejects invalid rules, unexpected origins, and expired mock tokens",
  { timeout: 5000 },
  async (t) => {
    const router = await routerFor(t);
    const { socket, token } = await mockSession(router);
    const rule = {
      token,
      procedure: "demo.success",
      topic: null,
      response: [50, 1, {}],
    };

    assert.equal(
      (await setMock(router, rule, "https://example.invalid")).status,
      403,
    );
    assert.equal(
      (await setMock(router, { ...rule, token: "bad" })).status,
      404,
    );
    assert.equal((await setMock(router, { ...rule, topic: "" })).status, 400);
    assert.equal(
      (
        await setMock(router, {
          ...rule,
          response: [50, 1, { progress: true }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await setMock(router, {
          ...rule,
          response: [50, 1, {}, ["a".repeat(33 * 1024)]],
        })
      ).status,
      413,
    );
    assert.deepEqual(await exchange(socket, call(1, "demo.success")), [
      50,
      1,
      {},
      ["Mock result"],
    ]);

    const closed = once(socket, "close");
    await exchange(socket, [6, {}, "wamp.close.normal"]);
    await closed;
    assert.equal((await setMock(router, rule)).status, 404);
  },
);
