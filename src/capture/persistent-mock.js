/** @typedef {NonNullable<ReturnType<import("./reload-mocks.js").ReloadMocks["inspect"]>>} PendingMock */

/** @param {import("./reload-mocks.js").ReloadMocks | import("./reload-mock-storage.js").StoredReloadMocks} mocks */
export function watchMockRoutes(mocks) {
  chrome.webNavigation.onHistoryStateUpdated?.addListener((details) => {
    if (details.documentLifecycle !== "active") return;
    void Promise.resolve(mocks.updateRoute(details)).catch(() => {
      console.warn("WAMP Inspector: could not save the new mock route.");
    });
  });
}

/** @param {import("./reload-mocks.js").ReloadMocks | import("./reload-mock-storage.js").StoredReloadMocks} mocks @param {chrome.webNavigation.WebNavigationTransitionCallbackDetails} page */
export function commitMockPage(
  mocks,
  { tabId, url, transitionType, documentId },
) {
  void Promise.resolve(
    mocks.navigate(tabId, url, transitionType, documentId),
  ).catch(() => {
    console.warn("WAMP Inspector: could not save mock navigation.");
  });
}

/** @type {Map<number, Promise<void>>} */
const mockEdits = new Map();

/** @template T @param {number} tabId @param {() => Promise<T>} edit */
export function runMockEdit(tabId, edit) {
  const operation = (mockEdits.get(tabId) ?? Promise.resolve()).then(edit);
  const settled = operation.then(
    () => {},
    () => {},
  );
  mockEdits.set(tabId, settled);
  void settled.then(() => {
    if (mockEdits.get(tabId) === settled) mockEdits.delete(tabId);
  });
  return operation;
}

/** @param {PendingMock} entry @param {boolean} [retire] */
export async function syncPersistentMock({ owner, rule }, retire = false) {
  if (!rule.persistent) return false;
  const configuration = retire
    ? {
        ...rule,
        persistent: { enabled: false, revision: rule.persistent.revision + 1 },
      }
    : rule;
  try {
    const reply = await chrome.tabs.sendMessage(
      owner.tabId,
      { type: "sync-persistent-mock", rule: configuration },
      { documentId: owner.documentId },
    );
    return reply?.ok === true;
  } catch {
    // A replacement document retrieves the saved setting at document_start.
    return false;
  }
}

/** @param {PendingMock} entry */
export async function retireMock(entry) {
  if (entry.rule.persistent) return syncPersistentMock(entry, true);
  const { owner, rule } = entry;
  try {
    await chrome.tabs.sendMessage(
      owner.tabId,
      { type: "cancel-one-shot-mock", token: rule.token },
      { documentId: owner.documentId },
    );
  } catch {
    // The original document has already been replaced.
  }
}
