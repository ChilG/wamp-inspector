const MAX_MOCK_BODY_CHARACTERS = 1_048_576;
const MAX_RELOAD_TOKEN_CHARACTERS = 128;
const RELOAD_RETRY_DELAYS = [5, 10, 20, 40, 80, 160];
const RELOAD_LOOKUP_BUDGET_MS = 350;
let reportedForwardingError = false;
let mockChannel = null;

// The isolated script starts first in the manifest and retains the hook's
// detached channel before page scripts can register listeners.
document.addEventListener(
  "wamp-inspector:mock-channel",
  (event) => {
    const channel = event.relatedTarget;
    if (!channel) return;
    mockChannel = channel;
    channel.addEventListener("wamp-inspector:mock-state", forwardMockState);
    channel.addEventListener(
      "wamp-inspector:reload-consumed",
      forwardReloadConsumed,
    );
    channel.addEventListener(
      "wamp-inspector:reload-detached",
      forwardReloadDetached,
    );
    void restoreReloadMock(channel);
  },
  { once: true },
);

function forwardInspectorMessage(event) {
  const { data } = event;
  if (
    event.source !== window ||
    data?.source !== "wamp-inspector" ||
    (data.type !== "ws-event" && data.type !== "ws-message") ||
    (data.type === "ws-event" && data.payload?.eventType === "mock-state")
  )
    return;
  return forwardRuntimeMessage({
    type: data.type,
    payload: data.payload,
  });
}

function parseDetail(event) {
  if (typeof event.detail !== "string") return null;
  try {
    return JSON.parse(event.detail);
  } catch {
    return null;
  }
}

function forwardMockState(event) {
  const status = parseDetail(event);
  if (!Array.isArray(status) || status.length !== 2) return;
  const [id, mockSourceMessageId] = status;
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    (mockSourceMessageId !== null &&
      (!Number.isSafeInteger(mockSourceMessageId) || mockSourceMessageId < 1))
  )
    return;
  return forwardRuntimeMessage({
    type: "ws-event",
    payload: { id, eventType: "mock-state", mockSourceMessageId },
  });
}

function isReloadToken(token) {
  return (
    typeof token === "string" &&
    token.length > 0 &&
    token.length <= MAX_RELOAD_TOKEN_CHARACTERS
  );
}

function isReloadRule(rule) {
  return (
    rule !== null &&
    typeof rule === "object" &&
    isReloadToken(rule.token) &&
    typeof rule.endpoint === "string" &&
    rule.endpoint.length > 0 &&
    typeof rule.procedure === "string" &&
    rule.procedure.length > 0 &&
    (rule.topic === null || typeof rule.topic === "string") &&
    typeof rule.resultBody === "string" &&
    rule.resultBody.length <= MAX_MOCK_BODY_CHARACTERS &&
    (rule.persistent === undefined ||
      (typeof rule.persistent?.enabled === "boolean" &&
        Number.isSafeInteger(rule.persistent.revision) &&
        rule.persistent.revision >= 0))
  );
}

async function restoreReloadMock(channel) {
  const now = () => globalThis.performance?.now() ?? Date.now();
  const deadline = now() + RELOAD_LOOKUP_BUDGET_MS;
  const request = { type: "get-reload-mock" };
  try {
    let rules;
    for (let attempt = 0; ; attempt += 1) {
      if (mockChannel !== channel) return;
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.id) {
        stopForwarding();
        return;
      }
      const response = await runtime.sendMessage(request);
      if (mockChannel !== channel) return;

      rules = Array.isArray(response?.rules)
        ? response.rules.filter(isReloadRule)
        : [];
      if (rules.length || response?.retry !== true) break;
      const delay = RELOAD_RETRY_DELAYS[attempt];
      if (delay === undefined || now() + delay > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (now() > deadline) return;
    }
    const oneShot = rules.find((rule) => !rule.persistent) ?? null;
    for (const rule of [oneShot, ...rules.filter((rule) => rule.persistent)]) {
      if (deliverReloadMock(channel, rule) && rule)
        void forwardRuntimeMessage({
          type: "mock-reload-readiness",
          token: rule.token,
          ready: rule.persistent?.enabled !== false,
          ...(rule.persistent ? { revision: rule.persistent.revision } : {}),
        });
    }
  } catch (error) {
    handleForwardingError(error);
  }
}

