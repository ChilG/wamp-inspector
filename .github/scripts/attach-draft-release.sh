#!/usr/bin/env bash
set -euo pipefail

: "${ARCHIVE_NAME:?ARCHIVE_NAME is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

archive="dist/$ARCHIVE_NAME"
unzip -tq "$archive"

if release=$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,assets); then
  if ! jq -e '.isDraft' <<< "$release" > /dev/null; then
    echo "Release $RELEASE_TAG has already been published" >&2
    exit 1
  fi

  if jq -e --arg name "$ARCHIVE_NAME" 'any(.assets[]; .name == $name and .state == "uploaded")' <<< "$release" > /dev/null; then
    echo "$ARCHIVE_NAME is already attached to the draft"
  else
    gh release upload "$RELEASE_TAG" "$archive" --repo "$GITHUB_REPOSITORY"
  fi
else
  gh release create "$RELEASE_TAG" "$archive" --repo "$GITHUB_REPOSITORY" --draft --verify-tag --generate-notes
fi
