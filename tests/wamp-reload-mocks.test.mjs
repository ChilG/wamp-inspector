import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeMockStatus,
  MockReadiness,
  readMockDocument,
  refreshMockDocument,
  ReloadMocks,
} from "../src/capture/reload-mocks.js";

const source = {
  tabId: 4,
  pageUrl: "https://fixture.invalid/sport",
  frameUrl: "https://frame.fixture.invalid/sport",
  frameId: 8,
  documentId: "original",
};
const sameFrame = { ...source, documentId: "frame-reload" };
const nextFrame = { ...sameFrame, frameId: 12 };

test("reads the inspected URL and frame from the extension-owned Chrome sender", () => {
  const sender = {
    id: "extension-id",
    tab: { id: source.tabId, url: source.pageUrl + "#tab" },
    url: source.frameUrl + "#anchor",
    frameId: source.frameId,
    documentId: source.documentId,
    documentLifecycle: "active",
  };
  assert.deepEqual(readMockDocument(sender, sender.id), source);
  assert.equal(readMockDocument({ ...sender, id: "other" }, sender.id), null);
  assert.equal(
    readMockDocument({ ...sender, documentLifecycle: "cached" }, sender.id),
    null,
  );
});

test("takes the current SPA routes from Chrome while keeping the source document", async (t) => {
  t.after(() => delete globalThis.chrome);
  const pageUrl = `${source.pageUrl}/football`;
  const frameUrl = `${source.frameUrl}/football`;
  const requests = [];
  let documentId = source.documentId;
  globalThis.chrome = {
    webNavigation: {
      async getFrame(details) {
        requests.push(details);
        return details.frameId === 0
          ? { url: `${pageUrl}#page`, documentLifecycle: "active" }
          : {
              url: `${frameUrl}#frame`,
              documentId,
              documentLifecycle: "active",
            };
      },
    },
  };
  assert.deepEqual(await refreshMockDocument(source), {
    ...source,
    pageUrl,
    frameUrl,
  });
  assert.deepEqual(requests, [
    {
      tabId: source.tabId,
      frameId: source.frameId,
      documentId: source.documentId,
    },
    { tabId: source.tabId, frameId: 0 },
  ]);
  documentId = "replacement";
  assert.equal(await refreshMockDocument(source), null);
});

function remember(mocks, options = {}, scope = source) {
  const attempt = mocks.begin(scope);
  const rule = {
    token: attempt.token,
    endpoint: "wss://socket.fixture.invalid/wamp",
    procedure: "fixture.initial",
    topic: "fixture.scores",
    resultBody: '[[],{"label":"mock"}]',
    ...options,
  };
  attempt.finish(true, rule);
  return rule;
}

test("a top-frame replacement waits for Chrome to confirm a reload", () => {
  const top = {
    ...source,
    frameId: 0,
    frameUrl: source.pageUrl,
  };
  const replacement = { ...top, documentId: "new-top-document" };
  for (const transition of ["link", "reload"]) {
    const mocks = new ReloadMocks();
    const rule = remember(mocks, {}, top);
    assert.deepEqual(mocks.lookup(replacement), { rules: [], retry: true });
    mocks.navigate(top.tabId, top.pageUrl, transition);
    assert.deepEqual(mocks.lookup(replacement), {
      rules: transition === "reload" ? [rule] : [],
      retry: false,
    });
  }
});

test("shows a saved mock separately from frame and WebSocket readiness", () => {
  const mocks = new ReloadMocks();
  const rule = remember(mocks, {
    endpoint: "wss://frame.fixture.invalid/wamp",
  });
  const pending = mocks.inspect(source.tabId);
  const ready = { documentId: source.documentId, token: rule.token };
  const socket = {
    documentId: source.documentId,
    frameId: source.frameId,
    protocol: "wamp.2.json",
    state: "OPEN",
    url: "/wamp",
  };
  assert.equal(describeMockStatus(pending, undefined, [socket]).state, "saved");
  assert.equal(
    describeMockStatus(pending, { ...ready, token: "other" }, [socket]).state,
    "saved",
  );
  for (const unrelated of [
    { ...socket, protocol: "wamp.2.msgpack" },
    { ...socket, documentId: "other-document" },
    { ...socket, state: "CLOSED" },
  ]) {
    assert.equal(
      describeMockStatus(pending, ready, [unrelated]).state,
      "waiting-socket",
    );
  }
  assert.deepEqual(
    describeMockStatus(pending, ready, [{ ...socket, url: "/other" }]),
    {
      state: "waiting-call",
      endpoint: rule.endpoint,
      procedure: rule.procedure,
      topic: rule.topic,
    },
  );
  assert.equal(describeMockStatus(null, ready, [socket]), null);
});

