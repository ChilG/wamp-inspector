#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

version="$(node -p 'require("./manifest.json").version')"
if [[ ! "$version" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  echo "Invalid extension version in manifest.json" >&2
  exit 1
fi

browser="${1:-}"
case "$browser" in
  "") suffix="" ;;
  chrome|edge) suffix="-$browser" ;;
  *)
    echo "Supported browser targets are chrome and edge." >&2
    exit 1
    ;;
esac

filename="wamp-inspector-${version}${suffix}.zip"
archive="dist/$filename"
mkdir -p dist
temporary="$(mktemp -d dist/.package-extension.XXXXXX)"
trap 'rm -rf -- "$temporary"' EXIT

{
  if [[ "$browser" != edge ]]; then
    printf '%s\n' manifest.json
  fi
  find src -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \)
  find icons -type f \( -name '*.png' -o -name '*.svg' \)
} | LC_ALL=C sort | zip -qX "$temporary/$filename" -@
if [[ "$browser" == edge ]]; then
  node --input-type=commonjs > "$temporary/manifest.json" <<'NODE'
const { update_url, ...manifest } = require("./manifest.json");
const edgeBranding = (text) => text.replace(/\bChrome\b/g, "Microsoft Edge");
const edgeManifest = {
  ...manifest,
  name: edgeBranding(manifest.name),
  description: edgeBranding(manifest.description),
};
if ([...edgeManifest.description].length > 132) {
  console.error("Edge description exceeds 132 characters after converting the browser name.");
  process.exit(1);
}
console.log(JSON.stringify(edgeManifest, null, 2));
NODE
  (cd "$temporary" && zip -qX "$filename" manifest.json)
fi

unzip -tq "$temporary/$filename" >&2
mv -f -- "$temporary/$filename" "$archive"
printf '%s\n' "$archive"
