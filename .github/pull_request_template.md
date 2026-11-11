## What and why

<!-- What changes for someone using Penmoss, and why. Link the issue: Fixes PEN-… -->

## Release note

<!-- One line per user-facing change: New, Improved or Fixed, then (Mac) or (Android) if the change is only there, a colon and one sentence ending in a full stop. Write `none` for a change nobody using Penmoss would notice (CI, tests, contributor docs). This goes into the release notes in the app and on GitHub; the "Release note" check reads it.
New: Settings → Updates shows what changed in each version.
Fixed (Android): The keyboard no longer hides the last line. -->

## How it was checked

<!-- Tests that fail without the change, and what you tried in the running app (Mac, Android, CLI, an agent). Screenshots in light and dark for anything visible. -->

## Checklist

- [ ] `task check` passes (lint, typecheck, unit tests)
- [ ] New or changed behaviour has a test that fails without it
- [ ] A decision this changes is recorded in `docs/decisions.md`
- [ ] A user-facing change updates its page in the user docs (`site/src/content/docs/docs/`, penmoss.app/docs) in this pull request
- [ ] Contributor docs in `docs/` that this makes wrong are updated
