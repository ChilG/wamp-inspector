import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const filename = fileURLToPath(
  new URL("../src/capture/hook.js", import.meta.url),
);
const script = readFileSync(filename, "utf8");

const procedure = "/fixture#initialDump";
const topic = "/fixture/scores";
const otherTopic = "/fixture/schedule";
const endpoint = "ws://fixture.invalid/wamp";
const token = "fixture-reload";

function setup(objectPrototype = {}) {
  const messages = [];
  const mockEvents = [];
  const reloadArmed = [];
  const reloadConsumed = [];
  const reloadDetached = [];
  const getDetail = Object.getOwnPropertyDescriptor(
    CustomEvent.prototype,
    "detail",
  ).get;

  class NativeWebSocket extends EventTarget {
    static OPEN = 1;
    #url;
    #protocol;

    constructor(url, protocol) {
      super();
      this.#url = new URL(url).href;
      this.#protocol = protocol;
      this.readyState = 0;
      this.sent = [];
    }

    get url() {
      return this.#url;
    }

    get protocol() {
      return this.#protocol;
    }

    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }

    send(data) {
      this.sent.push(data);
    }
  }

  const window = Object.assign(new EventTarget(), {
    WebSocket: NativeWebSocket,
    postMessage(message) {
      messages.push(structuredClone(message));
    },
  });
  const document = Object.assign(new EventTarget(), {
    createElement: () => new EventTarget(),
  });
  class FocusEvent extends Event {
    constructor(type, { relatedTarget }) {
      super(type);
      this.relatedTarget = relatedTarget;
    }
  }
  let mockChannel;
  document.addEventListener(
    "wamp-inspector:mock-channel",
    (event) => {
      mockChannel = event.relatedTarget;
      mockChannel.addEventListener("wamp-inspector:mock-state", (status) => {
        mockEvents.push(JSON.parse(getDetail.call(status)));
      });
      mockChannel.addEventListener("wamp-inspector:reload-armed", (event) => {
        reloadArmed.push(JSON.parse(getDetail.call(event)));
      });
      mockChannel.addEventListener(
        "wamp-inspector:reload-consumed",
        (event) => {
          reloadConsumed.push(getDetail.call(event));
        },
      );
      mockChannel.addEventListener("wamp-inspector:reload-detached", (event) =>
        reloadDetached.push(getDetail.call(event)),
      );
    },
    { once: true },
  );

  runInNewContext(
    `Object.assign(Object.prototype, objectPrototype);\n${script}`,
    {
      window,
      document,
      Event,
      FocusEvent,
      CustomEvent,
      structuredClone,
      objectPrototype,
    },
    { filename },
  );

  function send(
    socket,
    requestId,
    callTopic = topic,
    callProcedure = procedure,
  ) {
    socket.send(
      JSON.stringify([
        48,
        requestId,
        {},
        callProcedure,
        [],
        { topic: callTopic },
      ]),
    );
    return messages.findLast((message) => message.type === "ws-message")
      .payload;
  }

  function receive(socket, frame, { trusted = true, extensible = true } = {}) {
    const event = new MessageEvent("message", { data: JSON.stringify(frame) });
    Object.defineProperty(event, "isTrusted", { value: trusted });
    if (!extensible) Object.preventExtensions(event);
    socket.dispatchEvent(event);
    return { capture: messages.at(-1).payload, event };
  }

  function postWindowCommand(call, result) {
    const event = new MessageEvent("message", {
      data: {
        source: "wamp-inspector-control",
        type: "arm-mock-response",
        payload: {
          commandId: "page-generated",
          socketId: call.socketId,
          callMessageId: call.messageId,
          resultMessageId: result.messageId,
        },
      },
    });
    Object.defineProperty(event, "source", { value: window });
    window.dispatchEvent(event);
  }

  function arm(call, result, resultBody, reloadToken) {
    return !mockChannel.dispatchEvent(
      new CustomEvent("wamp-inspector:arm", {
        cancelable: true,
        detail: JSON.stringify([
          call.socketId,
          call.messageId,
          result.messageId,
          ...(reloadToken !== undefined
            ? [resultBody ?? null, reloadToken]
            : resultBody === undefined
              ? []
              : [resultBody]),
        ]),
      }),
    );
  }

  function restore(rule) {
    return !mockChannel.dispatchEvent(
      new CustomEvent("wamp-inspector:restore-mock", {
        cancelable: true,
        detail: JSON.stringify(rule),
      }),
    );
  }

  function pageHide({ trusted = true, persisted = true } = {}) {
    const event = new Event("pagehide");
    Object.defineProperties(event, {
      isTrusted: { value: trusted },
      persisted: { value: persisted },
    });
    window.dispatchEvent(event);
  }

  return {
    arm,
    pageHide,
    postWindowCommand,
    receive,
    restore,
    reloadArmed,
    reloadConsumed,
    reloadDetached,
    send,
    mockEvents,
    messages,
    WindowWebSocket: window.WebSocket,
  };
}

