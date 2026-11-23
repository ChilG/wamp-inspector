import { readWampFrame } from "../shared/wamp-frame.js";
import {
  FrameHistory,
  beginMockSave,
  withSavedMock,
} from "./capture-history.js";
import {
  commitMockPage,
  retireMock,
  runMockEdit,
  syncPersistentMock,
  watchMockRoutes,
} from "./persistent-mock.js";
import { StoredReloadMocks } from "./reload-mock-storage.js";
import {
  MockReadiness,
  readMockDocument,
  refreshMockDocument,
  ReloadMocks,
} from "./reload-mocks.js";

/** @typedef {import("../shared/capture-contracts.js").CapturedFrame} CapturedFrame */
/** @typedef {import("../shared/capture-contracts.js").CapturePortRequest} CapturePortRequest */
/** @typedef {import("../shared/capture-contracts.js").CaptureResponses} CaptureResponses */
/** @typedef {import("../shared/capture-contracts.js").CaptureUpdate} CaptureUpdate */
/** @typedef {import("../shared/capture-contracts.js").SocketSummary} SocketSummary */
/** @typedef {import("../shared/capture-contracts.js").WorkerMessage} WorkerMessage */
/** @typedef {NonNullable<ReturnType<typeof readMockDocument>>} MockDocument */
/** @typedef {Extract<WorkerMessage, {type: "arm-mock-response"}>} ArmMockResponseRequest */
/** @typedef {Extract<WorkerMessage, {type: "get-mock-response"}>} GetMockResponseRequest */
/** @typedef {Omit<import("../shared/capture-contracts.js").SocketDetail, "messageCount" | "messages"> & {history: FrameHistory, savedMocks: Map<string, string | null>, reloadDocument: ReturnType<typeof readMockDocument>}} SocketRecord */
/** @typedef {{connections: boolean, allMessages: boolean, socketKeys: Set<string>}} PendingCaptureUpdate */

/** @type {Map<number, Map<string, SocketRecord>>} */
const socketsByTab = new Map();
const reloadMocks = chrome.storage?.session
  ? new StoredReloadMocks(chrome.storage.session)
  : new ReloadMocks();
watchMockRoutes(reloadMocks);
const mockReadiness = new MockReadiness();
const extensionId = chrome.runtime.id;
const MAX_MOCK_BODY_CHARACTERS = 1_048_576;
const CAPTURE_UPDATE_DELAY = 32;
/** @type {Map<number, Set<chrome.runtime.Port>>} */
const subscribersByTab = new Map();
/** @type {Map<number, PendingCaptureUpdate>} */
const pendingCaptureUpdates = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let captureUpdateTimer = null;

/** @param {number} tabId @param {chrome.runtime.Port} port */
function removeSubscriber(tabId, port) {
  const subscribers = subscribersByTab.get(tabId);
  if (!subscribers) return;
  subscribers.delete(port);
  if (subscribers.size === 0) {
    subscribersByTab.delete(tabId);
    pendingCaptureUpdates.delete(tabId);
  }
}

/** @param {number} tabId @param {chrome.runtime.Port} port @param {CaptureUpdate} update */
function postCaptureUpdate(tabId, port, update) {
  try {
    port.postMessage(update);
  } catch {
    // The panel can close after the batch was queued.
    removeSubscriber(tabId, port);
  }
}

function flushCaptureUpdates() {
  captureUpdateTimer = null;
  const pending = Array.from(pendingCaptureUpdates);
  pendingCaptureUpdates.clear();
  for (const [tabId, change] of pending) {
    /** @type {CaptureUpdate} */
    const update = {
      ...change,
      type: "capture-updated",
      socketKeys: Array.from(change.socketKeys),
    };
    for (const port of subscribersByTab.get(tabId) ?? [])
      postCaptureUpdate(tabId, port, update);
  }
}

