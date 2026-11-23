/** @typedef {import("../shared/capture-contracts.js").ReloadMockRule} ReloadRule */
/** @typedef {{tabId: number, pageUrl: string, frameUrl: string, frameId: number, documentId: string, pageDocumentId?: string}} MockDocument */
/** @typedef {Pick<chrome.webNavigation.WebNavigationFramedCallbackDetails, "tabId" | "frameId" | "documentId" | "url">} MockRouteChange */
/** @typedef {{scope: MockDocument, order: number, consumed: boolean}} Attempt */
/** @typedef {{rule: ReloadRule, owner: MockDocument, navigation: number}} PendingMock */
/** @typedef {{pageUrl: string, navigation: number, lastAccepted: number, entries: PendingMock[], attempts: Map<string, Attempt>}} TabMocks */
/** @typedef {{version: 2, pageUrl: string, navigation: number, entries: PendingMock[]}} ReloadMockSnapshot */
/** @typedef {import("../shared/capture-contracts.js").SocketSummary} SocketSummary */

const MAX_BODY_CHARACTERS = 1_048_576;
const MAX_CALL_NAME_CHARACTERS = 16 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isIndex(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {string | undefined} address */
function pageAddress(address) {
  if (!address) return null;
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** @param {string} address */
function frameAddressWithoutQuery(address) {
  const url = new URL(address);
  url.search = "";
  return url.href;
}

/** @param {chrome.runtime.MessageSender} sender @param {string} extensionId @returns {MockDocument | null} */
export function readMockDocument(sender, extensionId) {
  const tabId = sender.tab?.id;
  const { frameId, documentId } = sender;
  const pageUrl = pageAddress(sender.tab?.url);
  const frameUrl = pageAddress(sender.url);
  if (
    !extensionId ||
    sender.id !== extensionId ||
    !isIndex(tabId) ||
    !isIndex(frameId) ||
    !documentId ||
    !pageUrl ||
    !frameUrl ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active")
  )
    return null;
  return { tabId, frameId, documentId, pageUrl, frameUrl };
}

/** @param {MockDocument} scope @returns {Promise<MockDocument | null>} */
export async function refreshMockDocument(scope) {
  const { tabId, frameId, documentId } = scope;
  try {
    // The socket's sender URL can predate a same-document history update.
    const source = chrome.webNavigation.getFrame({
      tabId,
      frameId,
      documentId,
    });
    const main =
      frameId === 0
        ? source
        : chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    const [frame, page] = await Promise.all([source, main]);
    if (
      frame?.documentId !== documentId ||
      frame.documentLifecycle !== "active" ||
      page?.documentLifecycle !== "active"
    )
      return null;
    const pageUrl = pageAddress(page.url);
    const frameUrl = pageAddress(frame.url);
    return pageUrl && frameUrl
      ? {
          ...scope,
          pageUrl,
          frameUrl,
          ...(page.documentId ? { pageDocumentId: page.documentId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** @param {MockDocument} first @param {MockDocument} second */
function sameDocument(first, second) {
  return (
    first.frameId === second.frameId && first.documentId === second.documentId
  );
}

/** @param {unknown} rule @param {string} token @returns {rule is ReloadRule} */
function validRule(rule, token) {
  if (
    !isRecord(rule) ||
    rule.token !== token ||
    typeof rule.endpoint !== "string" ||
    typeof rule.procedure !== "string" ||
    !rule.procedure ||
    (rule.topic !== null && typeof rule.topic !== "string") ||
    rule.procedure.length + (rule.topic?.length ?? 0) >
      MAX_CALL_NAME_CHARACTERS ||
    typeof rule.resultBody !== "string" ||
    rule.resultBody.length > MAX_BODY_CHARACTERS ||
    (rule.persistent !== undefined &&
      (!isRecord(rule.persistent) ||
        typeof rule.persistent.enabled !== "boolean" ||
        !isIndex(rule.persistent.revision)))
  )
    return false;
  try {
    const { protocol } = new URL(rule.endpoint);
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

/** @param {ReloadRule} rule */
function copyRule({
  token,
  endpoint,
  procedure,
  topic,
  resultBody,
  persistent,
}) {
  return {
    token,
    endpoint,
    procedure,
    topic,
    resultBody,
    ...(persistent ? { persistent: { ...persistent } } : {}),
  };
}

/** @param {unknown} raw @param {number} tabId @returns {MockDocument | null} */
function readSnapshotOwner(raw, tabId) {
  if (!isRecord(raw)) return null;
  const { pageUrl, frameUrl, frameId, documentId, pageDocumentId } = raw;
  if (
    raw.tabId !== tabId ||
    !isIndex(frameId) ||
    typeof documentId !== "string" ||
    !documentId ||
    (pageDocumentId !== undefined &&
      (typeof pageDocumentId !== "string" || !pageDocumentId)) ||
    typeof pageUrl !== "string" ||
    pageAddress(pageUrl) !== pageUrl ||
    typeof frameUrl !== "string" ||
    pageAddress(frameUrl) !== frameUrl
  )
    return null;

  return {
    tabId,
    pageUrl,
    frameUrl,
    frameId,
    documentId,
    ...(pageDocumentId ? { pageDocumentId } : {}),
  };
}

/** @param {unknown} value @returns {ReloadRule | null} */
function readSnapshotRule(value) {
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    !UUID.test(value.token) ||
    !validRule(value, value.token)
  )
    return null;
  try {
    const body = JSON.parse(value.resultBody);
    if (
      !Array.isArray(body) ||
      body.length > 2 ||
      (body.length >= 1 && !Array.isArray(body[0])) ||
      (body.length === 2 && !isRecord(body[1]))
    )
      return null;
    JSON.stringify(body);
    structuredClone(body);
  } catch {
    return null;
  }
  return copyRule(value);
}

/** @param {unknown} value @param {number} tabId @param {number} navigation */
function readSnapshotEntry(value, tabId, navigation) {
  if (
    !isRecord(value) ||
    !isIndex(value.navigation) ||
    value.navigation > navigation
  )
    return null;
  const owner = readSnapshotOwner(value.owner, tabId);
  const rule = readSnapshotRule(value.rule);
  return owner && rule ? { owner, rule, navigation: value.navigation } : null;
}

/** @param {ReloadRule} rule @param {ReloadRule | undefined} candidate */
function sameMockTarget(rule, candidate) {
  if (!rule.persistent) return !candidate?.persistent;
  return Boolean(candidate?.persistent && sameCallTarget(rule, candidate));
}

/** @param {ReloadRule} first @param {ReloadRule} second */
function sameCallTarget(first, second) {
  return first.procedure === second.procedure && first.topic === second.topic;
}

/** @param {MockDocument} owner @param {MockDocument} scope */
function isReplacementDocument(owner, scope) {
  if (
    owner.pageUrl !== scope.pageUrl ||
    (owner.frameId === 0) !== (scope.frameId === 0) ||
    owner.documentId === scope.documentId
  )
    return false;
  return (
    owner.frameUrl === scope.frameUrl ||
    (scope.frameId !== 0 &&
      frameAddressWithoutQuery(owner.frameUrl) ===
        frameAddressWithoutQuery(scope.frameUrl))
  );
}

/**
 * @param {PendingMock | null} pending
 * @param {{documentId: string, token: string} | undefined} ready
 * @param {Iterable<Pick<SocketSummary, "documentId" | "frameId" | "state" | "protocol">>} sockets
 * @returns {import("../shared/capture-contracts.js").PendingMockStatus | null}
 */
export function describeMockStatus(pending, ready, sockets) {
  if (!pending) return null;
  const { rule, owner } = pending;
  const { endpoint, procedure, topic, persistent } = rule;
  const target = {
    endpoint,
    procedure,
    topic,
    ...(persistent ? { token: rule.token } : {}),
  };
  if (persistent?.enabled === false) return { ...target, state: "disabled" };
  if (ready?.token !== rule.token || ready.documentId !== owner.documentId)
    return { ...target, state: "saved" };

  const connected = Array.from(sockets).some(
    (socket) =>
      socket.documentId === owner.documentId &&
      socket.frameId === owner.frameId &&
      socket.state === "OPEN" &&
      socket.protocol === "wamp.2.json",
  );
  return {
    state: connected ? "waiting-call" : "waiting-socket",
    ...target,
  };
}

export class MockReadiness {
  /** @type {Map<number, Map<string, {documentId: string, token: string, ready: boolean, revision?: number}>>} */
  #markers = new Map();

  /** @param {PendingMock | null} pending @param {MockDocument} scope @param {string} token @param {boolean} ready @param {number} [revision] */
  record(pending, scope, token, ready, revision) {
    if (
      pending?.rule.token !== token ||
      pending.rule.persistent?.revision !== revision ||
      pending.owner.tabId !== scope.tabId ||
      !sameDocument(pending.owner, scope)
    )
      return false;
    const { tabId, documentId } = scope;
    const markers = this.#markers.get(tabId) ?? new Map();
    const previous = markers.get(token);
    if (
      ready &&
      previous?.token === token &&
      previous.documentId === documentId &&
      previous.revision === revision &&
      !previous.ready
    )
      return false;
    markers.set(token, { documentId, token, ready, revision });
    this.#markers.set(tabId, markers);
    return true;
  }

  /** @param {number} tabId @param {PendingMock | null} pending @param {Parameters<typeof describeMockStatus>[2]} sockets */
  describe(tabId, pending, sockets) {
    const marker = pending
      ? this.#markers.get(tabId)?.get(pending.rule.token)
      : undefined;
    return describeMockStatus(
      pending,
      marker?.ready && marker.revision === pending?.rule.persistent?.revision
        ? marker
        : undefined,
      sockets,
    );
  }

  /** @param {number} tabId @param {string} [token] */
  clear(tabId, token) {
    if (token === undefined) this.#markers.delete(tabId);
    else this.#markers.get(tabId)?.delete(token);
  }

  /** @param {number} tabId @param {string | undefined} documentId */
  navigate(tabId, documentId) {
    for (const marker of this.#markers.get(tabId)?.values() ?? [])
      if (marker.documentId !== documentId) this.clear(tabId, marker.token);
  }
}

export class ReloadMocks {
  /** @type {Map<number, TabMocks>} */
  #tabs = new Map();
  #order = 0;

  /** @param {MockDocument} scope */
  begin(scope) {
    const { tabId, pageUrl } = scope;
    let tab = this.#tabs.get(tabId);
    if (!tab) {
      tab = {
        pageUrl,
        navigation: 0,
        lastAccepted: 0,
        entries: [],
        attempts: new Map(),
      };
      this.#tabs.set(tabId, tab);
    }
    const token = crypto.randomUUID();
    const attempt = { scope, order: ++this.#order, consumed: false };
    const navigation = tab.navigation;
    tab.attempts.set(token, attempt);

    return {
      token,
      /** @param {boolean} ok @param {ReloadRule} [rule] */
      finish: (ok, rule) => {
        if (!tab.attempts.delete(token)) return;
        if (
          !ok ||
          this.#tabs.get(tabId) !== tab ||
          (rule && !validRule(rule, token)) ||
          attempt.order < tab.lastAccepted
        )
          return;
        tab.lastAccepted = attempt.order;
        tab.pageUrl = pageUrl;
        const replaced = new Set(
          tab.entries.filter(
            (entry) =>
              sameMockTarget(entry.rule, rule) ||
              (rule?.persistent &&
                !entry.rule.persistent &&
                sameCallTarget(entry.rule, rule)),
          ),
        );
        const entries = tab.entries.filter((entry) => !replaced.has(entry));
        tab.entries =
          !attempt.consumed && rule
            ? [...entries, { rule: copyRule(rule), owner: scope, navigation }]
            : entries;
        return Array.from(replaced);
      },
    };
  }

  /** @param {MockDocument} scope */
  resume(scope) {
    return this.lookup(scope).rules[0] ?? null;
  }

  /** @param {MockDocument} scope @returns {{rules: ReloadRule[], retry: boolean}} */
  lookup(scope) {
    const tab = this.#tabs.get(scope.tabId);
    if (
      !tab ||
      tab.pageUrl !== scope.pageUrl ||
      tab.entries.some(({ owner }) => sameDocument(owner, scope))
    )
      return { rules: [], retry: false };
    const eligible = tab.entries.filter(({ owner }) =>
      isReplacementDocument(owner, scope),
    );
    // Changing frame IDs or query strings requires a confirmed top-level reload.
    const claimable = eligible.filter(
      ({ owner, navigation }) =>
        navigation !== tab.navigation ||
        (scope.frameId !== 0 &&
          owner.frameId === scope.frameId &&
          owner.frameUrl === scope.frameUrl),
    );
    const original =
      claimable.find(({ owner }) => owner.frameUrl === scope.frameUrl) ??
      claimable[0];
    if (!original) return { rules: [], retry: eligible.length > 0 };

    // Restore rules from one source document together. Sibling iframes can share a path.
    const claimed = new Set(
      claimable.filter(({ owner }) => sameDocument(original.owner, owner)),
    );
    tab.entries = tab.entries.map((entry) => {
      if (!claimed.has(entry)) return entry;
      const pageDocumentId = entry.rule.persistent
        ? entry.owner.pageDocumentId
        : undefined;
      return {
        ...entry,
        owner: pageDocumentId ? { ...scope, pageDocumentId } : scope,
        navigation: tab.navigation,
      };
    });
    return { rules: Array.from(claimed, ({ rule }) => rule), retry: false };
  }

  /** @param {number} tabId @param {string} [token] @returns {PendingMock | null} */
  inspect(tabId, token) {
    const entries = this.list(tabId);
    return (
      (token === undefined
        ? entries.at(-1)
        : entries.find(({ rule }) => rule.token === token)) ?? null
    );
  }

  /** @param {number} tabId */
  list(tabId) {
    return this.#tabs.get(tabId)?.entries ?? [];
  }

  /** @param {number} tabId @param {string} token @param {boolean} enabled */
  setEnabled(tabId, token, enabled) {
    const tab = this.#tabs.get(tabId);
    const pending = this.inspect(tabId, token);
    if (!tab || !pending?.rule.persistent) return null;
    const { persistent } = pending.rule;
    if (persistent.enabled === enabled) return pending;
    const rule = {
      ...pending.rule,
      persistent: { enabled, revision: persistent.revision + 1 },
    };
    const next = { ...pending, rule };
    tab.entries = tab.entries.map((entry) =>
      entry === pending ? next : entry,
    );
    return next;
  }

  /** @param {number} tabId @param {string} token */
  remove(tabId, token) {
    const tab = this.#tabs.get(tabId);
    const entry = this.inspect(tabId, token);
    if (!tab || !entry?.rule.persistent) return null;

    tab.entries = tab.entries.filter((saved) => saved !== entry);
    return entry;
  }

  /** @param {MockDocument} scope @param {string} token */
  consume(scope, token) {
    const tab = this.#tabs.get(scope.tabId);
    if (!tab) return false;

    const attempt = tab.attempts.get(token);
    if (attempt && sameDocument(attempt.scope, scope)) {
      attempt.consumed = true;
      return true;
    }
    const pending = this.inspect(scope.tabId, token);
    if (
      !pending ||
      pending.rule.persistent ||
      !sameDocument(pending.owner, scope)
    )
      return false;

    tab.entries = tab.entries.filter((entry) => entry !== pending);
    return true;
  }

  /** @param {MockRouteChange} change */
  updateRoute({ tabId, frameId, documentId, url }) {
    const tab = this.#tabs.get(tabId);
    const address = pageAddress(url);
    if (!tab || !address || !documentId) return;
    const entries = tab.entries.map((entry) => {
      if (!entry.rule.persistent) return entry;
      const { owner } = entry;
      const top = frameId === 0 && owner.pageDocumentId === documentId;
      const frame =
        frameId === owner.frameId &&
        owner.documentId === documentId &&
        entry.navigation === tab.navigation;
      const pageUrl = top ? address : owner.pageUrl;
      const frameUrl = frame ? address : owner.frameUrl;
      if (top) tab.pageUrl = pageUrl;
      return pageUrl === owner.pageUrl && frameUrl === owner.frameUrl
        ? entry
        : { ...entry, owner: { ...owner, pageUrl, frameUrl } };
    });
    if (entries.some((entry, index) => entry !== tab.entries[index]))
      tab.entries = entries;
  }

  /** @param {number} tabId @param {string | undefined} url @param {string | undefined} transitionType @param {string} [documentId] */
  navigate(tabId, url, transitionType, documentId) {
    const tab = this.#tabs.get(tabId);
    if (!tab || url === undefined) return;
    if (transitionType !== "reload" || tab.pageUrl !== pageAddress(url)) {
      this.clear(tabId);
      return;
    }
    tab.navigation++;
    tab.entries = tab.entries
      .filter(({ owner }) => owner.pageUrl === tab.pageUrl)
      .map((entry) =>
        entry.rule.persistent && documentId
          ? { ...entry, owner: { ...entry.owner, pageDocumentId: documentId } }
          : entry,
      );
  }

  /** @param {number} tabId @param {boolean} [preservePersistent] */
  clear(tabId, preservePersistent = false) {
    const tab = this.#tabs.get(tabId);
    if (preservePersistent && tab) {
      tab.attempts.clear();
      const persistent = tab.entries.filter(({ rule }) => rule.persistent);
      if (persistent.length) {
        if (persistent.length !== tab.entries.length) tab.entries = persistent;
        return;
      }
    }
    this.#tabs.delete(tabId);
  }

  /** @param {number} tabId @returns {ReloadMockSnapshot | null} */
  snapshot(tabId) {
    const tab = this.#tabs.get(tabId);
    return tab?.entries.length
      ? {
          version: 2,
          pageUrl: tab.pageUrl,
          navigation: tab.navigation,
          entries: tab.entries,
        }
      : null;
  }

  /** @param {number} tabId @param {unknown} value */
  hydrate(tabId, value) {
    if (!isRecord(value) || !isIndex(value.navigation)) return false;
    const { navigation } = value;
    const rawEntries =
      value.version === 1
        ? [value.pending]
        : value.version === 2
          ? value.entries
          : null;
    if (!Array.isArray(rawEntries) || !rawEntries.length) return false;
    /** @type {PendingMock[]} */
    const entries = [];
    for (const raw of rawEntries) {
      const entry = readSnapshotEntry(raw, tabId, navigation);
      if (
        !entry ||
        entries.some(
          ({ rule }) =>
            rule.token === entry.rule.token || sameMockTarget(rule, entry.rule),
        )
      )
        return false;
      entries.push(entry);
    }
    const pageUrl =
      value.version === 1 ? entries[0].owner.pageUrl : value.pageUrl;
    if (typeof pageUrl !== "string" || pageAddress(pageUrl) !== pageUrl)
      return false;
    this.#tabs.set(tabId, {
      pageUrl,
      navigation,
      lastAccepted: 0,
      entries,
      attempts: new Map(),
    });
    return true;
  }
}
