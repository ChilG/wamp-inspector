import { analyzeMessages } from "./panel-messages.js";
import { MessageSearch, syncChildren } from "./panel-search.js";
import { createJsonPreview } from "./panel-json-preview.js";
import { PayloadSearch } from "./panel-payload-search.js";
import { PayloadPanelResize } from "./panel-resize.js";
import { bindTopicColumn, MessageColumnResize } from "./panel-columns.js";
import { subscribeToCapture } from "./panel-capture-stream.js";
import { bindMockList } from "./panel-mock-list.js";
import { bindMockResponse } from "./panel-mock-response.js";
import { PayloadColumns } from "./panel-payload-columns.js";
import { bindConnectionPicker } from "./panel-connection-picker.js";
import {
  EMPTY_PREVIEW,
  PreviewTabStrip,
  closePreviewTab,
  hidePreview,
  openPreviewTab,
  retainPreviewTabs,
} from "./panel-preview-tabs.js";
import { sendCaptureRequest } from "../shared/capture-client.js";

const $ = (selector) => document.querySelector(selector);
const clone = (name) =>
  $(`#${name}-template`).content.firstElementChild.cloneNode(true);
const tabId = chrome.devtools.inspectedWindow.tabId;
const connectionPicker = bindConnectionPicker(
  $(".socket-select"),
  chooseSocket,
);
const openConnections = $("#connections");
const closedConnections = $("#closed-connections");
const closedHistory = $("#closed-history");
const clearButton = $("#clear");
const socketDetails = $("#socket-details");
const metadata = $("#metadata");
const stream = $(".stream");
const columnResize = new MessageColumnResize(stream);
bindTopicColumn(stream, $("#show-topic-column"), columnResize);
const inspector = $("#message-inspector");
const payloads = $("#payload-contents");
const previewTabs = new PreviewTabStrip(
  $("#preview-tabs-bar"),
  $("#preview-body"),
  {
    activate: showMessageTab,
    close: closeMessageTab,
  },
);
const panelResize = new PayloadPanelResize(inspector);
const payloadSearch = new PayloadSearch(inspector, payloads, () =>
  panelResize.update(),
);
const mockBody = $("#mock-response-body");
const renderMocks = bindMockList({
  tabId,
  onChange: () => queueCaptureRefresh({ connections: true }),
});
const sockets = new Map();
const previewStates = new Map();
const setMockCall = bindMockResponse({
  opener: $("#mock-response-open"),
  status: $("#mock-response-status"),
  form: $("#mock-response-form"),
  body: mockBody,
  error: $("#mock-response-error"),
  apply: $("#mock-response-apply"),
  enable: $("#mock-response-enable"),
  cancel: $("#mock-response-cancel"),
  onEdit(editing) {
    inspector.toggleAttribute("data-editing", editing);
    payloads.hidden = editing;
    payloadSearch.setEditor(editing ? mockBody : null);
    panelResize.update();
  },
  onPreview: renderSavedMock,
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
let savedMockPayload = null;
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

const messageSearch = new MessageSearch();
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
  const stateCode = socket.state ?? "";
  view.presentation = { address, endpoint, frame, state, stateCode, time };

  text(view.item.querySelector("code"), endpoint);
  text(status, state);
  status.dataset.state = stateCode;
  text(view.item.querySelector(".frame"), frame);
  text(view.item.querySelector("time"), time);
  view.button.title = address;
  text(view.option, `${endpoint} · ${frame} · ${state} · ${time}`);
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
  setMockCall(
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
  const selected = sockets.get(selectedSocketKey);
  connectionPicker.setSelected(selected);
  renderSocketMetadata(selected?.socket);
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
    if (retained.has(key)) continue;
    sockets.delete(key);
    previewStates.delete(key);
  }

  syncChildren(
    openConnections,
    open.map(({ item }) => item),
  );
  syncChildren(
    closedConnections,
    closed.map(({ item }) => item),
  );
  connectionPicker.setOptions(
    open.map(({ option }) => option),
    closed.map(({ option }) => option),
  );
  text($("#count"), open.length);
  text($("#closed-count"), closed.length);
  $("#no-connections").hidden = open.length > 0;
  closedHistory.hidden = closed.length === 0;

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

function resetInspector() {
  rowViews
    .get(selectedMessageKey)
    ?.button.setAttribute("aria-expanded", "false");
  selectedMessageKey = null;
  updateMockResponseTarget();
  inspector.hidden = true;
  payloadSearch.close();
  payloadSearch.setPayloads();
  payloads.replaceChildren();
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
    const onField = source
      ? (path) => payloadColumns.offer(source, path)
      : null;
    body.append(createJsonPreview(payload.value, onField));
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
    ? [
        message.responseType,
        message.responseMocked ? "Mocked" : "",
        formatTime(message.responseTime),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const section = createPayload("Response", meta, message.response, "response");
  section.dataset.payload = "response";
  return section;
}

function updatePayloadSearch(message) {
  if (!message) {
    payloadSearch.setPayloads();
    return;
  }
  const captured = [message.payload, message.response];
  payloadSearch.setPayloads(
    ...(savedMockPayload ? [savedMockPayload, ...captured] : captured),
  );
}

function renderSavedMock(payload, reveal) {
  const previous = payloads.querySelector("#saved-mock-response");
  savedMockPayload = payload;
  if (payload) {
    const section = createPayload("Mock response", "", payload, null);
    section.id = "saved-mock-response";
    if (previous) previous.replaceWith(section);
    else payloads.prepend(section);
  } else {
    previous?.remove();
  }
  updatePayloadSearch(rowViews.get(selectedMessageKey)?.message);
  if (reveal) payloads.scrollTop = 0;
}

function renderInspector(key) {
  if (selectedMessageKey === key) return;
  resetInspector();

  const view = rowViews.get(key);
  if (!view) return;
  const { button, message } = view;
  const exchange = message.direction === "exchange";
  selectedMessageKey = key;
  button.setAttribute("aria-expanded", "true");
  const timestamp = formatTime(message.time);
  const meta = exchange
    ? timestamp
    : `${directions[message.direction][1]} · ${timestamp}`;
  payloads.append(
    createPayload(exchange ? "Request" : message.type, meta, message.payload),
  );
  if (exchange) payloads.append(createReply(message));
  updatePayloadSearch(message);
  updateMockResponseTarget();

  inspector.hidden = false;
  panelResize.update();
  payloads.scrollTop = 0;
}

function describePreviewTab(key) {
  const { message } = rowViews.get(key);
  const time = formatTime(message.time);
  return {
    label:
      message.id == null
        ? `${message.type} · ${time}`
        : `${message.type} #${message.id}`,
    detail: [message.summary, message.topic, time].filter(Boolean).join(" · "),
  };
}

function currentPreview() {
  return previewStates.get(selectedSocketKey) ?? EMPTY_PREVIEW;
}

function renderPreview(preview) {
  const previousKey = selectedMessageKey;
  const key = preview.visible ? preview.activeKey : null;
  const lostFocus = previewTabs.render(
    preview.visible ? preview : EMPTY_PREVIEW,
    describePreviewTab,
  );
  renderInspector(key);
  if (key !== previousKey && key !== null) previewTabs.reveal(key);
  if (lostFocus) {
    if (key === null) focusMessageRow(previousKey);
    else previewTabs.focus(key);
  }
}

function setPreview(preview) {
  if (preview.keys.length) previewStates.set(selectedSocketKey, preview);
  else previewStates.delete(selectedSocketKey);
  renderPreview(preview);
}

function showMessageTab(key) {
  if (!rowViews.has(key)) return;
  setPreview(openPreviewTab(currentPreview(), key));
}

function openRowPreview(key, button) {
  showMessageTab(key);
  const overflow =
    button.getBoundingClientRect().bottom -
    stream.getBoundingClientRect().bottom;
  if (overflow > 0) stream.scrollTop += overflow;
}

function focusMessageRow(key) {
  const button = rowViews.get(key)?.button;
  if (button?.checkVisibility()) button.focus({ preventScroll: true });
  else messageSearch.focus();
}

function closeMessageTab(key = null) {
  const current = currentPreview();
  const preview = key === null ? EMPTY_PREVIEW : closePreviewTab(current, key);
  setPreview(preview);
  if (preview.visible) previewTabs.focus(preview.activeKey);
  else focusMessageRow(key ?? current.activeKey);
}

function hideInspector() {
  const preview = currentPreview();
  setPreview(hidePreview(preview));
  focusMessageRow(preview.activeKey);
}

function renderMessageRow(message, previous) {
  if (
    previous &&
    previous.message.replyKey === message.replyKey &&
    previous.message.responseMocked === message.responseMocked &&
    previous.message.mocked === message.mocked &&
    previous.message.mockArmed === message.mockArmed &&
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
    button.addEventListener("click", () => openRowPreview(message.key, button));

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
  const badge = item.querySelector(".mock-badge");
  const mocked = message.responseMocked || message.mocked;
  const armed = !mocked && message.mockArmed;
  badge.hidden = !mocked && !armed;
  badge.toggleAttribute("data-armed", armed);
  badge.title = armed
    ? "Waiting for the matching CALL result"
    : "Response used a mock";
  text(badge, mocked ? "Mocked" : armed ? "Mock armed" : "");
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
  renderPreview(EMPTY_PREVIEW);
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
  const armedCallId =
    socket.state === "OPEN" ? socket.mockSourceMessageId : null;
  const signature = JSON.stringify([
    messages.length,
    first?.messageId,
    last?.messageId,
    last?.timestamp,
    socket.lastMessageAt,
    armedCallId,
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
    rows.map((row) => {
      const mockArmed =
        armedCallId != null &&
        row.type === "CALL" &&
        row.messageId === armedCallId;
      return [
        row.key,
        renderMessageRow({ ...row, mockArmed }, rowViews.get(row.key)),
      ];
    }),
  );
  const previousKey = selectedMessageKey;
  const before = rowViews.get(previousKey)?.message;
  rowViews = next;
  messageSearch.setRows(
    [...rowViews.values()],
    "No WAMP messages on this connection.",
    { preserveScroll },
  );
  setPreview(retainPreviewTabs(currentPreview(), rowViews));
  if (selectedMessageKey === previousKey && previousKey !== null) {
    const after = rowViews.get(previousKey)?.message;
    if (after && before?.replyKey !== after.replyKey) {
      payloads
        .querySelector('[data-payload="response"]')
        ?.replaceWith(createReply(after));
      updatePayloadSearch(after);
    }
    updateMockResponseTarget();
  }
}

function setSelectedSocket(key) {
  if (key === selectedSocketKey) return false;
  selectedSocketKey = key;
  detailRequest += 1;
  socketDetails.open = false;
  clearMessageView(
    key === null ? "No WAMP messages captured yet." : "Loading messages…",
  );
  const preview = currentPreview();
  if (!preview.visible && preview.activeKey !== null)
    previewStates.set(key, openPreviewTab(preview, preview.activeKey));
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
      const [response, mockStatus] = await Promise.all([
        sendCaptureRequest({ type: "get-sockets", tabId }),
        sendCaptureRequest({ type: "get-mock-status", tabId }),
      ]);
      if (revision !== captureRevision || clearing) return;
      if (!Array.isArray(response?.sockets))
        throw new Error("Missing socket list");
      renderSockets(response.sockets);
      renderMocks(mockStatus?.mocks ?? []);
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
      connections: message.connections === true || message.allMessages === true,
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
  renderMocks([]);
  setCaptureStatus("");
}

$("#close-inspector").addEventListener("click", hideInspector);
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
      previewStates.clear();
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
