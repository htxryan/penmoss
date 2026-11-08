# T40 P2b · Git mirror, Status, error reports and sync on Android

Evidence for the second half of T40's P2 ([issue #76](https://github.com/htxryan/penmoss/issues/76)): Settings → Git mirror (AC5), Settings → Status (AC6), the app's error reports (AC7), pictures that failed with Retry (AC8), and the note's sync icon (PL10). Decisions A426–A429 in [`decisions.md`](../../../decisions.md). P2a's evidence is in [`p2a.md`](p2a.md). No server change.

## How it was run

- The `penmoss36` emulator (API 36, 1080×2400) on the agent worker, a local Worker (`wrangler dev --local`) with this branch's server, and the web app on Vite, as in P2a. The phone was still signed in with admin from P2a. Screenshots are scaled to 1080 px tall.
- Three sessions under the shared lock, of 4, 8 and 2 minutes. The third, after the review of #93, checked the changed start-up: a crash was recorded (names known, so scrubbed and not withheld), sent on the next start (`POST /api/errors 204`), and listed in Status.
- The first found a bug: the server refused the phone's error report with 400. The app's JSON leaves out fields that hold their default, and `source = "android"` was a default, so the request had no `source`. The reporter then dropped the report, as it drops anything the server refuses outright. `source` is now always written, with `StatusApiTest` checking the body the server gets (it fails with the default put back). The second session re-ran the walk-through.
- BiometricPrompt is a secure window, so a screenshot of it is black. What it showed was read with `uiautomator dump`; `adb -e emu finger touch 1` answered it.
- Airplane mode does not cut the phone off from a local server reached through `adb reverse`, and removing the reverse port leaves open connections working. To be offline, the adb server was restarted (which drops every tunnelled connection) and only the web's port reversed again.

## Walk-through

| Step | What happened | Screenshot |
| --- | --- | --- |
| Settings | Settings' home lists Git mirror, "Your notes, copied to GitHub", and Status, "Backups and error reports", before Devices and tokens. | [p2b-settings-home](p2b-settings-home.png) |
| Git mirror | The local server has no `GITHUB_MIRROR_TOKEN`: the web's intro, then Off, "No GitHub token: set the GITHUB_MIRROR_TOKEN secret to turn it on", and the repository and branch (A426). The On view (last commit, counts, attachments left out, failures) is covered by `StatusModelsTest` and `StatusScreensTest`. | [p2b-mirror](p2b-mirror.png) |
| A crash | `adb shell am crash app.penmoss.debug` stopped the app; `files/error-reports.json` already held the report (`"source":"android"`, "CrashedByAdbException: shell-induced crash", location `crash`, the stack). Opened again, the first pass sent it: `POST /api/errors 204`, and the file was empty (A427). | — |
| Status | This phone ("Synced at 2:42 AM", Open), Backups (folder tree copied never, accounts and tokens exported never, Back up now), and Errors: "Android app · 25 Oct, 2:42 AM", "CrashedByAdbException: shell-induced crash", "crash", Details, then Clear errors (A426). | [p2b-status-error](p2b-status-error.png) |
| Cancel | Back up now: the prompt, "Confirm it's you", "Penmoss is trying to back up your notes now.", with the fingerprint sensor and Use PIN. Cancelled: "Not done: this phone did not confirm it was you." Nothing was sent. | [p2b-not-done](p2b-not-done.png) |
| Back up now | Again, with a fingerprint: `POST /api/admin/backup 200`, "Backed up the folder tree, accounts and tokens.", and accounts and tokens exported "25 Oct, 2:43 AM". The folder tree stays "never": the workspace copy is skipped while nothing changed since the last, here an empty workspace, as on the web. | [p2b-backed-up](p2b-backed-up.png) |
| Clear errors | "Clear the error list?", "It empties the list on every device. New errors are listed again as they happen.", Cancel and Clear errors; then the check and a fingerprint: `DELETE /api/errors 204`, "Cleared the errors.", "No errors reported in the last 30 days." | [p2b-clear-confirm](p2b-clear-confirm.png), [p2b-cleared](p2b-cleared.png) |
| The sync icon | A new note, "Walk through note", typed: the icon in the top bar reads "Sync: Synced". Offline, one more word: "Sync: Offline", the cloud crossed out, with one edit unsent in Room (A429). | [p2b-note-offline](p2b-note-offline.png) |
| What it means | A tap: "Offline", "Penmoss can't be reached. This note is as it was last synced, and edits made here stay on this phone until it can be.", with Sync and storage and OK. | [p2b-note-explain](p2b-note-explain.png) |
| Sync and storage | "Offline: showing what's on this phone", "On this phone, not sent yet", "1 edit", Sync now (A428). The first tap on the dialog's Sync and storage did not open it; the second did, and a repeat from the start opened it with one tap, so it was not reproduced. | [p2b-sync-storage](p2b-sync-storage.png) |
| Back online | Reconnected, Sync now: "Synced at 2:48 AM", "Nothing: Penmoss has everything made on this phone."; the note's icon read "Sync: Synced" again. | [p2b-sync-storage-sent](p2b-sync-storage-sent.png), [p2b-note-synced](p2b-note-synced.png) |

