#!/bin/sh
# Fails if the repository holds a planning or roadmap file (W8, W13). The plan is a Claude
# artifact linked from a GitHub issue, and the issue and its sub-issues track progress. Nothing of
# it lives in the repository. Part of `task lint`, so `task check` and CI's Check job run it.
# Looks at tracked files and at untracked ones that aren't ignored, so it fails before a commit.
# It also refuses screenshots, recordings and scripts under docs/evidence: evidence goes in the
# pull request or the issue, and the factory's proof in its R2 bucket (A1223, A1478).
set -eu
cd "$(dirname "$0")/.."

files="$(
  git ls-files
  git ls-files --others --exclude-standard
)"

found="$(echo "$files" | grep -iE '^(tasks|plans?|roadmap)/|(^|/)docs/(ideas|plans?|notes|specs?|roadmap|tasks)/|(^|/)(plan|plans|spec|todo|tasks|roadmap)\.(md|html|txt)$' || true)"

if [ -n "$found" ]; then
  echo 'Planning files belong in a Claude artifact tracked by GitHub issues, not the repository (W13):' >&2
  echo "$found" | sed 's/^/  /' >&2
  echo 'Move the plan into an artifact linked from the parent issue, with a sub-issue per task, and delete them.' >&2
  exit 1
fi

evidence="$(echo "$files" | grep -iE '^docs/evidence/.*\.(png|jpe?g|gif|webp|mp4|mov|webm|mjs|js|ts|py)$' || true)"

if [ -n "$evidence" ]; then
  echo 'Evidence goes in the pull request or the issue, not the repository (A1478):' >&2
  echo "$evidence" | sed 's/^/  /' >&2
  echo 'Attach the screenshots to the pull request or the issue, and delete them here.' >&2
  exit 1
fi
