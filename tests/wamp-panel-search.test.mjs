import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageSearch } from "../src/devtools/panel-search.js";

function captureSearch(t, messages) {
  const form = new FormData();
  t.mock.method(globalThis, "FormData", function (form) {
    return form;
  });
  const rows = messages.map((message) => ({ item: {}, message }));
  const control = { toggleAttribute() {}, setAttribute() {} };
  const search = Object.assign(Object.create(MessageSearch.prototype), {
    input: { value: "" },
    form,
    minimum: { valueAsNumber: NaN },
    filterButton: control,
    filterCount: {},
    matchCount: {},
    showButton: control,
    list: { children: rows.map(({ item }) => item) },
    empty: {},
    stream: {},
    indexByItem: new WeakMap(),
    onFilter() {},
    updateTypes() {},
  });

  search.setRows(rows, "No messages in this capture.");

  return {
    form,
    minimum: search.minimum,
    search(query) {
      search.input.value = query;
      search.apply();
      return rows
        .filter(({ item }) => !item.hidden)
        .map(({ message }) => message.id);
    },
  };
}

test("main search finds request and response payloads without enabling a filter", (t) => {
  let requestReads = 0;
  const view = captureSearch(t, [
    {
      id: 12,
      type: "CALL",
      summary: "sports.getGames",
      latency: 30,
      responseState: "success",
      payload: {
        kind: "json",
        value: {
          toJSON() {
            requestReads += 1;
            return { competitionName: "EuroLeague" };
          },
        },
      },
      response: { kind: "json", value: { scores: [{ name: "Real Madrid" }] } },
    },
    {
      id: 112,
      type: "EVENT",
      payload: { kind: "json", value: { name: "Real Madrid", label: "#12" } },
    },
  ]);

  assert.equal(requestReads, 0);
  assert.deepEqual(view.search("#12"), [12]);
  assert.equal(requestReads, 0);
  assert.deepEqual(view.search("  COMPETITIONname  "), [12]);
  assert.deepEqual(view.search("euroleague"), [12]);
  assert.deepEqual(view.search("Real Madrid"), [12, 112]);
  assert.equal(requestReads, 1);

  view.form.append("type", "CALL");
  view.form.append("response", "success");
  assert.deepEqual(view.search("Real Madrid"), [12]);
  view.minimum.valueAsNumber = 31;
  assert.deepEqual(view.search("Real Madrid"), []);
});
