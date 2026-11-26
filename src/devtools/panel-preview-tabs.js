import { syncChildren } from "./panel-search.js";

export const EMPTY_PREVIEW = Object.freeze({
  keys: Object.freeze([]),
  activeKey: null,
  visible: false,
});

export function openPreviewTab(preview, key) {
  if (preview.visible && preview.activeKey === key) return preview;
  return {
    keys: preview.keys.includes(key) ? preview.keys : [...preview.keys, key],
    activeKey: key,
    visible: true,
  };
}

export function movePreviewTab(preview, key, index) {
  const current = preview.keys.indexOf(key);
  if (
    current < 0 ||
    current === index ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= preview.keys.length
  )
    return preview;

  const keys = preview.keys.toSpliced(current, 1).toSpliced(index, 0, key);
  return { ...preview, keys };
}

export function hidePreview(preview) {
  return preview.visible ? { ...preview, visible: false } : preview;
}

function filterPreviewTabs(preview, retain) {
  const keys = preview.keys.filter(retain);
  if (keys.length === preview.keys.length) return preview;
  if (keys.length === 0) return EMPTY_PREVIEW;
  const position = preview.keys.indexOf(preview.activeKey);
  const activeKey = keys.includes(preview.activeKey)
    ? preview.activeKey
    : (preview.keys.slice(position + 1).find(retain) ?? keys.at(-1));
  return { ...preview, keys, activeKey };
}

export function closePreviewTab(preview, key) {
  return filterPreviewTabs(preview, (entry) => entry !== key);
}

export function retainPreviewTabs(preview, rows) {
  return filterPreviewTabs(preview, (key) => rows.has(key));
}

export class PreviewTabStrip {
  constructor(bar, content, { activate, close, move }) {
    this.list = bar.querySelector('[role="tablist"]');
    this.content = content;
    this.activate = activate;
    this.close = close;
    this.move = move;
    this.preview = EMPTY_PREVIEW;
    this.entries = new Map();
    this.nextId = 0;
    this.draggedKey = null;
    this.dropMarker = null;
    this.hoverX = null;
    this.scrollFrame = null;
    this.list.addEventListener("keydown", (event) => this.onKeyDown(event));
    const updateDrag = (event) => this.dragOver(event);
    this.list.addEventListener("dragenter", updateDrag);
    this.list.addEventListener("dragover", updateDrag);
    this.list.addEventListener("dragleave", (event) => {
      if (!this.list.contains(event.relatedTarget)) this.clearHover();
    });
    this.list.addEventListener("drop", (event) => this.drop(event));
    this.list.addEventListener("dragend", () => {
      if (this.draggedKey === null) return;
      this.endDrag();
      this.focus(this.preview.activeKey);
    });
    bar
      .querySelector("#close-all-preview-tabs")
      .addEventListener("click", () => close());
  }

