const timeoutMs = 2000;
const connectionStatus = document.querySelector("#connection-status");
const result = document.querySelector("#call-result");
const scenario = document.querySelector("#scenario");
const form = document.querySelector("form");
const sendButton = form.querySelector("button");
const socket = new WebSocket(`ws://${window.location.host}/ws`, "wamp.2.json");

let nextRequestId = 1;
let connected = false;
let pending = null;

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
  connectionStatus.textContent = message;
  finishCall("Connection closed before a response arrived.");
  sendButton.disabled = true;
}

socket.addEventListener("close", (event) => {
  onDisconnect(event.wasClean ? "Disconnected" : "Connection failed");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!connected || pending) return;

  const id = nextRequestId++;
  sendButton.disabled = true;
  result.textContent = `Waiting for request ${id}…`;
  const timer = window.setTimeout(() => {
    finishCall(`Timed out waiting for a reply to request ${id}.`);
  }, timeoutMs);
  pending = { id, timer };
  socket.send(JSON.stringify([48, id, {}, scenario.value]));
});