A picture that fails for good cannot be caused on the emulator without changing the server. Its count and Retry (`PhoneQueueTest`, against Room), the note's snackbar (`StatusScreensTest`) and the note's icon (`StatusModelsTest`, `StatusScreensTest`) are covered by the tests below; `NoteRoute`'s wiring of them is not.

## Tests

- **Kotlin (`engine-bridge`):** `StatusApiTest`, against MockWebServer: an error report is a `POST /api/errors` whose body names `source` `android`, with no check; the mirror's status is read (unknown fields ignored); backups and errors are read without the check, and Back up now and Clear errors are sent after it, with the token.
- **Robolectric (`app`):**
  - `ErrorReporterTest` (17): each error once, with its message, stack, place and release; a title, a folder name or quoted text never leaves the phone; scrubbed when recorded, so a name gone from Room since still never leaves; until names are known, only the kind, class names and frames; a new workspace's names; `clear`; straight, escaped, open and cut quotes, and a title the limit would cut; a real `JsonDecodingException` without its `JSON input`; frames and parts of words left alone; nothing goes when the names cannot be read, or before the reporter is connected; a background run that gave up, only for an error, named, and once; at most 10 wait and 20 a run; offline or signed out waits, and a refused report is dropped; reports survive the process; an unreadable file starts afresh; an uncaught exception is recorded, then handed on.
  - `PhoneQueueTest`, through the app's graph against a real Room database: Sync and storage's counts by kind, and after Retry; a note's own unsent edits (pending and kept apart, not kept) and pictures; the names (titles, deleted ones too, and folders); the reporter scrubbing with the names Room holds; clearing the cache forgetting the reports and the mirror's answer.
  - `StatusModelsTest`, through the real client against MockWebServer: the mirror in the web's words; offline with and without a kept answer; the kept answer is this workspace's only; Status reads without the check; Back up now and Clear errors ask it and send nothing when refused; `insufficient_scope` asks to sign in again, in Status's words; the note's sync state for every case, failed pictures included.
  - `StatusScreensTest`: Git mirror's rows and links, and its age offline; Status's backups and errors, Clear errors asking first, nothing offered while loading, and Sign in again without admin while This phone still opens; Sync and storage by kind, with Retry for failed pictures, and when nothing waits; the sync icon's state and its explanation, which opens Sync and storage, and for failed pictures retries; the note's snackbar when one more picture fails, with Retry.
  - `AttachmentsTest`: a picture given up on is counted, and Retry starts its tries again.
  - `SyncStatusTest`: a failed pass is reported, but being offline or signed out is not; the last failure is a server error or an unreadable reply only. `SessionManagerTest`: every sign-out forgets the reports and the mirror's answer, also when unsent edits are kept. `BackgroundSyncTest`: a run that gave up is passed on. `NoteEditorControllerTest`: the page's errors are reported.
  - `SettingsScreensTest`: the home's Git mirror and Status rows.