/** @param {number} tabId @param {{connections?: boolean, allMessages?: boolean, socketKey?: string}} [change] */
function queueCaptureUpdate(
  tabId,
  { connections = false, allMessages = false, socketKey } = {},
) {
  if (!subscribersByTab.has(tabId)) return;
  const queued = pendingCaptureUpdates.get(tabId);
  const socketKeys = queued?.socketKeys ?? new Set();
  pendingCaptureUpdates.set(tabId, {
    connections: connections || queued?.connections === true,
    allMessages: allMessages || queued?.allMessages === true,
    socketKeys:
      socketKey && !socketKeys.has(socketKey)
        ? new Set([...socketKeys, socketKey])
        : socketKeys,
  });
  if (captureUpdateTimer === null)
    captureUpdateTimer = setTimeout(flushCaptureUpdates, CAPTURE_UPDATE_DELAY);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "wamp-capture") return;
  /** @type {number | null} */
  let tabId = null;
  port.onMessage.addListener(
    /** @param {CapturePortRequest | undefined} message */ (message) => {
      if (
        tabId !== null ||
        message?.type !== "subscribe" ||
        !Number.isInteger(message.tabId) ||
        message.tabId < 0
      )
        return;
      tabId = message.tabId;
      const subscribers = subscribersByTab.get(tabId) ?? new Set();
      subscribers.add(port);
      subscribersByTab.set(tabId, subscribers);
      postCaptureUpdate(tabId, port, { type: "capture-ready" });
    },
  );
  port.onDisconnect.addListener(() => {
    if (tabId !== null) removeSubscriber(tabId, port);
  });
});

/** @param {number} tabId */
function getTabStore(tabId) {
  let store = socketsByTab.get(tabId);
  if (!store) {
    store = new Map();
    socketsByTab.set(tabId, store);
  }
  return store;
}

/** @param {number} frameId @param {number} socketId @param {string | null} [documentId] */
function makeSocketKey(frameId, socketId, documentId) {
  const key = `${frameId}:${socketId}`;
  return documentId ? `${key}:${documentId}` : key;
}

/** @param {SocketRecord} socketInfo */
function hasWampSubprotocol(socketInfo) {
  const protocolValues = [socketInfo.protocol, socketInfo.requestedProtocols]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return protocolValues.some(
    (value) => value === "wamp" || value.startsWith("wamp."),
  );
}

/** @param {number} tabId @param {number} frameId @param {number} socketId @param {string | null} documentId */
function getSocketRecord(tabId, frameId, socketId, documentId) {
  const socketStore = getTabStore(tabId);
  const socketKey = makeSocketKey(frameId, socketId, documentId);
  const previous = socketStore.get(socketKey);

  if (previous) {
    return { socketStore, socketKey, record: previous };
  }

  /** @type {SocketRecord} */
  const record = {
    id: socketId,
    frameId,
    documentId,
    tabId,
    url: "",
    state: "UNKNOWN",
    createdAt: "",
    protocol: "",
    requestedProtocols: "",
    extensions: "",
    eventType: "created",
    updatedAt: "",
    history: new FrameHistory(),
    savedMocks: new Map(),
    reloadDocument: null,
    lastMessageAt: "",
    mockSourceMessageId: null,
  };

  socketStore.set(socketKey, record);
  return { socketStore, socketKey, record };
}

/** @param {SocketRecord} socketInfo @returns {SocketSummary} */
function toSocketSummary(socketInfo) {
  return {
    id: socketInfo.id,
    frameId: socketInfo.frameId,
    documentId: socketInfo.documentId,
    tabId: socketInfo.tabId,
    url: socketInfo.url,
    state: socketInfo.state,
    createdAt: socketInfo.createdAt,
    protocol: socketInfo.protocol,
    requestedProtocols: socketInfo.requestedProtocols,
    extensions: socketInfo.extensions,
    eventType: socketInfo.eventType,
    updatedAt: socketInfo.updatedAt,
    messageCount: socketInfo.history.size,
    lastMessageAt: socketInfo.lastMessageAt || "",
    mockSourceMessageId: socketInfo.mockSourceMessageId ?? null,
  };
}

