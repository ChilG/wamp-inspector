#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${VERSION_BRANCH:?VERSION_BRANCH is required}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

version=$(node --input-type=commonjs <<'NODE'
const { version } = require("./manifest.json");
const pkg = require("./package.json");
const lock = require("./package-lock.json");
const stableVersion = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2}$/;

if (
  typeof version !== "string" ||
  !stableVersion.test(version) ||
  version === "0.0.0" ||
  version.split(".").some((part) => Number(part) > 65535)
) {
  console.error("Expected a stable Chrome extension version in manifest.json.");
  process.exit(1);
}
if ([pkg.version, lock.version, lock.packages?.[""]?.version].some((value) => value !== version)) {
  console.error("The manifest, package, and package-lock versions must match before tagging.");
  process.exit(1);
}
console.log(version);
NODE
)

tag="v$version"
tag_ref="refs/tags/$tag"
if [[ "$VERSION_BRANCH" != "release/$tag" ]]; then
  printf 'Version branch must be release/%s. Got %s.\n' "$tag" "$VERSION_BRANCH" >&2
  exit 1
fi

commit=$(git rev-parse --verify 'HEAD^{commit}')
gh auth setup-git --hostname github.com

remote_refs=$(git ls-remote --tags origin "$tag_ref" "${tag_ref}^{}")
remote_commit=$(awk -v ref="$tag_ref" '
  $2 == ref { unpeeled = $1 }
  $2 == (ref "^{}") { peeled = $1 }
  END { print (peeled != "" ? peeled : unpeeled) }
' <<< "$remote_refs")

if [[ -z "$remote_commit" ]]; then
  git push origin "$commit:$tag_ref"
elif [[ "$remote_commit" != "$commit" ]]; then
  printf 'Tag %s already points to %s. Expected %s.\n' "$tag" "$remote_commit" "$commit" >&2
  exit 1
fi

gh workflow run package-extension.yml --repo "$GITHUB_REPOSITORY" --ref "$tag"
