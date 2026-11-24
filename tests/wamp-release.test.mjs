import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const tag = "v0.1.1";
const chrome = "wamp-inspector-0.1.1-chrome.zip";
const edge = "wamp-inspector-0.1.1-edge.zip";
const repo = ["--repo", "test/wamp-inspector"];

function fixture(t, manifestOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "wamp-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    "scripts",
    "src",
    "icons",
    "manifest.json",
    "package.json",
  ]) {
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  const scripts = ".github/scripts";
  mkdirSync(join(root, scripts), { recursive: true });
  for (const file of ["package-artifact.sh", "attach-draft-release.sh"]) {
    copyFileSync(join(source, scripts, file), join(root, scripts, file));
  }

  const gh = join(root, "gh");
  const calls = join(root, "gh-calls");
  const output = join(root, "github-output");
  writeFileSync(calls, "");
  writeFileSync(output, "");
  writeFileSync(
    gh,
    [
      "#!/bin/bash",
      'printf "%s\\0" "$@" >> "$GH_CALLS"',
      'printf "\\n" >> "$GH_CALLS"',
      'if [[ "$2" == view ]]; then',
      '  [[ -n "${GH_RELEASE:-}" ]] || exit 1',
      '  printf "%s\\n" "$GH_RELEASE"',
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const manifestPath = join(root, "manifest.json");
  const manifest = {
    ...JSON.parse(readFileSync(manifestPath, "utf8")),
    name: "Chrome Test Extension",
    version: tag.slice(1),
    update_url: "https://example.test/chrome-update",
    ...manifestOverrides,
  };
  const manifestSource = JSON.stringify(manifest);
  writeFileSync(manifestPath, manifestSource);

  function run(file, args, env = {}) {
    return spawnSync(file, args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  return {
    manifest,
    manifestPath,
    manifestSource,
    build(...args) {
      return run("bash", ["scripts/package-extension.sh", ...args]);
    },
    package(ref = tag) {
      const result = run("bash", [join(scripts, "package-artifact.sh")], {
        GITHUB_OUTPUT: output,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: ref,
      });
      return { ...result, outputs: readFileSync(output, "utf8") };
    },
    entries() {
      const dist = join(root, "dist");
      return existsSync(dist) ? readdirSync(dist) : [];
    },
    unzip(file, ...args) {
      const result = run("unzip", [...args, join("dist", file)]);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
    fromZip(file, entry) {
      const result = run("unzip", ["-p", join("dist", file), entry]);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
    attach(release = "", archiveNames = [chrome, edge]) {
      return run("bash", [join(scripts, "attach-draft-release.sh")], {
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        GH_CALLS: calls,
        GH_RELEASE:
          typeof release === "string" ? release : JSON.stringify(release),
        GITHUB_REPOSITORY: repo[1],
        RELEASE_TAG: tag,
        CHROME_ARCHIVE_NAME: archiveNames[0],
        EDGE_ARCHIVE_NAME: archiveNames[1],
      });
    },
    calls() {
      return readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\0").slice(0, -1));
    },
  };
}

const view = ["release", "view", tag, ...repo, "--json", "isDraft,assets"];

test("preserves the default Chrome package used by existing local builds", (t) => {
  const project = fixture(t);
  const result = project.build();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "dist/wamp-inspector-0.1.1.zip");
  assert.deepEqual(
    JSON.parse(project.fromZip("wamp-inspector-0.1.1.zip", "manifest.json")),
    project.manifest,
  );
});

test("packages both browsers from the same source and exposes each ZIP to Actions", (t) => {
  const project = fixture(t);
  const result = project.package();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.outputs,
    `chrome_filename=${chrome}\nedge_filename=${edge}\n`,
  );
  assert.deepEqual(project.entries(), [chrome, edge]);
  const chromeManifest = JSON.parse(project.fromZip(chrome, "manifest.json"));
  const edgeManifest = JSON.parse(project.fromZip(edge, "manifest.json"));
  const { update_url, ...expected } = project.manifest;
  assert.deepEqual(chromeManifest, project.manifest);
  assert.deepEqual(edgeManifest, {
    ...expected,
    name: "Microsoft Edge Test Extension",
    description: expected.description.replace("Chrome", "Microsoft Edge"),
  });
  const entries = project.unzip(chrome, "-Z1").trim().split("\n").sort();
  assert.deepEqual(
    project.unzip(edge, "-Z1").trim().split("\n").sort(),
    entries,
  );
  assert.equal(
    project.fromZip(edge, "src/devtools/devtools.js"),
    project.fromZip(chrome, "src/devtools/devtools.js"),
  );
  assert.equal(
    readFileSync(project.manifestPath, "utf8"),
    project.manifestSource,
  );
});

test("rejects an unsupported browser or a mismatched release tag before packaging", (t) => {
  const project = fixture(t);
  const build = project.build("firefox");
  assert.notEqual(build.status, 0);
  assert.match(build.stderr, /chrome.*edge/);
  const result = project.package("v0.1.2");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must match v0\.1\.1/);
  assert.equal(result.outputs, "");
  assert.deepEqual(project.entries(), []);
});

test("rejects a Chrome description that becomes too long for Edge", (t) => {
  const project = fixture(t, {
    description: "Chrome DevTools ".padEnd(132, "x"),
  });
  const result = project.build("edge");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Edge description exceeds 132 characters/);
  assert.deepEqual(project.entries(), []);
});

test("creates a draft with both validated packages for the existing tag", (t) => {
  const project = fixture(t);
  assert.equal(project.package().status, 0);
  const result = project.attach();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(project.calls(), [
    view,
    [
      "release",
      "create",
      tag,
      `dist/${chrome}`,
      `dist/${edge}`,
      ...repo,
      "--draft",
      "--verify-tag",
      "--generate-notes",
    ],
  ]);
});

test("a rerun uploads only the unfinished asset and skips a complete draft", (t) => {
  const project = fixture(t);
  assert.equal(project.package().status, 0);
  const uploadedChrome = { name: chrome, state: "uploaded" };
  const unfinished = project.attach({
    isDraft: true,
    assets: [uploadedChrome, { name: edge, state: "starter" }],
  });
  assert.equal(unfinished.status, 0, unfinished.stderr);
  const complete = project.attach({
    isDraft: true,
    assets: [uploadedChrome, { name: edge, state: "uploaded" }],
  });
  assert.equal(complete.status, 0, complete.stderr);
  assert.deepEqual(project.calls(), [
    view,
    ["release", "upload", tag, `dist/${edge}`, ...repo, "--clobber"],
    view,
  ]);
});

test("leaves published releases alone and catches missing packages before calling GitHub", (t) => {
  const project = fixture(t);
  assert.equal(project.package().status, 0);
  assert.notEqual(project.attach("", [chrome, "missing.zip"]).status, 0);
  assert.deepEqual(project.calls(), []);
  const result = project.attach({ isDraft: false, assets: [] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already been published/);
  assert.deepEqual(project.calls(), [view]);
});
