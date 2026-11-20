import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatPayloadPath,
  payloadColumnValue,
} from "../src/devtools/panel-payload-columns.js";

const json = (value) => ({ kind: "json", value });

test("uses an exact path and reads the selected request or response", () => {
  const message = {
    payload: json([{}, { topic: "outer", markets: [{ topic: "request" }] }]),
    response: json([{}, { topic: "reply" }]),
  };
  assert.equal(
    payloadColumnValue(message, {
      source: "request",
      path: [1, "markets", 0, "topic"],
    }),
    "request",
  );
  assert.equal(
    payloadColumnValue(message, { source: "response", path: [1, "topic"] }),
    "reply",
  );
  assert.equal(
    payloadColumnValue(message, {
      source: "response",
      path: [1, "markets", 0, "topic"],
    }),
    "—",
  );
});

test("preserves falsy values and distinguishes missing values from null", () => {
  const message = {
    payload: json({ active: false, count: 0, detail: null, text: "" }),
  };
  const value = (property) =>
    payloadColumnValue(message, { source: "request", path: [property] });
  assert.equal(value("active"), "false");
  assert.equal(value("count"), "0");
  assert.equal(value("detail"), "null");
  assert.equal(value("text"), '""');
  assert.equal(value("missing"), "—");
  assert.equal(value("constructor"), "—");
});

test("formats unusual keys without merging path segments", () => {
  assert.equal(
    formatPayloadPath([5, "market.data", 0, 'price"USD']),
    '$[5]["market.data"][0]["price\\"USD"]',
  );
  assert.equal(formatPayloadPath([5, "topic"]), "$[5].topic");
});