function openSocket(hook, protocol = "wamp.2.json", url = endpoint) {
  const socket = new hook.WindowWebSocket(url, protocol);
  socket.open();
  return socket;
}

function captureSample(hook, socket, requestId = 1, sampleTopic = topic) {
  const call = hook.send(socket, requestId, sampleTopic);
  const frame = [50, requestId, { sample: true }, ["sample"], { score: 10 }];
  const { capture: result } = hook.receive(socket, frame);
  return { call, result };
}

test("reports the armed sample until its matching CALL completes or the socket closes", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const first = captureSample(hook, socket);
  const other = captureSample(hook, socket, 2, otherTopic);

  assert.equal(hook.arm(first.call, first.result), true);
  assert.equal(hook.arm(other.call, first.result), false);
  assert.deepEqual(hook.mockEvents, [
    [first.call.socketId, first.call.messageId],
  ]);
  assert.equal(hook.arm(other.call, other.result), true);
  hook.send(socket, 3);
  assert.equal(
    hook.receive(socket, [50, 3, {}, ["unrelated"]]).capture.mocked,
    undefined,
  );
  hook.send(socket, 4, otherTopic);
  hook.receive(socket, [50, 4, { progress: true }, ["progress"]]);
  assert.deepEqual(hook.mockEvents.at(-1), [
    other.call.socketId,
    other.call.messageId,
  ]);
  const final = hook.receive(socket, [50, 4, {}, ["matched"]]).capture;
  assert.equal(final.mocked, true);
  assert.deepEqual(hook.mockEvents.at(-1), [other.call.socketId, null]);

  assert.equal(hook.arm(other.call, other.result), true);
  hook.send(socket, 5, otherTopic);
  hook.receive(socket, [8, 48, 5, {}, "wamp.error.runtime_error"]);
  assert.deepEqual(hook.mockEvents.at(-1), [other.call.socketId, null]);

  assert.equal(hook.arm(first.call, first.result), true);
  socket.close();
  assert.equal(hook.messages.at(-1).payload.eventType, "close");
  assert.equal(
    hook.messages.some(({ payload }) => "mockSourceMessageId" in payload),
    false,
  );
});

test("preserves an armed rule's canonical source until a genuinely terminal reply", () => {
  const hook = setup();
  const socket = openSocket(
    hook,
    "wamp.2.json",
    "WS://Fixture.Invalid:80/wamp",
  );
  const sample = captureSample(hook, socket);
  assert.equal(hook.arm(sample.call, sample.result, undefined, token), true);
  assert.deepEqual(hook.reloadArmed, [
    {
      token,
      endpoint,
      procedure,
      topic,
      resultBody: JSON.stringify(sample.result.parsed.slice(3)),
    },
  ]);
  hook.send(socket, 2);
  hook.receive(socket, [50, 2, { progress: true }, ["partial"]]);
  hook.receive(socket, [50, 2, {}, ["scripted"]], { trusted: false });
  assert.deepEqual(hook.reloadConsumed, []);
  const error = [8, 48, 2, {}, "wamp.error.fixture"];
  assert.deepEqual(hook.receive(socket, error).capture.parsed, error);
  assert.deepEqual(hook.reloadConsumed, [token]);

  assert.equal(
    hook.arm(sample.call, sample.result, undefined, "unused-reload"),
    true,
  );
  hook.send(socket, 3);
  socket.close();
  assert.deepEqual(hook.reloadConsumed, [token]);
  assert.deepEqual(hook.reloadDetached, ["unused-reload"]);
  assert.equal(
    hook.messages.some(
      ({ payload }) => "token" in payload || "resultBody" in payload,
    ),
    false,
  );
});

