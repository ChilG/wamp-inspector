import { sendCaptureRequest } from "../shared/capture-client.js";

/** @typedef {import("../shared/capture-contracts.js").SocketSummary} SocketSummary */
/** @typedef {import("../shared/capture-contracts.js").DecodedPayload} DecodedPayload */
/** @typedef {{type: string, direction: string, response?: DecodedPayload, responseType?: string, responseMocked?: boolean, mockArmed?: boolean, messageId?: number, responseMessageId?: number}} MessageRow */
/** @typedef {Extract<import("../shared/capture-contracts.js").CaptureRequest, {type: "get-mock-response"}>} MockTarget */
/** @typedef {{resultBody: string | null}} SavedMock */

const MAX_EDITED_BODY = 1_048_576;

/** @param {string} source */
function readEditedBody(source) {
  if (source.length > MAX_EDITED_BODY)
    return { error: "Edited JSON must be 1,048,576 characters or less." };

  let body;
  try {
    body = JSON.parse(source);
  } catch {
    return { error: "Enter valid JSON." };
  }

  if (
    !Array.isArray(body) ||
    body.length > 2 ||
    (body.length >= 1 && !Array.isArray(body[0])) ||
    (body.length === 2 &&
      (!body[1] || typeof body[1] !== "object" || Array.isArray(body[1])))
  )
    return {
      error: "Enter RESULT arguments as [], [args], or [args, kwargs].",
    };

  try {
    const frame = [50, 0, {}, ...body];
    JSON.stringify(frame);
    structuredClone(frame);
  } catch {
    return { error: "The RESULT arguments are too deeply nested." };
  }

  return { value: source.trim() };
}

/** @param {MockTarget | null} first @param {MockTarget | null} second */
function sameCapture(first, second) {
  return (
    first !== null &&
    second !== null &&
    first.tabId === second.tabId &&
    first.frameId === second.frameId &&
    first.documentId === second.documentId &&
    first.socketId === second.socketId &&
    first.callMessageId === second.callMessageId &&
    first.resultMessageId === second.resultMessageId
  );
}

/**
 * @param {{
 *   opener: HTMLButtonElement, status: HTMLElement,
 *   form: HTMLFormElement, body: HTMLTextAreaElement, error: HTMLElement,
 *   apply: HTMLButtonElement, enable: HTMLButtonElement,
 *   cancel: HTMLButtonElement, onEdit: (editing: boolean) => void,
 *   onPreview: (preview: DecodedPayload | null, reveal: boolean) => void
 * }} controls
 * @param {typeof sendCaptureRequest} [send]
 */
