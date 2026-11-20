import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const filename = fileURLToPath(
  new URL("../src/popup/popup.js", import.meta.url),
);
const script = readFileSync(filename, "utf8");
const siteTab = { id: 7, title: "Example site", url: "https://example.test/" };

function setup({
  tabs = [siteTab],
  sockets = [],
  available = true,
  queryFailed = false,
  pending,
} = {}) {
  const elements = new Map();
  const snapshotRequests = [];
  const availabilityRequests = [];
  let click;
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, {
          textContent: "",
          dataset: {},
          setAttribute(name, value) {
            this[name] = value;
          },
          addEventListener(event, listener) {
            if (event === "click") click = listener;
          },
        });
      }
      return elements.get(selector);
    },
  };
  const chrome = {
    tabs: {
      async query() {
        return tabs;
      },
      async sendMessage(tabId, message, { frameId }) {
        availabilityRequests.push([tabId, message.type, frameId]);
        if (!available) throw new Error("Receiving end does not exist");
        return { available: true };
      },
    },
    runtime: {
      async sendMessage({ type, tabId }) {
        snapshotRequests.push([type, tabId]);
        if (queryFailed) throw new Error("Capture worker unavailable");
        if (pending) await pending;
        return { sockets };
      },
    },
  };
  runInNewContext(script, { document, chrome }, { filename });
  return {
    elements,
    snapshotRequests,
    availabilityRequests,
    refresh: () => click(),
  };
}

test("checks automatically and summarizes the retained WAMP activity across the current tab", async () => {
  const newest = "2026-11-20T07:21:45.000Z";
  const popup = setup({
    sockets: [
      {
        state: "OPEN",
        messageCount: 20,
        lastMessageAt: "2026-11-20T07:21:21.000Z",
      },
      { state: "CLOSED", messageCount: 5, lastMessageAt: newest },
      { state: "OPEN", messageCount: 0, lastMessageAt: "" },
    ],
  });
  await setImmediate();
  const { elements, snapshotRequests, availabilityRequests } = popup;
  assert.deepEqual(snapshotRequests, [["get-sockets", 7]]);
  assert.deepEqual(availabilityRequests, []);
  assert.equal(elements.get("#tab-name").textContent, siteTab.title);
  assert.equal(elements.get("#tab-url").textContent, siteTab.url);
  assert.equal(elements.get("#tab-name").title, siteTab.title);
  assert.equal(elements.get("#tab-url").title, siteTab.url);
  assert.equal(elements.get("#capture-status").textContent, "WAMP connected");
  assert.equal(elements.get("#tab-summary").hidden, false);
  assert.equal(elements.get("#open-count").textContent, "2");
  assert.equal(elements.get("#message-count").textContent, "25");
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  assert.equal(
    elements.get("#last-message").textContent,
    clock.format(Date.parse(newest)),
  );
});

test("shows zero activity only when the tab can be inspected", async () => {
  const empty = setup();
  const unavailable = setup({ available: false });
  const noTab = setup({ tabs: [] });
  const error = setup({ queryFailed: true });
  const malformed = setup({ sockets: null });
  await setImmediate();
  assert.deepEqual(empty.availabilityRequests, [
    [7, "capture-availability", 0],
  ]);
  assert.equal(
    empty.elements.get("#capture-status").textContent,
    "No WAMP detected",
  );
  assert.equal(empty.elements.get("#open-count").textContent, "0");
  assert.equal(empty.elements.get("#message-count").textContent, "0");
  assert.equal(empty.elements.get("#last-message").textContent, "—");
  assert.equal(
    unavailable.elements.get("#capture-status").textContent,
    "Unavailable on this page",
  );
  assert.equal(
    noTab.elements.get("#capture-status").textContent,
    "No active tab",
  );
  assert.deepEqual(noTab.snapshotRequests, []);
  assert.equal(
    error.elements.get("#capture-status").textContent,
    "Could not check this tab",
  );
  assert.equal(
    malformed.elements.get("#capture-status").textContent,
    "Could not check this tab",
  );
  for (const popup of [unavailable, noTab, error, malformed]) {
    assert.equal(popup.elements.get("#tab-summary").hidden, true);
  }
});

test("does not overlap a request when Refresh is pressed during the automatic check", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const { elements, refresh, snapshotRequests } = setup({
    pending: promise,
    sockets: [{ state: "CONNECTING", messageCount: 0, lastMessageAt: "" }],
  });
  await setImmediate();
  assert.equal(elements.get("#check-tab")["aria-disabled"], "true");
  await refresh();
  assert.equal(snapshotRequests.length, 1);
  resolve();
  await setImmediate();
  assert.equal(
    elements.get("#capture-status").textContent,
    "Connecting to WAMP",
  );
  assert.equal(elements.get("#check-tab")["aria-disabled"], "false");
});

test("refreshes after a connection closes and preserves its activity in the summary", async () => {
  const sockets = [
    { state: "OPEN", messageCount: 1, lastMessageAt: "invalid timestamp" },
  ];
  const { elements, refresh, snapshotRequests } = setup({ sockets });
  await setImmediate();
  assert.equal(elements.get("#capture-status").textContent, "WAMP connected");
  sockets[0] = { ...sockets[0], state: "CLOSED" };
  await refresh();
  assert.equal(snapshotRequests.length, 2);
  assert.equal(
    elements.get("#capture-status").textContent,
    "No open WAMP connections",
  );
  assert.equal(elements.get("#open-count").textContent, "0");
  assert.equal(elements.get("#message-count").textContent, "1");
  assert.equal(elements.get("#last-message").textContent, "—");
});
