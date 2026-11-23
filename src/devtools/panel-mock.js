const scenarios = new Set(["demo.success", "demo.error", "demo.no_response"]);

/** @param {string} address */
function mockOrigin(address) {
  try {
    const url = new URL(address);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** @param {string} origin @param {string} scenario */
function mockExpression(origin, scenario) {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== "/")
      return { status: "unavailable" };
    return window.wampInspectorMockDemo?.sendCall(${JSON.stringify(scenario)})
      ?? { status: "unavailable" };
  })()`;
}

/** @param {unknown} response */
function statusMessage(response) {
  const { status, requestId } =
    /** @type {{status?: unknown, requestId?: unknown}} */ (response ?? {});
  switch (status) {
    case "sent":
      if (Number.isSafeInteger(requestId))
        return `CALL #${requestId} sent. See the capture below.`;
      break;
    case "busy":
      return "Already waiting for a mock CALL. Try again in a moment.";
    case "not_connected":
      return "The mock demo is not connected. Reload the page and try again.";
    case "invalid_scenario":
      return "Choose a mock scenario.";
    case "unavailable":
      return "The mock demo could not send a CALL. Open the WAMP mock demo in this tab and try again.";
  }
  return "Unable to send mock CALL. Reload the mock demo and try again.";
}

/**
 * @param {{trigger: HTMLButtonElement, popover: HTMLElement, form: HTMLFormElement, scenario: HTMLSelectElement, send: HTMLButtonElement, status: HTMLElement}} controls
 * @param {typeof chrome.devtools.inspectedWindow} [inspectedWindow]
 */
export function bindMockSender(
  { trigger, popover, form, scenario, send, status },
  inspectedWindow = chrome.devtools.inspectedWindow,
) {
  /** @type {string | null} */
  let origin = null;
  let revision = 0;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!origin || send.disabled) return;
    if (!scenarios.has(scenario.value)) {
      status.textContent = statusMessage({ status: "invalid_scenario" });
      return;
    }

    const submittedRevision = revision;
    send.disabled = true;
    status.textContent = "Sending mock CALL…";

    /** @param {unknown} [response] */
    function showResult(response) {
      if (submittedRevision !== revision) return;
      send.disabled = false;
      status.textContent = statusMessage(response);
    }

    try {
      inspectedWindow.eval(
        mockExpression(origin, scenario.value),
        (response, exception) => showResult(exception ? undefined : response),
      );
    } catch {
      showResult();
    }
  });

  return /** @param {string} address */ (address) => {
    origin = mockOrigin(address);
    revision += 1;
    trigger.hidden = !origin;
    send.disabled = false;
    status.textContent = "";
    if (popover.matches(":popover-open")) popover.hidePopover();
  };
}
