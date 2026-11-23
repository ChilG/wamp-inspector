(() => {
  "use strict";

  if (window.__wampInspectorHookInstalled) {
    return;
  }

  window.__wampInspectorHookInstalled = true;

  const NativeWebSocket = window.WebSocket;
  const WAMP_ERROR = 8;
  const WAMP_CALL = 48;
  const WAMP_RESULT = 50;
  const MAX_PENDING_CALLS = 512;
  const MAX_SAMPLES = 128;
  const MAX_SAMPLE_CHARACTERS = 8 * 1024 * 1024;
  const MAX_MOCK_BODY_CHARACTERS = 1_048_576;
  const MAX_CALL_NAME_CHARACTERS = 16 * 1024;
  const MAX_RELOAD_ENDPOINT_CHARACTERS = 16 * 1024;
  const MAX_RELOAD_TOKEN_CHARACTERS = 128;
  const MAX_RELOAD_PACKET_CHARACTERS =
    2 * MAX_MOCK_BODY_CHARACTERS +
    6 * (MAX_CALL_NAME_CHARACTERS + MAX_RELOAD_ENDPOINT_CHARACTERS) +
    4096;
  const readSocketUrl = Function.call.bind(
    Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, "url").get,
  );
  const readSocketProtocol = Function.call.bind(
    Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, "protocol").get,
  );
  const parseJson = JSON.parse;
  const stringifyJson = JSON.stringify;
  const cloneFrame = structuredClone;
  const jsonValues = Object.values;
  const hasOwn = Object.hasOwn;
  const setPrototype = Object.setPrototypeOf;
  const NativeMap = Map;
  const getEntry = Function.call.bind(Map.prototype.get);
  const setEntry = Function.call.bind(Map.prototype.set);
  const deleteEntry = Function.call.bind(Map.prototype.delete);
  const clearEntries = Function.call.bind(Map.prototype.clear);
  const mapKeys = Function.call.bind(Map.prototype.keys);
  const mapValues = Function.call.bind(Map.prototype.values);
  const mapSize = Function.call.bind(
    Object.getOwnPropertyDescriptor(Map.prototype, "size").get,
  );
  const mockSockets = new NativeMap();
  const startupSettlements = [];
  let oneShotRule = null;
  const persistentRules = new NativeMap();
  const persistentVersions = new NativeMap();
  const canceledMocks = new NativeMap();
  let receivedRestore = false;
  let socketSeq = 0;
  let messageSeq = 0;

  window.addEventListener("pagehide", (event) => {
    if (!event.isTrusted || !event.persisted) return;
    // A document returning from BFCache may no longer have a configured mock.
    for (const { token } of mapValues(persistentRules))
      setEntry(persistentVersions, token, Infinity);
    clearEntries(persistentRules);
  });

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
      return parseJson(rawText);
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

  function isDictionary(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasValidBody(frame, bodyIndex) {
    return (
      frame.length >= bodyIndex &&
      frame.length <= bodyIndex + 2 &&
      (frame.length === bodyIndex || Array.isArray(frame[bodyIndex])) &&
      (frame.length <= bodyIndex + 1 || isDictionary(frame[bodyIndex + 1]))
    );
  }

  function isFinalResult(frame) {
    return (
      frame[0] === WAMP_RESULT &&
      isDictionary(frame[2]) &&
      (frame[2].progress === undefined || frame[2].progress === false) &&
      hasValidBody(frame, 3)
    );
  }

  function isCallError(frame) {
    return (
      frame[0] === WAMP_ERROR &&
      frame[1] === WAMP_CALL &&
      isDictionary(frame[3]) &&
      typeof frame[4] === "string" &&
      hasValidBody(frame, 5)
    );
  }

  function callTopic(frame) {
    const topic = frame[5]?.topic;
    return typeof topic === "string" && topic.trim() ? topic : null;
  }

  function readEditedBody(resultBody) {
    if (
      typeof resultBody !== "string" ||
      resultBody.length > MAX_MOCK_BODY_CHARACTERS
    )
      return null;
    const body = parseJsonPayload(resultBody);
    if (!Array.isArray(body) || !hasValidBody(body, 0)) return null;

    try {
      // Check both the app's wire format and the inspector's capture.
      const frame = [WAMP_RESULT, 0, {}, ...body];
      if (typeof stringifyJson(frame) !== "string") return null;
      cloneFrame(frame);
      return body;
    } catch {
      return null;
    }
  }

  function isReloadToken(token) {
    return (
      typeof token === "string" &&
      token.length > 0 &&
      token.length <= MAX_RELOAD_TOKEN_CHARACTERS
    );
  }

  function isReloadEndpoint(endpoint) {
    return (
      typeof endpoint === "string" &&
      endpoint.length <= MAX_RELOAD_ENDPOINT_CHARACTERS &&
      (endpoint.startsWith("ws://") || endpoint.startsWith("wss://"))
    );
  }

  function matchesCall(rule, call) {
    return rule.procedure === call.procedure && rule.topic === call.topic;
  }

  function matchKey(procedure, topic) {
    return `${procedure.length}:${procedure}${topic ?? ""}`;
  }

  function replaceOneShotRule(rule) {
    const onSourceChanged = oneShotRule?.onSourceChanged;
    oneShotRule = rule;
    if (onSourceChanged !== rule?.onSourceChanged) onSourceChanged?.(null);
  }

  function createMockState(socketId, endpoint, onSourceChanged) {
    const pendingCalls = new NativeMap();
    const samples = new NativeMap();
    let sampleCharacters = 0;

    function removeCall(requestId, settled = false) {
      const call = getEntry(pendingCalls, requestId);
      if (!call) return;

      if (
        settled &&
        !receivedRestore &&
        startupSettlements.length < MAX_PENDING_CALLS
      )
        startupSettlements[startupSettlements.length] = call;
      deleteEntry(pendingCalls, requestId);
      if (oneShotRule?.call === call) {
        const { token } = oneShotRule;
        replaceOneShotRule(null);
        if (token) dispatchPrivateMockEvent("reload-consumed", token);
      }
    }

    function findPendingCall(rule) {
      for (const call of mapValues(pendingCalls)) {
        if (matchesCall(rule, call)) return call;
      }
      return null;
    }

    function claimOneShotCall(call) {
      const rule = oneShotRule;
      if (!rule || rule.call || !matchesCall(rule, call)) return;
      oneShotRule = {
        __proto__: null,
        ...rule,
        call,
        callSocketId: socketId,
        onSourceChanged: rule.onSourceChanged ?? onSourceChanged,
      };
      if (!rule.onSourceChanged) onSourceChanged(call.messageId);
    }

    function trackCall(frame, messageId) {
      if (
        !Array.isArray(frame) ||
        frame[0] !== WAMP_CALL ||
        !hasValidBody(frame, 4)
      )
        return;

      const [, requestId, details, procedure] = frame;
      if (
        !Number.isSafeInteger(requestId) ||
        requestId < 0 ||
        !isDictionary(details) ||
        typeof procedure !== "string" ||
        !procedure
      )
        return;

      removeCall(requestId);
      const topic = callTopic(frame);
      if (procedure.length + (topic?.length ?? 0) > MAX_CALL_NAME_CHARACTERS)
        return;

      const call = { messageId, procedure, topic };
      setEntry(pendingCalls, requestId, call);
      if (mapSize(pendingCalls) > MAX_PENDING_CALLS) {
        removeCall(mapKeys(pendingCalls).next().value);
      }
      claimOneShotCall(call);
    }

    function rememberResult(messageId, call, payload) {
      const characters =
        payload.rawText.length +
        call.procedure.length +
        (call.topic?.length ?? 0);
      if (characters > MAX_SAMPLE_CHARACTERS) return;

      setEntry(samples, messageId, {
        call,
        body: payload.parsed.slice(3),
        characters,
      });
      sampleCharacters += characters;
      while (
        mapSize(samples) > MAX_SAMPLES ||
        sampleCharacters > MAX_SAMPLE_CHARACTERS
      ) {
        const oldestId = mapKeys(samples).next().value;
        sampleCharacters -= getEntry(samples, oldestId).characters;
        deleteEntry(samples, oldestId);
      }
    }

    function arm(
      callMessageId,
      resultMessageId,
      resultBody,
      reloadToken,
      persistent,
    ) {
      const sample = getEntry(samples, resultMessageId);
      if (!sample || sample.call.messageId !== callMessageId) return false;
      const body =
        resultBody === undefined ? sample.body : readEditedBody(resultBody);
      if (!body) return false;

      const reloadBody =
        reloadToken && isReloadEndpoint(endpoint)
          ? (resultBody ?? serializeReloadBody(body))
          : null;
      if (persistent && reloadBody === null) return false;
      if (!persistent) {
        receivedRestore = true;
        startupSettlements.length = 0;
        replaceOneShotRule({
          __proto__: null,
          procedure: sample.call.procedure,
          topic: sample.call.topic,
          body,
          token: reloadToken,
          onSourceChanged,
        });
        onSourceChanged(callMessageId);
      }
      if (reloadBody !== null)
        dispatchPrivateMockEvent(
          "reload-armed",
          stringifyJson({
            __proto__: null,
            token: reloadToken,
            endpoint,
            procedure: sample.call.procedure,
            topic: sample.call.topic,
            resultBody: reloadBody,
            ...(persistent
              ? { persistent: { __proto__: null, enabled: true, revision: 0 } }
              : {}),
          }),
        );
      return true;
    }

    function receive(event, payload, messageId) {
      const frame = payload.parsed;
      if (!event.isTrusted || !Array.isArray(frame)) return payload;

      if (isCallError(frame)) {
        removeCall(frame[2], true);
        return payload;
      }
      if (!isFinalResult(frame)) return payload;

      const requestId = frame[1];
      const call = getEntry(pendingCalls, requestId);
      if (!call) return payload;

      const body =
        oneShotRule?.call === call
          ? oneShotRule.body
          : getEntry(persistentRules, matchKey(call.procedure, call.topic))
              ?.body;
      removeCall(requestId, true);

      if (body) {
        // Keep the event and its current RESULT details and change only its body.
        try {
          const parsed = [...frame.slice(0, 3), ...body];
          const rawText = stringifyJson(parsed);
          if (typeof rawText !== "string") return payload;
          Object.defineProperty(event, "data", {
            value: rawText,
            configurable: true,
          });
          return { ...payload, rawText, parsed, mocked: true };
        } catch {
          // An event that cannot be extended still delivers its original data.
        }
      }

      rememberResult(messageId, call, payload);
      return payload;
    }

    function detach() {
      if (oneShotRule?.callSocketId !== socketId) return;
      const { token } = oneShotRule;
      replaceOneShotRule(null);
      // A closed socket does not consume the saved rule for a future reload.
      if (token) dispatchPrivateMockEvent("reload-detached", token);
    }

    return {
      arm,
      receive,
      trackCall,
      findPendingCall,
      claimOneShotCall,
      detach,
    };
  }

  function serializeReloadBody(body) {
    try {
      // Keep page-defined inherited toJSON methods out of the private snapshot.
      const snapshot = cloneFrame(body);
      const pending = [snapshot];
      while (pending.length) {
        const index = pending.length - 1;
        const current = pending[index];
        pending.length = index;
        setPrototype(current, null);
        const values = jsonValues(current);
        for (let i = 0; i < values.length; i++) {
          const value = values[i];
          if (value !== null && typeof value === "object")
            pending[pending.length] = value;
        }
      }
      const raw = stringifyJson(snapshot);
      return typeof raw === "string" && raw.length <= MAX_MOCK_BODY_CHARACTERS
        ? raw
        : null;
    } catch {
      return null;
    }
  }

  function restoreMock(detail) {
    if (
      typeof detail !== "string" ||
      detail.length > MAX_RELOAD_PACKET_CHARACTERS
    )
      return false;
    if (detail === "null") {
      receivedRestore = true;
      startupSettlements.length = 0;
      return false;
    }
    const rule = parseJsonPayload(detail);
    if (!isDictionary(rule)) return false;
    const { token, endpoint, procedure, topic, resultBody } = rule;
    const persistent = hasOwn(rule, "persistent") ? rule.persistent : undefined;
    if (
      !isReloadToken(token) ||
      !isReloadEndpoint(endpoint) ||
      typeof procedure !== "string" ||
      !procedure ||
      (topic !== null && (typeof topic !== "string" || !topic.trim())) ||
      procedure.length + (topic?.length ?? 0) > MAX_CALL_NAME_CHARACTERS
    )
      return false;
    const body = readEditedBody(resultBody);
    if (!body) return false;

    if (persistent !== undefined) {
      if (
        !isDictionary(persistent) ||
        !hasOwn(persistent, "enabled") ||
        !hasOwn(persistent, "revision") ||
        typeof persistent.enabled !== "boolean" ||
        !Number.isSafeInteger(persistent.revision) ||
        persistent.revision < 0 ||
        persistent.revision < (getEntry(persistentVersions, token) ?? 0)
      )
        return false;
      setEntry(persistentVersions, token, persistent.revision);
      const key = matchKey(procedure, topic);
      if (persistent.enabled) {
        setEntry(persistentRules, key, { token, body });
      } else if (getEntry(persistentRules, key)?.token === token) {
        deleteEntry(persistentRules, key);
      }
      return true;
    }
    if (receivedRestore || getEntry(canceledMocks, token)) return false;
    receivedRestore = true;
    const nextRule = { __proto__: null, token, procedure, topic, body };
    let earliest;
    let owner;
    for (const socket of mapValues(mockSockets)) {
      const call = socket.findPendingCall(nextRule);
      if (call && (!earliest || call.messageId < earliest.messageId)) {
        earliest = call;
        owner = socket;
      }
    }
    let missed = false;
    for (let i = 0; i < startupSettlements.length; i++) {
      const call = startupSettlements[i];
      if (
        matchesCall(nextRule, call) &&
        (!earliest || call.messageId < earliest.messageId)
      ) {
        missed = true;
        break;
      }
    }
    startupSettlements.length = 0;
    if (missed) {
      dispatchPrivateMockEvent("reload-consumed", token);
      return false;
    }
    replaceOneShotRule(nextRule);
    if (earliest) owner.claimOneShotCall(earliest);
    return true;
  }

  // Transfer the detached node to the isolated script at document_start.
  // Keep commands and rule metadata off the page's window message bus.
  const mockChannel = document.createElement("span");
  const MockStateEvent = CustomEvent;
  const dispatchMockEvent = mockChannel.dispatchEvent.bind(mockChannel);
  function dispatchPrivateMockEvent(type, detail) {
    dispatchMockEvent(new MockStateEvent(`wamp-inspector:${type}`, { detail }));
  }
  // Keep page overrides of the event methods from observing the detached node.
  const readDetail = Function.call.bind(
    Object.getOwnPropertyDescriptor(CustomEvent.prototype, "detail").get,
  );
  const acceptCommand = Function.call.bind(Event.prototype.preventDefault);
  mockChannel.addEventListener("wamp-inspector:arm", (event) => {
    const command = parseJsonPayload(readDetail(event));
    if (!Array.isArray(command) || command.length < 3 || command.length > 6)
      return;
    const socketId = command[0];
    const callMessageId = command[1];
    const resultMessageId = command[2];
    const reloadToken = command[4];
    const persistent = command[5];
    if (command.length >= 5 && !isReloadToken(reloadToken)) return;
    if (command.length === 6 && persistent !== true) return;
    const resultBody =
      command.length >= 5 && command[3] === null ? undefined : command[3];
    if (
      getEntry(mockSockets, socketId)?.arm(
        callMessageId,
        resultMessageId,
        resultBody,
        reloadToken,
        persistent,
      ) === true
    )
      acceptCommand(event);
  });
  mockChannel.addEventListener("wamp-inspector:restore-mock", (event) => {
    if (restoreMock(readDetail(event))) acceptCommand(event);
  });
  mockChannel.addEventListener("wamp-inspector:cancel-mock", (event) => {
    const token = readDetail(event);
    if (!isReloadToken(token)) return;
    setEntry(canceledMocks, token, true);
    if (oneShotRule?.token === token) replaceOneShotRule(null);
  });
  document.dispatchEvent(
    new FocusEvent("wamp-inspector:mock-channel", {
      relatedTarget: mockChannel,
    }),
  );

  function wrapWebSocket(url, protocols) {
    const socket =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    const socketId = ++socketSeq;
    const endpoint = readSocketUrl(socket);
    let mockState = null;

    function emit(eventType) {
      postSocketEvent({
        id: socketId,
        eventType,
        url: endpoint,
        createdAt: socket.__wampInspectorCreatedAt,
        state: socketState(socket),
        readyState: socket.readyState,
        protocol: readSocketProtocol(socket),
        extensions: socket.extensions || "",
        requestedProtocols: Array.isArray(protocols)
          ? protocols.join(", ")
          : protocols || "",
      });
    }

    function emitMessage(direction, messageId, payload) {
      postSocketMessage({
        socketId,
        messageId,
        direction,
        timestamp: new Date().toISOString(),
        url: endpoint,
        ...payload,
      });
    }

    socket.__wampInspectorCreatedAt = new Date().toISOString();

    emit("created");

    const nativeSend = socket.send.bind(socket);
    socket.send = function sendWithInspector(data) {
      const payload = normalizePayload(data);
      const messageId = ++messageSeq;
      emitMessage("sent", messageId, payload);
      const result = nativeSend(data);
      if (socket.readyState === NativeWebSocket.OPEN) {
        mockState?.trackCall(payload.parsed, messageId);
      }
      return result;
    };

    socket.addEventListener("open", () => {
      if (readSocketProtocol(socket) === "wamp.2.json") {
        const state = createMockState(
          socketId,
          endpoint,
          (mockSourceMessageId) => {
            dispatchPrivateMockEvent(
              "mock-state",
              stringifyJson([socketId, mockSourceMessageId]),
            );
          },
        );
        mockState = state;
        setEntry(mockSockets, socketId, {
          arm: (
            callMessageId,
            resultMessageId,
            resultBody,
            reloadToken,
            persistent,
          ) =>
            socket.readyState === NativeWebSocket.OPEN &&
            state.arm(
              callMessageId,
              resultMessageId,
              resultBody,
              reloadToken,
              persistent,
            ),
          findPendingCall: (rule) =>
            socket.readyState === NativeWebSocket.OPEN
              ? state.findPendingCall(rule)
              : null,
          claimOneShotCall: state.claimOneShotCall,
        });
      }
      emit("open");
    });
    socket.addEventListener("error", () => emit("error"));
    socket.addEventListener("close", () => {
      deleteEntry(mockSockets, socketId);
      mockState?.detach();
      mockState = null;
      emit("close");
    });
    socket.addEventListener(
      "message",
      (event) => {
        const payload = normalizePayload(event.data);
        const messageId = ++messageSeq;
        const received =
          mockState?.receive(event, payload, messageId) ?? payload;
        emitMessage("received", messageId, received);
      },
      true,
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
