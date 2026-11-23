export class PayloadPanelResize {
  constructor(panel) {
    this.panel = panel;
    this.capture = panel.closest(".capture");
    this.toolbar = this.capture.querySelector(".capture-header");
    this.search = panel.querySelector(".payload-search");
    this.handle = panel.querySelector("#payload-resize");
    this.expandButton = panel.querySelector("#expand-inspector");
    this.requestedHeight = null;
    this.expanded = false;
    this.drag = null;

    this.handle.addEventListener("pointerdown", (event) =>
      this.startDrag(event),
    );
    this.handle.addEventListener("pointermove", (event) =>
      this.dragPanel(event),
    );
    this.handle.addEventListener("lostpointercapture", () => {
      this.drag = null;
      this.capture.removeAttribute("data-resizing");
    });
    this.handle.addEventListener("keydown", (event) =>
      this.resizeWithKeyboard(event),
    );
    this.expandButton.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.update();
    });

    const observer = new ResizeObserver(() => this.update());
    observer.observe(this.capture);
    observer.observe(this.toolbar);
  }

  bounds() {
    const available = Math.max(
      0,
      this.capture.clientHeight - this.toolbar.offsetHeight,
    );
    const reservedForMessages = Math.min(54, Math.floor(available * 0.45));
    const max = available - reservedForMessages;
    const editing = this.panel.hasAttribute("data-editing");
    const min = Math.min(
      max,
      (editing ? 164 : 84) + this.search.offsetHeight,
      Math.floor(available * (editing ? 0.62 : 0.4)),
    );
    return { min, max };
  }

  update() {
    if (this.panel.hidden) return;
    const { min, max } = this.bounds();
    const requested = this.expanded ? max : this.requestedHeight;
    if (requested === null)
      this.capture.style.removeProperty("--inspector-height");

    const target = requested ?? this.panel.offsetHeight;
    const height = Math.min(max, Math.max(min, target));
    if (requested !== null || height !== target) {
      this.capture.style.setProperty("--inspector-height", `${height}px`);
    }

    this.handle.setAttribute("aria-valuemin", min);
    this.handle.setAttribute("aria-valuemax", max);
    this.handle.setAttribute("aria-valuenow", height);
    this.handle.setAttribute("aria-valuetext", `${height} pixels high`);
    this.panel.toggleAttribute("data-expanded", this.expanded);
    this.expandButton.textContent = this.expanded ? "Restore" : "Expand";
    this.expandButton.disabled = !this.expanded && max <= height;
  }

  resizeTo(height) {
    const { min, max } = this.bounds();
    this.requestedHeight = Math.min(max, Math.max(min, height));
    this.expanded = false;
    this.update();
  }

  startDrag(event) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    this.drag = {
      pointerId: event.pointerId,
      y: event.clientY,
      height: this.panel.offsetHeight,
    };
    this.handle.focus({ preventScroll: true });
    this.handle.setPointerCapture(event.pointerId);
    this.capture.setAttribute("data-resizing", "");
  }

  dragPanel(event) {
    if (this.drag?.pointerId !== event.pointerId) return;
    this.resizeTo(this.drag.height + this.drag.y - event.clientY);
  }

  resizeWithKeyboard(event) {
    const { min, max } = this.bounds();
    const height = this.panel.offsetHeight;
    const step = 16;
    const targets = {
      ArrowUp: height + step,
      ArrowDown: height - step,
      Home: min,
      End: max,
    };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    this.resizeTo(targets[event.key]);
  }
}
