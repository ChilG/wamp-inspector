const timeoutMs = 2000;
const procedures = new Set(["demo.success", "demo.error", "demo.no_response"]);
const connectionStatus = document.querySelector("#connection-status");
const result = document.querySelector("#call-result");
const scenario = document.querySelector("#scenario");
const form = document.querySelector("form");
const sendButton = form.querySelector("button");
const socket = new WebSocket(`ws://${window.location.host}/ws`, "wamp.2.json");

let nextRequestId = 1;
let connected = false;
let pending = null;
let controlToken = null;

function finishCall(message) {
  if (!pending) return;
  window.clearTimeout(pending.timer);
  pending = null;
  result.textContent = message;
  sendButton.disabled = !connected;
}

socket.addEventListener("open", () => {
  socket.send(JSON.stringify([1, "demo", { roles: { caller: {} } }]));
});

socket.addEventListener("message", (event) => {
  const [type, idOrRequestType, detailsOrRequestId, , errorUri] = JSON.parse(
    event.data,
  );

  if (type === 2) {
    connected = true;
    const token = detailsOrRequestId?.x_mock_control;
    controlToken = typeof token === "string" ? token : null;
    connectionStatus.textContent = "Connected";
    sendButton.disabled = false;
  }

  if (type === 50 && pending?.id === idOrRequestType) {
    finishCall(`Success. Received RESULT for request ${pending.id}.`);
  }

  if (
    type === 8 &&
    idOrRequestType === 48 &&
    pending?.id === detailsOrRequestId
  ) {
    finishCall(`Error. ${errorUri} for request ${pending.id}.`);
  }
});

function onDisconnect(message) {
  connected = false;
  controlToken = null;
  connectionStatus.textContent = message;
  finishCall("Connection closed before a response arrived.");
  sendButton.disabled = true;
}

socket.addEventListener("close", (event) => {
  onDisconnect(event.wasClean ? "Disconnected" : "Connection failed");
});

function hasOpenSession() {
  return connected && socket.readyState === WebSocket.OPEN;
}

function sendCall(procedure, topic = null) {
  if (
    !procedures.has(procedure) ||
    (topic !== null &&
      (typeof topic !== "string" || !topic.trim() || topic.length > 512))
  )
    return { status: "invalid_scenario" };
  if (!hasOpenSession()) return { status: "not_connected" };
  if (pending) return { status: "busy" };

  const id = nextRequestId;
  const frame = [48, id, {}, procedure];
  try {
    socket.send(
      JSON.stringify(topic === null ? frame : [...frame, [], { topic }]),
    );
  } catch {
    result.textContent = "Unable to send the mock CALL.";
    return { status: "unavailable" };
  }

  nextRequestId += 1;
  scenario.value = procedure;
  sendButton.disabled = true;
  result.textContent = `Waiting for request ${id}…`;
  const timer = window.setTimeout(() => {
    finishCall(`Timed out waiting for a reply to request ${id}.`);
  }, timeoutMs);
  pending = { id, timer };
  return { status: "sent", requestId: id };
}

window.wampInspectorMockDemo = Object.freeze({
  sendCall,
  getControlToken: () => (hasOpenSession() ? controlToken : null),
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendCall(scenario.value);
});
