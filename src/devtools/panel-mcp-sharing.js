import { mountNativeBridge } from "./panel-mcp-native.js";

/**
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} status
 * @param {number} tabId
 * @param {typeof chrome} [api]
 * @param {Window} [page]
 * @param {typeof mountNativeBridge} [mountNative]
 */
export function bindMcpSharing(
  button,
  status,
  tabId,
  api = chrome,
  page = window,
  mountNative = mountNativeBridge,
) {
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  /** @type {ReturnType<typeof mountNativeBridge> | null} */
  let native = null;
  let requestingPermission = false;
  let closed = false;

  /** @param {string} message */
  function render(message) {
    button.textContent = port ? "Stop sharing" : "Share with MCP";
    button.disabled = requestingPermission;
    status.textContent = message;
  }

  /** @param {string} message */
  function stop(message) {
    const current = port;
    port = null;
    current?.disconnect();
    native?.close();
    native = null;
    if (!closed) render(message);
  }

  function connect() {
    const current = api.runtime.connect({ name: "wamp-mcp-share" });
    port = current;
    current.onMessage.addListener((message) => {
      if (port !== current) return;
      if (message?.type === "native-response") {
        native?.send(message.message);
        return;
      }
      if (message?.type !== "mcp-share-status") return;
      if (message.state === "connecting" && !native) {
        native = mountNative(
          page,
          (message) => post(current, { type: "native-message", message }),
          (hadError) =>
            post(current, { type: "native-disconnected", hadError }),
        );
      } else if (message.state === "sharing") {
        render("Sharing WAMP metadata from this tab.");
      } else if (message.state === "error" || message.state === "stopped") {
        stop(message.message || "MCP sharing stopped.");
      }
    });
    current.onDisconnect.addListener(() => {
      const error = api.runtime.lastError;
      if (port !== current) return;
      port = null;
      stop(
        error
          ? "MCP bridge disconnected. Try sharing again."
          : "MCP bridge disconnected. Sharing stopped.",
      );
    });
    render("Connecting to the local MCP bridge…");
    post(current, { type: "share", tabId });
  }

  /** @param {chrome.runtime.Port} current @param {unknown} message */
  function post(current, message) {
    if (port !== current) return;
    try {
      current.postMessage(message);
    } catch {
      stop("MCP bridge disconnected. Try sharing again.");
    }
  }

  button.addEventListener("click", async () => {
    if (closed || requestingPermission) return;
    if (port) {
      stop("MCP sharing stopped.");
      return;
    }

    requestingPermission = true;
    render("Waiting for Native Messaging permission…");
    try {
      const granted = await api.permissions.request({
        permissions: ["nativeMessaging"],
      });
      requestingPermission = false;
      if (closed) return;
      if (granted) connect();
      else render("Native Messaging permission is required to share with MCP.");
    } catch (error) {
      requestingPermission = false;
      console.warn("WAMP Inspector: unable to start MCP sharing", error);
      stop(
        "Unable to start MCP sharing. Check the installation and try again.",
      );
    }
  });
  page.addEventListener(
    "pagehide",
    () => {
      closed = true;
      stop("");
    },
    { once: true },
  );
  render("");
}