/** @param {number} tabId @param {string} socketKey @param {number | null | undefined} source */
function updateMockSource(tabId, socketKey, source) {
  const socketStore = socketsByTab.get(tabId);
  const socket = socketStore?.get(socketKey);
  if (
    !socketStore ||
    socket?.state !== "OPEN" ||
    socket.documentEnded ||
    socket.protocol !== "wamp.2.json" ||
    (source !== null &&
      (typeof source !== "number" ||
        !Number.isSafeInteger(source) ||
        source < 1))
  ) {
    return false;
  }
  if (socket.mockSourceMessageId !== source) {
    socketStore.set(socketKey, { ...socket, mockSourceMessageId: source });
    queueCaptureUpdate(tabId, { connections: true, socketKey });
  }
  return true;
}

/** @param {MockDocument} scope @param {string} token @param {boolean} [ready] @param {number} [revision] */
async function markMockReady(scope, token, ready = true, revision) {
  const pending = await reloadMocks.inspect(scope.tabId, token);
  const accepted = mockReadiness.record(pending, scope, token, ready, revision);
  if (accepted) queueCaptureUpdate(scope.tabId, { connections: true });
  return accepted;
}

/** @param {number} tabId @param {string} token @param {boolean} enabled */
function setMockEnabled(tabId, token, enabled) {
  return runMockEdit(tabId, async () => {
    const pending = await reloadMocks.setEnabled(tabId, token, enabled);
    if (!pending) return { ok: false };
    if (await syncPersistentMock(pending))
      await markMockReady(
        pending.owner,
        token,
        enabled,
        pending.rule.persistent?.revision,
      );
    queueCaptureUpdate(tabId, { connections: true });
    return { ok: true };
  });
}

/** @param {number} tabId @param {string} token */
function deleteMock(tabId, token) {
  return runMockEdit(tabId, async () => {
    const removed = await reloadMocks.remove(tabId, token);
    if (!removed) return { ok: false };

    await retireMock(removed);
    mockReadiness.clear(tabId, token);
    queueCaptureUpdate(tabId, { connections: true });
    return { ok: true };
  });
}

/** @param {number} tabId */
async function getMockStatus(tabId) {
  const sockets = Array.from(socketsByTab.get(tabId)?.values() ?? []);
  return {
    mocks: (await reloadMocks.list(tabId)).flatMap((entry) => {
      const status = mockReadiness.describe(tabId, entry, sockets);
      return status ? [status] : [];
    }),
  };
}

/** @param {CapturedFrame[]} frames @param {number} callMessageId @param {number} resultMessageId */
function hasCapturedResponse(frames, callMessageId, resultMessageId) {
  const call = frames.find((frame) => frame.messageId === callMessageId);
  const result = frames.find((frame) => frame.messageId === resultMessageId);
  if (
    call?.direction !== "sent" ||
    result?.direction !== "received" ||
    result.mocked
  )
    return false;

  const request = readWampFrame(call).payload.value;
  const response = readWampFrame(result).payload.value;
  if (!Array.isArray(request) || !Array.isArray(response)) return false;
  const details = response[2];
  return (
    request[0] === 48 &&
    response[0] === 50 &&
    request[1] === response[1] &&
    !!details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    details.progress !== true
  );
}

/** @param {ArmMockResponseRequest | GetMockResponseRequest} request @param {chrome.runtime.MessageSender} sender */
function findMockSource(request, sender) {
  const {
    tabId,
    frameId,
    documentId,
    socketId,
    callMessageId,
    resultMessageId,
  } = request;
  if (
    !isMockPanel(sender, tabId) ||
    ![frameId, socketId, callMessageId, resultMessageId].every(
      Number.isSafeInteger,
    ) ||
    frameId < 0 ||
    socketId < 1 ||
    callMessageId < 1 ||
    resultMessageId <= callMessageId ||
    typeof documentId !== "string" ||
    !documentId
  )
    return null;

  const socketKey = makeSocketKey(frameId, socketId, documentId);
  const socket = socketsByTab.get(tabId)?.get(socketKey);
  if (!socket || socket.documentEnded || socket.protocol !== "wamp.2.json")
    return null;

  return {
    socket,
    socketKey,
    sourceKey: `${callMessageId}:${resultMessageId}`,
  };
}

/** @param {chrome.runtime.MessageSender} sender @param {number} tabId */
function isMockPanel(sender, tabId) {
  return (
    sender.id === extensionId &&
    sender.url === chrome.runtime.getURL("src/devtools/panel.html") &&
    Number.isSafeInteger(tabId) &&
    tabId >= 0
  );
}

