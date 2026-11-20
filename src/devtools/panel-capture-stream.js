const KEEPALIVE_MS = 20_000;
const FIRST_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 4_000;

/** @typedef {import("../shared/capture-contracts.js").CapturePortRequest} CapturePortRequest */
/** @typedef {import("../shared/capture-contracts.js").CaptureUpdate} CaptureUpdate */

/**
 * @param {number} tabId
 * @param {(message: CaptureUpdate) => void} onMessage
 * @param {() => void} onDisconnected
 */
export function subscribeToCapture(tabId, onMessage, onDisconnected) {
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  /** @type {number | null} */
  let reconnectTimer = null;
  let reconnectDelay = FIRST_RECONNECT_MS;
  let stopped = false;

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    onDisconnected();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  /** @param {chrome.runtime.Port} current */
  function disconnect(current) {
    if (current !== port) return;
    port = null;
    try {
      current.disconnect();
    } catch (error) {
      if (!stopped)
        console.debug(
          "WAMP Inspector: capture port already closed",
          error instanceof Error ? error.message : error,
        );
    }
    scheduleReconnect();
  }

  /** @param {chrome.runtime.Port} current @param {CapturePortRequest} message */
  function post(current, message) {
    try {
      current.postMessage(message);
    } catch {
      disconnect(current);
    }
  }

  function connect() {
    if (stopped) return;
    try {
      const current = chrome.runtime.connect({ name: "wamp-capture" });
      port = current;
      current.onMessage.addListener(
        /** @param {CaptureUpdate} message */ (message) => {
          if (current !== port) return;
          if (message?.type === "capture-ready")
            reconnectDelay = FIRST_RECONNECT_MS;
          onMessage(message);
        },
      );
      current.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        if (current !== port) return;
        port = null;
        if (error)
          console.debug(
            "WAMP Inspector: capture stream disconnected",
            error.message,
          );
        scheduleReconnect();
      });
      post(current, { type: "subscribe", tabId });
    } catch (error) {
      console.warn("WAMP Inspector: unable to open the capture stream", error);
      scheduleReconnect();
    }
  }

  // Capture is stored in memory while the inspector is active. Keep its worker
  // alive through quiet periods without reading the capture again.
  const keepalive = window.setInterval(() => {
    if (port) post(port, { type: "ping" });
  }, KEEPALIVE_MS);

  window.addEventListener(
    "pagehide",
    () => {
      stopped = true;
      window.clearInterval(keepalive);
      window.clearTimeout(reconnectTimer ?? undefined);
      if (port) disconnect(port);
    },
    { once: true },
  );

  connect();
}
