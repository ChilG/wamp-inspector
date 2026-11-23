const nativeHostName = "com.wamp_inspector.bridge";

/**
 * @param {Window} page
 * @param {(message: unknown) => void} onMessage
 * @param {(hadError: boolean) => void} onDisconnect
 */
export function mountNativeBridge(page, onMessage, onDisconnect) {
  const frame = page.document.createElement("iframe");
  frame.hidden = true;
  frame.title = "WAMP Inspector Native Messaging";
  frame.src = new URL("./mcp-native.html", import.meta.url).href;

  /** @type {chrome.runtime.Port | null} */
  let native = null;
  let closed = false;

  function open() {
    if (closed) return;
    try {
      // Chrome exposes newly granted Native Messaging APIs in this new extension context.
      const context = /** @type {(Window & {chrome: typeof chrome}) | null} */ (
        frame.contentWindow
      );
      if (!context) throw new Error("Native Messaging context unavailable.");
      const runtime = context.chrome.runtime;
      const port = runtime.connectNative(nativeHostName);
      native = port;
      port.onMessage.addListener((message) => {
        if (!closed && native === port) onMessage(message);
      });
      port.onDisconnect.addListener(() => {
        const error = runtime.lastError;
        if (closed || native !== port) return;
        native = null;
        onDisconnect(Boolean(error));
      });
    } catch {
      onDisconnect(true);
    }
  }

  frame.addEventListener("load", open, { once: true });
  page.document.body.append(frame);
  return {
    /** @param {unknown} message */
    send(message) {
      try {
        native?.postMessage(message);
      } catch {
        onDisconnect(true);
      }
    },
    close() {
      closed = true;
      try {
        native?.disconnect();
      } finally {
        native = null;
        frame.remove();
      }
    },
  };
}
