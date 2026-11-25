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
  constructor(bar, content, { activate, close }) {
    this.list = bar.querySelector('[role="tablist"]');
    this.content = content;
    this.activate = activate;
    this.close = close;
    this.preview = EMPTY_PREVIEW;
    this.entries = new Map();
    this.nextId = 0;
    this.list.addEventListener("keydown", (event) => this.onKeyDown(event));
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
    tab.setAttribute("aria-keyshortcuts", "Delete");
    tab.addEventListener("click", () => this.activate(key));

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
    const hadFocus = this.list.contains(document.activeElement);
    this.preview = preview;
    const entries = new Map();
    for (const key of preview.keys) {
      const entry =
        this.entries.get(key) ?? this.createEntry(key, describe(key));
      const active = key === preview.activeKey;
      entry.tab.setAttribute("aria-selected", String(active));
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

  onKeyDown(event) {
    if (
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !event.target.matches(".preview-tab")
    )
      return;
    const { keys, activeKey } = this.preview;
    const current = keys.indexOf(activeKey);
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
