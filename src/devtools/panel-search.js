function indexMessageRow({ item, message }) {
  const {
    type,
    id,
    summary,
    topic,
    replySummary,
    responseType,
    response,
    responseState,
    latency,
  } = message;
  let payloadText;

  return {
    item,
    message,
    type,
    id,
    latency,
    responseState,
    text: [type, id, summary, topic, responseType, replySummary]
      .join(" ")
      .toLowerCase(),
    payloadContains(query) {
      payloadText ??= [message.payload, response]
        .map((payload) =>
          payload?.kind === "text"
            ? payload.value
            : JSON.stringify(payload?.value),
        )
        .join("\n")
        .toLowerCase();
      return payloadText.includes(query);
    },
  };
}

function matchesMessage(
  row,
  { query, requestId, types, responses, minimumLatency, includePayload },
) {
  if (types.length && !types.includes(row.type)) return false;
  if (responses.length && !responses.includes(row.responseState)) return false;
  if (
    minimumLatency !== null &&
    (row.latency == null || row.latency < minimumLatency)
  )
    return false;
  if (requestId !== undefined) return String(row.id) === requestId;
  return (
    row.text.includes(query) || (includePayload && row.payloadContains(query))
  );
}

export function syncChildren(parent, children) {
  const retained = new Set(children);
  for (const child of Array.from(parent.children)) {
    if (!retained.has(child)) child.remove();
  }
  children.forEach((child, index) => {
    if (child !== parent.children[index])
      parent.insertBefore(child, parent.children[index] ?? null);
  });
}

export class MessageSearch {
  constructor(onFilter) {
    this.input = document.querySelector("#message-search");
    this.form = document.querySelector("#message-filters");
    this.minimum = document.querySelector("#minimum-latency");
    this.filterButton = document.querySelector("#filter-button");
    this.filterCount = document.querySelector("#filter-count");
    this.matchCount = document.querySelector("#match-count");
    this.bar = document.querySelector(".capture-bar");
    this.showButton = document.querySelector("#show-search");
    this.hideButton = document.querySelector("#hide-search");
    this.list = document.querySelector("#messages");
    this.empty = document.querySelector("#no-messages");
    this.stream = document.querySelector(".stream");
    this.typeChoices = document.querySelector("#filter-types");
    this.onFilter = onFilter;
    this.rows = [];
    this.indexByItem = new WeakMap();
    this.emptyMessage = "No messages in this capture.";
    this.bindControls();
  }

  updateTypes() {
    const previous = new Map(
      Array.from(this.typeChoices.children, (label) => [
        label.dataset.type,
        label,
      ]),
    );
    const checked = new FormData(this.form).getAll("type");
    const types = Array.from(
      new Set([
        "CALL",
        "EVENT",
        "SUBSCRIBE",
        ...checked,
        ...this.rows.map(({ type }) => type),
      ]),
    ).sort();
    const labels = types.map((type) => {
      if (previous.has(type)) return previous.get(type);
      const label = document.createElement("label");
      const input = document.createElement("input");
      label.className = "filter-toggle";
      label.dataset.type = type;
      input.type = "checkbox";
      input.name = "type";
      input.value = type;
      label.append(input, type);
      return label;
    });
    syncChildren(this.typeChoices, labels);
  }

  bindControls() {
    this.input.addEventListener("input", () => this.apply());
    this.form.addEventListener("input", () => this.apply());
    this.form.addEventListener("submit", (event) => event.preventDefault());
    document.querySelector("#clear-filters").addEventListener("click", () => {
      this.form.reset();
      this.apply();
    });
    this.showButton.addEventListener("click", () => {
      this.setSearchOpen(true);
      this.input.focus();
    });
    this.hideButton.addEventListener("click", () => {
      this.setSearchOpen(false);
      this.showButton.focus();
    });
    this.form.addEventListener("beforetoggle", (event) => {
      if (event.newState === "open") this.positionPopover();
    });
    window.addEventListener("resize", () => {
      if (!this.form.matches(":popover-open")) return;
      this.setSearchOpen(true);
      this.positionPopover();
    });
  }

  setSearchOpen(open) {
    this.bar.toggleAttribute("data-search-open", open);
    this.showButton.setAttribute("aria-expanded", String(open));
  }

  positionPopover() {
    const { bottom, left } = this.filterButton.getBoundingClientRect();
    this.form.style.setProperty("--filter-top", `${bottom + 5}px`);
    this.form.style.setProperty("--filter-left", `${left}px`);
  }

  setRows(rows, emptyMessage, { preserveScroll = false } = {}) {
    this.rows = rows.map((row) => {
      const previous = this.indexByItem.get(row.item);
      if (previous?.message === row.message) return previous;
      const indexed = indexMessageRow(row);
      this.indexByItem.set(row.item, indexed);
      return indexed;
    });
    this.emptyMessage = emptyMessage;
    this.updateTypes();
    syncChildren(
      this.list,
      this.rows.map(({ item }) => item),
    );
    this.apply(!preserveScroll);
  }

  apply(resetScroll = true) {
    const data = new FormData(this.form);
    const query = this.input.value.trim().toLowerCase();
    const latency = this.minimum.valueAsNumber;
    const filters = {
      query,
      requestId: query.match(/^#(\d+)$/)?.[1],
      types: data.getAll("type"),
      responses: data.getAll("response"),
      minimumLatency: Number.isFinite(latency) && latency >= 0 ? latency : null,
      includePayload: data.has("payload"),
    };
    let matches = 0;
    for (const row of this.rows) {
      const visible = matchesMessage(row, filters);
      row.item.hidden = !visible;
      if (visible) matches += 1;
    }

    const active =
      filters.types.length +
      filters.responses.length +
      Number(filters.minimumLatency !== null) +
      Number(filters.includePayload);
    this.filterCount.textContent = String(active);
    this.filterCount.hidden = active === 0;
    this.filterButton.toggleAttribute("data-active", active > 0);
    this.showButton.toggleAttribute(
      "data-active",
      Boolean(query) || active > 0,
    );
    this.showButton.setAttribute(
      "aria-label",
      Boolean(query) || active > 0 ? "Search, filters active" : "Search",
    );
    const count = `${matches} / ${this.rows.length}`;
    if (this.matchCount.textContent !== count)
      this.matchCount.textContent = count;
    this.matchCount.title = `${matches} of ${this.rows.length} rows`;
    this.empty.hidden = matches !== 0;
    const emptyMessage = this.rows.length
      ? "No matching messages."
      : this.emptyMessage;
    if (this.empty.textContent !== emptyMessage)
      this.empty.textContent = emptyMessage;
    this.onFilter();
    if (resetScroll) this.stream.scrollTop = 0;
  }
}
