import { analyzeMessages } from "./panel-messages.js";
import { MessageSearch, syncChildren } from "./panel-search.js";
import { createJsonPreview } from "./panel-json-preview.js";
import { PayloadSearch } from "./panel-payload-search.js";
import { PayloadPanelResize } from "./panel-resize.js";
import { bindTopicColumn, MessageColumnResize } from "./panel-columns.js";
import { subscribeToCapture } from "./panel-capture-stream.js";
import { bindMockSender } from "./panel-mock.js";
import { bindMockResponseEditor } from "./panel-mock-response.js";
import { PayloadColumns } from "./panel-payload-columns.js";
import { sendCaptureRequest } from "../shared/capture-client.js";

const $ = (selector) => document.querySelector(selector);
const clone = (name) =>
  $(`#${name}-template`).content.firstElementChild.cloneNode(true);
const tabId = chrome.devtools.inspectedWindow.tabId;
const picker = $("#socket-picker");
const pickOpen = $("#pick-open");
const pickClosed = $("#pick-closed");
const openConnections = $("#connections");
const closedConnections = $("#closed-connections");
const closedHistory = $("#closed-history");
const clearButton = $("#clear");
const socketDetails = $("#socket-details");
const metadata = $("#metadata");
const noConnectionOption = new Option("No connections", "");
const stream = $(".stream");
const columnResize = new MessageColumnResize(stream);
bindTopicColumn(stream, $("#show-topic-column"), columnResize);
const inspector = $("#message-inspector");
const payloads = $("#payload-contents");
const panelResize = new PayloadPanelResize(inspector);
const payloadSearch = new PayloadSearch(inspector, payloads, () =>
  panelResize.update(),
);
const sockets = new Map();
const setMockPage = bindMockSender({
  trigger: $("#mock-open"),
  popover: $("#mock-controls"),
  form: $("#mock-controls"),
  scenario: $("#mock-scenario"),
  topic: $("#mock-topic"),
  send: $("#mock-send"),
  status: $("#mock-status"),
});

const mockResponseEditor = bindMockResponseEditor({
  opener: $("#mock-response-open"),
  dialog: $("#mock-response-editor"),
  form: $("#mock-response-form"),
  procedure: $("#mock-response-procedure"),
  topic: $("#mock-response-topic"),
  json: $("#mock-response-json"),
  apply: $("#mock-response-apply"),
  status: $("#mock-response-status"),
});

const clockOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};
const connectionClock = new Intl.DateTimeFormat(undefined, clockOptions);
const messageClock = new Intl.DateTimeFormat(undefined, {
  ...clockOptions,
  fractionalSecondDigits: 3,
});
const stateLabels = {
  OPEN: "Open",
  CONNECTING: "Connecting",
  CLOSING: "Closing",
  CLOSED: "Closed",
};
const directions = {
  sent: ["↑", "Sent"],
  received: ["↓", "Received"],
  exchange: ["⇅", "Request and response"],
};

let selectedSocketKey = null;
let selectedMessageKey = null;
let rowViews = new Map();
let messageSnapshot = null;
let captureRevision = 0;
let detailRequest = 0;
let refreshing = false;
let connectionsQueued = false;
let messagesQueued = false;
let refreshRetry = null;
let refreshRetryDelay = 250;
let clearing = false;
let visibleMetadata = "";
let pageUrlKnown = false;

const messageSearch = new MessageSearch(() => {
  if (rowViews.get(selectedMessageKey)?.item.hidden) closeInspector();
});
const payloadColumns = new PayloadColumns(stream, columnResize, () => {
  for (const { item, message } of rowViews.values())
    payloadColumns.renderCells(item, message);
});

function text(element, value) {
  const next = String(value ?? "");
  if (element.textContent !== next) element.textContent = next;
}

function formatTime(value, formatter = messageClock) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? formatter.format(time) : "—";
}