test("a persistent mock substitutes matching results until disabled and ignores older enable messages", () => {
  const hook = setup();
  const socket = openSocket(hook, "wamp.2.json", `${endpoint}/replacement`);
  const rule = {
    token,
    endpoint,
    procedure,
    topic,
    resultBody: '[["mock"]]',
    persistent: { enabled: true, revision: 0 },
  };
  assert.equal(hook.restore(rule), true);
  for (const id of [1, 2]) {
    hook.send(socket, id);
    const details = { live: id };
    assert.deepEqual(
      hook.receive(socket, [50, id, details, ["wire"]]).capture.parsed,
      [50, id, details, ["mock"]],
    );
  }
  hook.send(socket, 3);
  assert.equal(
    hook.restore({ ...rule, persistent: { enabled: false, revision: 1 } }),
    true,
  );
  assert.equal(hook.restore(rule), false);
  assert.deepEqual(hook.receive(socket, [50, 3, {}, ["wire"]]).capture.parsed, [
    50,
    3,
    {},
    ["wire"],
  ]);
  assert.deepEqual(hook.reloadConsumed, []);
});

function persistentMock(overrides = {}) {
  return {
    token,
    endpoint,
    procedure,
    topic,
    resultBody: '[["scores"]]',
    persistent: { enabled: true, revision: 0 },
    ...overrides,
  };
}

test("keeps multiple persistent mocks active and toggles each token independently", () => {
  const hook = setup();
  const scores = openSocket(hook);
  const schedule = openSocket(hook, "wamp.2.json", `${endpoint}/replacement`);
  const scoresRule = persistentMock();
  const scheduleRule = persistentMock({
    token: "fixture-schedule",
    topic: otherTopic,
    resultBody: '[["schedule"]]',
  });
  assert.equal(hook.restore(scoresRule), true);
  assert.equal(hook.restore(scheduleRule), true);
  hook.send(scores, 7);
  hook.send(schedule, 7, otherTopic);
  for (const [socket, label] of [
    [schedule, "schedule"],
    [scores, "scores"],
  ]) {
    const details = { live: label };
    const expected = [50, 7, details, [label]];
    const { capture, event } = hook.receive(socket, [50, 7, details, ["wire"]]);
    assert.deepEqual(capture.parsed, expected);
    assert.deepEqual(JSON.parse(event.data), expected);
  }

  assert.equal(
    hook.restore({
      ...scheduleRule,
      persistent: { enabled: false, revision: 1 },
    }),
    true,
  );
  hook.send(schedule, 8, otherTopic);
  hook.send(schedule, 9);
  const original = [50, 8, {}, ["wire"]];
  assert.deepEqual(hook.receive(schedule, original).capture.parsed, original);
  assert.deepEqual(
    hook.receive(schedule, [50, 9, {}, ["wire"]]).capture.parsed,
    [50, 9, {}, ["scores"]],
  );
});

test("disabling a replaced persistent token keeps the current rule for its pair", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const previous = persistentMock();
  assert.equal(hook.restore(previous), true);
  assert.equal(
    hook.restore(
      persistentMock({ token: "replacement", resultBody: '[["new"]]' }),
    ),
    true,
  );
  assert.equal(
    hook.restore({ ...previous, persistent: { enabled: false, revision: 1 } }),
    true,
  );
  assert.equal(hook.restore(previous), false);
  hook.send(socket, 8);
  assert.deepEqual(hook.receive(socket, [50, 8, {}, ["wire"]]).capture.parsed, [
    50,
    8,
    {},
    ["new"],
  ]);
});

test("a trusted BFCache navigation clears every persistent rule and blocks stale updates", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const first = persistentMock();
  const second = persistentMock({
    token: "fixture-schedule",
    topic: otherTopic,
  });
  assert.equal(hook.restore(first), true);
  assert.equal(hook.restore(second), true);
  hook.pageHide({ trusted: false });
  hook.send(socket, 1);
  assert.equal(
    hook.receive(socket, [50, 1, {}, ["wire"]]).capture.mocked,
    true,
  );

  hook.pageHide();
  assert.equal(hook.restore(first), false);
  assert.equal(hook.restore(second), false);
  for (const [id, callTopic] of [
    [2, topic],
    [3, otherTopic],
  ]) {
    hook.send(socket, id, callTopic);
    const response = [50, id, {}, ["wire"]];
    assert.deepEqual(hook.receive(socket, response).capture.parsed, response);
  }
});

