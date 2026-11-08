# T40 P3b · Version history on Android

Evidence for the second half of T40's P3 ([issue #76](https://github.com/htxryan/penmoss/issues/76)):

- Version history (NT16): **Version history** in the note's ⋮ menu, a full-screen list over the open note with time, author chip (device or agent) and summary; online only with a clear offline message, the last list cached for reading;
- A version's diff (NT17): unified line diff in monospace (added/removed tinted by theme tokens, long lines wrapped, long unchanged runs folded), with a toggle to the whole version's markdown;
- Restore (NT18): **Restore this version** with a confirm; the open editor flushes first, then the phone exchanges the note at once;
- Undo an agent's change (NT19): **Undo this change** on agent versions; overlaps it could not undo are listed in a dialog, as the web lists them;
- Save a version now (NT20): history screen top-bar action; flushes the editor first, exchanges, then saves.

No new server route: the phone reuses `GET /api/notes/:id/versions`, `GET …/versions/:v`, `POST …/restore`, `POST …/revert` and `POST …/versions`. Decisions A435–A439 are in [`decisions.md`](../../../decisions.md).

## How it was run

- **No emulator session: blocked on KVM.** The worker's `penmoss36` AVD exists (`~/Android/sdk/emulator`, `~/.android/avd/penmoss36.avd`), but this session's user has no KVM permission (`/dev/kvm` is `root:kvm`, this user is not in `kvm`; `sg` asks for a password and `sudo` needs one), so the emulator never boots. The P3a emulator walk-through is therefore not repeated here; the Pixel checklist below (in [`docs/android.md`](../../../android.md#test-version-history-on-the-pixel-t40-p3b)) is for Ryan, and the flows it checks are covered by the tests below.
- **What covers it instead:**
  - Robolectric screen tests (`HistoryScreensTest`, 8): the list with time, author chip and summary; selecting a version reads its diff; the diff toggles to the whole version; Restore asks for confirm first and only the confirm restores; Revert only on agent versions; overlaps listed; offline problem with the cached list; Save version in the top bar.
  - Model tests against a canned server (`HistoryModelTest`, 20): the list with authors cached for reading; flush → POST → exchange order on restore; unchanged restore; revert's overlaps; save's flush → exchange → save order; offline with and without cache; revoked token signs out; restore, revert and save with genuinely unsent edits in Room on success and failure paths.
  - `NoteEditorControllerTest` (+3): `flushAndWait` stores the page's last edits before returning, waits for an Update that arrives late, and sends nothing when the note is not open.
  - `HttpPenmossApiTest` (+2): the history list with authors, one version's diff and write-back, save's 201.
  - `MigrationTest` (+1): a schema-8 database opens at 9 and caches a version list.
  - Full `task android:test` (627 tests, 0 failures), `task android:build`, `task typecheck`, and the server's `history.test.ts` (16), `trash-route.test.ts` and `folder-scope.test.ts` (141) in workerd — all green.
  - `task check` (ESLint) does not pass in this environment, on the clean base either: type-aware rules fail with "a type that could not be resolved" on files this slice never touches (verified identical with the slice stashed). Pre-existing and environmental; recorded here instead of worked around.

## Walk-through (by test, against the canned server)

| Step | What happens |
| --- | --- |
| The menu | The note's ⋮ menu gains **Version history** (tag `noteHistory`), enabled once the note is loaded. It opens over the note, so the editor stays open for flush and exchange. |
| The list | Time (`shortWhen`, as Trash shows it), one chip per author (the line monitor icon for a device, a spark for an agent, each with its label and an accessible Device/Agent name), and the web's line (`Saved by hand`, the summary). `loadsTheHistoryListWithItsAuthorsAndCachesIt`. |
| Offline | Online, the answer is cached in Room (schema 9, `history_cache`). Offline, the cached list reads with "Offline: showing versions from …"; with no cache, "Version history needs a connection to the server." `offlineShowsTheCachedList`, `offlineWithNothingCachedSaysHistoryNeedsAConnection`. The detail of a version never read needs the connection too. |
| The diff | The selected version's unified diff in monospace; `⋯ N unchanged lines` folds long runs (same CONTEXT as the web); **Show whole version** toggles to the version's markdown as plain text. `theDiffShowsAddedLinesAndTogglesToTheWholeVersion`, `longUnchangedRunsFoldAroundEachChange`. |
| Restore | **Restore this version** asks "Restore this version?" naming when it is from; only the confirm restores. Flush, `POST …/restore`, then the note is exchanged at once, so the content shows without waiting for the next pass; the list is read again. `restoreAsksForConfirmFirst`, `restoresFlushFirstThenExchangesAtOnce`, `aRestoreThatChangedNothingSaysSo`. |
| Revert | Only on versions with an agent author. Flush, `POST …/revert`, then exchange; what overlapped later edits is listed in a dialog ("Some changes overlapped … Before the edit: …"), as the web lists it. `revertIsOnlyOnAnAgentsVersion`, `revertUndoesTheAgentsChangeAndListsWhatOverlapped`, `overlapsTheRevertCouldNotUndoAreListed`. |
| Save now | The top bar's **Save version**: flush, exchange, then `POST …/versions`, so the version includes the phone's last edits. `saveVersionIsInTheTopBar`, `saveFlushesExchangesThenSaves`. |

**Not walked through on a device:**

- **Revert against the real server** needs a version an agent made; making one needs the agent edit engine. The request order and the overlaps dialog are covered above; the Pixel checklist says how to check it with a real agent edit.
- **The restored content appearing in the open editor** end to end (flush → restore → exchange → page Remote) is covered at each seam (controller, model order, exchange path) but not with a live WebView; the Pixel checklist checks it by eye.

## Tests

- **Kotlin (`engine-bridge`):** `HttpPenmossApiTest.readsTheHistoryListWithItsAuthors`, `readsOneVersionsDiffAndWritesBack` (restore/revert paths, save's 201).
- **Robolectric (`app`):**
  - `HistoryModelTest` (20) through the real client against MockWebServer with a canned dispatcher: the list and its detail, caching, restore/revert/save order with flush and exchange first, overlaps, offline with and without cache, revoked token, and all three actions with genuinely unsent edits in Room on success and failure paths.
  - `HistoryScreensTest` (8): list, select, diff and toggle, restore confirm, revert only on agent versions, overlaps dialog, offline problem, save action.
  - `NoteEditorControllerTest` (+3): `flushAndWait`, including the late-Update wait.
  - `MigrationTest` (+1): schema 8 opens at 9; the version-list cache starts empty and stores.
- **Mutation checks:**

  | Change made to the code | What failed |
  | --- | --- |
  | Model without `flushEditor()` in restore/revert/save | `restoresFlushFirstThenExchangesAtOnce` (events), `revert…` (events), `save…` (events) |
  | Model without `exchangeNow()` after restore/revert, or before save | the same three order tests |
  | Screen restoring without the confirm | `restoreAsksForConfirmFirst` (no confirm dialog; restore sent at once) |
  | Detail without the agent check on the revert button | `revertIsOnlyOnAnAgentsVersion` |
  | `diffRows` without folding | `longUnchangedRunsFoldAroundEachChange` |
  | `versionLine` without the reason word | `theRowSaysWhatEachVersionChanged` |

## Deploy

No server change: the phone uses the existing version routes, so no deploy is needed before the Pixel checklist in [`docs/android.md`](../../../android.md#test-version-history-on-the-pixel-t40-p3b).

## Fixup (T40 P3b review follow-ups)

The P3b review found four should-fix items and six nits, fixed here without touching the server:

- **Slow page beats `flushAndWait` (NT20).** `flushAndWait` re-sends `Flush` after the first quiet check and waits for five quiet checks in a row (~250 ms) instead of two. `flushAndWaitWaitsForAnUpdateThatArrivesLate` delivers the page's Update ~200 ms after `Flush` and asserts the wait was still open. Residual risk (A437): a page slower than the whole streak still beats the wait; its edits land on the next pass, never lost.
- **Silent exchange failure.** `exchangeNow` returns the `ExchangeResult?`; save aborts when it is null instead of saving a version without the phone's last edits, and restore/revert keep their success but say the new content is still coming. Covered by `saveAbortsWhenTheExchangeDidNotGoThrough`, `restoreSaysTheContentIsStillComingWhenTheExchangeFails`, `revertSaysTheContentIsStillComingWhenTheExchangeFails`.
- **Offline `select()` kept nothing.** Selecting a version no longer clears the detail first: a version whose detail will not load keeps showing what was read before. Covered by `aFailedSelectKeepsTheDetailAlreadyRead`.
- **Pending-edits coverage.** Restore, revert and save now run with genuinely unsent edits in Room on success (`restoreKeepsUnsentEdits`, `revertKeepsUnsentEdits`, `saveKeepsUnsentEdits`) and failure (`restoreFailureKeepsUnsentEditsAndSkipsTheExchange`, `revertFailureKeepsUnsentEditsAndSkipsTheExchange`, `saveFailureKeepsUnsentEdits`) paths; a failed POST skips the exchange and drops nothing queued. Amends A438's "asserted with unsent edits recorded".
- **Nits:** `HistoryUi.cachedAt` (written, never read) dropped; `HistoryCacheDao.delete` is now called when a note is purged (`NoteStore.dropPurged`); the restore confirm and message guard against a missing `createdAt` (`takeIf { it > 0 }`; belt-and-braces — `shortWhen` still renders "never" there, unreachable since the server always sends it); the save divergence from the web (phone selects the newest version, web clears the selection) is recorded in A438; the Pixel checklist's sign-out parenthetical is fixed (`docs/android.md` step 6: sign-out with nothing unsent clears the cache with the database). The post-action list reload still refetches the detail (N6, cheap and correct).
