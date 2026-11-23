import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { analyzeMessages } from "../src/devtools/panel-messages.js";
import { bindMockResponse } from "../src/devtools/panel-mock-response.js";

const socket = {
  id: 3,
  tabId: 22,
  frameId: 19,
  documentId: "document-19",
  state: "OPEN",
  protocol: "wamp.2.json",
};
const frames = [
  {
    messageId: 41,
    direction: "sent",
    parsed: [48, 7, {}, "matches.snapshot", [], { topic: "matches.live" }],
  },
  {
    messageId: 43,
    direction: "received",
    parsed: [50, 7, {}, [], { score: 1 }],
  },
];

const selectCall = (reply = frames[1]) =>
  analyzeMessages([frames[0], reply]).rows[0];

function setup(arm = async () => ({ ok: true })) {
  const opener = Object.assign(new EventTarget(), {
    hidden: true,
    disabled: false,
    focus() {},
  });
  const status = { textContent: "" };
  const error = { textContent: "" };
  const body = Object.assign(new EventTarget(), {
    value: "",
    setAttribute() {},
    removeAttribute() {},
    focus() {},
  });
  const form = Object.assign(new EventTarget(), { hidden: true });
  const apply = { disabled: false };
  const enable = { disabled: false };
  const cancel = new EventTarget();
  const requests = [];
  const editing = [];
  const previews = [];
  const savedByCapture = new Map();
  const setCall = bindMockResponse(
    {
      opener,
      status,
      form,
      body,
      error,
      apply,
      enable,
      cancel,
      onEdit: (open) => editing.push(open),
      onPreview: (payload) => previews.push(payload),
    },
    async (request) => {
      const key = JSON.stringify([
        request.documentId,
        request.socketId,
        request.callMessageId,
        request.resultMessageId,
      ]);
      if (request.type === "get-mock-response")
        return { saved: savedByCapture.get(key) ?? null };
      requests.push(request);
      const reply = await arm();
      if (reply.ok)
        savedByCapture.set(key, { resultBody: request.resultBody ?? null });
      return reply;
    },
  );
  return {
    opener,
    status,
    form,
    editing,
    previews,
    body,
    cancel,
    error,
    requests,
    setCall,
    click() {
      opener.dispatchEvent(new Event("click"));
    },
    submit(persistent = false) {
      const event = new Event("submit", { cancelable: true });
      Object.defineProperty(event, "submitter", {
        value: persistent ? enable : apply,
      });
      form.dispatchEvent(event);
    },
  };
}

test("arms the captured result in its original connection and frame", async () => {
  const ui = setup();
  ui.setCall(socket, selectCall());
  assert.equal(ui.opener.hidden, false);
  assert.equal(ui.requests.length, 0);
  await setImmediate();
  ui.click();
  assert.equal(ui.form.hidden, false);
  assert.deepEqual(ui.editing, [true]);
  assert.deepEqual(JSON.parse(ui.body.value), [[], { score: 1 }]);
  assert.equal(ui.requests.length, 0);
  ui.submit();
  await setImmediate();
  assert.deepEqual(ui.requests, [
    {
      type: "arm-mock-response",
      tabId: 22,
      socketId: 3,
      frameId: 19,
      documentId: "document-19",
      callMessageId: 41,
      resultMessageId: 43,
    },
  ]);
  assert.equal(ui.form.hidden, true);
  assert.deepEqual(ui.editing, [true, false]);
  assert.equal(ui.status.textContent, "");
  ui.setCall(socket, { ...selectCall(), mockArmed: true });
  assert.match(ui.status.textContent, /Next matching CALL/);
  ui.setCall(socket, selectCall());
  assert.equal(ui.status.textContent, "");
});

test("previews applied JSON and restores it when revisiting and reapplying the same capture", async () => {
  const ui = setup();
  ui.setCall(socket, selectCall());
  await setImmediate();
  ui.click();
  ui.body.value = '[[], {"score": 9}]';
  ui.submit();
  await setImmediate();
  const expected = { kind: "json", value: [[], { score: 9 }] };
  assert.deepEqual(ui.previews.at(-1), expected);
  assert.deepEqual(selectCall().response.value, frames[1].parsed);

  ui.setCall(socket, null);
  ui.setCall(socket, selectCall());
  await setImmediate();
  assert.deepEqual(ui.previews.at(-1), expected);
  ui.click();
  assert.deepEqual(JSON.parse(ui.body.value), expected.value);
  ui.submit();
  await setImmediate();
  assert.equal(ui.requests.at(-1).resultBody, '[[], {"score": 9}]');
});

