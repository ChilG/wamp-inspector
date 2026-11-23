#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

version=$(node -p 'require("./manifest.json").version')
branch="release/v$version"
ref="refs/heads/$branch"

report_pr() {
  printf 'Version PR: %s\n' "$1"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '[Version PR](%s)\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

pr_url=$(gh pr list --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --state open \
  --json url,isCrossRepository --jq 'map(select(.isCrossRepository == false)) | .[0].url // empty')
if [[ -n "$pr_url" ]]; then
  report_pr "$pr_url"
  exit 0
fi

git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m "chore: bump version to v$version" -- manifest.json package.json package-lock.json

gh auth setup-git --hostname github.com
if git ls-remote --exit-code --heads origin "$ref" > /dev/null; then
  git fetch --no-tags origin "$ref"
  if [[ "$(git rev-parse --verify FETCH_HEAD^)" != "$(git rev-parse --verify HEAD^)" ]] ||
    ! git diff --quiet FETCH_HEAD HEAD --; then
    printf 'The existing branch %s has a different base or contents. Review it before retrying.\n' "$branch" >&2
    exit 1
  fi
else
  result=$?
  if [[ "$result" -ne 2 ]]; then
    exit "$result"
  fi
  git push origin "HEAD:$ref"
fi

if ! pr_url=$(gh pr create --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --title "Bump version to v$version" --body "Bumps the extension, package, and lockfile to v$version."); then
  printf 'The branch is available at https://github.com/%s/compare/main...%s?expand=1\n' "$GITHUB_REPOSITORY" "$branch" >&2
  exit 1
fi
report_pr "$pr_url"
