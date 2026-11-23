#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

version="$(node -p 'require("./manifest.json").version')"
if [[ ! "$version" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  echo "Invalid extension version in manifest.json" >&2
  exit 1
fi

filename="wamp-inspector-$version.zip"
archive="dist/$filename"
mkdir -p dist
temporary="$(mktemp -d dist/.package-extension.XXXXXX)"
trap 'rm -rf -- "$temporary"' EXIT

{
  printf '%s\n' manifest.json
  find src -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \)
  find icons -type f \( -name '*.png' -o -name '*.svg' \)
} | LC_ALL=C sort | zip -qX "$temporary/$filename" -@
unzip -tq "$temporary/$filename" >&2
mv -f -- "$temporary/$filename" "$archive"
printf '%s\n' "$archive"
