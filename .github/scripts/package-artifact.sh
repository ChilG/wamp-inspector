#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

version=$(node -p 'require("./manifest.json").version')
if [[ "${GITHUB_REF_TYPE:-}" == tag && "${GITHUB_REF_NAME:-}" != "v$version" ]]; then
  echo "The release tag must match v$version from manifest.json" >&2
  exit 1
fi

chrome_archive=$(npm run --silent build -- chrome)
edge_archive=$(npm run --silent build -- edge)
{
  printf 'chrome_filename=%s\n' "${chrome_archive##*/}"
  printf 'edge_filename=%s\n' "${edge_archive##*/}"
} >> "$GITHUB_OUTPUT"