test("a one-shot mock stays armed when persistent rules arrive and takes precedence once", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const oneShotToken = "fixture-one-shot";
  assert.equal(
    hook.restore({
      token: oneShotToken,
      endpoint,
      procedure,
      topic,
      resultBody: '[["once"]]',
    }),
    true,
  );
  assert.equal(hook.restore(persistentMock()), true);
  assert.equal(
    hook.restore(
      persistentMock({
        token: "different-topic",
        topic: otherTopic,
        resultBody: '[["other"]]',
      }),
    ),
    true,
  );
  for (const [id, callTopic, body] of [
    [9, otherTopic, "other"],
    [10, topic, "once"],
    [11, topic, "scores"],
  ]) {
    hook.send(socket, id, callTopic);
    assert.deepEqual(
      hook.receive(socket, [50, id, {}, ["wire"]]).capture.parsed,
      [50, id, {}, [body]],
    );
  }
  assert.deepEqual(hook.reloadConsumed, [oneShotToken]);
});

test("applies a manually armed one-shot mock to the next matching CALL on any socket", () => {
  const hook = setup();
  const source = openSocket(hook);
  const replacement = openSocket(
    hook,
    "wamp.2.json",
    `${endpoint}/replacement`,
  );
  const sample = captureSample(hook, source);
  const body = [["edited"], { score: 44 }];
  assert.equal(
    hook.arm(sample.call, sample.result, JSON.stringify(body)),
    true,
  );

  hook.send(source, 20, otherTopic);
  hook.send(replacement, 21, topic, `${procedure}.other`);
  hook.send(replacement, 20);
  const unrelatedTopic = [50, 20, {}, ["other topic"]];
  const unrelatedProcedure = [50, 21, {}, ["other procedure"]];
  assert.deepEqual(
    hook.receive(source, unrelatedTopic).capture.parsed,
    unrelatedTopic,
  );
  assert.deepEqual(
    hook.receive(replacement, unrelatedProcedure).capture.parsed,
    unrelatedProcedure,
  );

  const details = { sequence: 20 };
  const expected = [50, 20, details, ...body];
  const { capture, event } = hook.receive(replacement, [
    50,
    20,
    details,
    ["wire"],
  ]);
  assert.equal(capture.mocked, true);
  assert.deepEqual(capture.parsed, expected);
  assert.deepEqual(JSON.parse(event.data), expected);
  assert.deepEqual(hook.mockEvents.at(-1), [sample.call.socketId, null]);

  hook.send(source, 22);
  const next = [50, 22, {}, ["next matching result"]];
  assert.deepEqual(hook.receive(source, next).capture.parsed, next);
});

test("restores one rule across sockets and uses the new CALL and RESULT details", () => {
  const hook = setup();
  const rule = {
    token,
    endpoint,
    procedure,
    topic,
    resultBody: JSON.stringify([["reload"], { score: 44 }]),
  };
  assert.equal(hook.restore(rule), true);
  const unsupported = openSocket(hook, "wamp.2.msgpack");
  const socket = openSocket(hook, "wamp.2.json", `${endpoint}/replacement`);
  const competing = openSocket(hook);
  hook.send(unsupported, 1);
  assert.equal(
    hook.receive(unsupported, [50, 1, {}, ["real"]]).capture.mocked,
    undefined,
  );
  hook.send(socket, 2, otherTopic);
  hook.send(socket, 3, topic, procedure + ".other");
  for (const id of [2, 3]) {
    assert.equal(
      hook.receive(socket, [50, id, {}, ["unrelated"]]).capture.mocked,
      undefined,
    );
  }
  hook.send(socket, 4);
  hook.send(competing, 1);
  assert.equal(
    hook.receive(competing, [50, 1, {}, ["competing"]]).capture.mocked,
    undefined,
  );
  const details = { live: true };
  const { capture, event } = hook.receive(socket, [50, 4, details, ["real"]]);
  const expected = [50, 4, details, ["reload"], { score: 44 }];
  assert.equal(capture.mocked, true);
  assert.equal(event.isTrusted, true);
  assert.deepEqual(capture.parsed, expected);
  assert.deepEqual(JSON.parse(event.data), expected);
  assert.deepEqual(hook.reloadConsumed, [token]);
  assert.equal(hook.restore(rule), false);
  hook.send(competing, 2);
  assert.equal(
    hook.receive(competing, [50, 2, {}, ["after"]]).capture.mocked,
    undefined,
  );
  assert.deepEqual(
    socket.sent.map((rawText) => JSON.parse(rawText)[1]),
    [2, 3, 4],
  );
});