test("a closed socket clears readiness without discarding the saved mock", () => {
  const mocks = new ReloadMocks();
  const rule = remember(mocks);
  const pending = mocks.inspect(source.tabId);
  const readiness = new MockReadiness();
  const sibling = { ...source, frameId: source.frameId + 1 };
  assert.equal(readiness.record(pending, sibling, rule.token, true), false);
  assert.equal(readiness.record(pending, source, rule.token, true), true);
  assert.equal(readiness.record(pending, source, rule.token, false), true);
  assert.equal(readiness.record(pending, source, rule.token, true), false);
  assert.equal(readiness.describe(source.tabId, pending, []).state, "saved");
  assert.deepEqual(mocks.inspect(source.tabId).rule, rule);
});

test("only a replacement document in the same inspected page and frame gets the pending mock", () => {
  const mocks = new ReloadMocks();
  const rule = remember(mocks);
  assert.equal(mocks.resume(source), null);
  assert.equal(mocks.resume(nextFrame), null);
  mocks.navigate(source.tabId, source.pageUrl, "reload");
  assert.equal(mocks.resume({ ...nextFrame, tabId: 5 }), null);
  assert.equal(mocks.resume({ ...nextFrame, frameUrl: source.pageUrl }), null);
  assert.deepEqual(mocks.resume(nextFrame), rule);
  assert.equal(mocks.resume(nextFrame), null);
  assert.equal(mocks.consume(source, rule.token), false);
  assert.equal(mocks.consume(nextFrame, rule.token), true);
  mocks.navigate(source.tabId, source.pageUrl, "reload");
  assert.equal(mocks.resume({ ...nextFrame, documentId: "next" }), null);
});

test("an early matching iframe lookup waits for the top reload before claiming", () => {
  const mocks = new ReloadMocks();
  const rule = remember(mocks);
  assert.deepEqual(mocks.lookup(nextFrame), { rules: [], retry: true });
  assert.deepEqual(mocks.lookup(nextFrame), { rules: [], retry: true });
  assert.deepEqual(mocks.inspect(source.tabId), {
    owner: source,
    rule,
    navigation: 0,
  });

  mocks.navigate(source.tabId, source.pageUrl, "reload");
  assert.deepEqual(mocks.lookup(nextFrame), { rules: [rule], retry: false });
  assert.deepEqual(mocks.inspect(source.tabId), {
    owner: nextFrame,
    rule,
    navigation: 1,
  });
  assert.deepEqual(mocks.lookup(nextFrame), { rules: [], retry: false });
});

test("restores an enabled mock after an iframe changes position on page reload", () => {
  const mocks = new ReloadMocks();
  const rule = remember(
    mocks,
    { persistent: { enabled: true, revision: 0 } },
    { ...source, frameSlot: "1/0" },
  );
  const replacement = { ...nextFrame, frameSlot: "0/0" };
  mocks.navigate(source.tabId, source.pageUrl, "reload");
  assert.deepEqual(mocks.lookup(replacement), { rules: [rule], retry: false });
  assert.equal(
    mocks.inspect(source.tabId).owner.documentId,
    replacement.documentId,
  );
});

test("a confirmed page reload restores a mock after the same iframe route changes its query", () => {
  const mocks = new ReloadMocks();
  const owner = { ...source, frameUrl: `${source.frameUrl}?instance=1` };
  const replacement = {
    ...nextFrame,
    frameUrl: `${source.frameUrl}?instance=2`,
  };
  const rule = remember(mocks, {}, owner);
  assert.deepEqual(mocks.lookup(replacement), { rules: [], retry: true });
  assert.deepEqual(mocks.lookup({ ...replacement, frameId: owner.frameId }), {
    rules: [],
    retry: true,
  });
  mocks.navigate(owner.tabId, owner.pageUrl, "reload");
  const miss = { rules: [], retry: false };
  for (const scope of [
    {
      ...replacement,
      frameUrl: "https://other.fixture.invalid/sport?instance=2",
    },
    {
      ...replacement,
      frameUrl: "https://frame.fixture.invalid/other?instance=2",
    },
  ]) {
    assert.deepEqual(mocks.lookup(scope), miss);
  }
  assert.deepEqual(mocks.lookup(replacement), { rules: [rule], retry: false });
  assert.equal(mocks.consume(owner, rule.token), false);
  assert.equal(mocks.consume(replacement, rule.token), true);
});

