#!/bin/sh
# `task check:changed` (A1176): the parts of `task check` that this branch's changes can affect,
# for running before each commit. `task check` (and CI's Check job) still run everything before a
# push, so nothing is checked less; it is checked less often while a branch is being built.
#
#   sh scripts/check-changed.sh            # against the merge base with origin/main
#   sh scripts/check-changed.sh main       # against another ref
#
# Changed means committed on this branch, staged, unstaged or untracked. What runs:
#   - ESLint, stylelint and Prettier on the changed files only;
#   - typecheck and unit tests of every package with a changed file, and of every package that
#     depends on one (pnpm's `...[<ref>]` filter);
#   - the release-page and Play upload script tests when their folders changed.
# A change to shared config (lockfile, root package.json, tsconfig.base.json, the lint and format
# configs, the Taskfile) can affect any package, so it runs the whole `task check` instead.
set -eu

cd "$(dirname "$0")/.."
ref="${1:-origin/main}"
base="$(git merge-base HEAD "$ref")"

changed="$(
  {
    git diff --name-only --diff-filter=ACMR "$base"
    git ls-files --others --exclude-standard
  } | sort -u
)"

if [ -z "$changed" ]; then
  echo "[check:changed] nothing changed against $ref"
  exit 0
fi

if echo "$changed" | grep -qE '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|eslint\.config\.js|stylelint\.config\.js|\.prettierrc[^/]*|\.prettierignore|Taskfile\.yml)$'; then
  echo '[check:changed] shared config changed: running the whole `task check`'
  exec task check:all
fi

count="$(echo "$changed" | wc -l | tr -d ' ')"
echo "[check:changed] $count changed files against $ref ($(git rev-parse --short "$base"))"

sh scripts/no-plan-files.sh

# Lint and format: only the changed files that still exist.
existing="$(echo "$changed" | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done)"
scripts="$(echo "$existing" | grep -E '\.(ts|tsx|js|mjs|cjs|jsx)$' || true)"
styles="$(echo "$existing" | grep -E '\.css$' || true)"

if [ -n "$scripts" ]; then
  # astro:content's types for the site's content config (see Taskfile.yml's lint).
  if echo "$scripts" | grep -q '^site/'; then pnpm --filter @penmoss/site exec astro sync > /dev/null; fi
  echo "[check:changed] eslint: $(echo "$scripts" | wc -l | tr -d ' ') files"
  echo "$scripts" | tr '\n' '\0' |
    NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096" xargs -0 pnpm exec eslint --no-warn-ignored
fi
if [ -n "$styles" ]; then
  echo "$styles" | tr '\n' '\0' | xargs -0 pnpm exec stylelint --allow-empty-input
fi
if [ -n "$existing" ]; then
  echo "$existing" | tr '\n' '\0' | xargs -0 pnpm exec prettier --check --ignore-unknown
fi

# Typecheck and tests: the changed packages and their dependents. pnpm compares against the ref
# itself; untracked files count through the package they sit in, found here.
filters="--filter=...[$base]"
for pkg in $(echo "$changed" | grep -oE '^(apps|packages)/[^/]+' | sort -u); do
  if [ -f "$pkg/package.json" ]; then
    filters="$filters --filter=...{./$pkg}"
  fi
done
# A change outside every package selects the root project, which has no scripts, so these
# run the script where it exists (`run --if-present`) rather than exec it in every project.
# shellcheck disable=SC2086
pnpm -r --workspace-concurrency=2 $filters run --if-present typecheck
# shellcheck disable=SC2086
pnpm -r --workspace-concurrency=1 $filters run --if-present test

if echo "$changed" | grep -q '^\.github/scripts/'; then
  task releases:test
fi
if echo "$changed" | grep -q '^apps/android/play/'; then
  task android:publish:test
fi
echo '[check:changed] passed. Run `task check` before pushing.'