function deliverReloadMock(channel, rule) {
  return !channel.dispatchEvent(
    new CustomEvent("wamp-inspector:restore-mock", {
      cancelable: true,
      detail: JSON.stringify(rule),
    }),
  );
}

function forwardReloadConsumed(event) {
  const token = event.detail;
  if (isReloadToken(token))
    return forwardRuntimeMessage({ type: "mock-reload-consumed", token });
}

function forwardReloadDetached(event) {
  const token = event.detail;
  if (isReloadToken(token))
    return forwardRuntimeMessage({
      type: "mock-reload-readiness",
      token,
      ready: false,
    });
}

function stopForwarding() {
  window.removeEventListener("message", forwardInspectorMessage);
  mockChannel?.removeEventListener(
    "wamp-inspector:mock-state",
    forwardMockState,
  );
  mockChannel?.removeEventListener(
    "wamp-inspector:reload-consumed",
    forwardReloadConsumed,
  );
  mockChannel?.removeEventListener(
    "wamp-inspector:reload-detached",
    forwardReloadDetached,
  );
  mockChannel = null;
}

function handleForwardingError(error) {
  if (error?.message === "Extension context invalidated.") {
    stopForwarding();
  } else if (!reportedForwardingError) {
    reportedForwardingError = true;
    console.warn(
      "WAMP Inspector: could not communicate with the extension worker",
      error?.message,
    );
  }
}

async function forwardRuntimeMessage(message) {
  try {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.id) {
      stopForwarding();
      return;
    }

    await runtime.sendMessage(message);
    reportedForwardingError = false;
  } catch (error) {
    handleForwardingError(error);
  }
}

window.addEventListener("message", forwardInspectorMessage);

function armMockResponse(message) {
  const {
    socketId,
    callMessageId,
    resultMessageId,
    resultBody,
    reloadToken,
    persistent,
  } = message;
  const channel = mockChannel;
  if (
    !channel ||
    ![socketId, callMessageId, resultMessageId].every(Number.isSafeInteger) ||
    socketId < 1 ||
    callMessageId < 1 ||
    resultMessageId <= callMessageId ||
    (resultBody !== undefined &&
      (typeof resultBody !== "string" ||
        resultBody.length > MAX_MOCK_BODY_CHARACTERS)) ||
    (reloadToken !== undefined && !isReloadToken(reloadToken)) ||
    (persistent !== undefined &&
      (persistent !== true || !isReloadToken(reloadToken)))
  ) {
    return { ok: false };
  }

  const commandParts = [socketId, callMessageId, resultMessageId];
  if (reloadToken !== undefined)
    commandParts.push(resultBody ?? null, reloadToken);
  else if (resultBody !== undefined) commandParts.push(resultBody);
  if (persistent) commandParts.push(true);
  const command = new CustomEvent("wamp-inspector:arm", {
    cancelable: true,
    detail: JSON.stringify(commandParts),
  });

  let reload;
  function captureReloadRule(event) {
    const rule = parseDetail(event);
    if (isReloadRule(rule) && rule.token === reloadToken) reload = rule;
  }

  if (reloadToken !== undefined)
    channel.addEventListener("wamp-inspector:reload-armed", captureReloadRule);
  try {
    const ok = !channel.dispatchEvent(command);
    return ok && reload ? { ok, reload } : { ok };
  } finally {
    if (reloadToken !== undefined)
      channel.removeEventListener(
        "wamp-inspector:reload-armed",
        captureReloadRule,
      );
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message?.type === "capture-availability") {
    sendResponse({ available: true });
  }
  if (message?.type === "arm-mock-response" && !sender.tab) {
    sendResponse(armMockResponse(message));
  }
  if (message?.type === "sync-persistent-mock" && !sender.tab) {
    const { rule } = message;
    const ok = Boolean(
      mockChannel &&
      isReloadRule(rule) &&
      rule.persistent &&
      deliverReloadMock(mockChannel, rule),
    );
    sendResponse({ ok });
  }
  if (
    message?.type === "cancel-one-shot-mock" &&
    !sender.tab &&
    isReloadToken(message.token)
  ) {
    mockChannel?.dispatchEvent(
      new CustomEvent("wamp-inspector:cancel-mock", { detail: message.token }),
    );
    sendResponse({ ok: Boolean(mockChannel) });
  }
});
