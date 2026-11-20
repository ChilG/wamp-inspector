let reportedForwardingError = false;

async function forwardInspectorMessage(event) {
  if (event.source !== window) {
    return;
  }

  if (
    event.data?.source !== "wamp-inspector" ||
    (event.data?.type !== "ws-event" && event.data?.type !== "ws-message")
  ) {
    return;
  }

  try {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.id) {
      window.removeEventListener("message", forwardInspectorMessage);
      return;
    }

    await runtime.sendMessage({
      type: event.data.type,
      payload: event.data.payload,
    });
    reportedForwardingError = false;
  } catch (error) {
    if (error?.message === "Extension context invalidated.") {
      window.removeEventListener("message", forwardInspectorMessage);
    } else if (!reportedForwardingError) {
      reportedForwardingError = true;
      console.warn(
        "WAMP Inspector: could not forward a WebSocket event",
        error?.message,
      );
    }
  }
}

window.addEventListener("message", forwardInspectorMessage);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type === "capture-availability" &&
    sender.id === chrome.runtime.id
  ) {
    sendResponse({ available: true });
  }
});
