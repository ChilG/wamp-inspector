#!/usr/bin/env bash
set -euo pipefail

: "${CHROME_ARCHIVE_NAME:?CHROME_ARCHIVE_NAME is required}"
: "${EDGE_ARCHIVE_NAME:?EDGE_ARCHIVE_NAME is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

archives=("dist/$CHROME_ARCHIVE_NAME" "dist/$EDGE_ARCHIVE_NAME")
for archive in "${archives[@]}"; do
  unzip -tq "$archive"
done

if release=$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,assets); then
  if ! jq -e '.isDraft' <<< "$release" > /dev/null; then
    echo "Release $RELEASE_TAG has already been published" >&2
    exit 1
  fi

  missing_archives=()
  for archive in "${archives[@]}"; do
    name="${archive##*/}"
    if jq -e --arg name "$name" 'any(.assets[]; .name == $name and .state == "uploaded")' <<< "$release" > /dev/null; then
      echo "$name is already attached to the draft"
    else
      missing_archives+=("$archive")
    fi
  done

  if (( ${#missing_archives[@]} > 0 )); then
    gh release upload "$RELEASE_TAG" "${missing_archives[@]}" --repo "$GITHUB_REPOSITORY" --clobber
  fi
else
  gh release create "$RELEASE_TAG" "${archives[@]}" --repo "$GITHUB_REPOSITORY" --draft --verify-tag --generate-notes
fi
