import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_PREVIEW,
  closePreviewTab,
  hidePreview,
  openPreviewTab,
  retainPreviewTabs,
} from "../src/devtools/panel-preview-tabs.js";

test("adds rows in opening order and activates an existing tab in place", () => {
  const first = openPreviewTab(EMPTY_PREVIEW, "call:1");
  const both = openPreviewTab(first, "result:1");
  const reopened = openPreviewTab(both, "call:1");

  assert.deepEqual(first.keys, ["call:1"]);
  assert.deepEqual(reopened, {
    keys: ["call:1", "result:1"],
    activeKey: "call:1",
    visible: true,
  });
  assert.equal(openPreviewTab(reopened, "call:1"), reopened);
});

test("hides the inspector while keeping its tabs available to reopen", () => {
  const first = openPreviewTab(EMPTY_PREVIEW, "call:1");
  const hidden = hidePreview(first);

  assert.deepEqual(hidden, { ...first, visible: false });
  assert.deepEqual(openPreviewTab(hidden, "call:1"), first);
  assert.equal(hidePreview(hidden), hidden);
  assert.equal(closePreviewTab(first, "missing"), first);
});

test("activates the next tab, then the previous tab, when closing the active tab", () => {
  const first = openPreviewTab(EMPTY_PREVIEW, "first");
  const second = openPreviewTab(first, "second");
  const third = openPreviewTab(second, "third");
  const all = openPreviewTab(third, "second");

  assert.equal(closePreviewTab(all, "first").activeKey, "second");
  const next = closePreviewTab(all, "second");
  assert.deepEqual(next.keys, ["first", "third"]);
  assert.equal(next.activeKey, "third");
  const previous = closePreviewTab(next, "third");
  assert.equal(previous.activeKey, "first");
  assert.deepEqual(closePreviewTab(previous, "first"), EMPTY_PREVIEW);
});

test("prunes expired capture rows while keeping their surviving neighbors", () => {
  let tabs = EMPTY_PREVIEW;
  for (const key of ["a", "b", "c", "d"]) tabs = openPreviewTab(tabs, key);
  tabs = openPreviewTab(tabs, "b");

  assert.equal(retainPreviewTabs(tabs, new Set(tabs.keys)), tabs);
  assert.deepEqual(retainPreviewTabs(tabs, new Set(["a", "d"])), {
    keys: ["a", "d"],
    activeKey: "d",
    visible: true,
  });
  assert.deepEqual(retainPreviewTabs(hidePreview(tabs), new Set(["a"])), {
    keys: ["a"],
    activeKey: "a",
    visible: false,
  });
  assert.deepEqual(retainPreviewTabs(tabs, new Set()), EMPTY_PREVIEW);
});
