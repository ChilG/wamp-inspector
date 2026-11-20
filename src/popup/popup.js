const tabDetails = document.querySelector("#tab-details");
const tabName = document.querySelector("#tab-name");
const tabUrl = document.querySelector("#tab-url");
const captureStatus = document.querySelector("#capture-status");
const summary = document.querySelector("#tab-summary");
const openCount = document.querySelector("#open-count");
const messageCount = document.querySelector("#message-count");
const lastMessage = document.querySelector("#last-message");
const checkTabButton = document.querySelector("#check-tab");
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const numbers = new Intl.NumberFormat();
let checking = false;

function showStatus(state, label) {
  captureStatus.dataset.state = state;
  captureStatus.textContent = label;
}

async function canInspect(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: "capture-availability" },
      { frameId: 0 },
    );
    return response?.available === true;
  } catch {
    return false;
  }
}

function showSummary(sockets) {
  let open = 0;
  let messages = 0;
  let latest = -Infinity;
  for (const socket of sockets) {
    if (socket.state === "OPEN") open += 1;
    messages += socket.messageCount;
    const timestamp = Date.parse(socket.lastMessageAt);
    if (timestamp > latest) latest = timestamp;
  }

  openCount.textContent = numbers.format(open);
  messageCount.textContent = numbers.format(messages);
  lastMessage.textContent = Number.isFinite(latest)
    ? clock.format(latest)
    : "—";
  summary.hidden = false;

  if (open > 0) showStatus("connected", "WAMP connected");
  else if (sockets.some((socket) => socket.state === "CONNECTING"))
    showStatus("connecting", "Connecting to WAMP");
  else if (sockets.length > 0) showStatus("closed", "No open WAMP connections");
  else showStatus("empty", "No WAMP detected");
}

async function checkCurrentTab() {
  if (checking) return;
  checking = true;
  checkTabButton.setAttribute("aria-disabled", "true");
  showStatus("checking", "Checking this tab…");
  tabDetails.hidden = true;
  summary.hidden = true;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!Number.isInteger(tab?.id) || tab.id < 0) {
      showStatus("unavailable", "No active tab");
      return;
    }

    tabName.textContent = tab.title || "Untitled";
    tabName.title = tabName.textContent;
    tabUrl.textContent = tab.url || "";
    tabUrl.title = tabUrl.textContent;
    tabUrl.hidden = !tab.url;
    tabDetails.hidden = false;

    const response = await chrome.runtime.sendMessage({
      type: "get-sockets",
      tabId: tab.id,
    });
    if (!Array.isArray(response?.sockets)) {
      showStatus("error", "Could not check this tab");
      return;
    }
    if (response.sockets.length === 0 && !(await canInspect(tab.id))) {
      showStatus("unavailable", "Unavailable on this page");
      return;
    }

    showSummary(response.sockets);
  } catch {
    showStatus("error", "Could not check this tab");
  } finally {
    checkTabButton.setAttribute("aria-disabled", "false");
    checking = false;
  }
}

checkTabButton.addEventListener("click", checkCurrentTab);
void checkCurrentTab();
