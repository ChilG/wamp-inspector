import { sendCaptureRequest } from "../shared/capture-client.js";

const oneShotLabels = {
  saved: "Mock saved · Waiting for frame confirmation",
  "waiting-socket": "Mock ready · Waiting for a WAMP WebSocket",
  "waiting-call": "Mock ready · Waiting for matching CALL",
};

const persistentLabels = {
  saved: "Mock enabled · Waiting for frame confirmation",
  "waiting-socket": "Mock enabled · Waiting for a WAMP WebSocket",
  "waiting-call": "Mock enabled · Waiting for matching CALL",
  disabled: "Mock disabled",
};

function text(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function describeMock(mock, status, target) {
  const summary = mock ? `${mock.procedure} · ${mock.topic ?? "No topic"}` : "";
  text(target, summary);
  status.title = mock ? `${summary}\nCaptured from ${mock.endpoint}` : "";
}

function showError(error, message = "") {
  text(error, message);
  error.hidden = !message;
}

export function bindMockList({ tabId, onChange }) {
  const bar = document.querySelector("#pending-mock-bar");
  const status = document.querySelector("#pending-mock-status");
  const state = document.querySelector("#pending-mock-state");
  const target = document.querySelector("#pending-mock-target");
  const details = document.querySelector("#persistent-mocks");
  const summary = document.querySelector("#persistent-mocks-summary");
  const search = document.querySelector("#message-search");
  const openSearch = document.querySelector("#show-search");
  const count = document.querySelector("#persistent-mocks-count");
  const activeCount = document.querySelector("#persistent-mocks-active");
  const list = document.querySelector("#persistent-mock-list");
  const template = document.querySelector("#persistent-mock-template");
  const views = new Map();

  function updateSummary() {
    let active = 0;
    for (const { mock } of views.values())
      if (mock.state !== "disabled") active += 1;
    details.hidden = views.size === 0;
    text(count, `Mocks (${views.size})`);
    text(activeCount, `${active} enabled`);
  }

  function updateView(view, mock) {
    if (view.mock.state !== mock.state) showError(view.error);
    view.mock = mock;
    const enabled = mock.state !== "disabled";
    view.item.toggleAttribute("data-enabled", enabled);
    text(view.state, persistentLabels[mock.state]);
    describeMock(mock, view.status, view.target);
    text(view.toggle, enabled ? "Disable mock" : "Enable mock");
  }

  function removeView(token, view) {
    const wasFocused = view.item.contains(document.activeElement);
    view.item.remove();
    views.delete(token);
    if (wasFocused) {
      const next = views.size
        ? summary
        : search.checkVisibility()
          ? search
          : openSearch;
      next.focus();
    }
  }

  async function manageMock(view, request, onSuccess, failure) {
    if (view.toggle.hasAttribute("aria-disabled")) return;
    const actions = [view.toggle, view.remove];
    for (const action of actions) action.setAttribute("aria-disabled", "true");
    showError(view.error);
    try {
      const reply = await sendCaptureRequest({
        ...request,
        tabId,
        token: view.mock.token,
      });
      if (!reply?.ok) throw new Error(failure);
      onSuccess();
      updateSummary();
    } catch {
      showError(view.error, failure);
    } finally {
      for (const action of actions) action.removeAttribute("aria-disabled");
      onChange();
    }
  }

  function createView(mock) {
    const item = template.content.firstElementChild.cloneNode(true);
    const toggle = item.querySelector(".persistent-mock-toggle");
    const remove = item.querySelector(".persistent-mock-delete");
    const error = item.querySelector(".persistent-mock-error");
    const target = item.querySelector(".persistent-mock-target");
    target.id = `persistent-mock-target-${mock.token}`;
    toggle.setAttribute("aria-describedby", target.id);
    remove.setAttribute("aria-describedby", target.id);
    const view = {
      item,
      toggle,
      remove,
      error,
      target,
      mock,
      state: item.querySelector(".persistent-mock-state"),
      status: item.querySelector(".persistent-mock-status"),
    };
    toggle.addEventListener("click", () => {
      const { state } = view.mock;
      const enabled = state === "disabled";
      void manageMock(
        view,
        { type: "set-mock-enabled", enabled },
        () => {
          if (view.mock.state === state)
            updateView(view, {
              ...view.mock,
              state: enabled ? "saved" : "disabled",
            });
        },
        "Unable to update this mock. Try again.",
      );
    });
    remove.addEventListener("click", () => {
      void manageMock(
        view,
        { type: "delete-mock" },
        () => {
          if (views.get(mock.token) === view) removeView(mock.token, view);
        },
        "Unable to delete this mock. Try again.",
      );
    });
    views.set(mock.token, view);
    list.append(item);
    return view;
  }

  return (mocks) => {
    const oneShot = mocks.find(({ token }) => !token);
    bar.hidden = !oneShot;
    text(state, oneShot ? oneShotLabels[oneShot.state] : "");
    describeMock(oneShot, status, target);

    const tokens = new Set();
    for (const mock of mocks) {
      if (!mock.token) continue;
      tokens.add(mock.token);
      updateView(views.get(mock.token) ?? createView(mock), mock);
    }
    for (const [token, view] of views) {
      if (tokens.has(token)) continue;
      removeView(token, view);
    }
    updateSummary();
  };
}
