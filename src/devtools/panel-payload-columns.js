const storageKey = "wamp.payloadColumns";
const defaultWidth = 140;
const missing = "—";

export function formatPayloadPath(path) {
  return (
    "$" +
    path
      .map((segment) => {
        if (typeof segment === "number") return `[${segment}]`;
        return /^[A-Za-z_$][\w$]*$/.test(segment)
          ? `.${segment}`
          : `[${JSON.stringify(segment)}]`;
      })
      .join("")
  );
}

export function payloadColumnValue(message, { source, path }) {
  const payload = source === "response" ? message.response : message.payload;
  if (payload?.kind !== "json") return missing;
  let value = payload.value;
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    )
      return missing;
    value = value[segment];
  }
  if (value === undefined) return missing;
  if (value === "") return '""';
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).length} fields}`;
  return String(value);
}

function readColumns() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (column) =>
        column &&
        typeof column.id === "string" &&
        /^custom-[a-f0-9-]+$/.test(column.id) &&
        typeof column.label === "string" &&
        Boolean(column.label.trim()) &&
        (column.source === "request" || column.source === "response") &&
        Array.isArray(column.path) &&
        column.path.length > 0 &&
        column.path.every(
          (segment) =>
            typeof segment === "string" ||
            (Number.isSafeInteger(segment) && segment >= 0),
        ),
    );
  } catch (error) {
    console.warn("WAMP Inspector: could not read custom columns", error);
    return [];
  }
}

function describeColumn({ source, path }) {
  return `${source === "response" ? "Response" : "Request or message"} · ${formatPayloadPath(path)}`;
}

function sameField(column, field) {
  return (
    column.source === field.source &&
    column.path.length === field.path.length &&
    column.path.every((segment, index) => segment === field.path[index])
  );
}

export class PayloadColumns {
  constructor(stream, columnResize, onChange) {
    this.stream = stream;
    this.columnResize = columnResize;
    this.onChange = onChange;
    this.columns = readColumns();
    this.pendingField = null;
    this.head = stream.querySelector(".stream-head .custom-column-cells");
    this.panel = document.querySelector("#payload-columns");
    this.form = document.querySelector("#payload-column-form");
    this.name = document.querySelector("#payload-column-name");
    this.path = document.querySelector("#payload-column-path");
    this.list = document.querySelector("#payload-column-list");
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.add();
    });
    this.panel.addEventListener("toggle", (event) => {
      if (event.newState === "closed") {
        this.pendingField = null;
        this.form.hidden = true;
      }
    });
    this.renderHeaders();
    this.renderList();
  }

  offer(source, path) {
    const field = { source, path };
    const previous = this.columns.find((column) => sameField(column, field));
    this.pendingField = {
      ...field,
      id: previous?.id ?? `custom-${crypto.randomUUID()}`,
    };
    this.path.textContent = describeColumn(field);
    this.name.value =
      previous?.label ?? (String(path.at(-1)).slice(0, 64) || "Field");
    this.form.hidden = false;
    if (!this.panel.matches(":popover-open")) this.panel.showPopover();
    this.name.focus();
    this.name.select();
  }

  add() {
    const label = this.name.value.trim();
    const field = this.pendingField;
    if (!label || !field) return;
    const column = { ...field, label };
    const exists = this.columns.some(({ id }) => id === field.id);
    this.setColumns(
      exists
        ? this.columns.map((current) =>
            current.id === field.id ? column : current,
          )
        : [...this.columns, column],
    );
    this.panel.hidePopover();
  }

  setColumns(columns) {
    this.columns = columns;
    try {
      localStorage.setItem(storageKey, JSON.stringify(columns));
    } catch (error) {
      console.warn("WAMP Inspector: could not save custom columns", error);
    }
    this.renderHeaders();
    this.renderList();
    this.onChange();
  }

  renderHeaders() {
    this.head.replaceChildren(
      ...this.columns.map((column) => {
        const heading = document.createElement("span");
        const label = document.createElement("span");
        heading.className = "column-heading";
        heading.dataset.column = column.id;
        heading.dataset.columnLabel = column.label;
        heading.title = describeColumn(column);
        label.className = "clip";
        label.textContent = column.label;
        heading.append(label);
        return heading;
      }),
    );
    const widths = this.columns.map(
      ({ id }) => `var(--message-column-${id}, ${defaultWidth}px)`,
    );
    if (widths.length) {
      this.stream.style.setProperty("--custom-column-tracks", widths.join(" "));
      this.stream.style.setProperty(
        "--custom-column-width",
        `calc(${widths.join(" + ")})`,
      );
      this.stream.style.setProperty(
        "--custom-column-count",
        String(widths.length),
      );
    } else {
      for (const property of [
        "--custom-column-tracks",
        "--custom-column-width",
        "--custom-column-count",
      ]) {
        this.stream.style.removeProperty(property);
      }
    }
    this.columnResize.syncColumns();
  }

  renderList() {
    this.list.replaceChildren(
      ...this.columns.map((column) => {
        const item = document.createElement("li");
        const description = document.createElement("div");
        const name = document.createElement("strong");
        const path = document.createElement("code");
        const remove = document.createElement("button");
        name.textContent = column.label;
        path.textContent = describeColumn(column);
        remove.type = "button";
        remove.className = "control";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove ${column.label} column`);
        remove.addEventListener("click", () =>
          this.setColumns(this.columns.filter(({ id }) => id !== column.id)),
        );
        description.append(name, path);
        item.append(description, remove);
        return item;
      }),
    );
  }

  renderCells(item, message) {
    const cells = item.querySelector(".custom-column-cells");
    if (!this.columns.length && !cells.childElementCount) return;
    cells.replaceChildren(
      ...this.columns.map((column) => {
        const cell = document.createElement("code");
        const value = payloadColumnValue(message, column);
        cell.className = "payload-column-value clip";
        cell.textContent = value;
        cell.title = value;
        return cell;
      }),
    );
  }
}
