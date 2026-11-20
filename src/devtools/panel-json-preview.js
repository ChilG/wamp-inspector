export function createJsonPreview(value, onField) {
  const preview = document.createElement("code");
  preview.className = "json-tree";
  preview.append(createJsonValue(value, [], onField, true));
  return preview;
}

export function revealJsonMatch(preview, { path, part }) {
  let node = preview.firstElementChild;
  for (const [depth, index] of path.entries()) {
    if (!node) return null;
    if (!node.classList.contains("json-entries")) {
      const toggle = node.firstElementChild;
      const contents = node.lastElementChild;
      if (!toggle?.classList.contains("json-branch")) return null;
      if (contents.hidden) toggle.click();
      node = contents.firstElementChild;
    }
    const entry = node?.children[index];
    if (!entry) return null;
    if (depth === path.length - 1 && part === "key")
      return entry.firstElementChild;
    node = entry.lastElementChild;
  }
  return node;
}

function createJsonValue(value, path, onField, expand = false) {
  if (value === null || typeof value !== "object") {
    const token = document.createElement("span");
    token.className = `json-${value === null ? "null" : typeof value}`;
    token.textContent = JSON.stringify(value);
    return token;
  }

  const array = Array.isArray(value);
  const keys = Object.keys(value);
  const [start, end] = array ? ["[", "]"] : ["{", "}"];
  if (!keys.length) return start + end;
  if (expand)
    return createJsonEntries(value, keys, array, start, end, path, onField);

  const branch = document.createElement("span");
  const toggle = document.createElement("button");
  const contents = document.createElement("span");
  const unit = array ? "item" : "property";
  const description = `${array ? "array" : "object"} with ${keys.length} ${keys.length === 1 ? unit : array ? "items" : "properties"}`;

  toggle.type = "button";
  toggle.className = "json-branch";
  toggle.textContent = `${start}…${end}`;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", `Expand ${description}`);
  toggle.title = `Expand ${description}`;
  contents.className = "json-branch-contents";
  contents.hidden = true;
  toggle.addEventListener("click", () => {
    const opening = contents.hidden;
    if (opening && !contents.hasChildNodes()) {
      contents.append(
        createJsonEntries(value, keys, array, "", end, path, onField),
      );
    }
    const action = opening ? "Collapse" : "Expand";
    toggle.textContent = opening ? start : `${start}…${end}`;
    toggle.setAttribute("aria-expanded", String(opening));
    toggle.setAttribute("aria-label", `${action} ${description}`);
    toggle.title = `${action} ${description}`;
    contents.hidden = !opening;
  });
  branch.append(toggle, contents);
  return branch;
}

function createJsonEntries(value, keys, array, start, end, path, onField) {
  const entries = document.createElement("span");
  entries.className = "json-entries";
  keys.forEach((key, index) => {
    const entry = document.createElement("span");
    entry.className = "json-entry";
    const childPath = [...path, array ? Number(key) : key];
    if (!array) {
      const label = document.createElement(onField ? "button" : "span");
      label.className = "json-key";
      label.textContent = JSON.stringify(key);
      if (onField) {
        label.type = "button";
        label.title = "Use this key as a table column";
        label.setAttribute(
          "aria-label",
          `Add ${JSON.stringify(key)} as a column`,
        );
        label.addEventListener("click", () => onField(childPath));
      }
      entry.append(label, ": ");
    }
    entry.append(createJsonValue(value[key], childPath, onField));
    if (index < keys.length - 1) entry.append(", ");
    entries.append(entry);
  });
  const fragment = document.createDocumentFragment();
  fragment.append(start, entries, end);
  return fragment;
}
