import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeMessages } from "../src/devtools/panel-messages.js";

function frame(messageId, direction, parsed, elapsed = messageId * 100) {
  return {
    messageId,
    direction,
    parsed,
    timestamp: new Date(Date.UTC(2026, 0, 1) + elapsed).toISOString(),
    format: "text",
    rawText: JSON.stringify(parsed),
  };
}

test("pairs requests and results, preserves request identity, and measures latency", () => {
  const request = frame(1, "sent", [
    48,
    8,
    {},
    "sports.getOdds",
    [{ eventId: 7842 }],
  ]);
  const pending = analyzeMessages([request]);
  assert.equal(pending.pendingCount, 1);
  assert.equal(pending.rows[0].summary, "sports.getOdds");
  assert.equal(pending.rows[0].responseState, "pending");

  const replied = analyzeMessages([
    request,
    frame(2, "received", [50, 8, {}, [{ odds: [] }]], 828),
  ]);
  assert.equal(replied.pendingCount, 0);
  assert.equal(replied.averageLatency, 728);
  assert.equal(replied.rows.length, 1);
  assert.equal(replied.rows[0].key, pending.rows[0].key);
  assert.equal(replied.rows[0].responseState, "success");
  assert.deepEqual(replied.rows[0].response.value, [50, 8, {}, [{ odds: [] }]]);
});

test("matches errors to the request type and keeps standalone frames visible", () => {
  const data = [
    frame(1, "sent", [48, 4, {}, "sports.getOdds"]),
    frame(2, "sent", [32, 4, {}, "/sports/updates"]),
    frame(3, "received", [8, 32, 4, {}, "wamp.error.not_authorized"]),
    frame(4, "received", [50, 9, {}, []]),
  ];
  const { rows, pendingCount } = analyzeMessages(data);
  assert.equal(pendingCount, 1);
  assert.equal(rows[0].responseState, "pending");
  assert.equal(rows[1].responseState, "error");
  assert.equal(rows[1].replySummary, "wamp.error.not_authorized");
  assert.equal(rows[2].id, 9);
  assert.equal(rows[2].responseState, "success");
});

test("uses known subscription topics in event previews and preserves opaque frames", () => {
  const { rows } = analyzeMessages([
    frame(1, "sent", [32, 5, {}, "/sports/updates"]),
    frame(2, "received", [33, 5, 100]),
    frame(3, "received", [
      36,
      100,
      200,
      {},
      [{ eventId: 7842, status: "open" }],
    ]),
    {
      ...frame(4, "received", null),
      format: "blob",
      rawText: "[binary blob 20 bytes]",
    },
    frame(5, "received", false),
    frame(6, "received", null),
  ]);
  assert.equal(rows[1].summary, "Event #7842 · open");
  assert.equal(rows[1].topic, "/sports/updates");
  assert.deepEqual(rows[2].payload, {
    kind: "text",
    value: "[binary blob 20 bytes]",
  });
  assert.deepEqual(rows[3].payload, { kind: "json", value: false });
  assert.deepEqual(rows[4].payload, { kind: "json", value: null });
});

test("keeps a progressive call pending until its final response", () => {
  const request = frame(1, "sent", [48, 8, {}, "sports.stream"]);
  const progress = frame(2, "received", [
    50,
    8,
    { progress: true },
    ["partial"],
  ]);
  assert.equal(analyzeMessages([request, progress]).pendingCount, 1);

  const { rows, pendingCount } = analyzeMessages([
    request,
    progress,
    frame(3, "received", [50, 8, {}, ["complete"]]),
  ]);
  assert.equal(pendingCount, 0);
  assert.equal(rows[0].responseState, "success");
  assert.equal(rows[1].summary, "Progressive result");
});

test("zero latency is valid and malformed or backward times are excluded", () => {
  const { rows, averageLatency } = analyzeMessages([
    frame(1, "sent", [48, 1, {}, "zero"], 100),
    frame(2, "received", [50, 1, {}, []], 100),
    frame(3, "sent", [48, 2, {}, "backward"], 400),
    frame(4, "received", [50, 2, {}, []], 300),
    { ...frame(5, "sent", [48, 3, {}, "invalid"]), timestamp: "invalid" },
    frame(6, "received", [50, 3, {}, []]),
  ]);
  assert.equal(rows[0].latency, 0);
  assert.equal(rows[1].latency, null);
  assert.equal(rows[2].latency, null);
  assert.equal(averageLatency, 0);
});

test("keeps legacy JSON and invalid text available without treating either as a reply", () => {
  const { rows } = analyzeMessages([
    { rawText: '{"active":false}', direction: "received" },
    { rawText: "unstructured\nmessage", format: "text" },
    { rawText: "", format: "text" },
    frame(4, "received", [999, { data: true }]),
  ]);
  assert.deepEqual(rows[0].payload, { kind: "json", value: { active: false } });
  assert.equal(rows[0].responseState, "");
  assert.equal(rows[1].summary, "unstructured message");
  assert.equal(rows[1].payload.value, "unstructured\nmessage");
  assert.equal(rows[2].summary, "Empty text frame");
  assert.equal(rows[3].type, "TYPE_999");
});

test("reads CALL topic from keyword arguments while retaining the procedure", () => {
  const { rows } = analyzeMessages([
    frame(1, "sent", [
      48,
      11,
      {},
      "/sports#initialDump",
      [],
      { topic: "/sports/en/next" },
    ]),
    frame(2, "received", [50, 11, {}, [], { topic: "reply.value" }]),
    frame(3, "sent", [
      48,
      12,
      {},
      "/sports#initialDump",
      [{ topic: "positional.value" }],
    ]),
    frame(4, "sent", [
      48,
      13,
      {},
      "/sports#initialDump",
      [],
      { topic: { name: "nested.value" } },
    ]),
    frame(5, "sent", [48, 14, {}, "/sports#initialDump", [], { topic: " " }]),
  ]);
  assert.deepEqual(
    rows.map(({ summary }) => summary),
    Array(4).fill("/sports#initialDump"),
  );
  assert.deepEqual(
    rows.map(({ topic }) => topic),
    ["/sports/en/next", null, null, null],
  );
});

test("uses protocol topics for pub/sub and the concrete topic for a pattern event", () => {
  const { rows } = analyzeMessages([
    frame(1, "sent", [
      16,
      20,
      {},
      "sports.scores",
      [],
      { topic: "payload.value" },
    ]),
    frame(2, "sent", [32, 21, { match: "prefix" }, "sports"]),
    frame(3, "received", [33, 21, 42]),
    frame(4, "received", [36, 42, 100, { topic: "sports.live" }]),
    frame(5, "received", [36, 43, 101, {}]),
  ]);
  assert.deepEqual(
    rows.map(({ topic }) => topic),
    ["sports.scores", "sports", "sports.live", null],
  );
  assert.equal(rows[2].summary, "Subscription #42");
});

test("gives rows distinct stable keys when local message IDs repeat", () => {
  const messages = [
    frame(1, "sent", [70, 24, {}], 100),
    frame(1, "sent", [48, 25, {}, "fixture.call"], 100),
    frame(1, "sent", [48, 26, {}, "fixture.otherCall"], 100),
  ];
  const keys = (frames) => analyzeMessages(frames).rows.map(({ key }) => key);
  const all = keys(messages);
  assert.equal(new Set(all).size, 3);
  assert.deepEqual(keys(messages.slice(0, 2)), all.slice(0, 2));
});