test("enables a persistent mock from the same edited RESULT preview", async () => {
  const ui = setup();
  ui.setCall(socket, selectCall());
  await setImmediate();
  ui.click();
  ui.body.value = '[[], {"score": 14}]';
  ui.submit(true);
  await setImmediate();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].persistent, true);
  assert.equal(ui.requests[0].resultBody, ui.body.value);
  assert.deepEqual(ui.previews.at(-1), {
    kind: "json",
    value: [[], { score: 14 }],
  });
  assert.equal(ui.form.hidden, true);
});

test("rejects invalid JSON and frame-shaped edits before applying a valid body", async () => {
  const ui = setup();
  ui.setCall(socket, selectCall());
  await setImmediate();
  ui.click();
  ui.body.value = "{";
  ui.submit();
  assert.match(ui.error.textContent, /valid JSON/);
  ui.body.value = "[50, 10, {}, []]";
  ui.submit();
  assert.match(ui.error.textContent, /RESULT arguments/);
  ui.body.value = "[".repeat(20_000) + "0" + "]".repeat(20_000);
  ui.submit();
  assert.match(ui.error.textContent, /deeply nested/);
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.form.hidden, false);

  ui.body.value = '[["fixture"], { "score": 7 }]';
  ui.submit();
  await setImmediate();
  assert.equal(ui.requests[0].resultBody, ui.body.value);
  assert.equal(ui.error.textContent, "");
  assert.equal(ui.form.hidden, true);
});

test("cancel discards the draft without arming the response", async () => {
  const ui = setup();
  ui.setCall(socket, selectCall());
  await setImmediate();
  ui.click();
  ui.body.value = "[]";
  ui.cancel.dispatchEvent(new Event("click"));
  assert.equal(ui.form.hidden, true);
  assert.equal(ui.requests.length, 0);
  ui.click();
  assert.deepEqual(JSON.parse(ui.body.value), [[], { score: 1 }]);
});

test("requires a genuine, final captured RESULT and an open JSON WAMP connection", () => {
  const ui = setup();
  for (const unsupported of [
    { ...socket, state: "CLOSED" },
    { ...socket, documentId: null },
    { ...socket, protocol: "wamp.2.msgpack" },
  ]) {
    ui.setCall(unsupported, selectCall());
    assert.equal(ui.opener.hidden, true);
  }
  for (const reply of [
    { ...frames[1], mocked: true },
    { ...frames[1], messageId: undefined },
    { ...frames[1], parsed: [50, 7, { progress: true }, ["partial"]] },
    { ...frames[1], parsed: [8, 48, 7, {}, "wamp.error.canceled"] },
  ]) {
    ui.setCall(socket, selectCall(reply));
    assert.equal(ui.opener.hidden, true);
  }
  ui.click();
  assert.equal(ui.requests.length, 0);
});

test("ignores an acknowledgement that belongs to a different selection", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const ui = setup(() => promise);
  ui.setCall(socket, selectCall());
  await setImmediate();
  ui.click();
  ui.submit();
  assert.equal(ui.opener.disabled, true);
  ui.setCall({ ...socket, documentId: "other-document" }, selectCall());
  resolve({ ok: true });
  await setImmediate();
  assert.equal(ui.form.hidden, true);
  assert.equal(ui.status.textContent, "");
  assert.equal(ui.opener.disabled, false);
});

test("reports when the selected result cannot be armed", async () => {
  const ui = setup(async () => ({ ok: false }));
  ui.setCall(socket, selectCall());
  await setImmediate();
  ui.click();
  ui.submit();
  await setImmediate();
  assert.match(ui.error.textContent, /Capture a fresh RESULT/);
  assert.equal(ui.form.hidden, false);
  assert.equal(ui.opener.disabled, false);
});
