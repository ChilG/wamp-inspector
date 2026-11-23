import assert from "node:assert/strict";
import { test } from "node:test";
import { StoredReloadMocks } from "../src/capture/reload-mock-storage.js";

const source = {
  tabId: 4,
  pageUrl: "https://fixture.invalid/sport",
  frameUrl: "https://frame.fixture.invalid/sport",
  frameId: 8,
  documentId: "original",
};
const replacement = { ...source, frameId: 12, documentId: "replacement" };
const key = "wamp.pendingReloadMock.4";

function sessionStorage() {
  const items = new Map();
  return {
    items,
    async get(name) {
      return items.has(name)
        ? { [name]: structuredClone(items.get(name)) }
        : {};
    },
    async set(update) {
      for (const [name, value] of Object.entries(update))
        items.set(name, structuredClone(value));
    },
    async remove(name) {
      items.delete(name);
    },
  };
}

function ruleFor(token, options = {}) {
  return {
    token,
    endpoint: "wss://socket.fixture.invalid/wamp",
    procedure: "fixture.initial",
    topic: "fixture.scores",
    resultBody: '[[],{"label":"mock"}]',
    ...options,
  };
}

async function save(mocks, options, scope = source) {
  const attempt = await mocks.begin(scope);
  const rule = ruleFor(attempt.token, options);
  await attempt.finish(true, rule);
  return rule;
}

test("tracks same-document route changes for persistent reloads and rejects unrelated history", async () => {
  const storage = sessionStorage();
  const first = new StoredReloadMocks(storage);
  const rule = await save(
    first,
    { persistent: { enabled: true, revision: 0 } },
    { ...source, pageDocumentId: "top-original" },
  );
  const pageUrl = `${source.pageUrl}/football`;
  const frameUrl = `${source.frameUrl}/football`;
  const update = {
    tabId: source.tabId,
    frameId: 0,
    documentId: "top-original",
    url: pageUrl,
  };
  await first.updateRoute({ ...update, documentId: "different" });
  assert.equal(
    (await first.inspect(source.tabId)).owner.pageUrl,
    source.pageUrl,
  );
  await first.updateRoute(update);
  await first.updateRoute({
    ...update,
    frameId: source.frameId,
    documentId: source.documentId,
    url: frameUrl,
  });

  const second = new StoredReloadMocks(storage);
  await second.navigate(source.tabId, pageUrl, "reload", "top-reloaded");
  assert.deepEqual(
    await second.resume({ ...replacement, pageUrl, frameUrl }),
    rule,
  );
  assert.equal(
    (await second.inspect(source.tabId)).owner.pageDocumentId,
    "top-reloaded",
  );
});

test("a persistent mock keeps its body and switch state across reload and worker restart", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const rule = await save(mocks, {
    persistent: { enabled: true, revision: 0 },
  });
  assert.equal(await mocks.consume(source, rule.token), false);
  const disabled = await mocks.setEnabled(source.tabId, rule.token, false);
  assert.deepEqual(disabled.rule.persistent, { enabled: false, revision: 1 });
  await mocks.navigate(source.tabId, source.pageUrl, "reload");
  const worker = new StoredReloadMocks(storage);
  const restored = await worker.resume({
    ...source,
    documentId: "new-document",
  });
  assert.equal(restored.resultBody, rule.resultBody);
  assert.deepEqual(restored.persistent, disabled.rule.persistent);
  assert.equal(
    await worker.setEnabled(source.tabId, "stale-token", true),
    null,
  );
  const enabled = await worker.setEnabled(source.tabId, rule.token, true);
  assert.deepEqual(enabled.rule.persistent, { enabled: true, revision: 2 });
});

test("persists multiple independently toggled mocks and replaces only a matching rule", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const persistent = { enabled: true, revision: 0 };
  const first = await save(mocks, { persistent });
  const second = await save(mocks, { topic: "fixture.schedule", persistent });
  const oneShot = await save(mocks, { procedure: "fixture.once" });
  assert.deepEqual(await mocks.setEnabled(source.tabId, first.token, false), {
    navigation: 0,
    owner: source,
    rule: { ...first, persistent: { enabled: false, revision: 1 } },
  });
  const updated = await save(mocks, {
    topic: second.topic,
    persistent,
    resultBody: "[]",
  });
  await mocks.navigate(source.tabId, source.pageUrl, "reload");
  const worker = new StoredReloadMocks(storage);
  const { rules } = await worker.lookup(replacement);
  assert.deepEqual(
    rules.map(({ token }) => token).sort(),
    [first.token, updated.token, oneShot.token].sort(),
  );
  assert.deepEqual(
    rules.find(({ token }) => token === first.token)?.persistent,
    { enabled: false, revision: 1 },
  );
  assert.equal(await worker.consume(replacement, oneShot.token), true);
  assert.deepEqual(
    (await worker.list(source.tabId)).map(({ rule }) => rule.token).sort(),
    [first.token, updated.token].sort(),
  );
});

