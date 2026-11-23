import { revealJsonMatch } from "./panel-json-preview.js";

const debounceMs = 100;

function literalPattern(term, flags = "iu") {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
}

export function findEditorMatches(text, query) {
  const term = query.trim();
  if (!term) return [];
  return Array.from(text.matchAll(literalPattern(term, "giu")), (hit) => ({
    start: hit.index,
    end: hit.index + hit[0].length,
  }));
}

export function findPayloadMatches(payload, query) {
  const term = query.trim();
  if (!payload || !term) return [];
  const pattern = literalPattern(term);
  const matches = [];
  const path = [];
  const stack = [];

  function visit(value) {
    if (value !== null && typeof value === "object") {
      stack.push({
        value,
        keys: Object.keys(value),
        index: 0,
        array: Array.isArray(value),
      });
    } else if (pattern.test(String(value))) {
      matches.push({ path: [...path], part: "value" });
    }
  }

  // The preview renders siblings in Object.keys order at each level.
  visit(payload.value);
  while (stack.length) {
    const frame = stack.at(-1);
    path.length = stack.length - 1;
    if (frame.index === frame.keys.length) {
      stack.pop();
      continue;
    }
    const index = frame.index++;
    const key = frame.keys[index];
    path.push(index);
    if (!frame.array && pattern.test(key))
      matches.push({ path: [...path], part: "key" });
    visit(frame.value[key]);
  }
  return matches;
}

function sameMatch(previous, current) {
  if (!previous) return false;
  if ("start" in current) {
    return previous.start === current.start && previous.end === current.end;
  }
  return (
    previous.source === current.source &&
    previous.part === current.part &&
    previous.path.length === current.path.length &&
    previous.path.every((index, depth) => index === current.path[depth])
  );
}

function highlightMatch(token, query) {
  const content = token.textContent;
  const displayedQuery = token.matches(".json-key, .json-string")
    ? JSON.stringify(query).slice(1, -1)
    : query;
  const hit = literalPattern(displayedQuery).exec(content);
  if (!hit) {
    token.classList.add("payload-match");
    return token;
  }

  const mark = document.createElement("mark");
  mark.className = "payload-match";
  mark.textContent = hit[0];
  token.replaceChildren(
    content.slice(0, hit.index),
    mark,
    content.slice(hit.index + hit[0].length),
  );
  return mark;
}

function measureEditorLine(context, text, tabWidth) {
  let width = 0;
  for (const [index, part] of text.split("\t").entries()) {
    if (index && tabWidth)
      width = (Math.floor(width / tabWidth) + 1) * tabWidth;
    width += context.measureText(part).width;
  }
  return width;
}

function scrollEditorMatch(editor, match) {
  const { ownerDocument } = editor;
  const style = ownerDocument.defaultView.getComputedStyle(editor);
  const lines = editor.value.slice(0, match.start).split("\n");
  const lineHeight = Number.parseFloat(style.lineHeight);
  const top =
    (lines.length - 1) * lineHeight +
    (Number.parseFloat(style.paddingTop) || 0);
  if (
    top < editor.scrollTop ||
    top + lineHeight > editor.scrollTop + editor.clientHeight
  )
    editor.scrollTop = Math.max(
      0,
      top - (editor.clientHeight - lineHeight) / 2,
    );

  if (editor.scrollWidth <= editor.clientWidth) return;
  const context = ownerDocument.createElement("canvas").getContext("2d");
  if (!context) return;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const tabSize = Number.parseFloat(style.tabSize);
  const tabWidth = style.tabSize.endsWith("px")
    ? tabSize
    : (tabSize || 0) * context.measureText(" ").width;
  const prefix = lines.at(-1);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const left = paddingLeft + measureEditorLine(context, prefix, tabWidth);
  const lineMatch = editor.value.slice(match.start, match.end).split("\n")[0];
  const right =
    paddingLeft + measureEditorLine(context, prefix + lineMatch, tabWidth);
  if (
    left < editor.scrollLeft ||
    right > editor.scrollLeft + editor.clientWidth
  )
    editor.scrollLeft = Math.max(
      0,
      left - Math.max(0, (editor.clientWidth - right + left) / 2),
    );
}

