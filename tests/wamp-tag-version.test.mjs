import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../.github/scripts/tag-version.sh", import.meta.url),
);
const tagRef = "refs/tags/v0.1.1";
const dispatch =
  "workflow run package-extension.yml --repo test/wamp-inspector --ref v0.1.1";
const setupAuth = "auth setup-git --hostname github.com";

function fixture(t, lockVersion = "0.1.1") {
  const root = mkdtempSync(join(tmpdir(), "wamp-tag-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const calls = join(root, "gh.log");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
    GITHUB_REPOSITORY: "test/wamp-inspector",
    GH_TOKEN: "fixture",
    GH_CALLS: calls,
    GH_DISPATCH_EXIT: "0",
    VERSION_BRANCH: "release/v0.1.1",
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };

  function git(...args) {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }

  mkdirSync(join(checkout, ".github", "scripts"), { recursive: true });
  mkdirSync(bin);
  const fixtureScript = join(checkout, ".github", "scripts", "tag-version.sh");
  copyFileSync(script, fixtureScript);
  writeFileSync(calls, "");
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$GH_CALLS"\nif [[ "$1" == workflow ]]; then exit "$GH_DISPATCH_EXIT"; fi\n',
    { mode: 0o755 },
  );
  git("init", "--initial-branch=main");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  for (const [name, document] of Object.entries({
    "manifest.json": { version: "0.1.1" },
    "package.json": { version: "0.1.1" },
    "package-lock.json": {
      version: "0.1.1",
      packages: { "": { version: lockVersion } },
    },
  })) {
    writeFileSync(join(checkout, name), JSON.stringify(document));
  }
  git("add", "manifest.json", "package.json", "package-lock.json");
  git("commit", "-m", "Merge version bump");
  const mergeCommit = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "Later main commit");
  const mainTip = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  git("checkout", "--detach", mergeCommit);

  return {
    mergeCommit,
    mainTip,
    git,
    run(overrides = {}) {
      return spawnSync("bash", [fixtureScript], {
        cwd: checkout,
        env: { ...env, ...overrides },
        encoding: "utf8",
      });
    },
    remoteRef(ref) {
      return git("ls-remote", "origin", ref).split(/\s+/)[0];
    },
    calls() {
      return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
    },
  };
}

test("tags the checked-out merge commit and dispatches packaging on that tag", (t) => {
  const project = fixture(t);
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(project.remoteRef(tagRef), project.mergeCommit);
  assert.equal(project.remoteRef("refs/heads/main"), project.mainTip);
  assert.deepEqual(project.calls(), [setupAuth, dispatch]);
});

test("reuses the same tag when dispatch fails and the job is retried", (t) => {
  const project = fixture(t);
  assert.equal(project.run({ GH_DISPATCH_EXIT: "3" }).status, 3);
  assert.equal(project.remoteRef(tagRef), project.mergeCommit);
  const retry = project.run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(project.remoteRef(tagRef), project.mergeCommit);
  assert.deepEqual(project.calls(), [setupAuth, dispatch, setupAuth, dispatch]);
});

test("reuses an annotated remote tag that points to the merge commit", (t) => {
  const project = fixture(t);
  project.git(
    "tag",
    "-a",
    "v0.1.1",
    "-m",
    "Version 0.1.1",
    project.mergeCommit,
  );
  project.git("push", "origin", tagRef);
  const tagObject = project.remoteRef(tagRef);
  assert.notEqual(tagObject, project.mergeCommit);
  const result = project.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(project.remoteRef(tagRef), tagObject);
  assert.deepEqual(project.calls(), [setupAuth, dispatch]);
});

test("rejects a tag at a different commit without moving it or dispatching", (t) => {
  const project = fixture(t);
  project.git("push", "origin", `${project.mainTip}:${tagRef}`);
  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already points to/);
  assert.equal(project.remoteRef(tagRef), project.mainTip);
  assert.deepEqual(project.calls(), [setupAuth]);
});

test("rejects a mismatched version branch before contacting gh or tagging", (t) => {
  const project = fixture(t);
  const result = project.run({ VERSION_BRANCH: "release/v0.1.2" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release\/v0\.1\.1/);
  assert.equal(project.remoteRef(tagRef), "");
  assert.deepEqual(project.calls(), []);
});

test("rejects a mismatched lockfile before contacting gh or tagging", (t) => {
  const project = fixture(t, "0.1.0");
  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /versions must match/);
  assert.equal(project.remoteRef(tagRef), "");
  assert.deepEqual(project.calls(), []);
});
