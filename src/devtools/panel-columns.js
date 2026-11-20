const storageKey = "wamp.messageColumnWidths";
const topicVisibilityKey = "wamp.showTopicColumn";
const maxWidth = 4096;
const columnSettings = {
  dir: { label: "Direction", min: 22 },
  type: { label: "Type", min: 64 },
  request: { label: "Request ID", min: 42 },
  summary: { label: "Summary", min: 72 },
  topic: { label: "Topic", min: 80 },
  time: { label: "Time", min: 56 },
  latency: { label: "Latency", min: 46 },
};

function readWidths() {
  try {
    const widths = JSON.parse(localStorage.getItem(storageKey));
    return { wide: widths?.wide ?? {}, compact: widths?.compact ?? {} };
  } catch (error) {
    console.warn("WAMP Inspector: could not read column preferences", error);
    return { wide: {}, compact: {} };
  }
}

function boundWidth(width, min) {
  return Math.min(maxWidth, Math.max(min, Math.round(width)));
}

export class MessageColumnResize {
  constructor(stream) {
    this.stream = stream;
    this.compact = matchMedia("(max-width: 1000px)");
    this.widths = readWidths();
    this.drag = null;
    this.columns = [];
    this.observer = new ResizeObserver(() => {
      for (const column of this.columns) this.updateValue(column);
    });
    this.compact.addEventListener("change", () => this.restoreLayout());
    this.syncColumns();
  }

  get mode() {
    return this.compact.matches ? "compact" : "wide";
  }

  syncColumns() {
    const headings = new Set(
      this.stream.querySelectorAll(".stream-head [data-column]"),
    );
    const previous = new Map(
      this.columns.map((column) => [column.heading, column]),
    );
    this.columns = Array.from(headings, (heading) => {
      if (previous.has(heading)) return previous.get(heading);
      const column = this.bindColumn(heading);
      this.observer.observe(heading);
      return column;
    });
    const keys = new Set(this.columns.map(({ key }) => key));
    const removed = new Set();
    for (const [heading, column] of previous) {
      if (!headings.has(heading)) this.observer.unobserve(heading);
      if (!keys.has(column.key)) {
        this.stream.style.removeProperty(column.property);
        removed.add(column.key);
      }
    }
    if (removed.size) {
      this.widths = Object.fromEntries(
        Object.entries(this.widths).map(([mode, widths]) => [
          mode,
          Object.fromEntries(
            Object.entries(widths).filter(([key]) => !removed.has(key)),
          ),
        ]),
      );
      this.save();
    }
    this.restoreLayout();
  }

  bindColumn(heading) {
    const key = heading.dataset.column;
    const handle = document.createElement("span");
    const settings = columnSettings[key] ?? {
      label: heading.dataset.columnLabel,
      min: 80,
    };
    const column = {
      heading,
      handle,
      key,
      ...settings,
      property: `--message-column-${key}`,
    };
    handle.className = "column-resize";
    handle.tabIndex = 0;
    handle.title =
      "Drag or use the arrow keys to resize. Double-click or press Enter to reset.";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-controls", "messages");
    handle.setAttribute("aria-valuemin", column.min);
    handle.setAttribute("aria-valuemax", maxWidth);
    handle.addEventListener("pointerdown", (event) =>
      this.startDrag(event, column),
    );
    handle.addEventListener("pointermove", (event) => this.moveDrag(event));
    handle.addEventListener("lostpointercapture", (event) =>
      this.endDrag(event),
    );
    handle.addEventListener("dblclick", () => this.reset(column));
    handle.addEventListener("keydown", (event) =>
      this.resizeWithKeyboard(event, column),
    );
    heading.append(handle);
    return column;
  }

  restoreLayout() {
    for (const column of this.columns) {
      const width = this.widths[this.mode][column.key];
      const combined =
        column.key === "summary" &&
        this.compact.matches &&
        this.stream.hasAttribute("data-show-topic");
      const label = combined ? "Summary and Topic" : column.label;
      column.handle.setAttribute("aria-label", `Resize ${label} column`);
      if (Number.isFinite(width)) {
        this.stream.style.setProperty(
          column.property,
          `${boundWidth(width, column.min)}px`,
        );
      } else {
        this.stream.style.removeProperty(column.property);
      }
    }
    for (const column of this.columns) this.updateValue(column);
  }

  updateValue(column) {
    const width = Math.round(column.heading.getBoundingClientRect().width);
    column.handle.setAttribute("aria-valuenow", width);
    column.handle.setAttribute("aria-valuetext", `${width} pixels wide`);
  }

  resize(column, width) {
    const value = boundWidth(width, column.min);
    const mode = this.mode;
    this.widths = {
      ...this.widths,
      [mode]: { ...this.widths[mode], [column.key]: value },
    };
    this.stream.style.setProperty(column.property, `${value}px`);
  }

  reset(column) {
    const mode = this.mode;
    const { [column.key]: _removed, ...remaining } = this.widths[mode];
    this.widths = { ...this.widths, [mode]: remaining };
    this.stream.style.removeProperty(column.property);
    this.save();
  }

  save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.widths));
    } catch (error) {
      console.warn("WAMP Inspector: could not save column preferences", error);
    }
  }

  startDrag(event, column) {
    if (!event.isPrimary || event.button !== 0) return;
    this.drag = {
      column,
      pointerId: event.pointerId,
      mode: this.mode,
      startX: event.clientX,
      width: column.heading.getBoundingClientRect().width,
    };
    column.handle.focus({ preventScroll: true });
    column.handle.setPointerCapture(event.pointerId);
    column.handle.setAttribute("data-dragging", "");
    this.stream.setAttribute("data-column-resizing", "");
  }

  moveDrag(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId || drag.mode !== this.mode)
      return;
    this.resize(drag.column, drag.width + event.clientX - drag.startX);
  }

  endDrag(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    this.drag.column.handle.removeAttribute("data-dragging");
    this.stream.removeAttribute("data-column-resizing");
    this.drag = null;
    this.save();
  }

  resizeWithKeyboard(event, column) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.reset(column);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -16 : 16;
    this.resize(column, column.heading.getBoundingClientRect().width + step);
    this.save();
  }
}

export function bindTopicColumn(stream, checkbox, columnResize) {
  try {
    checkbox.checked = localStorage.getItem(topicVisibilityKey) === "true";
  } catch (error) {
    console.warn(
      "WAMP Inspector: could not read Topic column preference",
      error,
    );
  }

  function applyVisibility() {
    stream.toggleAttribute("data-show-topic", checkbox.checked);
    columnResize.restoreLayout();
  }

  applyVisibility();
  checkbox.addEventListener("change", () => {
    applyVisibility();
    try {
      localStorage.setItem(topicVisibilityKey, String(checkbox.checked));
    } catch (error) {
      console.warn(
        "WAMP Inspector: could not save Topic column preference",
        error,
      );
    }
  });
}