- **Mutation checks:**
  - Sending without the scrub fails `aTitleOrFolderNameOrQuotedTextNeverLeavesThePhone`.
  - With `source` given its default again, `StatusApiTest`'s `anErrorReportNamesItsSourceAndIsNotChecked` fails.
  - Review of #93, B1: recording without the scrub fails 4 of `ErrorReporterTest`'s tests and `PhoneQueueTest`'s `theReporterScrubsWithTheNamesRoomHolds`.
  - Review of #93, S1: an open quote not scrubbed, escaped quotes as before, or the text cut before the scrub each fails `quotedTextOfEveryKindIsScrubbedBeforeTheTextIsCut`; the JSON reply kept fails `aJsonErrorNeverSendsTheReplyItQuotes`.

## After the review of #93

One blocker, four should-fix items and five nits, each with a regression test:

| Item | Fix | Tests |
| --- | --- | --- |
| B1. Titles could leak once Room no longer held them (after a sign-out and in again, a rename, another workspace) | Scrubbed when recorded, with names kept in memory from a Room flow, so the file only holds scrubbed text; the free text withheld until any names are known; sent after the pass, scrubbed again; the file emptied at every sign-out and when the cache is cleared (A427) | `aReportIsScrubbedWhenRecordedSoNamesGoneSinceStillNeverLeave`, `untilNamesAreKnownOnlyTheKindAndFramesAreKept`, `clearForgetsWhatWaits`, `theReporterScrubsWithTheNamesRoomHolds`, `clearingTheCacheForgetsReportsAndTheMirror`, `SessionManagerTest` |
| S1. Quoted text leaked when cut, escaped or left open, and in a JSON error's quoted reply | Scrubbed before the text is cut; straight and escaped quotes; an open quote runs to the end; `JSON input:` and what follows withheld (A427) | `quotedTextOfEveryKindIsScrubbedBeforeTheTextIsCut`, `aJsonErrorNeverSendsTheReplyItQuotes` |
| S2. The note's icon said Synced with a picture failed, and Waiting forever with kept edits | A failed-pictures state ("2 pictures failed") with Retry; kept edits do not count (A429) | `theNotesSyncState`, `failedPicturesShowInTheIconAndTheExplanationRetries`, `aNotesOwnCountsAreItsOwn` |
| S3. The mirror's last answer outlived the account | Kept with its workspace, and forgotten at sign-out and when the cache is cleared (A426) | `theMirrorKeptOfflineIsThisWorkspacesOnly`, `clearingTheCacheForgetsReportsAndTheMirror` |
| S4. Room queries, the names and the snackbar were untested | `PhoneQueueTest` against Room; the snackbar is `PicturesFailedNotice`, tested; the evidence now says what `NoteRoute`'s wiring leaves untested | `PhoneQueueTest`, `aPictureThatFailsInTheNoteIsSaidWithRetry` |
| N1. A background run that gave up for being offline was reported, nameless, by every process | Only for a server error or an unreadable reply, which it names; one like it waiting is not recorded again | `aBackgroundRunThatGaveUpNamesItsCauseAndIsReportedOnce`, `theLastFailureIsAServerFailureOnly` |
| N2. Status used Devices' words for a sign-in that cannot administer | "This phone's sign-in can't see backups and errors" | `aTokenThatCannotAdministerIsAskedToSignInAgain` |
| N3. An unused field | Removed | — |
| N4. The crash handler came after the graph | The reporter is made and installed before the graph is built, and connected to it after | `nothingIsSentUntilTheReporterIsConnected` |
| N5. Names in stack frames made them unreadable | Frames and exception class names are left alone; names match whole words only | `framesAndPartsOfWordsAreLeftAlone` |

The open question about the first tap on the dialog's Sync and storage was not looked into further: it was not reproduced.
