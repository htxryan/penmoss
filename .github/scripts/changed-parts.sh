#!/usr/bin/env bash
# Which parts of the repository a change touches (A1095), and whether it changes what ships
# (A1349). CI's `pick` job lists the changed files (a pull request's files, or a push's
# compare) and pipes them here, one per line; each test job runs only for its part.
#
#   changed-parts.sh [--all] < files     prints check=, web=, android=, desktop=, site=, ships=
#
# `--all` (a list GitHub couldn't give or truncated) turns every part on. `ships` says whether
# the Mac app or the APK is built from something that changed: app and package source, their
# build configuration, or the lockfile. CI, Taskfile and lint changes, tests and docs never
# ship, so a merge of only those builds and tests but publishes no new Alpha build (PEN-128).
set -euo pipefail

all=false
[ "${1:-}" = --all ] && all=true

check=false web=false android=false desktop=false site=false ships=false
if [ "$all" = true ]; then
  check=true web=true android=true desktop=true site=true ships=true
else
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # penmoss.app (T80.15, R13): the Astro site and its docs get the Site job.
    case "$f" in
      site/*) site=true ;;
    esac
    # Docs, the site, prototypes and spikes change no job; markdown neither, except the test
    # fixtures.
    case "$f" in
      docs/* | site/* | prototype/* | spikes/* | .claude/*) continue ;;
      */test/*) ;;
      *.md) continue ;;
    esac
    case "$f" in
      # Shared: everything builds from these. Only the lockfile changes what ships.
      pnpm-lock.yaml)
        check=true web=true android=true desktop=true site=true ships=true ;;
      .github/* | package.json | pnpm-workspace.yaml | Taskfile.yml | \
        tsconfig.base.json | .node-version | .npmrc | eslint.config.js | stylelint.config.js | \
        .prettierrc* | .prettierignore)
        check=true web=true android=true desktop=true site=true ;;
      # Packages the web app, the Android editor and the Mac app all bundle.
      packages/core/* | packages/editor/* | packages/git-notebook/* | packages/sync-client/* | packages/ui/*)
        check=true web=true android=true desktop=true ;;
      # The web app's source is also the Android editor's and the Mac app's.
      apps/web/*) check=true web=true android=true desktop=true ;;
      # The CLI ships inside the Mac app, and so does search by meaning (D59).
      packages/cli/* | packages/embed/*) check=true desktop=true ;;
      apps/desktop/*) check=true desktop=true ;;
      # The Android editor page and the Play script are JavaScript: Check lints and tests them.
      apps/android/editor/* | apps/android/play/*) check=true android=true ;;
      # Kotlin and Gradle: only the Android job.
      apps/android/*) android=true ;;
      # The relay, scripts and anything else: Check alone.
      *) check=true ;;
    esac
    # What ships: the source the apps are built from, never their tests or test setup.
    case "$f" in
      */test/* | */tests/* | */e2e/* | */androidTest/* | */__tests__/* | */fixtures/* | \
        *.test.* | *.spec.* | */playwright.config.* | */vitest.config.* | */vitest.*.config.*) ;;
      apps/android/play/*) ;;
      packages/core/* | packages/editor/* | packages/git-notebook/* | packages/sync-client/* | \
        packages/ui/* | packages/cli/* | packages/embed/* | apps/web/* | apps/desktop/* | \
        apps/android/*)
        ships=true ;;
    esac
  done
fi

echo "check=$check"
echo "web=$web"
echo "android=$android"
echo "desktop=$desktop"
echo "site=$site"
echo "ships=$ships"