test("restores onto the earliest matching pending CALL even when it was already sent", () => {
  const hook = setup();
  const newer = openSocket(hook);
  const earlier = openSocket(hook);
  hook.send(earlier, 1);
  hook.send(newer, 1);
  const rule = { token, endpoint, procedure, topic, resultBody: "[]" };
  assert.equal(hook.restore({ ...rule, resultBody: "[[], []]" }), false);
  assert.equal(hook.restore(rule), true);
  const reply = [50, 1, {}, ["genuine"]];
  assert.deepEqual(hook.receive(newer, reply).capture.parsed, reply);
  assert.deepEqual(
    hook.receive(earlier, reply).capture.parsed,
    reply.slice(0, 3),
  );
  assert.deepEqual(hook.reloadConsumed, [token]);
});

test("claims a restored one-shot without inheriting page defaults", () => {
  const hook = setup({ call: true, callSocketId: 99, onSourceChanged: true });
  const socket = openSocket(hook, "wamp.2.json", `${endpoint}/replacement`);
  const rule = { token, endpoint, procedure, topic, resultBody: "[]" };
  assert.equal(hook.restore(rule), true);
  hook.send(socket, 18);
  const reply = [50, 18, { live: true }, ["genuine"]];
  assert.deepEqual(
    hook.receive(socket, reply).capture.parsed,
    reply.slice(0, 3),
  );
  assert.deepEqual(hook.reloadConsumed, [token]);
});

test("a new manual mock replaces an unclaimed restored mock on the same endpoint", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  hook.restore({
    token,
    endpoint,
    procedure,
    topic: otherTopic,
    resultBody: "[]",
  });
  assert.equal(hook.arm(sample.call, sample.result), true);
  hook.send(socket, 2);
  assert.equal(
    hook.receive(socket, [50, 2, {}, ["real"]]).capture.mocked,
    true,
  );

  hook.send(socket, 3, otherTopic);
  const reply = [50, 3, {}, ["next"]];
  assert.deepEqual(hook.receive(socket, reply).capture.parsed, reply);
  assert.deepEqual(hook.reloadConsumed, []);
});

test("a late restore never moves a one-shot mock past a terminal startup reply", () => {
  for (const terminal of [
    [50, 1, {}, ["real startup reply"]],
    [8, 48, 1, {}, "fixture.startup_error"],
  ]) {
    const hook = setup();
    const socket = openSocket(hook);
    hook.send(socket, 1);
    assert.deepEqual(hook.receive(socket, terminal).capture.parsed, terminal);
    assert.equal(
      hook.restore(
        persistentMock({ token: "fixture-schedule", topic: otherTopic }),
      ),
      true,
    );
    assert.equal(
      hook.restore({ token, endpoint, procedure, topic, resultBody: "[[]]" }),
      false,
    );
    assert.deepEqual(hook.reloadConsumed, [token]);
    hook.send(socket, 2);
    const real = [50, 2, {}, ["another real reply"]];
    assert.deepEqual(hook.receive(socket, real).capture.parsed, real);
  }
});

test("a page window message cannot arm a captured response", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  hook.postWindowCommand(sample.call, sample.result);
  hook.send(socket, 2);
  const original = [50, 2, {}, ["real reply"]];
  assert.deepEqual(hook.receive(socket, original).capture.parsed, original);
});

test("page event overrides cannot observe the detached command target", (t) => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  const detail = Object.getOwnPropertyDescriptor(
    CustomEvent.prototype,
    "detail",
  );
  const preventDefault = Event.prototype.preventDefault;
  let observed = false;
  Object.defineProperty(CustomEvent.prototype, "detail", {
    ...detail,
    get() {
      observed = true;
      return detail.get.call(this);
    },
  });
  Event.prototype.preventDefault = function () {
    observed = true;
    return preventDefault.call(this);
  };
  t.after(() => {
    Object.defineProperty(CustomEvent.prototype, "detail", detail);
    Event.prototype.preventDefault = preventDefault;
  });
  assert.equal(hook.arm(sample.call, sample.result), true);
  assert.equal(observed, false);
});