  createEntry(key, { label, detail }) {
    const item = document.createElement("div");
    item.className = "preview-tab-item";
    item.setAttribute("role", "presentation");

    const tab = document.createElement("button");
    tab.className = "preview-tab clip";
    tab.id = `preview-tab-${++this.nextId}`;
    tab.type = "button";
    tab.textContent = label;
    tab.title = detail;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", this.content.id);
    tab.setAttribute(
      "aria-keyshortcuts",
      "Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight",
    );
    tab.addEventListener("click", () => this.activate(key));
    tab.addEventListener("dragstart", (event) => {
      if (!tab.draggable || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      this.endDrag();
      this.draggedKey = key;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-wamp-preview-tab", "tab");
    });

    const close = document.createElement("button");
    close.className = "preview-tab-close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${label}`);
    close.addEventListener("click", () => this.close(key));

    item.append(tab, close);
    return { item, tab, close };
  }

  render(preview, describe) {
    if (this.preview === preview) return false;
    this.endDrag();
    const hadFocus = this.list.contains(document.activeElement);
    this.preview = preview;
    const entries = new Map();
    for (const key of preview.keys) {
      const entry =
        this.entries.get(key) ?? this.createEntry(key, describe(key));
      const active = key === preview.activeKey;
      entry.tab.setAttribute("aria-selected", String(active));
      entry.tab.draggable = preview.keys.length > 1;
      entry.tab.tabIndex = active ? 0 : -1;
      entry.close.tabIndex = active ? 0 : -1;
      entries.set(key, entry);
    }
    this.entries = entries;
    syncChildren(
      this.list,
      Array.from(entries.values(), ({ item }) => item),
    );

    const activeTab = entries.get(preview.activeKey)?.tab;
    if (activeTab) this.content.setAttribute("aria-labelledby", activeTab.id);
    else this.content.removeAttribute("aria-labelledby");
    return hadFocus && !this.list.contains(document.activeElement);
  }

  reveal(key) {
    const item = this.entries.get(key)?.item;
    if (!item) return;
    const list = this.list.getBoundingClientRect();
    const tab = item.getBoundingClientRect();
    if (tab.left < list.left) this.list.scrollLeft += tab.left - list.left;
    else if (tab.right > list.right)
      this.list.scrollLeft += tab.right - list.right;
  }

  focus(key) {
    this.entries.get(key)?.tab.focus({ preventScroll: true });
  }

  dropTarget(x) {
    const from = this.preview.keys.indexOf(this.draggedKey);
    const entries = [...this.entries.values()];
    const next = entries.findIndex(({ item }) => {
      const { left, width } = item.getBoundingClientRect();
      return x < left + width / 2;
    });
    const gap = next === -1 ? entries.length : next;
    const index = gap > from ? gap - 1 : gap;
    if (index === from) return null;
    return {
      item: (entries[gap] ?? entries.at(-1)).item,
      attribute: next === -1 ? "data-drop-after" : "data-drop-before",
      index,
    };
  }

  setMarker(marker) {
    const previous = this.dropMarker;
    if (
      previous?.item !== marker?.item ||
      previous?.attribute !== marker?.attribute
    ) {
      if (previous) {
        previous.item.removeAttribute(previous.attribute);
        previous.item.style.removeProperty("--preview-drop-offset");
      }
      if (marker) marker.item.setAttribute(marker.attribute, "");
    }
    this.dropMarker = marker;
    if (!marker) return;

    const strip = this.list.getBoundingClientRect();
    const item = marker.item.getBoundingClientRect();
    const gap =
      marker.attribute === "data-drop-before" ? item.left : item.right;
    const left = Math.min(strip.right - 3, Math.max(strip.left + 1, gap - 1));
    marker.item.style.setProperty(
      "--preview-drop-offset",
      `${left - item.left}px`,
    );
  }

  clearHover() {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
    this.hoverX = null;
    this.setMarker(null);
  }

  endDrag() {
    this.clearHover();
    this.draggedKey = null;
  }

  dragOver(event) {
    if (this.draggedKey === null || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    this.hoverX = event.clientX;
    this.setMarker(this.dropTarget(this.hoverX));
    if (this.scrollFrame === null)
      this.scrollFrame = requestAnimationFrame(() => this.scrollAtEdge());
  }

  scrollAtEdge() {
    this.scrollFrame = null;
    const x = this.hoverX;
    if (x === null) return;
    const { left, right, width } = this.list.getBoundingClientRect();
    const edge = Math.min(width / 4, 28);
    const previous = this.list.scrollLeft;
    if (x < left + edge) this.list.scrollLeft -= 12;
    else if (x > right - edge) this.list.scrollLeft += 12;
    if (this.list.scrollLeft === previous) return;
    this.setMarker(this.dropTarget(x));
    this.scrollFrame = requestAnimationFrame(() => this.scrollAtEdge());
  }

  drop(event) {
    const key = this.draggedKey;
    if (key === null) return;
    event.preventDefault();
    const target = this.dropTarget(event.clientX);
    this.endDrag();
    if (target) this.move(key, target.index);
    this.focus(this.preview.activeKey);
  }

  onKeyDown(event) {
    if (
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      !event.target.matches(".preview-tab")
    )
      return;
    const { keys, activeKey } = this.preview;
    const current = keys.indexOf(activeKey);
    if (
      event.altKey &&
      event.shiftKey &&
      ["ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      event.preventDefault();
      this.move(activeKey, current + (event.key === "ArrowLeft" ? -1 : 1));
      this.reveal(activeKey);
      this.focus(activeKey);
      return;
    }
    if (event.altKey || event.shiftKey) return;
    if (event.key === "Delete") {
      event.preventDefault();
      this.close(activeKey);
      return;
    }

    const next = {
      ArrowLeft: (current - 1 + keys.length) % keys.length,
      ArrowRight: (current + 1) % keys.length,
      Home: 0,
      End: keys.length - 1,
    };
    if (!Object.hasOwn(next, event.key)) return;
    event.preventDefault();
    const key = keys[next[event.key]];
    this.activate(key);
    this.focus(key);
  }
}
