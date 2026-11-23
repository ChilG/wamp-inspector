import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { bindMockSender } from "../src/devtools/panel-mock.js";

function setup() {
  const controls = {
    trigger: { hidden: true },
    popover: {
      open: false,
      matches() {
        return this.open;
      },
      hidePopover() {
        this.open = false;
      },
    },
    form: new EventTarget(),
    scenario: { value: "demo.success" },
    send: { disabled: false },
    status: { textContent: "" },
  };
  const evaluations = [];
  const setPage = bindMockSender(controls, {
    eval(expression, callback) {
      evaluations.push({ expression, callback });
    },
  });
  const submit = () =>
    controls.form.dispatchEvent(new Event("submit", { cancelable: true }));
  return { ...controls, evaluations, setPage, submit };
}

test("sends the selected mock through the inspected loopback demo", () => {
  const { trigger, send, status, setPage, submit, scenario, evaluations } =
    setup();
  setPage("http://127.0.0.1:8765/");
  assert.equal(trigger.hidden, false);
  scenario.value = "demo.error";
  assert.equal(submit(), false);
  submit();
  assert.equal(evaluations.length, 1);
  assert.equal(send.disabled, true);

  const sent = [];
  const response = runInNewContext(evaluations[0].expression, {
    location: new URL("http://127.0.0.1:8765/"),
    window: {
      wampInspectorMockDemo: {
        sendCall(procedure) {
          sent.push(procedure);
          return { status: "sent", requestId: 5 };
        },
      },
    },
  });
  evaluations[0].callback(response);
  assert.deepEqual(sent, ["demo.error"]);
  assert.equal(status.textContent, "CALL #5 sent. See the capture below.");
  assert.equal(send.disabled, false);
});

test("requires the loopback demo at submission time and rejects unknown scenarios", () => {
  const { trigger, evaluations, setPage, status, submit, scenario } = setup();
  setPage("https://example.com/");
  submit();
  assert.equal(trigger.hidden, true);
  assert.equal(evaluations.length, 0);

  setPage("http://127.0.0.1:8765/");
  scenario.value = "arbitrary.procedure";
  submit();
  assert.equal(evaluations.length, 0);
  assert.match(status.textContent, /scenario/i);

  scenario.value = "demo.success";
  submit();
  let calls = 0;
  const window = {
    wampInspectorMockDemo: {
      sendCall() {
        calls++;
      },
    },
  };
  for (const url of [
    "https://example.com/",
    "https://127.0.0.1/",
    "http://127.0.0.1/other",
  ]) {
    const reply = runInNewContext(evaluations[0].expression, {
      location: new URL(url),
      window,
    });
    assert.equal(reply.status, "unavailable");
  }
  assert.equal(calls, 0);
  evaluations[0].callback(
    runInNewContext(evaluations[0].expression, {
      location: new URL("http://127.0.0.1:8765/"),
      window: {},
    }),
  );
  assert.match(status.textContent, /mock demo/i);
});

test("reports busy or disconnected sessions and resets on navigation", () => {
  const { popover, status, setPage, submit, evaluations, send } = setup();
  setPage("http://127.0.0.1:8765/");
  submit();
  evaluations[0].callback({ status: "busy" });
  assert.match(status.textContent, /already waiting/i);

  submit();
  evaluations[1].callback({ status: "not_connected" });
  assert.match(status.textContent, /not connected/i);

  submit();
  popover.open = true;
  setPage("https://example.com/");
  evaluations[2].callback({ status: "sent", requestId: 9 });
  assert.equal(popover.open, false);
  assert.equal(status.textContent, "");
  assert.equal(send.disabled, false);
});

test("restores the send control when Chrome cannot evaluate the request", () => {
  const { status, setPage, submit, evaluations, send } = setup();
  setPage("http://127.0.0.1:8765/");
  submit();
  evaluations[0].callback(undefined, { isError: true });
  assert.match(status.textContent, /unable to send/i);
  assert.equal(send.disabled, false);
});