/** @param {GetMockResponseRequest} request @param {chrome.runtime.MessageSender} sender @returns {CaptureResponses["get-mock-response"]} */
function getMockResponse(request, sender) {
  const target = findMockSource(request, sender);
  const resultBody = target?.socket.savedMocks.get(target.sourceKey);
  if (
    !target ||
    resultBody === undefined ||
    !hasCapturedResponse(
      target.socket.history.toArray(),
      request.callMessageId,
      request.resultMessageId,
    )
  )
    return { saved: null };
  return { saved: { resultBody } };
}

/** @param {ArmMockResponseRequest} request @param {chrome.runtime.MessageSender} sender */
async function armMockResponse(request, sender) {
  const { tabId, callMessageId, resultMessageId, resultBody, persistent } =
    request;
  const target = findMockSource(request, sender);
  if (
    !target ||
    target.socket.state !== "OPEN" ||
    (persistent !== undefined &&
      (persistent !== true || !target.socket.reloadDocument)) ||
    (resultBody !== undefined &&
      (typeof resultBody !== "string" ||
        resultBody.length > MAX_MOCK_BODY_CHARACTERS)) ||
    !hasCapturedResponse(
      target.socket.history.toArray(),
      callMessageId,
      resultMessageId,
    )
  )
    return { ok: false };
  const apply = () => applyMockResponse(request, target);
  return target.socket.reloadDocument ? runMockEdit(tabId, apply) : apply();
}

/** @param {ArmMockResponseRequest} request @param {NonNullable<ReturnType<typeof findMockSource>>} target */
async function applyMockResponse(request, target) {
  const {
    type,
    tabId,
    documentId,
    socketId,
    callMessageId,
    resultMessageId,
    resultBody,
    persistent,
  } = request;
  const { socket, socketKey, sourceKey } = target;
  const scope = socket.reloadDocument
    ? await refreshMockDocument(socket.reloadDocument)
    : null;
  if (
    (persistent && !scope) ||
    socketsByTab.get(tabId)?.get(socketKey)?.history !== socket.history
  )
    return { ok: false };
  const reload = scope ? await reloadMocks.begin(scope) : null;
  const finishSave = beginMockSave(socket.history, sourceKey);
  let ok = false;
  /** @type {import("../shared/capture-contracts.js").ReloadMockRule | undefined} */
  let rule;
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      {
        type,
        socketId,
        callMessageId,
        resultMessageId,
        ...(resultBody === undefined ? {} : { resultBody }),
        ...(reload ? { reloadToken: reload.token } : {}),
        ...(persistent ? { persistent } : {}),
      },
      { documentId },
    );
    rule = response?.reload;
    ok =
      response?.ok === true &&
      (!persistent || rule?.persistent?.enabled === true);
  } finally {
    if (!ok) await reload?.finish(false);
    if (!ok) finishSave(false);
  }
  if (!ok) return { ok };

  let replaced;
  try {
    replaced = await reload?.finish(ok, rule);
  } catch (error) {
    finishSave(false);
    if (scope && rule && !rule.persistent) {
      await retireMock({ owner: scope, rule, navigation: 0 });
      for (const { rule: saved } of await reloadMocks.list(tabId))
        if (!saved.persistent) mockReadiness.clear(tabId, saved.token);
      queueCaptureUpdate(tabId, { connections: true });
    }
    throw error;
  }
  if (finishSave(ok)) {
    const socketStore = socketsByTab.get(tabId);
    const latest = socketStore?.get(socketKey);
    if (
      socketStore &&
      latest?.history === socket.history &&
      !latest.documentEnded
    )
      socketStore.set(
        socketKey,
        withSavedMock(latest, sourceKey, resultBody ?? null),
      );
  }
  if (!reload) return { ok };
  for (const entry of replaced ?? []) {
    mockReadiness.clear(tabId, entry.rule.token);
    await retireMock(entry);
  }
  if (rule?.persistent) {
    const pending = await reloadMocks.inspect(tabId, rule.token);
    if (!pending) return { ok: false };
    if (await syncPersistentMock(pending))
      await markMockReady(
        pending.owner,
        rule.token,
        true,
        rule.persistent.revision,
      );
  } else if (scope && rule) await markMockReady(scope, rule.token);
  queueCaptureUpdate(tabId, { connections: true });
  return { ok };
}

