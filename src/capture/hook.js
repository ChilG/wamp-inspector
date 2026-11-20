(() => {
  if (window.__wampInspectorHookInstalled) {
    return;
  }

  window.__wampInspectorHookInstalled = true;

  const NativeWebSocket = window.WebSocket;
  let socketSeq = 0;
  let messageSeq = 0;

  function postToInspector(type, payload) {
    window.postMessage(
      {
        source: "wamp-inspector",
        type,
        payload,
      },
      "*",
    );
  }

  function postSocketEvent(payload) {
    postToInspector("ws-event", payload);
  }

  function postSocketMessage(payload) {
    postToInspector("ws-message", payload);
  }

  function socketState(socket) {
    return (
      ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][socket.readyState] ||
      "UNKNOWN"
    );
  }

  function parseJsonPayload(rawText) {
    if (typeof rawText !== "string") {
      return null;
    }

    try {
      return JSON.parse(rawText);
    } catch (error) {
      return null;
    }
  }

  function normalizePayload(data) {
    if (typeof data === "string") {
      return {
        rawText: data,
        parsed: parseJsonPayload(data),
        format: "text",
      };
    }

    if (data instanceof ArrayBuffer) {
      return {
        rawText: `[binary ${data.byteLength} bytes]`,
        parsed: null,
        format: "arraybuffer",
      };
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return {
        rawText: `[binary blob ${data.size} bytes]`,
        parsed: null,
        format: "blob",
      };
    }

    return {
      rawText: String(data),
      parsed: null,
      format: typeof data,
    };
  }

  function wrapWebSocket(url, protocols) {
    const socket =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    const socketId = ++socketSeq;

    function emit(eventType) {
      postSocketEvent({
        id: socketId,
        eventType,
        url: String(url),
        createdAt: socket.__wampInspectorCreatedAt,
        state: socketState(socket),
        readyState: socket.readyState,
        protocol: socket.protocol || "",
        extensions: socket.extensions || "",
        requestedProtocols: Array.isArray(protocols)
          ? protocols.join(", ")
          : protocols || "",
      });
    }

    function emitMessage(direction, data) {
      const payload = normalizePayload(data);

      postSocketMessage({
        socketId,
        messageId: ++messageSeq,
        direction,
        timestamp: new Date().toISOString(),
        url: String(url),
        ...payload,
      });
    }

    socket.__wampInspectorCreatedAt = new Date().toISOString();

    emit("created");

    const nativeSend = socket.send.bind(socket);
    socket.send = function sendWithInspector(data) {
      emitMessage("sent", data);
      return nativeSend(data);
    };

    socket.addEventListener("open", () => emit("open"));
    socket.addEventListener("error", () => emit("error"));
    socket.addEventListener("close", () => emit("close"));
    socket.addEventListener("message", (event) =>
      emitMessage("received", event.data),
    );

    return socket;
  }

  function WampInspectorWebSocket(url, protocols) {
    return wrapWebSocket(url, protocols);
  }

  WampInspectorWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(WampInspectorWebSocket, NativeWebSocket);

  window.WebSocket = WampInspectorWebSocket;
})();
