import { syncChildren } from "./panel-search.js";

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

export function bindConnectionPicker(container, chooseSocket) {
  const select = container.querySelector("#socket-picker");
  const openGroup = select.querySelector("#pick-open");
  const closedGroup = select.querySelector("#pick-closed");
  const endpoint = container.querySelector("#socket-picker-endpoint");
  const meta = container.querySelector("#socket-picker-meta");
  const status = container.querySelector("#socket-picker-status");
  const frame = meta.querySelector(".frame");
  const time = meta.querySelector("time");
  const empty = new Option("No connections", "");

  select.addEventListener("change", () => chooseSocket(select.value));

  return {
    setOptions(open, closed) {
      syncChildren(openGroup, open);
      syncChildren(closedGroup, closed);
      openGroup.hidden = open.length === 0;
      closedGroup.hidden = closed.length === 0;
      select.disabled = openGroup.hidden && closedGroup.hidden;
      if (select.disabled) {
        if (!empty.isConnected) select.prepend(empty);
      } else {
        empty.remove();
      }
    },
    setSelected(view) {
      const value = view?.option.value ?? "";
      if (select.value !== value) select.value = value;

      const connection = view?.presentation;
      setText(endpoint, connection?.endpoint ?? empty.text);
      meta.hidden = !connection;
      select.title = connection?.address ?? "";
      if (!connection) return;
      setText(status, connection.state);
      status.dataset.state = connection.stateCode;
      setText(frame, connection.frame);
      setText(time, connection.time);
    },
  };
}