chrome.runtime.onMessage.addListener(
  /** @param {WorkerMessage | undefined} message */ (
    message,
    sender,
    sendResponse,
  ) => {
    if (message?.type === "arm-mock-response") {
      armMockResponse(message, sender).then(sendResponse, () =>
        sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "get-mock-response") {
      sendResponse(getMockResponse(message, sender));
      return false;
    }

    if (message?.type === "get-mock-status") {
      if (!isMockPanel(sender, message.tabId)) {
        sendResponse({ mocks: [] });
        return false;
      }
      getMockStatus(message.tabId).then(sendResponse, () =>
        sendResponse({ mocks: [] }),
      );
      return true;
    }

    if (message?.type === "set-mock-enabled") {
      const { tabId, token, enabled } = message;
      if (
        !isMockPanel(sender, tabId) ||
        typeof token !== "string" ||
        typeof enabled !== "boolean"
      ) {
        sendResponse({ ok: false });
        return false;
      }
      setMockEnabled(tabId, token, enabled).then(sendResponse, () =>
        sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "delete-mock") {
      const { tabId, token } = message;
      if (!isMockPanel(sender, tabId) || typeof token !== "string") {
        sendResponse({ ok: false });
        return false;
      }
      deleteMock(tabId, token).then(sendResponse, () =>
        sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "get-reload-mock") {
      const scope = readMockDocument(sender, extensionId);
      if (!scope) {
        sendResponse({ rules: [] });
        return false;
      }
      Promise.resolve(reloadMocks.lookup(scope)).then(sendResponse, () =>
        sendResponse({ rules: [] }),
      );
      return true;
    }

    if (message?.type === "mock-reload-readiness") {
      const scope = readMockDocument(sender, extensionId);
      if (
        !scope ||
        typeof message.token !== "string" ||
        typeof message.ready !== "boolean" ||
        (message.revision !== undefined &&
          !Number.isSafeInteger(message.revision))
      ) {
        sendResponse({ ok: false });
        return false;
      }
      markMockReady(scope, message.token, message.ready, message.revision).then(
        (ok) => sendResponse({ ok }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "mock-reload-consumed") {
      const scope = readMockDocument(sender, extensionId);
      if (!scope || typeof message.token !== "string") {
        sendResponse({ ok: false });
        return false;
      }
      Promise.resolve(reloadMocks.consume(scope, message.token)).then(
        (ok) => {
          if (ok) {
            mockReadiness.clear(scope.tabId, message.token);
            queueCaptureUpdate(scope.tabId, { connections: true });
          }
          sendResponse({ ok });
        },
        () => sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "ws-event") {
      const tabId = sender.tab?.id;

      if (typeof tabId !== "number") {
        sendResponse({ ok: false });
        return false;
      }

      const frameId = sender.frameId ?? 0;
      const documentId = sender.documentId ?? null;
      if (message.payload.eventType === "mock-state") {
        const socketKey = makeSocketKey(
          frameId,
          message.payload.id,
          documentId,
        );
        const ok = updateMockSource(
          tabId,
          socketKey,
          message.payload.mockSourceMessageId,
        );
        sendResponse({ ok });
        return false;
      }
      const { socketStore, socketKey, record } = getSocketRecord(
        tabId,
        frameId,
        message.payload.id,
        documentId,
      );
      /** @type {Extract<WorkerMessage, {type: "ws-event"}>["payload"]} */
      const event =
        record.documentEnded && message.payload.state !== "CLOSED"
          ? { ...message.payload, state: "CLOSED", eventType: record.eventType }
          : message.payload;
      const mockSourceMessageId =
        (event.state ?? record.state) === "OPEN"
          ? (record.mockSourceMessageId ?? null)
          : null;

      socketStore.set(socketKey, {
        ...record,
        ...event,
        history: record.history,
        savedMocks: record.savedMocks,
        reloadDocument:
          readMockDocument(sender, extensionId) ?? record.reloadDocument,
        frameId,
        documentId,
        documentEnded: record.documentEnded,
        mockSourceMessageId,
        tabId,
        updatedAt: new Date().toISOString(),
      });
      queueCaptureUpdate(tabId, {
        connections: true,
        socketKey:
          mockSourceMessageId !== record.mockSourceMessageId
            ? socketKey
            : undefined,
      });

      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "ws-message") {
      const tabId = sender.tab?.id;

      if (typeof tabId !== "number") {
        sendResponse({ ok: false });
        return false;
      }

      const frameId = sender.frameId ?? 0;
      const { socketStore, socketKey, record } = getSocketRecord(
        tabId,
        frameId,
        message.payload.socketId,
        sender.documentId ?? null,
      );
      record.history.add(message.payload);

      socketStore.set(socketKey, {
        ...record,
        frameId,
        tabId,
        url: record.url || message.payload.url || "",
        lastMessageAt: message.payload.timestamp,
        updatedAt: new Date().toISOString(),
      });
      queueCaptureUpdate(tabId, { socketKey });

      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "get-sockets") {
      const socketStore = socketsByTab.get(message.tabId);
      const sockets = socketStore
        ? Array.from(socketStore.values())
            .filter(hasWampSubprotocol)
            .map(toSocketSummary)
        : [];

      /** @type {CaptureResponses["get-sockets"]} */
      const response = { sockets };
      sendResponse(response);
      return false;
    }

    if (message?.type === "get-socket-detail") {
      const socketStore = socketsByTab.get(message.tabId);
      const socketKey = makeSocketKey(
        message.frameId ?? 0,
        message.socketId,
        message.documentId,
      );
      const socket = socketStore?.get(socketKey) || null;

      if (!socket || !hasWampSubprotocol(socket)) {
        sendResponse({ socket: null });
        return false;
      }

      const { history, savedMocks, reloadDocument, ...details } = socket;
      /** @type {CaptureResponses["get-socket-detail"]} */
      const response = {
        socket: {
          ...details,
          messages: history.toArray(),
          messageCount: history.size,
        },
      };
      sendResponse(response);
      return false;
    }

    if (message?.type === "clear-messages") {
      if (!Number.isInteger(message.tabId)) {
        sendResponse({ ok: false });
        return false;
      }

      const cleared = reloadMocks.clear(message.tabId, true);
      const socketStore = socketsByTab.get(message.tabId);
      socketStore?.forEach((socket, key) => {
        socketStore.set(key, {
          ...socket,
          history: new FrameHistory(),
          savedMocks: new Map(),
          lastMessageAt: "",
        });
      });
      queueCaptureUpdate(message.tabId, { allMessages: true });
      if (cleared) {
        cleared.then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
        return true;
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  },
);

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.documentLifecycle && details.documentLifecycle !== "active")
    return;
  if (details.frameId === 0) {
    mockReadiness.navigate(details.tabId, details.documentId);
    commitMockPage(reloadMocks, details);
    socketsByTab.set(details.tabId, new Map());
    queueCaptureUpdate(details.tabId, { connections: true });
    return;
  }

  if (!details.documentId) return;

  const socketStore = socketsByTab.get(details.tabId);
  socketStore?.forEach((socket, key) => {
    if (
      socket.frameId !== details.frameId ||
      !socket.documentId ||
      socket.documentId === details.documentId ||
      socket.documentEnded
    )
      return;

    /** @type {Partial<SocketRecord>} */
    const close =
      socket.state === "CLOSED"
        ? {}
        : {
            state: "CLOSED",
            eventType: "navigation",
            updatedAt: new Date().toISOString(),
          };
    socketStore.set(key, {
      ...socket,
      ...close,
      documentEnded: true,
      mockSourceMessageId: null,
      savedMocks: new Map(),
    });
    if (socket.state !== "CLOSED")
      queueCaptureUpdate(details.tabId, {
        connections: true,
        socketKey: socket.mockSourceMessageId != null ? key : undefined,
      });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  socketsByTab.delete(tabId);
  mockReadiness.clear(tabId);
  Promise.resolve(reloadMocks.clear(tabId)).catch(() => {
    console.warn("WAMP Inspector: could not clear the closed tab's mock.");
  });
});
