import { revealJsonMatch } from "./panel-json-preview.js";

const debounceMs = 100;

function literalPattern(term) {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
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
  return (
    previous?.source === current.source &&
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
    this.payloads = [];
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
    if (!this.bar.hidden && this.input.value.trim())
      this.search(this.timer === null);
  }

  queueSearch() {
    clearTimeout(this.timer);
    if (!this.input.value.trim()) {
      this.search();
      return;
    }
    this.timer = setTimeout(() => this.search(), debounceMs);
  }

  search(keepSelection = false) {
    clearTimeout(this.timer);
    this.timer = null;
    const query = this.input.value.trim();
    const current = keepSelection ? this.matches[this.index] : null;
    this.matches = query
      ? this.payloads.flatMap((payload, source) =>
          findPayloadMatches(payload, query).map((match) => ({
            ...match,
            source,
          })),
        )
      : [];
    const preserved = this.matches.findIndex((match) =>
      sameMatch(current, match),
    );
    this.index = this.matches.length ? Math.max(0, preserved) : -1;
    if (preserved < 0 || !this.target?.isConnected) this.showMatch();
    this.status.textContent = this.matches.length
      ? `${this.index + 1} / ${this.matches.length}`
      : query
        ? "No matches"
        : "";
    this.previous.disabled = this.next.disabled = this.matches.length < 2;
  }

  move(step) {
    if (this.timer !== null) {
      this.search();
      return;
    }
    if (!this.matches.length) return;
    this.index =
      (this.index + step + this.matches.length) % this.matches.length;
    this.showMatch();
    this.status.textContent = `${this.index + 1} / ${this.matches.length}`;
  }

  showMatch() {
    if (this.target?.tagName === "MARK") {
      const token = this.target.parentElement;
      if (token) token.textContent = token.textContent;
    } else {
      this.target?.classList.remove("payload-match");
    }
    this.target = null;
    const match = this.matches[this.index];
    if (!match) return;
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