test("deletes only the selected persistent mock across reload and worker restart", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const removed = await save(mocks, {
    persistent: { enabled: true, revision: 0 },
  });
  const kept = await save(mocks, {
    topic: "fixture.schedule",
    persistent: { enabled: false, revision: 1 },
  });
  const oneShot = await save(mocks, { procedure: "fixture.once" });

  assert.equal(await mocks.remove(source.tabId, oneShot.token), null);
  assert.deepEqual(
    (await mocks.remove(source.tabId, removed.token)).rule,
    removed,
  );
  assert.equal(await mocks.remove(source.tabId, removed.token), null);
  await mocks.navigate(source.tabId, source.pageUrl, "reload");
  assert.deepEqual(await new StoredReloadMocks(storage).lookup(replacement), {
    rules: [kept, oneShot],
    retry: false,
  });
});

test("a failed persistent mock deletion retains the original snapshot", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const removed = await save(mocks, {
    persistent: { enabled: true, revision: 0 },
  });
  const before = storage.items.get(key);
  const { remove, set } = storage;
  storage.remove = storage.set = async () => {
    throw new Error("Unavailable");
  };

  await assert.rejects(
    mocks.remove(source.tabId, removed.token),
    /delete mock/,
  );
  assert.deepEqual(storage.items.get(key), before);
  assert.deepEqual(
    (await mocks.inspect(source.tabId, removed.token)).rule,
    removed,
  );

  storage.remove = remove;
  storage.set = set;
  assert.deepEqual(
    (await mocks.remove(source.tabId, removed.token)).rule,
    removed,
  );
  assert.equal(storage.items.has(key), false);
});

test("a failed persistent mock deletion does not discard the snapshot for a retained one-shot mock", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const removed = await save(mocks, {
    persistent: { enabled: true, revision: 0 },
  });
  const oneShot = await save(mocks, { procedure: "fixture.once" });
  const before = storage.items.get(key);
  storage.set = async () => {
    throw new Error("Unavailable");
  };

  await assert.rejects(
    mocks.remove(source.tabId, removed.token),
    /Unavailable/,
  );
  assert.deepEqual(storage.items.get(key), before);
  assert.deepEqual(
    (await mocks.list(source.tabId)).map(({ rule }) => rule),
    [removed, oneShot],
  );
});

test("reloads only a pending rule across worker restarts and persists its claim and consumption", async () => {
  const storage = sessionStorage();
  const first = new StoredReloadMocks(storage);
  const rule = await save(first, { privateExtra: "exclude" });
  assert.deepEqual([...storage.items.keys()], [key]);
  const stored = storage.items.get(key);
  assert.equal(stored.entries[0].rule.privateExtra, undefined);
  assert.equal(stored.attempts, undefined);
  storage.items.set(key, {
    version: 1,
    navigation: stored.navigation,
    pending: { ...stored.entries[0], owner: { ...source, frameSlot: "1/0" } },
  });

  const second = new StoredReloadMocks(storage);
  const { privateExtra, ...expected } = rule;
  assert.deepEqual(await second.inspect(source.tabId), {
    owner: source,
    rule: expected,
    navigation: 0,
  });
  assert.equal(await second.resume(source), null);
  assert.deepEqual(await second.lookup(replacement), {
    rules: [],
    retry: true,
  });
  assert.deepEqual(
    await second.lookup({ ...replacement, frameUrl: source.pageUrl }),
    {
      rules: [],
      retry: false,
    },
  );
  await second.navigate(source.tabId, source.pageUrl, "reload");

  const third = new StoredReloadMocks(storage);
  assert.deepEqual(await third.lookup(replacement), {
    rules: [expected],
    retry: false,
  });
  assert.equal(
    storage.items.get(key).entries[0].owner.documentId,
    replacement.documentId,
  );
  assert.equal(await third.consume(source, rule.token), false);

  const fourth = new StoredReloadMocks(storage);
  assert.deepEqual(await fourth.inspect(source.tabId), {
    owner: replacement,
    rule: expected,
    navigation: 1,
  });
  assert.equal(await fourth.resume(replacement), null);
  assert.equal(await fourth.consume(replacement, rule.token), true);
  assert.equal(storage.items.has(key), false);

  const fifth = new StoredReloadMocks(storage);
  await fifth.navigate(source.tabId, source.pageUrl, "reload");
  assert.equal(
    await fifth.resume({ ...replacement, documentId: "later" }),
    null,
  );
});

