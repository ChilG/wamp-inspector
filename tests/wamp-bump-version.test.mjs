import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/bump-version.mjs", import.meta.url),
);

function versionFiles(version) {
  return {
    "manifest.json": { manifest_version: 3, version },
    "package.json": { name: "wamp-inspector", version, private: true },
    "package-lock.json": {
      name: "wamp-inspector",
      version,
      lockfileVersion: 3,
      packages: {
        "": { name: "wamp-inspector", version },
        "node_modules/ws": { version: "8.23.0" },
      },
    },
  };
}

function fixture(t, files) {
  const cwd = mkdtempSync(join(tmpdir(), "wamp-bump-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const initial = Object.entries(files).map(([name, data]) => {
    const path = join(cwd, name);
    const content =
      typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(path, content);
    return [path, content];
  });
  return {
    run: (...args) =>
      spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" }),
    read: (name) => readFileSync(join(cwd, name), "utf8"),
    assertUnchanged() {
      for (const [path, content] of initial)
        assert.equal(readFileSync(path, "utf8"), content);
    },
  };
}

for (const [part, current, next] of [
  ["patch", "1.2.3", "1.2.4"],
  ["minor", "1.2.3", "1.3.0"],
  ["major", "1.2.3", "2.0.0"],
  ["patch", "1.2.65534", "1.2.65535"],
]) {
  test(`${part} updates all project versions from ${current} to ${next}`, (t) => {
    const project = fixture(t, versionFiles(current));
    const result = project.run(part);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${next}\n`);

    for (const [name, data] of Object.entries(versionFiles(next)))
      assert.equal(project.read(name), `${JSON.stringify(data, null, 2)}\n`);
  });
}

test("keeps existing inline manifest arrays on one line", (t) => {
  const manifest = `{
  "manifest_version": 3,
  "version": "1.2.3",
  "permissions": ["storage", "tabs"]
}\n`;
  const project = fixture(t, {
    ...versionFiles("1.2.3"),
    "manifest.json": manifest,
  });
  const result = project.run("patch");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    project.read("manifest.json"),
    manifest.replace("1.2.3", "1.2.4"),
  );
});

test("invalid bump arguments leave the version files unchanged", (t) => {
  const project = fixture(t, versionFiles("1.2.3"));
  for (const args of [[], ["prerelease"], ["patch", "minor"]]) {
    const result = project.run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /patch\|minor\|major/);
    project.assertUnchanged();
  }
});

test("mismatched package and lockfile versions leave the files unchanged", (t) => {
  const files = versionFiles("1.2.3");
  files["package-lock.json"].packages[""].version = "1.2.2";
  const project = fixture(t, files);
  const result = project.run("patch");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /versions must match/);
  project.assertUnchanged();
});

test("malformed JSON leaves the version files unchanged", (t) => {
  const project = fixture(t, {
    ...versionFiles("1.2.3"),
    "manifest.json": "{",
  });
  const result = project.run("patch");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /manifest\.json/);
  project.assertUnchanged();
});

for (const current of [
  "0.0.0",
  "01.2.3",
  "1.2.3-rc.1",
  "65536.0.0",
  "1.2.65535",
]) {
  test(`rejects patch from ${current} when it cannot produce a valid stable transition`, (t) => {
    const project = fixture(t, versionFiles(current));
    const result = project.run("patch");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Chrome extension version/);
    project.assertUnchanged();
  });
}
