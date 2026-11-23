import { ReloadMocks } from "./reload-mocks.js";

/** @typedef {Parameters<ReloadMocks["begin"]>[0]} MockDocument */
/** @typedef {import("../shared/capture-contracts.js").ReloadMockRule} ReloadRule */
/** @typedef {ReturnType<ReloadMocks["snapshot"]>} Snapshot */
/** @typedef {Pick<chrome.storage.StorageArea, "get" | "set" | "remove">} SessionStorage */

/** @param {number} tabId */
function storageKey(tabId) {
  return `wamp.pendingReloadMock.${tabId}`;
}

export class StoredReloadMocks {
  #mocks = new ReloadMocks();
  /** @type {SessionStorage} */
  #storage;
  /** @type {Map<number, Promise<void>>} */
  #operations = new Map();
  /** @type {Set<number>} */
  #hydrated = new Set();
  /** @type {Set<number>} */
  #possiblyStored = new Set();

  /** @param {SessionStorage} storage */
  constructor(storage) {
    this.#storage = storage;
  }

  /** @param {MockDocument} scope */
  async begin(scope) {
    const { result: attempt } = await this.#transition(scope.tabId, () =>
      this.#mocks.begin(scope),
    );
    return {
      token: attempt.token,
      /** @param {boolean} ok @param {ReloadRule} [rule] */
      finish: async (ok, rule) => {
        const { result } = await this.#transition(scope.tabId, () =>
          attempt.finish(ok, rule),
        );
        return result;
      },
    };
  }

  /** @param {MockDocument} scope */
  async resume(scope) {
    return (await this.lookup(scope)).rules[0] ?? null;
  }

  /** @param {MockDocument} scope */
  async lookup(scope) {
    const { result, persisted } = await this.#transition(scope.tabId, () =>
      this.#mocks.lookup(scope),
    );
    return persisted ? result : { rules: [], retry: false };
  }

  /** @param {number} tabId @param {string} [token] */
  inspect(tabId, token) {
    return this.#enqueue(tabId, async () => {
      await this.#hydrate(tabId);
      return this.#mocks.inspect(tabId, token);
    });
  }

  /** @param {number} tabId */
  list(tabId) {
    return this.#enqueue(tabId, async () => {
      await this.#hydrate(tabId);
      return this.#mocks.list(tabId);
    });
  }

  /** @param {number} tabId @param {string} token @param {boolean} enabled */
  async setEnabled(tabId, token, enabled) {
    const { result } = await this.#transition(tabId, () =>
      this.#mocks.setEnabled(tabId, token, enabled),
    );
    return result;
  }

  /** @param {number} tabId @param {string} token */
  async remove(tabId, token) {
    const { result } = await this.#transition(
      tabId,
      () => this.#mocks.remove(tabId, token),
      { requirePersistence: true },
    );
    return result;
  }

  /** @param {MockDocument} scope @param {string} token */
  async consume(scope, token) {
    const { result, persisted } = await this.#transition(
      scope.tabId,
      () => this.#mocks.consume(scope, token),
      { discardWhenEmpty: true },
    );
    return result && persisted;
  }

  /** @param {Parameters<ReloadMocks["updateRoute"]>[0]} change */
  async updateRoute(change) {
    await this.#transition(change.tabId, () => this.#mocks.updateRoute(change));
  }

  /** @param {number} tabId @param {string | undefined} url @param {string | undefined} transitionType @param {string} [documentId] */
  async navigate(tabId, url, transitionType, documentId) {
    await this.#transition(
      tabId,
      () => this.#mocks.navigate(tabId, url, transitionType, documentId),
      { discardWhenEmpty: url !== undefined },
    );
  }

  /** @param {number} tabId @param {boolean} [preservePersistent] */
  clear(tabId, preservePersistent) {
    return this.#transition(
      tabId,
      () => {
        this.#mocks.clear(tabId, preservePersistent);
      },
      { discardWhenEmpty: true },
    ).then(({ persisted }) => {
      if (!persisted)
        throw new Error("Could not clear pending mock from session storage.");
      if (!preservePersistent && !this.#possiblyStored.has(tabId))
        this.#hydrated.delete(tabId);
    });
  }

  /**
   * @template T
   * @param {number} tabId
   * @param {() => Promise<T>} operation
   */
  #enqueue(tabId, operation) {
    const previous = this.#operations.get(tabId) ?? Promise.resolve();
    const next = previous.then(operation);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.#operations.set(tabId, tail);
    void tail.then(() => {
      if (this.#operations.get(tabId) === tail) this.#operations.delete(tabId);
    });
    return next;
  }

  /**
   * @template T
   * @param {number} tabId
   * @param {() => T} mutate
   * @param {{discardWhenEmpty?: boolean, requirePersistence?: boolean}} [options]
   */
  #transition(
    tabId,
    mutate,
    { discardWhenEmpty = false, requirePersistence = false } = {},
  ) {
    return this.#enqueue(tabId, async () => {
      await this.#hydrate(tabId);
      const before = this.#mocks.snapshot(tabId);
      const result = mutate();
      const after = this.#mocks.snapshot(tabId);
      const changed =
        before?.entries !== after?.entries ||
        before?.pageUrl !== after?.pageUrl ||
        before?.navigation !== after?.navigation;
      try {
        const strictWrite =
          requirePersistence ||
          (after?.entries.some(({ rule }) => rule.persistent) ?? false);
        const persisted =
          changed || (discardWhenEmpty && !after)
            ? await this.#persist(tabId, after, strictWrite)
            : true;
        if (requirePersistence && !persisted)
          throw new Error("Could not delete mock from session storage.");
        return { result, persisted };
      } catch (error) {
        if (before) this.#mocks.hydrate(tabId, before);
        else this.#mocks.clear(tabId);
        throw error;
      }
    });
  }

  /** @param {number} tabId */
  async #hydrate(tabId) {
    if (this.#hydrated.has(tabId)) return;
    this.#hydrated.add(tabId);
    const key = storageKey(tabId);
    try {
      const items = await this.#storage.get(key);
      if (!Object.hasOwn(items, key)) return;
      this.#possiblyStored.add(tabId);
      if (!this.#mocks.hydrate(tabId, items[key])) await this.#discard(tabId);
    } catch {
      // A read failure must not leave an unknown old rule available for reuse.
      this.#possiblyStored.add(tabId);
      await this.#discard(tabId);
    }
  }

  /** @param {number} tabId @param {Snapshot} snapshot @param {boolean} strictWrite */
  async #persist(tabId, snapshot, strictWrite) {
    if (!snapshot) return this.#discard(tabId);
    this.#possiblyStored.add(tabId);
    try {
      await this.#storage.set({ [storageKey(tabId)]: snapshot });
      return true;
    } catch (error) {
      if (strictWrite) throw error;
      // A failed write may leave an older copy behind.
      return this.#discard(tabId);
    }
  }

  /** @param {number} tabId */
  async #discard(tabId) {
    if (!this.#possiblyStored.has(tabId)) return true;
    const key = storageKey(tabId);
    try {
      await this.#storage.remove(key);
    } catch {
      try {
        // If removal is unavailable, replace any old rule with an invalid entry.
        await this.#storage.set({ [key]: null });
      } catch {
        return false;
      }
    }
    this.#possiblyStored.delete(tabId);
    return true;
  }
}
