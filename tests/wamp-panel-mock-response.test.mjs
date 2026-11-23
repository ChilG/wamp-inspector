import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { bindMockResponseEditor } from "../src/devtools/panel-mock-response.js";

const address = "http://127.0.0.1:8765/";
const token = "701460d0-6702-4e35-94dd-f7d06d40ad61";
const socket = { frameId: 0, state: "OPEN", url: "ws://127.0.0.1:8765/ws" };
const call = {
  key: "call1",
  type: "CALL",
  direction: "exchange",
  id: 7,
  topic: "matches.live",
  payload: {
    kind: "json",
    value: [48, 7, {}, "/sports#initialDump", [], { topic: "matches.live" }],
  },
  response: { kind: "json", value: [50, 7, {}, [{ score: 1 }]] },
};

function setup(request = async () => ({ ok: true, status: 204 })) {
  const dialog = Object.assign(new EventTarget(), {
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  const controls = {
    opener: Object.assign(new EventTarget(), { hidden: true }),
    dialog,
    form: new EventTarget(),
    procedure: { textContent: "" },
    topic: { textContent: "" },
    json: { value: "" },
    apply: { disabled: false },
    status: { textContent: "" },
  };
  const evaluations = [];
  const posts = [];
  const editor = bindMockResponseEditor(
    controls,
    {
      eval(expression, callback) {
        evaluations.push({ expression, callback });
      },
    },
    async (...args) => {
      posts.push(args);
      return request(...args);
    },
  );
  return {
    ...controls,
    ...editor,
    evaluations,
    posts,
    open() {
      controls.opener.dispatchEvent(new Event("click"));
    },
    submit() {
      controls.form.dispatchEvent(new Event("submit", { cancelable: true }));
    },
  };
}

test("prefills the captured reply and arms the exact procedure and topic", async () => {
  const ui = setup();
  ui.setPage(address);
  ui.setCall(socket, call);
  assert.equal(ui.opener.hidden, false);
  ui.open();
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.procedure.textContent, "/sports#initialDump");
  assert.equal(ui.topic.textContent, "matches.live");
  assert.deepEqual(JSON.parse(ui.json.value), call.response.value);

  ui.json.value = '[50, 1, {}, [{"score": 42}]]';
  ui.submit();
  const { expression, callback } = ui.evaluations[0];
  assert.equal(
    runInNewContext(expression, {
      location: new URL("https://bettom.invalid/"),
      window: {
        wampInspectorMockDemo: {
          getControlToken() {
            throw new Error("wrong page");
          },
        },
      },
    }),
    null,
  );
  callback(token);
  await new Promise(setImmediate);

  const [[url, options]] = ui.posts;
  assert.equal(url, "http://127.0.0.1:8765/mock-response");
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.deepEqual(JSON.parse(options.body), {
    token,
    procedure: "/sports#initialDump",
    topic: "matches.live",
    response: [50, 1, {}, [{ score: 42 }]],
  });
  assert.match(ui.status.textContent, /Next CALL/);
  assert.equal(ui.apply.disabled, false);
});

test("offers mocks only for the selected test WebSocket and rejects invalid JSON", () => {
  const ui = setup();
  ui.setPage("https://bettom.invalid/");
  ui.setCall(socket, call);
  assert.equal(ui.opener.hidden, true);
  ui.setPage(address);
  for (const other of [
    { ...socket, frameId: 2 },
    { ...socket, state: "CLOSED" },
    { ...socket, url: "ws://127.0.0.1:8766/ws" },
  ]) {
    ui.setCall(other, call);
    assert.equal(ui.opener.hidden, true);
  }
  ui.setCall(socket, call);
  ui.open();
  ui.json.value = '[48,1,{},"other"]';
  ui.submit();
  assert.match(ui.status.textContent, /RESULT|ERROR/);
  ui.json.value = "{invalid";
  ui.submit();
  assert.match(ui.status.textContent, /JSON/);
  assert.equal(ui.evaluations.length, 0);
});

test("navigation invalidates an apply that is waiting for the demo connection", async () => {
  const ui = setup();
  ui.setPage(address);
  ui.setCall(socket, call);
  ui.open();
  ui.submit();
  ui.setPage("http://127.0.0.1:8766/");
  ui.evaluations[0].callback(token);
  await new Promise(setImmediate);
  assert.equal(ui.posts.length, 0);
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.opener.hidden, true);
});

test("connection and HTTP errors let the same rule be retried", async () => {
  const ui = setup(async () => ({ ok: false, status: 404 }));
  ui.setPage(address);
  ui.setCall(socket, { ...call, topic: null });
  ui.open();
  assert.equal(ui.topic.textContent, "No topic");
  ui.submit();
  ui.evaluations[0].callback(null);
  await new Promise(setImmediate);
  assert.match(ui.status.textContent, /connection/i);
  ui.submit();
  ui.evaluations[1].callback(token);
  await new Promise(setImmediate);
  assert.match(ui.status.textContent, /connection/i);
  assert.equal(ui.apply.disabled, false);
});