test("reuses only the captured body on the first matching real final result", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  const deliveries = [];
  socket.addEventListener("message", (event) => deliveries.push(event));
  assert.equal(hook.arm(sample.call, sample.result), true);

  hook.send(socket, 2, otherTopic);
  assert.equal(
    hook.receive(socket, [50, 2, {}, ["other topic"]]).capture.mocked,
    undefined,
  );
  hook.send(socket, 3, topic, "/fixture#differentProcedure");
  assert.equal(
    hook.receive(socket, [50, 3, {}, ["other procedure"]]).capture.mocked,
    undefined,
  );
  const matching = hook.send(socket, 4);
  hook.send(socket, 5);

  const progressive = [50, 4, { progress: true }, ["partial"]];
  const partial = hook.receive(socket, progressive).capture;
  assert.deepEqual(partial.parsed, progressive);
  assert.equal(hook.arm(matching, partial), false);
  assert.equal(
    hook.receive(socket, [50, 5, {}, ["later call"]]).capture.mocked,
    undefined,
  );
  const live = [50, 4, { live: true, progress: false }, ["original"]];
  const { capture, event } = hook.receive(socket, live);
  const expected = [50, 4, live[2], ["sample"], { score: 10 }];
  assert.equal(capture.mocked, true);
  assert.deepEqual(capture.parsed, expected);
  assert.equal(deliveries.at(-1), event);
  assert.equal(deliveries.at(-1).isTrusted, true);
  assert.deepEqual(JSON.parse(deliveries.at(-1).data), expected);
  assert.deepEqual(
    socket.sent.map((rawText) => JSON.parse(rawText)[1]),
    [1, 2, 3, 4, 5],
  );

  hook.send(socket, 6);
  assert.equal(
    hook.receive(socket, [50, 6, {}, ["unchanged"]]).capture.mocked,
    undefined,
  );
  assert.equal(hook.arm(sample.call, capture), false);
});

test("applies an edited body once without overwriting the captured response", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  const body = [["edited"], { score: 25 }];
  assert.equal(
    hook.arm(sample.call, sample.result, JSON.stringify(body)),
    true,
  );
  assert.equal(socket.sent.length, 1);

  hook.send(socket, 2, otherTopic);
  const differentTopic = [50, 2, {}, ["original for another topic"]];
  assert.deepEqual(
    hook.receive(socket, differentTopic).capture.parsed,
    differentTopic,
  );

  hook.send(socket, 3);
  const details = { live: true };
  const { capture, event } = hook.receive(socket, [50, 3, details, ["live"]]);
  const expected = [50, 3, details, ...body];
  assert.equal(capture.mocked, true);
  assert.deepEqual(capture.parsed, expected);
  assert.deepEqual(JSON.parse(event.data), expected);

  hook.send(socket, 4);
  const next = [50, 4, {}, ["next live"]];
  assert.deepEqual(hook.receive(socket, next).capture.parsed, next);

  assert.equal(hook.arm(sample.call, sample.result), true);
  hook.send(socket, 5);
  assert.deepEqual(hook.receive(socket, [50, 5, {}, ["live"]]).capture.parsed, [
    50,
    5,
    {},
    ["sample"],
    { score: 10 },
  ]);
});

test("checks the edited body shape, size, and captured sample before arming", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  const invalidBodies = [
    null,
    [[], {}],
    "",
    "not JSON",
    "{}",
    "null",
    "[{}]",
    "[[], []]",
    "[[], {}, 1]",
    "[50, 1, {}, []]",
    "[]".padEnd(1_048_577),
    "[".repeat(20_000) + "0" + "]".repeat(20_000),
  ];
  for (const body of invalidBodies) {
    assert.equal(hook.arm(sample.call, sample.result, body), false);
  }
  assert.equal(
    hook.arm({ ...sample.call, messageId: 999 }, sample.result, "[]"),
    false,
  );
  assert.equal(
    hook.arm(sample.call, sample.result, "[]".padEnd(1_048_576)),
    true,
  );
  hook.send(socket, 2);
  const frame = [50, 2, { live: true }, ["live"], { value: true }];
  assert.deepEqual(
    hook.receive(socket, frame).capture.parsed,
    frame.slice(0, 3),
  );
});

