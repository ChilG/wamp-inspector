import {
  isMockProcedure,
  isMockResponse,
  isMockTopic,
} from "../shared/wamp-mock-response.js";
import { mockOrigin } from "./panel-mock.js";

/** @typedef {import("../shared/capture-contracts.js").SocketSummary} SocketSummary */
/** @typedef {{key: string, type: string, direction: string, topic: string | null, id: number | string | null, payload?: {kind: string, value: unknown}, response?: {kind: string, value: unknown}}} CallRow */

/** @param {string | null} origin @param {SocketSummary | null} socket @param {CallRow | null} row */
function selectedCall(origin, socket, row) {
  if (
    !origin ||
    socket?.frameId !== 0 ||
    socket.state !== "OPEN" ||
    socket.url !== `ws://${new URL(origin).host}/ws` ||
    row?.type !== "CALL" ||
    row.direction !== "exchange" ||
    !Array.isArray(row.payload?.value)
  ) {
    return null;
  }

  const procedure = row.payload.value[3];
  const topic = row.topic;
  if (!isMockProcedure(procedure) || !isMockTopic(topic)) return null;

  const captured =
    row.response?.kind === "json" ? row.response.value : undefined;
  return {
    key: row.key,
    procedure,
    topic,
    example: isMockResponse(captured) ? captured : [50, Number(row.id), {}, []],
  };
}

/** @param {typeof chrome.devtools.inspectedWindow} inspectedWindow @param {string} origin */
function readControlToken(inspectedWindow, origin) {
  const expression = `(() => {
    if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== "/")
      return null;
    return window.wampInspectorMockDemo?.getControlToken() ?? null;
  })()`;
  return new Promise((resolve) => {
    inspectedWindow.eval(expression, (token, error) => {
      resolve(!error && typeof token === "string" ? token : null);
    });
  });
}

/**
 * @param {{opener: HTMLButtonElement, dialog: HTMLDialogElement, form: HTMLFormElement, procedure: HTMLElement, topic: HTMLElement, json: HTMLTextAreaElement, apply: HTMLButtonElement, status: HTMLElement}} controls
 * @param {typeof chrome.devtools.inspectedWindow} [inspectedWindow]
 * @param {typeof fetch} [request]
 */
export function bindMockResponseEditor(
  { opener, dialog, form, procedure, topic, json, apply, status },
  inspectedWindow = chrome.devtools.inspectedWindow,
  request = fetch,
) {
  /** @type {string | null} */
  let origin = null;
  /** @type {ReturnType<typeof selectedCall>} */
  let selected = null;
  /** @type {AbortController | null} */
  let operation = null;

  function cancelApply() {
    operation?.abort();
    operation = null;
    apply.disabled = false;
  }

  /** @param {SocketSummary | null} socket @param {CallRow | null} row */
  function setCall(socket, row) {
    const next = selectedCall(origin, socket, row);
    const changed = selected?.key !== next?.key;
    selected = next;
    opener.hidden = !selected;
    if (changed && dialog.open) {
      cancelApply();
      dialog.close();
    }
  }

  opener.addEventListener("click", () => {
    if (!selected) return;
    procedure.textContent = selected.procedure;
    topic.textContent = selected.topic ?? "No topic";
    json.value = JSON.stringify(selected.example, null, 2);
    status.textContent = "";
    dialog.showModal();
  });

  dialog.addEventListener("close", cancelApply);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!origin || !selected || !dialog.open || operation) return;

    let response;
    try {
      response = JSON.parse(json.value);
    } catch {
      status.textContent = "Enter valid JSON.";
      return;
    }
    if (!isMockResponse(response)) {
      status.textContent = "Enter a final RESULT, a CALL ERROR, or null.";
      return;
    }

    const target = selected;
    const demoOrigin = origin;
    const applyOperation = new AbortController();
    operation = applyOperation;
    apply.disabled = true;
    status.textContent = "Applying mock response…";
    try {
      const token = await readControlToken(inspectedWindow, demoOrigin);
      if (applyOperation.signal.aborted) return;
      if (!token) {
        status.textContent =
          "The demo connection is unavailable. Reload the demo and try again.";
        return;
      }
      const outcome = await request(`${demoOrigin}/mock-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([
          applyOperation.signal,
          AbortSignal.timeout(5000),
        ]),
        body: JSON.stringify({
          token,
          procedure: target.procedure,
          topic: target.topic,
          response,
        }),
      });
      if (applyOperation.signal.aborted) return;
      if (outcome.ok) {
        status.textContent =
          "Next CALL with this procedure and topic will use the mock.";
      } else if (outcome.status === 404) {
        status.textContent =
          "The demo connection has closed. Reload the demo and try again.";
      } else if (outcome.status === 413) {
        status.textContent =
          "The mock response exceeds the router’s 32 KiB request limit.";
      } else {
        status.textContent =
          "The router rejected this mock response. Check the JSON and try again.";
      }
    } catch {
      if (!applyOperation.signal.aborted) {
        status.textContent =
          "Unable to reach the local mock router. Check the demo connection.";
      }
    } finally {
      if (operation === applyOperation) {
        operation = null;
        apply.disabled = false;
      }
    }
  });

  return {
    /** @param {string} address */
    setPage(address) {
      origin = mockOrigin(address);
      setCall(null, null);
    },
    setCall,
  };
}
