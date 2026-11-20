import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

test("the Chrome manifest references files included in the repository", () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.json", root), "utf8"),
  );
  const entries = [
    manifest.background.service_worker,
    manifest.devtools_page,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(({ js }) => js),
  ];
  for (const path of entries) {
    const file = new URL(path, root);
    assert.ok(
      file.href.startsWith(root.href),
      `${path} must be inside the extension folder`,
    );
    assert.ok(
      statSync(file, { throwIfNoEntry: false })?.isFile(),
      `${path} must be included in the extension`,
    );
  }
});
