import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findEditorMatches,
  findPayloadMatches,
  PayloadSearch,
} from "../src/devtools/panel-payload-search.js";

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

test("finds literal draft text in source order using textarea offsets", () => {
  assert.deepEqual(findEditorMatches("😀[Key] K [KEY]", " [kEy] "), [
    { start: 2, end: 7 },
    { start: 10, end: 15 },
  ]);
  assert.deepEqual(findEditorMatches("😀[Key] K [KEY]", "k"), [
    { start: 3, end: 4 },
    { start: 8, end: 9 },
    { start: 11, end: 12 },
  ]);
  assert.deepEqual(findEditorMatches("{}", "  "), []);
});

function control(properties = {}) {
  const attributes = new Map();
  return Object.assign(new EventTarget(), {
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
    focus() {
      this.focused = true;
    },
    ...properties,
  });
}

test("moves the highlight when inserting a mock preview changes the match section", () => {
  const responseMatch = { isConnected: true };
  const request = { contains: () => false };
  const response = { contains: (node) => node === responseMatch };
  const elements = {
    "#toggle-payload-search": control(),
    "#payload-search": control({ hidden: false }),
    "#payload-query": control({ value: "needle" }),
    "#payload-match-count": control(),
    "#previous-payload-match": control(),
    "#next-payload-match": control(),
  };
  const scroll = { children: [{}, request, response] };
  const search = new PayloadSearch(
    { querySelector: (selector) => elements[selector] },
    scroll,
    () => {},
  );
  search.matches = [{ source: 1, path: [0], part: "value" }];
  search.index = 0;
  search.target = responseMatch;
  let revealed;
  search.showMatch = () => {
    revealed = scroll.children[search.matches[search.index].source];
  };
  search.setPayloads(json(["mock"]), json(["needle"]), json(["needle"]));
  assert.equal(revealed, request);
});

test("Find switches between the preview and editable draft without losing the query or overwriting an edit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = control({ value: "", placeholder: "Find key or value" });
  const status = control();
  const bar = control({ hidden: true });
  const next = control();
  const elements = {
    "#toggle-payload-search": control(),
    "#payload-search": bar,
    "#payload-query": input,
    "#payload-match-count": status,
    "#previous-payload-match": control(),
    "#next-payload-match": next,
  };
  const search = new PayloadSearch(
    { querySelector: (selector) => elements[selector] },
    { children: [] },
    () => {},
  );
  const editor = control({
    value: "needle\n".repeat(10),
    clientHeight: 48,
    scrollWidth: 60,
    clientWidth: 60,
    scrollTop: 0,
    scrollLeft: 0,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          lineHeight: "16px",
          fontStyle: "normal",
          fontWeight: "400",
          fontSize: "12px",
          fontFamily: "monospace",
          tabSize: "4",
          paddingTop: "0",
          paddingLeft: "0",
        }),
      },
      createElement: () => ({
        getContext: () => ({
          measureText: (text) => ({ width: text.length * 8 }),
        }),
      }),
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  });

  search.setOpen(true);
  input.value = "needle";
  search.setPayloads(json({ needle: true }));
  assert.equal(status.textContent, "1 / 1");

  search.setEditor(editor);
  assert.equal(input.value, "needle");
  assert.equal(input.placeholder, "Find in mock JSON");
  assert.equal(status.textContent, "1 / 10");
  assert.equal(editor.selectionStart, 0);
  assert.equal(editor.selectionEnd, 6);
  assert.equal(editor.focused, undefined);
  search.move(-1);
  assert.equal(status.textContent, "10 / 10");
  assert.equal(editor.selectionStart, 63);
  assert.equal(editor.selectionEnd, 69);
  assert.equal(editor.focused, true);
  assert.ok(editor.scrollTop > 0);

  editor.value = "new needle";
  editor.setSelectionRange(3, 3);
  editor.dispatchEvent(new Event("input"));
  search.setPayloads(json({ updated: "needle" }));
  t.mock.timers.tick(100);
  assert.equal(status.textContent, "1 / 1");
  assert.equal(editor.selectionStart, 3);
  assert.equal(editor.selectionEnd, 3);
  assert.equal(next.disabled, false);
  search.move(1);
  assert.equal(editor.selectionStart, 4);
  assert.equal(editor.selectionEnd, 10);

  editor.value = `${" ".repeat(80)}\tneedle`;
  editor.scrollWidth = 800;
  editor.dispatchEvent(new Event("input"));
  search.move(1);
  assert.equal(editor.selectionStart, 81);
  assert.ok(editor.scrollLeft > 600);

  search.setEditor(null);
  assert.equal(input.value, "needle");
  assert.equal(input.placeholder, "Find key or value");
  assert.equal(status.textContent, "1 / 1");
  assert.equal(next.disabled, true);
});