function setPageUrl(url) {
  pageUrlKnown = true;
  const page = $("#inspected-url");
  const address = typeof url === "string" ? url : "";
  text(page, address.replace(/^https?:\/\//, "") || "Unknown page URL");
  page.title = address;
  setMockPage(address);
  mockResponseEditor.setPage(address);
  updateMockResponseTarget();
}

function stateLabel(state) {
  return Object.hasOwn(stateLabels, state) ? stateLabels[state] : "Unknown";
}

function setCaptureStatus(message) {
  const status = $("#capture-status");
  text(status, message);
  status.hidden = !message;
}

function socketKey(socket) {
  const key = `${socket.frameId ?? 0}:${socket.id}`;
  return socket.documentId ? `${key}:${socket.documentId}` : key;
}

function createSocketView(key) {
  const item = clone("connection");
  const button = item.querySelector("button");
  button.addEventListener("click", () => chooseSocket(key));
  return { item, button, option: new Option("", key), socket: null };
}

function updateSocketView(view, socket) {
  view.socket = socket;
  const state = stateLabel(socket.state);
  const address =
    typeof socket.url === "string" && socket.url
      ? socket.url
      : "Unknown endpoint";
  const endpoint = address.replace(/^wss?:\/\//, "");
  const frame = `Frame ${socket.frameId ?? 0}`;
  const time = formatTime(socket.createdAt, connectionClock);
  const status = view.item.querySelector(".status");

  text(view.item.querySelector("code"), endpoint);
  text(status, state);
  status.dataset.state = socket.state ?? "";
  text(view.item.querySelector(".frame"), frame);
  text(view.item.querySelector("time"), time);
  view.button.title = address;
  text(view.option, `${state} · ${frame} · ${time} · ${endpoint}`);
}

function compareSockets(first, second) {
  const openFirst =
    Number(second.state === "OPEN") - Number(first.state === "OPEN");
  return (
    openFirst ||
    (Date.parse(second.createdAt) || 0) - (Date.parse(first.createdAt) || 0)
  );
}

function updateMockResponseTarget() {
  mockResponseEditor.setCall(
    sockets.get(selectedSocketKey)?.socket ?? null,
    rowViews.get(selectedMessageKey)?.message ?? null,
  );
}

function updateSocketSelection() {
  for (const [key, { button }] of sockets) {
    const pressed = String(key === selectedSocketKey);
    if (button.getAttribute("aria-pressed") !== pressed)
      button.setAttribute("aria-pressed", pressed);
  }
  const selected = selectedSocketKey ?? "";
  if (picker.value !== selected) picker.value = selected;
  renderSocketMetadata(sockets.get(selectedSocketKey)?.socket);
  updateMockResponseTarget();
}

/** @param {import("../shared/capture-contracts.js").SocketSummary[]} socketList */
function renderSockets(socketList) {
  const sorted = socketList
    .filter((socket) => Number.isSafeInteger(socket?.id))
    .toSorted(compareSockets);
  const open = [];
  const closed = [];
  const retained = new Set();

  for (const socket of sorted) {
    const key = socketKey(socket);
    const view = sockets.get(key) ?? createSocketView(key);
    updateSocketView(view, socket);
    sockets.set(key, view);
    retained.add(key);
    (socket.state === "CLOSED" ? closed : open).push(view);
  }
  for (const key of sockets.keys()) {
    if (!retained.has(key)) sockets.delete(key);
  }

  syncChildren(
    openConnections,
    open.map(({ item }) => item),
  );
  syncChildren(
    closedConnections,
    closed.map(({ item }) => item),
  );
  syncChildren(
    pickOpen,
    open.map(({ option }) => option),
  );
  syncChildren(
    pickClosed,
    closed.map(({ option }) => option),
  );
  text($("#count"), open.length);
  text($("#closed-count"), closed.length);
  $("#no-connections").hidden = open.length > 0;
  closedHistory.hidden = pickClosed.hidden = closed.length === 0;
  pickOpen.hidden = open.length === 0;
  picker.disabled = sorted.length === 0;
  if (picker.disabled) {
    if (!noConnectionOption.isConnected) picker.prepend(noConnectionOption);
  } else {
    noConnectionOption.remove();
  }

  if (!sockets.has(selectedSocketKey)) {
    const first = open[0] ?? closed[0];
    setSelectedSocket(first?.option.value ?? null);
    if (first?.socket.state === "CLOSED") closedHistory.open = true;
  }
  updateSocketSelection();
}

function renderSocketMetadata(socket) {
  socketDetails.hidden = !socket;
  if (!socket) return;

  const fields = [
    ["Endpoint", socket.url || "Unknown endpoint"],
    ["State", stateLabel(socket.state)],
    ["Frame", socket.frameId ?? 0],
    ["Protocol", socket.protocol],
    ["Requested", socket.requestedProtocols],
    ["Extensions", socket.extensions],
    ["Last event", socket.eventType],
  ];
  const signature = JSON.stringify(fields);
  if (signature === visibleMetadata) return;
  visibleMetadata = signature;
  metadata.replaceChildren(
    ...fields.map(([heading, value]) => {
      const group = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      text(term, heading);
      text(detail, value || (value === 0 ? 0 : "—"));
      group.append(term, detail);
      return group;
    }),
  );
}

function closeInspector(restoreFocus = false) {
  const button = rowViews.get(selectedMessageKey)?.button;
  button?.setAttribute("aria-expanded", "false");
  selectedMessageKey = null;
  updateMockResponseTarget();
  inspector.hidden = true;
  payloadSearch.close();
  payloadSearch.setPayloads();
  payloads.replaceChildren();
  if (restoreFocus) button?.focus({ preventScroll: true });
}

function createPayload(label, meta, payload, source = "request") {
  const section = clone("payload");
  text(section.querySelector("strong"), label);
  text(section.querySelector("header code"), meta);
  const body = section.querySelector(".payload-body");

  if (!payload) {
    body.classList.add("payload-waiting");
    text(body, "Waiting for response");
  } else if (payload.kind === "json") {
    body.append(
      createJsonPreview(payload.value, (path) =>
        payloadColumns.offer(source, path),
      ),
    );
  } else {
    const frameText = document.createElement("code");
    frameText.className = "payload-text";
    text(frameText, payload.value || "Empty text frame");
    body.append(frameText);
  }

  return section;
}

function createReply(message) {
  const meta = message.response
    ? `${message.responseType} · ${formatTime(message.responseTime)}`
    : "";
  return createPayload("Response", meta, message.response, "response");
}

function toggleInspector(key) {
  if (selectedMessageKey === key) {
    closeInspector();
    return;
  }

  const view = rowViews.get(key);
  if (!view) return;
  const { button, message } = view;
  const exchange = message.direction === "exchange";
  closeInspector();
  selectedMessageKey = key;
  updateMockResponseTarget();
  button.setAttribute("aria-expanded", "true");
  text(
    $("#inspected-message"),
    message.id == null ? message.type : `${message.type} · #${message.id}`,
  );
  const timestamp = formatTime(message.time);
  const meta = exchange
    ? timestamp
    : `${directions[message.direction][1]} · ${timestamp}`;
  payloads.append(
    createPayload(exchange ? "Request" : message.type, meta, message.payload),
  );
  if (exchange) payloads.append(createReply(message));
  payloadSearch.setPayloads(message.payload, message.response);

  inspector.hidden = false;
  panelResize.update();
  payloads.scrollTop = 0;
  const overflow =
    button.getBoundingClientRect().bottom -
    stream.getBoundingClientRect().bottom;
  if (overflow > 0) stream.scrollTop += overflow;
}

function renderMessageRow(message, previous) {
  if (
    previous &&
    previous.message.replyKey === message.replyKey &&
    previous.message.type === message.type &&
    previous.message.id === message.id &&
    previous.message.summary === message.summary &&
    previous.message.topic === message.topic
  ) {
    return previous;
  }
  const item = previous?.item ?? clone("message");
  const button = item.querySelector("button");
  if (!previous)
    button.addEventListener("click", () => toggleInspector(message.key));

  const [symbol, direction] = directions[message.direction];
  const icon = item.querySelector(".direction");
  const latency = item.querySelector(".latency");
  const summary = item.querySelector(".preview");
  const topic = item.querySelector(".row-topic");
  text(icon, symbol);
  icon.className = `direction ${message.direction}`;
  icon.title = direction;
  icon.setAttribute("aria-label", direction);
  icon.setAttribute("role", "img");
  text(item.querySelector(".message-type"), message.type);
  text(
    item.querySelector(".request-id"),
    message.id == null ? "—" : `#${message.id}`,
  );
  text(summary, message.summary || "—");
  summary.title = message.summary;
  summary.toggleAttribute(
    "data-empty",
    !message.summary && message.topic !== null,
  );
  text(topic, message.topic ?? "—");
  topic.toggleAttribute("data-empty", message.topic === null);
  if (message.topic !== null) {
    const label = message.type === "CALL" ? "Application topic" : "WAMP topic";
    topic.title = `${label} · ${message.topic}`;
    topic.setAttribute("aria-label", topic.title);
  } else {
    topic.removeAttribute("title");
    topic.removeAttribute("aria-label");
  }
  text(item.querySelector(".message-time"), formatTime(message.time));
  text(
    latency,
    message.latency != null
      ? `${message.latency} ms`
      : message.responseState === "pending"
        ? "Pending"
        : "—",
  );
  latency.classList.toggle("pending", message.responseState === "pending");
  latency.classList.toggle("error", message.responseState === "error");
  latency.title = message.responseType ?? "";
  payloadColumns.renderCells(item, message);
  return { item, button, message };
}

function clearMessageView(emptyMessage) {
  closeInspector();
  rowViews = new Map();
  messageSnapshot = null;
  text($("#message-count"), 0);
  text($("#pending-count"), 0);
  text($("#avg-response"), "—");
  messageSearch.setRows([], emptyMessage);
}

/** @param {import("../shared/capture-contracts.js").SocketDetail} socket */
function renderMessages(socket) {
  const messages = Array.isArray(socket.messages)
    ? socket.messages.filter(
        (message) => message && typeof message === "object",
      )
    : [];
  const first = messages[0];
  const last = messages.at(-1);
  const signature = JSON.stringify([
    messages.length,
    first?.messageId,
    last?.messageId,
    last?.timestamp,
    socket.lastMessageAt,
  ]);
  if (signature === messageSnapshot) return;
  const preserveScroll = messageSnapshot !== null;
  messageSnapshot = signature;

  const { rows, pendingCount, averageLatency } = analyzeMessages(messages);
  text($("#message-count"), messages.length);
  text($("#pending-count"), pendingCount);
  text(
    $("#avg-response"),
    averageLatency == null ? "—" : `${averageLatency} ms`,
  );

  const next = new Map(
    rows.map((row) => [row.key, renderMessageRow(row, rowViews.get(row.key))]),
  );
  const before = rowViews.get(selectedMessageKey)?.message;
  const after = next.get(selectedMessageKey)?.message;
  if (before && !after) closeInspector();
  if (after && before?.replyKey !== after.replyKey) {
    payloads.lastElementChild?.replaceWith(createReply(after));
    payloadSearch.setPayloads(after.payload, after.response);
  }
  rowViews = next;
  updateMockResponseTarget();
  messageSearch.setRows(
    [...rowViews.values()],
    "No WAMP messages on this connection.",
    { preserveScroll },
  );
}

function setSelectedSocket(key) {
  if (key === selectedSocketKey) return false;
  selectedSocketKey = key;
  detailRequest += 1;
  socketDetails.open = false;
  clearMessageView(
    key === null ? "No WAMP messages captured yet." : "Loading messages…",
  );
  return true;
}

function chooseSocket(key) {
  const view = sockets.get(key);
  if (!view) return;
  if (view.socket.state === "CLOSED") closedHistory.open = true;
  if (!setSelectedSocket(key)) return;
  updateSocketSelection();
  queueCaptureRefresh({ messages: true });
}

async function refreshSelectedSocket() {
  const key = selectedSocketKey;
  const socket = sockets.get(key)?.socket;
  if (!socket) return;
  const request = ++detailRequest;

  try {
    const response = await sendCaptureRequest({
      type: "get-socket-detail",
      tabId,
      frameId: socket.frameId ?? 0,
      socketId: socket.id,
      documentId: socket.documentId ?? null,
    });
    if (request !== detailRequest || clearing) return;
    if (response?.socket) renderMessages(response.socket);
    else clearMessageView("This connection is no longer available.");
    setCaptureStatus("");
  } catch (error) {
    if (request === detailRequest && !clearing) throw error;
  }
}

function queueCaptureRefresh({ connections = false, messages = false }) {
  connectionsQueued ||= connections;
  messagesQueued ||= messages;
  void refreshCapture();
}

async function refreshCapture() {
  if (
    refreshing ||
    clearing ||
    refreshRetry !== null ||
    (!connectionsQueued && !messagesQueued)
  )
    return;
  refreshing = true;
  const readConnections = connectionsQueued;
  const readMessages = messagesQueued;
  connectionsQueued = false;
  messagesQueued = false;
  const revision = captureRevision;
  const previousSocketKey = selectedSocketKey;

  try {
    if (readConnections) {
      const response = await sendCaptureRequest({ type: "get-sockets", tabId });
      if (revision !== captureRevision || clearing) return;
      if (!Array.isArray(response?.sockets))
        throw new Error("Missing socket list");
      renderSockets(response.sockets);
    }
    if (readMessages || selectedSocketKey !== previousSocketKey)
      await refreshSelectedSocket();
    if (revision !== captureRevision || clearing) return;
    refreshRetryDelay = 250;
    setCaptureStatus("");
  } catch (error) {
    if (revision !== captureRevision || clearing) return;
    console.warn("WAMP Inspector: unable to refresh the capture", error);
    setCaptureStatus(
      "Unable to refresh the capture. The inspector will retry automatically.",
    );
    connectionsQueued ||= readConnections;
    messagesQueued = true;
    refreshRetry = window.setTimeout(() => {
      refreshRetry = null;
      void refreshCapture();
    }, refreshRetryDelay);
    refreshRetryDelay = Math.min(refreshRetryDelay * 2, 4000);
  } finally {
    refreshing = false;
    void refreshCapture();
  }
}

/** @param {import("../shared/capture-contracts.js").CaptureUpdate} message */
function onCaptureUpdate(message) {
  if (message?.type === "capture-ready") {
    window.clearTimeout(refreshRetry);
    refreshRetry = null;
    refreshRetryDelay = 250;
    queueCaptureRefresh({ connections: true, messages: true });
  } else if (message?.type === "capture-updated") {
    queueCaptureRefresh({
      connections: message.connections === true,
      messages:
        message.allMessages === true ||
        message.socketKeys?.includes(selectedSocketKey) === true,
    });
  }
}

function resetCapture() {
  captureRevision += 1;
  detailRequest += 1;
  closedHistory.open = false;
  renderSockets([]);
  setCaptureStatus("");
}

picker.addEventListener("change", () => chooseSocket(picker.value));
$("#close-inspector").addEventListener("click", () => closeInspector(true));
clearButton.addEventListener("click", async () => {
  if (clearing) return;
  clearing = true;
  clearButton.disabled = true;
  const revision = ++captureRevision;
  detailRequest += 1;
  try {
    const response = await sendCaptureRequest({
      type: "clear-messages",
      tabId,
    });
    if (!response?.ok) throw new Error("Message clear was not confirmed");
    if (revision === captureRevision) {
      clearMessageView(
        selectedSocketKey
          ? "No WAMP messages on this connection."
          : "No WAMP messages captured yet.",
      );
      setCaptureStatus("");
    }
  } catch (error) {
    if (revision === captureRevision) {
      console.warn("WAMP Inspector: unable to clear messages", error);
      setCaptureStatus("Unable to clear messages. Try again.");
    }
  } finally {
    clearing = false;
    clearButton.disabled = false;
  }
  queueCaptureRefresh({ connections: true, messages: true });
});

chrome.devtools.network.onNavigated.addListener((url) => {
  resetCapture();
  setPageUrl(url);
  queueCaptureRefresh({ connections: true, messages: true });
});

chrome.devtools.inspectedWindow.eval("location.href", (url, exception) => {
  if (!pageUrlKnown) setPageUrl(exception ? null : url);
});

clearMessageView("No WAMP messages captured yet.");
renderSockets([]);
subscribeToCapture(tabId, onCaptureUpdate, () => {
  setCaptureStatus("Reconnecting to the background worker…");
});
