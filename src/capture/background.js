import { readWampFrame } from "../shared/wamp-frame.js";
import { createMcpSharing } from "./mcp-sharing.js";

/** @typedef {import("../shared/capture-contracts.js").CapturedFrame} CapturedFrame */
/** @typedef {import("../shared/capture-contracts.js").CapturePortRequest} CapturePortRequest */
/** @typedef {import("../shared/capture-contracts.js").CaptureResponses} CaptureResponses */
/** @typedef {import("../shared/capture-contracts.js").CaptureUpdate} CaptureUpdate */
/** @typedef {import("../shared/capture-contracts.js").SocketSummary} SocketSummary */
/** @typedef {import("../shared/capture-contracts.js").WorkerMessage} WorkerMessage */
/** @typedef {Omit<import("../shared/capture-contracts.js").SocketDetail, "messageCount" | "messages"> & {history: FrameHistory}} SocketRecord */
/** @typedef {{connections: boolean, allMessages: boolean, socketKeys: Set<string>}} PendingCaptureUpdate */

/** @type {Map<number, Map<string, SocketRecord>>} */
const socketsByTab = new Map();
const MAX_FRAMES_PER_TYPE = 1000;
const CAPTURE_UPDATE_DELAY = 32;
/** @type {Map<number, Set<chrome.runtime.Port>>} */
const subscribersByTab = new Map();
/** @type {Map<number, PendingCaptureUpdate>} */
const pendingCaptureUpdates = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let captureUpdateTimer = null;

class FrameHistory {
  /** @type {Map<number, CapturedFrame>} */
  #frames = new Map();
  /** @type {Map<string, {ids: number[], writeIndex: number}>} */
  #buckets = new Map();
  #nextId = 0;

  /** @param {CapturedFrame} frame */
  add(frame) {
    const type = readWampFrame(frame).knownType ?? "UNKNOWN";
    let bucket = this.#buckets.get(type);
    if (!bucket) {
      bucket = { ids: [], writeIndex: 0 };
      this.#buckets.set(type, bucket);
    }

    const id = this.#nextId++;
    // Each type cycles through its slots while the map retains capture order across types.
    const evictedId = bucket.ids[bucket.writeIndex];
    if (evictedId !== undefined) this.#frames.delete(evictedId);
    bucket.ids[bucket.writeIndex] = id;
    bucket.writeIndex = (bucket.writeIndex + 1) % MAX_FRAMES_PER_TYPE;
    this.#frames.set(id, frame);
  }

  get size() {
    return this.#frames.size;
  }

  toArray() {
    return Array.from(this.#frames.values());
  }
}

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

const mcpSharing = createMcpSharing(chrome, (tabId) =>
  Array.from(socketsByTab.get(tabId) ?? []).filter(([, socket]) =>
    hasWampSubprotocol(socket),
  ),
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "wamp-mcp-share") {
    mcpSharing.connect(port);
    return;
  }
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
    lastMessageAt: "",
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
  };
}

chrome.runtime.onMessage.addListener(
  /** @param {WorkerMessage | undefined} message */ (
    message,
    sender,
    sendResponse,
  ) => {
    if (message?.type === "ws-event") {
      const tabId = sender.tab?.id;

      if (typeof tabId !== "number") {
        sendResponse({ ok: false });
        return false;
      }

      const frameId = sender.frameId ?? 0;
      const documentId = sender.documentId ?? null;
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

      socketStore.set(socketKey, {
        ...record,
        ...event,
        history: record.history,
        frameId,
        documentId,
        documentEnded: record.documentEnded,
        tabId,
        updatedAt: new Date().toISOString(),
      });
      queueCaptureUpdate(tabId, { connections: true });

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

      const { history, ...details } = socket;
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

      const socketStore = socketsByTab.get(message.tabId);
      socketStore?.forEach((socket, key) => {
        socketStore.set(key, {
          ...socket,
          history: new FrameHistory(),
          lastMessageAt: "",
        });
      });
      queueCaptureUpdate(message.tabId, { allMessages: true });
      sendResponse({ ok: true });
      return false;
    }

    return false;
  },
);

chrome.webNavigation.onBeforeNavigate?.addListener(({ tabId, frameId }) => {
  if (frameId === 0) mcpSharing.revokeTab(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    mcpSharing.revokeTab(details.tabId);
    socketsByTab.set(details.tabId, new Map());
    queueCaptureUpdate(details.tabId, { connections: true });
    return;
  }

  if (
    !details.documentId ||
    (details.documentLifecycle && details.documentLifecycle !== "active")
  )
    return;

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
    socketStore.set(key, { ...socket, ...close, documentEnded: true });
    if (socket.state !== "CLOSED")
      queueCaptureUpdate(details.tabId, { connections: true });
  });
});

chrome.tabs.onReplaced?.addListener((_, removedTabId) => {
  mcpSharing.revokeTab(removedTabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mcpSharing.revokeTab(tabId);
  socketsByTab.delete(tabId);
});
