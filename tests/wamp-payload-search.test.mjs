import assert from "node:assert/strict";
import { test } from "node:test";
import { findPayloadMatches } from "../src/devtools/panel-payload-search.js";

const json = (value) => ({ kind: "json", value });

test("finds nested keys and scalar values in preview order", () => {
  const payload = json([
    50,
    {},
    {
      status: "STATUS",
      records: [{ label: "Status: ready" }, { status: true }],
    },
  ]);
  assert.deepEqual(findPayloadMatches(payload, " sTaTuS "), [
    { path: [2, 0], part: "key" },
    { path: [2, 0], part: "value" },
    { path: [2, 1, 0, 0], part: "value" },
    { path: [2, 1, 1, 0], part: "key" },
  ]);
  assert.deepEqual(findPayloadMatches(json({ "a.b": { "[0]": "x" } }), "[0]"), [
    { path: [0, 0], part: "key" },
  ]);
});

test("finds scalar roots, falsy values and literal text", () => {
  const payload = json([false, 0, null, "a[b]"]);
  for (const [index, query] of ["false", "0", "null", "[b]"].entries()) {
    assert.deepEqual(findPayloadMatches(payload, query), [
      { path: [index], part: "value" },
    ]);
  }
  assert.deepEqual(findPayloadMatches(json(false), "false"), [
    { path: [], part: "value" },
  ]);
  assert.deepEqual(
    findPayloadMatches({ kind: "text", value: "hello\nworld" }, "WORLD"),
    [{ path: [], part: "value" }],
  );
  assert.deepEqual(findPayloadMatches(payload, "unmatched"), []);
  assert.deepEqual(findPayloadMatches(payload, "  "), []);
  assert.deepEqual(findPayloadMatches(null, "null"), []);
});

test("searches a deeply nested collapsed payload without recursion", () => {
  const depth = 10_000;
  let value = "needle";
  for (let index = 0; index < depth; index++) value = [value];
  assert.deepEqual(findPayloadMatches(json(value), "needle"), [
    { path: Array(depth).fill(0), part: "value" },
  ]);
});