test("keeps errors and scripted events unchanged and consumes the rule on a real error", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  assert.equal(hook.arm(sample.call, sample.result), true);
  const call = hook.send(socket, 2);
  const scripted = [50, 2, {}, ["scripted"]];
  const { capture: scriptedCapture } = hook.receive(socket, scripted, {
    trusted: false,
  });
  assert.deepEqual(scriptedCapture.parsed, scripted);
  const malformed = [50, 2, {}, "invalid operands"];
  assert.deepEqual(hook.receive(socket, malformed).capture.parsed, malformed);
  assert.deepEqual(hook.receive(socket, [8, 48, 2]).capture.parsed, [8, 48, 2]);
  const error = [8, 48, 2, {}, "wamp.error.runtime_error"];
  assert.deepEqual(hook.receive(socket, error).capture.parsed, error);
  assert.equal(hook.arm(call, scriptedCapture), false);

  hook.send(socket, 3);
  assert.equal(
    hook.receive(socket, [50, 3, {}, ["unchanged"]]).capture.mocked,
    undefined,
  );
});

test("validates samples on their original WAMP JSON socket and matches absent topics", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const otherSocket = openSocket(hook);
  const unsupported = openSocket(hook, "wamp.2.msgpack");
  const sample = captureSample(hook, socket, 1, "");
  const otherSample = captureSample(hook, otherSocket);
  const unsupportedSample = captureSample(hook, unsupported);
  assert.equal(hook.arm(sample.call, otherSample.result), false);
  assert.equal(
    hook.arm(unsupportedSample.call, unsupportedSample.result),
    false,
  );
  assert.equal(hook.arm(sample.call, sample.result), true);

  hook.send(otherSocket, 2);
  assert.equal(
    hook.receive(otherSocket, [50, 2, {}, ["other socket"]]).capture.mocked,
    undefined,
  );
  hook.send(socket, 2);
  assert.equal(
    hook.receive(socket, [50, 2, {}, ["topic present"]]).capture.mocked,
    undefined,
  );
  hook.send(otherSocket, 3, null);
  assert.equal(
    hook.receive(otherSocket, [50, 3, {}, ["no topic"]]).capture.mocked,
    true,
  );

  socket.close();
  assert.equal(hook.arm(sample.call, sample.result), false);
});

test("accepts only matched sample identifiers within the bounded capture history", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const first = captureSample(hook, socket);
  const second = captureSample(hook, socket, 2);
  assert.equal(hook.arm(first.call, second.result), false);
  assert.equal(hook.arm(first.call, first.result), true);

  let latest;
  for (let requestId = 3; requestId <= 129; requestId++) {
    latest = captureSample(hook, socket, requestId, otherTopic);
  }
  assert.equal(hook.arm(first.call, first.result), false);
  assert.equal(hook.arm(latest.call, latest.result), true);
});

test("preserves a sample with no optional body and continues sending non-JSON data", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const call = hook.send(socket, 1);
  const { capture: result } = hook.receive(socket, [50, 1, {}]);
  assert.equal(hook.arm(call, result), true);
  socket.send("unrelated text");

  hook.send(socket, 2);
  const frame = [50, 2, { live: true }, ["live"], { value: true }];
  const { capture } = hook.receive(socket, frame);
  assert.equal(capture.mocked, true);
  assert.deepEqual(capture.parsed, [50, 2, frame[2]]);
  assert.equal(socket.sent[1], "unrelated text");
});

test("passes through the original event when its data cannot be changed", () => {
  const hook = setup();
  const socket = openSocket(hook);
  const sample = captureSample(hook, socket);
  assert.equal(hook.arm(sample.call, sample.result), true);
  hook.send(socket, 2);
  const frame = [50, 2, {}, ["original"]];
  const { capture, event } = hook.receive(socket, frame, { extensible: false });
  assert.deepEqual(capture.parsed, frame);
  assert.deepEqual(JSON.parse(event.data), frame);
  assert.equal(capture.mocked, undefined);

  hook.send(socket, 3);
  assert.equal(
    hook.receive(socket, [50, 3, {}, ["unchanged"]]).capture.mocked,
    undefined,
  );
});