test("an early iframe lookup does not retry for another document scope", () => {
  const mocks = new ReloadMocks();
  remember(mocks);
  const miss = { rules: [], retry: false };
  for (const scope of [
    source,
    { ...nextFrame, documentId: source.documentId },
    { ...nextFrame, frameId: 0 },
    { ...nextFrame, tabId: source.tabId + 1 },
    { ...nextFrame, pageUrl: source.frameUrl },
    { ...nextFrame, frameUrl: source.pageUrl },
  ]) {
    assert.deepEqual(mocks.lookup(scope), miss);
  }
  assert.equal(mocks.inspect(source.tabId + 1), null);
});

test("reloading a frame with its same frame ID carries pending rules without top navigation", () => {
  const mocks = new ReloadMocks();
  assert.deepEqual(mocks.resume(sameFrame), null);
  const rule = remember(mocks);
  assert.deepEqual(mocks.resume(sameFrame), rule);
  mocks.navigate(source.tabId, "https://fixture.invalid/other", "link");
  assert.equal(mocks.resume(nextFrame), null);
});

test("keeps mocks owned by sibling iframes with the same path separate", () => {
  const mocks = new ReloadMocks();
  const persistent = { enabled: true, revision: 0 };
  const firstFrame = { ...source, frameUrl: `${source.frameUrl}?instance=1` };
  const siblingFrame = {
    ...source,
    frameId: 9,
    documentId: "sibling",
    frameUrl: `${source.frameUrl}?instance=2`,
  };
  const first = remember(mocks, { persistent }, firstFrame);
  const sibling = remember(
    mocks,
    { topic: "fixture.sibling", persistent },
    siblingFrame,
  );
  assert.deepEqual(
    mocks.lookup({ ...firstFrame, documentId: "first-reloaded" }),
    { rules: [first], retry: false },
  );
  assert.equal(
    mocks.inspect(source.tabId, sibling.token).owner.documentId,
    siblingFrame.documentId,
  );

  mocks.navigate(source.tabId, source.pageUrl, "reload");
  const replacement = {
    ...siblingFrame,
    frameId: 21,
    documentId: "sibling-reloaded",
  };
  assert.deepEqual(mocks.lookup(replacement), {
    rules: [sibling],
    retry: false,
  });
  assert.deepEqual(mocks.lookup(replacement), { rules: [], retry: false });
});

test("enabling a persistent rule replaces a queued Apply once for the same call", () => {
  const mocks = new ReloadMocks();
  const once = remember(mocks);
  const persistent = remember(mocks, {
    persistent: { enabled: true, revision: 0 },
  });
  assert.equal(mocks.inspect(source.tabId, once.token), null);
  assert.deepEqual(
    mocks.inspect(source.tabId, persistent.token).rule,
    persistent,
  );
});

test("a same-URL navigation without a reload does not transfer an armed mock", () => {
  const mocks = new ReloadMocks();
  remember(mocks);
  mocks.navigate(source.tabId, source.pageUrl, "link");
  assert.equal(mocks.resume(nextFrame), null);
});

test("an armed mock is consumed if its document changes route before the matching result", () => {
  const mocks = new ReloadMocks();
  const rule = remember(mocks);
  const routed = { ...source, pageUrl: `${source.pageUrl}/football` };
  assert.equal(
    mocks.consume({ ...routed, documentId: "other" }, rule.token),
    false,
  );
  assert.equal(mocks.consume(routed, rule.token), true);
  assert.equal(mocks.inspect(routed.tabId), null);
});

test("an accepted replacement supersedes older arms, even if it is already consumed", () => {
  const mocks = new ReloadMocks();
  const older = mocks.begin(source);
  const newer = mocks.begin(source);
  assert.equal(mocks.consume(source, newer.token), true);
  newer.finish(true, {
    token: newer.token,
    endpoint: "ws://fixture.invalid/wamp",
    procedure: "new",
    topic: null,
    resultBody: "[]",
  });
  older.finish(true, {
    token: older.token,
    endpoint: "ws://fixture.invalid/wamp",
    procedure: "old",
    topic: null,
    resultBody: "[]",
  });
  assert.equal(mocks.resume(sameFrame), null);
});

test("clearing the capture drops a pending rule and an in-flight acknowledgement", () => {
  const mocks = new ReloadMocks();
  const rule = remember(mocks);
  const attempt = mocks.begin(source);
  mocks.clear(source.tabId);
  attempt.finish(true, { ...rule, token: attempt.token });
  assert.equal(mocks.resume(sameFrame), null);
});