export class PayloadSearch {
  constructor(inspector, scroll, onToggle) {
    this.scroll = scroll;
    this.onToggle = onToggle;
    this.toggle = inspector.querySelector("#toggle-payload-search");
    this.bar = inspector.querySelector("#payload-search");
    this.input = inspector.querySelector("#payload-query");
    this.status = inspector.querySelector("#payload-match-count");
    this.previous = inspector.querySelector("#previous-payload-match");
    this.next = inspector.querySelector("#next-payload-match");
    this.previewPlaceholder = this.input.placeholder;
    this.previewLabel = this.input.getAttribute("aria-label");
    this.payloads = [];
    this.editor = null;
    this.onEditorInput = () => this.queueSearch(false);
    this.matches = [];
    this.index = -1;
    this.timer = null;
    this.target = null;

    this.toggle.addEventListener("click", () => {
      if (this.bar.hidden) {
        this.setOpen(true);
        this.input.focus({ preventScroll: true });
      } else {
        this.close();
      }
    });
    this.input.addEventListener("input", () => this.queueSearch());
    this.bar.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        this.toggle.focus({ preventScroll: true });
      } else if (event.key === "Enter" && event.target === this.input) {
        event.preventDefault();
        this.move(event.shiftKey ? -1 : 1);
      }
    });
    this.previous.addEventListener("click", () => this.move(-1));
    this.next.addEventListener("click", () => this.move(1));
  }

  setOpen(open) {
    if (open === !this.bar.hidden) return;
    this.bar.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    this.onToggle();
  }

  close() {
    this.input.value = "";
    this.search();
    this.setOpen(false);
  }

  setPayloads(...payloads) {
    this.payloads = payloads;
    if (!this.editor && !this.bar.hidden && this.input.value.trim())
      this.search(this.timer === null);
  }

  setEditor(editor) {
    if (editor === this.editor) return;
    this.editor?.removeEventListener("input", this.onEditorInput);
    this.editor = editor;
    if (editor) editor.addEventListener("input", this.onEditorInput);
    this.input.placeholder = editor
      ? "Find in mock JSON"
      : this.previewPlaceholder;
    this.input.setAttribute(
      "aria-label",
      editor ? "Find in mock JSON" : this.previewLabel,
    );
    if (!this.bar.hidden) this.search();
  }

  queueSearch(reveal = true) {
    clearTimeout(this.timer);
    if (!this.input.value.trim()) {
      this.search(false, reveal);
      return;
    }
    this.timer = setTimeout(() => this.search(!reveal, reveal), debounceMs);
  }

  search(keepSelection = false, reveal = true) {
    clearTimeout(this.timer);
    this.timer = null;
    const query = this.input.value.trim();
    const current = keepSelection ? this.matches[this.index] : null;
    this.matches = this.editor
      ? findEditorMatches(this.editor.value, query)
      : this.payloads.flatMap((payload, source) =>
          findPayloadMatches(payload, query).map((match) => ({
            ...match,
            source,
          })),
        );
    const preserved = this.matches.findIndex((match) =>
      sameMatch(current, match),
    );
    this.index = this.matches.length ? Math.max(0, preserved) : -1;
    const section = this.scroll.children[this.matches[this.index]?.source];
    if (
      reveal &&
      (this.editor ||
        preserved < 0 ||
        !this.target?.isConnected ||
        !section?.contains(this.target))
    )
      this.showMatch();
    this.status.textContent = this.matches.length
      ? `${this.index + 1} / ${this.matches.length}`
      : query
        ? "No matches"
        : "";
    this.previous.disabled = this.next.disabled =
      this.matches.length < (this.editor ? 1 : 2);
  }

  move(step) {
    if (this.timer !== null) {
      this.search(false, !this.editor);
      if (this.editor) this.showMatch(true);
      return;
    }
    if (!this.matches.length) return;
    this.index =
      (this.index + step + this.matches.length) % this.matches.length;
    this.showMatch(true);
    this.status.textContent = `${this.index + 1} / ${this.matches.length}`;
  }

  showMatch(focusEditor = false) {
    if (this.target?.tagName === "MARK") {
      const token = this.target.parentElement;
      if (token) token.textContent = token.textContent;
    } else {
      this.target?.classList.remove("payload-match");
    }
    this.target = null;
    const match = this.matches[this.index];
    if (!match) return;
    if (this.editor) {
      if (focusEditor) this.editor.focus({ preventScroll: true });
      this.editor.setSelectionRange(match.start, match.end);
      scrollEditorMatch(this.editor, match);
      return;
    }
    const section = this.scroll.children[match.source];
    const preview = section?.querySelector(".json-tree");
    const token = preview
      ? revealJsonMatch(preview, match)
      : section?.querySelector(".payload-text");
    if (!token) return;
    this.target = highlightMatch(token, this.input.value.trim());
    const visible = this.scroll.getBoundingClientRect();
    const target =
      this.target.getClientRects()[0] ?? this.target.getBoundingClientRect();
    if (target.top < visible.top || target.bottom > visible.bottom) {
      this.scroll.scrollTop +=
        target.top -
        visible.top -
        Math.max(0, (visible.height - target.height) / 2);
    }
  }
}