test("invalid, wrong-tab, and unrelated navigation records are not rehydrated", async () => {
  const storage = sessionStorage();
  storage.items.set("unrelated", { untouched: true });
  const first = new StoredReloadMocks(storage);
  await save(first);
  const valid = structuredClone(storage.items.get(key));
  const badOwner = { ...valid.entries[0].owner, tabId: source.tabId + 1 };
  const badBody = { ...valid.entries[0].rule, resultBody: '{"not":"args"}' };
  for (const pending of [
    { ...valid.entries[0], owner: badOwner },
    { ...valid.entries[0], rule: badBody },
    { ...valid.entries[0], navigation: valid.navigation + 1 },
  ]) {
    storage.items.set(key, { ...valid, entries: [pending] });
    assert.equal(
      await new StoredReloadMocks(storage).resume(replacement),
      null,
    );
    assert.equal(storage.items.has(key), false);
  }
  storage.items.set(key, valid);
  const next = new StoredReloadMocks(storage);
  await next.navigate(source.tabId, source.pageUrl, "link");
  assert.equal(await next.resume(replacement), null);
  assert.equal(storage.items.has(key), false);
  assert.deepEqual(storage.items.get("unrelated"), { untouched: true });
});

test("a clear queued behind a delayed save removes only this tab's persisted rule", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const attempt = await mocks.begin(source);
  const setStarted = Promise.withResolvers();
  const allowSet = Promise.withResolvers();
  const set = storage.set;
  storage.items.set("unrelated", 1);
  storage.set = async (update) => {
    setStarted.resolve();
    await allowSet.promise;
    await set(update);
  };
  const finish = attempt.finish(true, ruleFor(attempt.token));
  await setStarted.promise;
  const inspection = mocks.inspect(source.tabId);
  const clear = mocks.clear(source.tabId);
  allowSet.resolve();
  await finish;
  assert.equal((await inspection)?.rule.token, attempt.token);
  await clear;
  assert.equal(await mocks.inspect(source.tabId), null);
  assert.deepEqual([...storage.items], [["unrelated", 1]]);
  assert.equal(await new StoredReloadMocks(storage).resume(replacement), null);
});

test("a clear while the first lookup is delayed invalidates a subsequent acknowledgement", async () => {
  const storage = sessionStorage();
  const read = storage.get;
  const allowRead = Promise.withResolvers();
  storage.get = async (name) => {
    await allowRead.promise;
    return read(name);
  };
  const mocks = new StoredReloadMocks(storage);
  const beginning = mocks.begin(source);
  const clear = mocks.clear(source.tabId);
  allowRead.resolve();
  const attempt = await beginning;
  await clear;
  await attempt.finish(true, ruleFor(attempt.token));
  assert.equal(storage.items.has(key), false);
  assert.equal(await mocks.resume(replacement), null);
});

test("removes stale storage when saving fails and keeps the current rule in memory", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  await save(mocks);
  storage.set = async () => {
    throw new Error("Session write failed");
  };
  const latest = await save(mocks, { resultBody: "[[]]" });
  assert.equal(storage.items.has(key), false);
  await mocks.navigate(source.tabId, source.pageUrl, "reload");
  assert.deepEqual(await mocks.resume(replacement), latest);
  assert.equal(await new StoredReloadMocks(storage).resume(replacement), null);
});

test("does not deliver a rule if a claim cannot be persisted or its old copy discarded", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  await save(mocks);
  await mocks.navigate(source.tabId, source.pageUrl, "reload");
  storage.set = storage.remove = async () => {
    throw new Error("Unavailable");
  };
  assert.equal(await mocks.resume(replacement), null);
});

test("a failed remove invalidates the stored rule when a session write still works", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const rule = await save(mocks);
  storage.remove = async () => {
    throw new Error("Unavailable");
  };
  assert.equal(await mocks.consume(source, rule.token), true);
  assert.equal(storage.items.get(key), null);
  const next = new StoredReloadMocks(storage);
  await next.navigate(source.tabId, source.pageUrl, "reload");
  assert.equal(await next.resume(replacement), null);
});

test("reports unsuccessful storage deletion and allows a later cleanup to retry", async () => {
  const storage = sessionStorage();
  const mocks = new StoredReloadMocks(storage);
  const discard = storage.remove;
  const set = storage.set;
  const unavailable = async () => {
    throw new Error("Unavailable");
  };

  const consumed = await save(mocks);
  storage.remove = storage.set = unavailable;
  assert.equal(await mocks.consume(source, consumed.token), false);
  assert.equal(storage.items.has(key), true);
  storage.remove = discard;
  await mocks.consume(source, consumed.token);
  assert.equal(storage.items.has(key), false);

  storage.set = set;
  await save(mocks);
  storage.remove = storage.set = unavailable;
  await assert.rejects(mocks.clear(source.tabId), /clear pending mock/);
  assert.equal(storage.items.has(key), true);
  storage.remove = discard;
  await mocks.clear(source.tabId);
  assert.equal(storage.items.has(key), false);
});