export function bindMockResponse(
  {
    opener,
    status,
    form,
    body,
    error,
    apply,
    enable,
    cancel,
    onEdit,
    onPreview,
  },
  send = sendCaptureRequest,
) {
  /** @type {MockTarget | null} */
  let target = null;
  /** @type {MockTarget | null} */
  let loading = null;
  /** @type {SavedMock | null} */
  let saved = null;
  /** @type {import("../shared/capture-contracts.js").JsonValue[]} */
  let sample = [];
  let initialText = "";
  let arming = false;
  let canArm = false;
  let shownArmed = false;

  function updateOpener() {
    opener.hidden = !canArm || !form.hidden;
    opener.disabled = arming || loading !== null;
  }

  /** @param {SavedMock | null} entry */
  function showSaved(entry, reveal = false) {
    const value =
      entry?.resultBody != null ? JSON.parse(entry.resultBody) : sample;
    saved = entry;
    onPreview(entry ? { kind: "json", value } : null, reveal);
  }

  /** @param {MockTarget} request */
  async function loadSaved(request) {
    loading = request;
    updateOpener();
    try {
      const reply = await send(request);
      if (target === request && loading === request)
        showSaved(reply?.saved ?? null);
    } catch {
      // The connection history may have disappeared while loading the row.
    } finally {
      if (loading === request) {
        loading = null;
        updateOpener();
      }
    }
  }

  /** @param {boolean} armed */
  function showArmed(armed) {
    shownArmed = armed;
    status.textContent = armed
      ? "Next matching CALL will use the mock once."
      : "";
  }

  /** @param {boolean} editing */
  function setEditing(editing, restoreFocus = false) {
    if (form.hidden === !editing) return;
    form.hidden = !editing;
    updateOpener();
    onEdit(editing);
    if (editing) body.focus({ preventScroll: true });
    else if (restoreFocus && canArm) opener.focus({ preventScroll: true });
  }

  /** @param {string} message */
  function showError(message, invalid = false) {
    error.textContent = message;
    if (invalid) body.setAttribute("aria-invalid", "true");
    else body.removeAttribute("aria-invalid");
  }

  /** @param {boolean} pending */
  function setPending(pending) {
    arming = pending;
    updateOpener();
    apply.disabled = pending;
    enable.disabled = pending;
    cancel.disabled = pending;
    body.readOnly = pending;
  }

  opener.addEventListener("click", () => {
    if (!canArm || loading || arming || !form.hidden) return;
    try {
      initialText = saved?.resultBody ?? JSON.stringify(sample, null, 2);
    } catch {
      status.textContent = "This RESULT could not be opened in the editor.";
      return;
    }
    body.value = initialText;
    showError("");
    setEditing(true);
  });

  cancel.addEventListener("click", () => {
    if (!arming) setEditing(false, true);
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing && !arming) {
      event.preventDefault();
      setEditing(false, true);
    }
  });
  body.addEventListener("input", () => showError(""));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!target || !canArm || arming || form.hidden) return;
    const request = target;
    const persistent = event.submitter === enable;
    const edited =
      body.value === initialText ? null : readEditedBody(body.value);
    if (edited?.error) {
      showError(edited.error, true);
      body.focus();
      return;
    }
    const resultBody = edited?.value ?? saved?.resultBody ?? null;
    showError("");
    setPending(true);
    let accepted = false;
    try {
      const reply = await send({
        ...request,
        type: "arm-mock-response",
        ...(persistent ? { persistent: true } : {}),
        ...(resultBody === null ? {} : { resultBody }),
      });
      accepted = reply?.ok === true;
    } catch {
      // The document may disappear while Chrome routes the command.
    } finally {
      setPending(false);
    }
    if (accepted && sameCapture(target, request)) {
      loading = null;
      setEditing(false, true);
      showSaved({ resultBody }, true);
      updateOpener();
    } else if (target === request) {
      showError(
        persistent
          ? "Mock could not be enabled. Capture a fresh RESULT and try again."
          : "Mock could not be armed. Capture a fresh RESULT and try again.",
      );
    }
  });

  /**
   * @param {SocketSummary | null} socket
   * @param {MessageRow | null} call
   */
  return function setCall(socket, call) {
    const documentId = socket?.documentId;
    const callMessageId = call?.messageId;
    const resultMessageId = call?.responseMessageId;
    const response =
      call?.response?.kind === "json" ? call.response.value : null;
    const hasSource =
      socket?.protocol === "wamp.2.json" &&
      typeof documentId === "string" &&
      documentId.length > 0 &&
      call?.type === "CALL" &&
      call.direction === "exchange" &&
      call.responseType === "RESULT" &&
      !call.responseMocked &&
      Array.isArray(response) &&
      typeof callMessageId === "number" &&
      Number.isSafeInteger(callMessageId) &&
      callMessageId > 0 &&
      typeof resultMessageId === "number" &&
      Number.isSafeInteger(resultMessageId) &&
      resultMessageId > callMessageId;

    /** @type {MockTarget | null} */
    const selected = hasSource
      ? {
          type: "get-mock-response",
          tabId: socket.tabId,
          socketId: socket.id,
          frameId: socket.frameId,
          documentId,
          callMessageId,
          resultMessageId,
        }
      : null;
    canArm = selected !== null && socket?.state === "OPEN";
    const armed = call?.mockArmed === true;
    if (sameCapture(target, selected) || (!target && !selected)) {
      if (!canArm) setEditing(false);
      if (shownArmed !== armed) showArmed(armed);
      updateOpener();
      return;
    }

    sample = hasSource ? response.slice(3) : [];
    target = selected;
    loading = null;
    setEditing(false);
    showSaved(null);
    updateOpener();
    showArmed(armed);
    if (target) void loadSaved(target);
  };
}
