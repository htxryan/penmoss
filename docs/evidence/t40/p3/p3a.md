# T40 P3a · Trash and restore on Android

Evidence for the first half of T40's P3 ([issue #76](https://github.com/htxryan/penmoss/issues/76)):

- Move to Trash with Undo (NT12), from the note's menu and from a new long-press sheet in lists (NT10's sheet);
- the Trash screen (NT13);
- Restore (NT14);
- Delete for good after a confirm and BiometricPrompt (NT15, D34);
- the notice when a restore made a conflict copy (NT21).

The server gains `POST /api/notes/:id/trash`. Decisions A430–A434 are in [`decisions.md`](../../../decisions.md). Version history (NT16–NT20) is P3b.

## How it was run

- **Setup:**
  - the `penmoss36` emulator (API 36, 1080×2400) on the agent worker;
  - a local Worker (`wrangler dev --local`) with this branch's server, and the web app on Vite, as in P2;
  - a fresh local database, so the phone signed in again through the approval page (an Android sign-in, so with admin);
  - notes made with `POST /api/notes`;
  - screenshots scaled to 1080 px tall.
- **Sessions:** three under the shared lock, of 8, 2 and 1 minutes.
  - **The first** found two problems, both fixed:
    - **The Trash screen's messages never showed.** The screen cleared the message before showing it, which changed the key of the effect showing it and cancelled it. It is now cleared once shown. `aRestoreSaysSoAndOffersToOpenTheNote` clears it as the model does, and fails with the old order.
    - **The app's snackbar covered the lists' New note button.** It now sits above it.
  - **The second** re-ran Restore and Delete for good with the fix.
  - **The third** re-took the Undo snackbar above the button.
- **Wording changed after the second session:** the restore message now reads "It goes back where it was with the next sync." The old text, "to its folder", was wrong for a note at the top level. The screenshot shows the old text.
- **Offline:** as in P2b, the adb server was restarted to drop the tunnels to the local Worker, and port 8787 was reversed again to come back.
- **BiometricPrompt** is a secure window, so it was read with `uiautomator dump` and answered with `adb -e emu finger touch 1`.

## Walk-through

| Step | What happened | Screenshot |
| --- | --- | --- |
| The long press | A long press on "Seed order" in Home opens a sheet with its title, **Move to folder…** and **Move to Trash** (A432). | [p3a-note-actions](p3a-note-actions.png) |
| Move to Trash | The note leaves the list at once. "Moved “…” to Trash" shows with **Undo**, above the New note button. | [p3a-moved-undo](p3a-moved-undo.png) |
| Undo | Undo within 5 s, before a pass had sent the move: the note is back in the list, and no request was made. (Undo while the request is in flight queues a restore instead, A430; `TrashSyncTest` covers it.) Moved again and left: `POST /api/notes/…/trash 200`, and the server's Trash lists it. | [p3a-undone](p3a-undone.png) |
| From the note | "Tomato plan", ⋮ → **Move to Trash** (under Move to folder… and Tags…). The note closes and the snackbar shows on Home. | [p3a-note-menu](p3a-note-menu.png) |
| Trashed elsewhere | "Old shopping list" was moved to Trash through the new route from the host (`{"folderId":null,"deletedAt":…}`). | — |
| Trash | Home ⋮ → **Trash**. It lists the three notes newest first, each "Deleted 25 Oct, 4:25 AM · goes for good in 30 days", with **Restore** and **Delete for good** (A433). | [p3a-home-more](p3a-home-more.png), [p3a-trash](p3a-trash.png) |
| Restore | Restore "Tomato plan": "Restored “Tomato plan”…" with **Open**. `POST /api/notes/…/restore 200`, and the server's Trash no longer lists it. **Open** shows the note with its content, which the NoteDoc had kept all along (A431). | [p3a-restored](p3a-restored.png), [p3a-restored-open](p3a-restored-open.png) |
| Delete for good | "Delete “Old shopping list” for good?" names the note, says it cannot be restored on any device, and that the phone will ask for the fingerprint, face or screen lock. Then the prompt, "Penmoss is trying to delete a note for good.", answered with a fingerprint: `DELETE /api/notes/… 204`, and the note left the phone's and the server's Trash. In the second session, "Deleted “Seed order” for good." and "Trash is empty." | [p3a-delete-confirm](p3a-delete-confirm.png), [p3a-deleted](p3a-deleted.png) |
| Offline | Offline, a note moved to Trash shows in Trash as "Moved to Trash on this phone · not sent yet", with **Delete for good** off and "Offline: these are the notes this phone holds in Trash.". Sync and storage: "1 note moved to Trash or restored" (A430). | [p3a-trash-offline](p3a-trash-offline.png), [p3a-sync-storage](p3a-sync-storage.png) |
| Back online | Sync now: `POST /api/notes/…/trash 200`, "Nothing: Penmoss has everything made on this phone.", and the server's Trash lists the note. | [p3a-sync-storage-sent](p3a-sync-storage-sent.png) |

**Not walked through:**

- **Folders.** The local server has no REST route that makes a folder, so restoring into a folder, and into one deleted since, was not walked through. `TrashSyncTest` covers both through the real coordinator, filer and HTTP client, against the fake server.
- **The copy notice (NT21).** It needs a note's server copy restored while the phone holds edits to it. `TrashScreensTest` and `EditorPageServicesTest` cover it; the Pixel checklist says how to check it if it happens.

## Tests

- **Server, in workerd:**
  - `trash-route.test.ts` (8) checks that the route:
    - records the deletion and the folder as a device's would, and takes the note out of the tree;
    - lets a socket replica read the flag and the trash info;
    - lets `/restore` read the same folder back;
    - leaves the content readable from the NoteDoc;
    - tells an open socket at once;
    - is idempotent (the same answer twice, and `/api/trash` lists the note);
    - answers 409 `restored_since` to a request whose `knownSeq` predates a restore made by someone else, and 200 once it includes it;
    - never refuses one over the caller's own restore (Trash, Undo, Trash, with any `knownSeq`);
    - answers the index seq the change was made after: the row the phone had is not after it, and the next row is, deleted; `/restore` answers the same way, and `restored: false` for a note not in Trash;
    - finishes a deletion that left the note in the tree (deleted in its document, still filed);
    - answers 403 `insufficient_scope` to a read-only token, 404 `note_not_found` to an unknown note (`/restore` too), and 400 to a bad `knownSeq`, a body that is not a JSON object, broken JSON, or a bad id; no body at all is no precondition;
    - accepts an agent that may write;
    - answers a route it does not have with Hono's plain "404 Not Found", which is what a phone meets on a server from before the route.
  - `folder-scope.test.ts`: a token scoped to another folder gets 404 for the new route. `history.test.ts`: `/restore`'s reply.
- **Kotlin (`engine-bridge`):** `HttpPenmossApiTest`: a move to Trash sends `{"knownSeq":n}` and reads `seq`; `/restore`'s `restored` and `seq`; only a 404 "No such note" (`note_not_found`, or an older server's `not_found`) counts as a note gone, never a page that is not JSON or another message; `/sync/changes`' `seq`.
- **Robolectric (`app`):**
  - `TrashSyncTest` (22), through the app's real coordinator, engine, Room store, filer, Trash sender and HTTP client, against `FakePenmoss` (which now answers `/trash` and `/restore` as the server does):
    - a move to Trash made offline goes on the first pass online, after the note's own edits;
    - Undo before it is sent cancels it, and nothing is sent;
    - a restore after it was sent files the note back in its folder, or at the top level when that folder was deleted meanwhile;
    - a restore made elsewhere after the phone's request wins;
    - a note trashed here stays in Trash while the Mac edits it;
    - a restore of a note deleted for good meanwhile drops it;
    - a note only the server's Trash lists is restored, fetched and filed;
    - against a server without the route (its plain "404 Not Found"), the move waits, nothing is dropped, and the phone knows why until the route answers;
    - a 404 "No such note" to a move drops the copy; a 404 page that is not JSON (a proxy's) to a move or a restore drops nothing, and it goes on a later pass;
    - **in flight** (the fake server applies the request, then the test acts before it answers): Undo during a move to Trash ends with the note restored on the server, in its folder; Move to Trash during a restore ends with it in Trash, recorded in its folder;
    - Trash, Undo after it was sent, Trash again ends in Trash, never refused over the phone's own restore (the first review's skewed-clock runs are gone: nothing compares clocks);
    - **no answer** (second review): a move the server applied whose answer was lost, or answered 500, or that was in flight when the app stopped, then Restore, ends with the note restored on the server; a restore that never arrived, with Trash and Undo made while it travelled, is sent again; so is a move to Trash with Undo and Trash made while it travelled;
    - a note moved here and then trashed, and one made offline in a folder and trashed, are recorded in that folder and restored to it, as on the web.
  - `TrashStoreTest` (15):
    - a move to Trash, or a restore, holds through index rows from before the server's change (by seq, whatever their times say), and settles when a row agrees;
    - a row from after it wins, even with an older time;
    - Undo while the move is in flight queues a restore; Move to Trash while a restore is in flight queues a move, filed first;
    - a request a stopped pass left in flight, or one that failed, is queued again, and stays tried: only a request never tried is cancelled by Undo, Restore or Move to Trash, both after a failure and after a stopped pass;
    - a refused move is kept to say in the database, so a new store on it (the app started again) still says it once;
    - a move to Trash sends the seq the phone had seen when it was asked;
    - a move made here is filed before the move to Trash goes;
    - a restore from a folder the phone does not know is listed at the top level, but filed into that folder;
    - a move waits for the note's own edits;
    - repeated or unknown moves do nothing;
    - Trash is ordered newest first.
  - `TrashModelTest` (11), through the real client against MockWebServer with the phone's check answered in the test:
    - the phone's rows and the server's list merged, with the days left;
    - offline;
    - Restore cancels a waiting move without the server, and queues a sent one with a sync;
    - Delete for good asks `PURGE`, sends `DELETE /api/notes/:id` and drops the copy;
    - a refused check sends nothing;
    - a waiting move cannot be deleted for good;
    - 409, 404 and 403 `insufficient_scope` each say what happened; a 404 page that is not JSON keeps the copy;
    - leaving a note while it closes for Move to Trash still moves it (`trashAfterClosing`, on the app's scope);
    - `trashEntries` prefers the server's time and counts days;
    - against a server without the route, the row and Delete for good say why and point to Restore, and nothing is sent.
  - `TrashScreensTest` (12):
    - the rows and their actions, with Delete for good off for a waiting move or without admin;
    - the confirm, where Cancel sends nothing;
    - empty and offline;
    - the restore message with **Open**;
    - the long-press sheet;
    - Home's ⋮ → Trash;
    - the copy notice;
    - Undo within its time cancels the move, and otherwise the move stays and is sent;
    - a second move gets its own Undo at once, and the first stays in Trash;
    - the line about a server without the route;
    - signing out says Trash changes are kept.
  - `MigrationTest`: a schema 6 database opens at 8 with its Trash and nothing to send, and the first P3a build's schema 7 opens at 8 with its queued move; both read `/sync/changes` from the start again, which fills every note's seq.
  - `PhoneQueueTest` and `StatusScreensTest`: moves to Trash and restores not sent (in flight too) are counted from Room, and listed in Sync and storage, with why they wait on a server without the route.
  - `EditorPageServicesTest`: `onCopied` names the note the copy came from.
- **Mutation checks:**

  | Change made to the code | What failed |
  | --- | --- |
  | Server: without the `knownSeq` check | `refuses a request whose caller has not seen a restore made elsewhere` |
  | Server: without the caller's-own-restore exemption | `never refuses a request over the caller's own restore` |
  | Server: broken JSON read as `{}` | `needs the write scope, a known note and a well-formed request` |
  | Server: without `requireScope('write')` | `needs the write scope…` |
  | `updateMetadata` without its hold on `deleted` | `aMoveToTrashHoldsThroughAStalePage…`, `aRestoreHoldsThroughAStalePage…` |
  | `trashesDue` without "edits first" | `aMoveToTrashWaitsForTheNotesOwnEdits` |
  | B1: Undo during an in-flight move cancels it (5 treated as 1) | `undoWhileTheMoveToTrashIsInFlightEndsWithTheNoteRestoredOnTheServer`, `undoWhileTheMoveIsInFlightQueuesARestoreRatherThanCancelling` |
  | B1: Move to Trash during an in-flight restore cancels it (6 treated as 3) | `aMoveToTrashWhileTheRestoreIsInFlightEndsWithTheNoteInTrashFromItsFolder`, `aMoveToTrashWhileTheRestoreIsInFlightQueuesAMoveAndFilesFirst` |
  | S2: sending the latest seq instead of the one seen when asked | `aRestoreMadeElsewhereAfterThisPhonesMoveToTrashWins` (and the skew tests, since removed) |
  | S3: moves to Trash sent before the filer | `aNoteMovedHereThenTrashedIsRecordedInItsNewFolder`, `aNoteMadeOfflineInAFolderAndTrashedIsRecordedInThatFolder` |
  | S3: `trashesDue` not waiting for a move to file | `aMoveMadeHereIsFiledBeforeTheMoveToTrashGoes`, `aMoveToTrashWhileTheRestoreIsInFlightQueuesAMoveAndFilesFirst` |
  | The Trash screen clearing its message before showing it | `aRestoreSaysSoAndOffersToOpenTheNote` |
  | Any 404 dropping the phone's copy (second review) | `aServerWithoutTheTrashRouteLeavesTheMoveWaitingAndTheNoteKept`, `aNotFoundPageThatIsNotJsonLeavesTheMoveToTrashWaitingAndTheNoteKept` |

## After the review of #94

One blocker, three should-fix items and four nits, each with a test:

| Item | Fix | Tests |
| --- | --- | --- |
| B1. Undo or Restore while a request was in flight cancelled it, and the server's answer was then ignored | In-flight states (5, 6): Undo or Restore meanwhile queues a restore, Move to Trash meanwhile queues a move; failures and a stopped pass requeue (A430) | the four in-flight tests above, `aRequestLeftInFlightByAStoppedPassIsQueuedAgain` |
| S2. `restored_since` and settling compared the phone's clock with the server's | Seqs instead: `knownSeq` (the index seq the phone had seen when it asked), the NoteDoc's last restore's seq and actor, a caller's own restores never refusing; settling on rows after the seq the server answered; `/restore` answers `restored` and `seq`. The fake server's clock can be skewed (A430, A431) | the skew tests, the server's seq tests |
| S3. A note moved here, or made here, and then trashed was recorded in its old folder or the top level | Its move is filed first, and the move to Trash waits for it (A430) | the folder tests |
| S4. Every 404 waited, with no reason given | "No such note" drops the copy; "No such endpoint" waits (an answer the server never gives, as the second review found), and Trash, Sync and storage and Delete for good say why and point to Restore | `aMoveToTrashOfANoteTheServerDoesNotHaveDropsTheCopy`, `aServerWithoutTheTrashRoute…`, `aServerWithoutTheTrashRouteIsSaidWithTheWayOut`, `movesToTrashThatWaitForTheServerSayWhyAndTheWayOut` |
| Nit: a second Undo waited behind the first | The first snackbar is dismissed (A432) | `aSecondMoveToTrashGetsItsOwnUndoTimeAtOnce` |
| Nit: the page's last edits were not awaited | The note is closed first, which waits for them (A432) | `NoteEditorControllerTest.closingWaitsForThePagesLastEdits` (the wiring in `NoteScreen` is untested) |
| Nit: broken JSON was read as no precondition | 400 (A431) | `needs the write scope…` |
| Nit: the sign-out toast left Trash out | "…moves, Trash changes, captures…" | `signingOutSaysTrashChangesAreKept` |
| A refused move was silent | "“X” was restored on another device, so it was left out of Trash." once, on the app's snackbar | `aRestoreMadeElsewhereAfterThisPhonesMoveToTrashWins` (the notice), `aServerWithoutTheTrashRouteIsSaidWithTheWayOut` (the words) |
| A431 claimed a retry finishes the unfiling, untested | Tested | `finishes a deletion that left the note in the tree` |

A fourth emulator session (4 minutes, a fresh install signed in again) checked the fixes against the branch's real server, not the fake one:

- **Trash, Restore, Trash again:** "Tomato plan" was moved to Trash, restored from Trash, and moved to Trash again. The log shows `POST …/trash 200`, then `POST …/restore 200`, then `POST …/trash 200`: never refused over the phone's own restore.
- **A restore elsewhere:**
  1. "Pear tart" was made on the server, and the phone synced it.
  2. Offline, the phone moved it to Trash.
  3. From the host, the note was moved to Trash and restored as another device (`{"folderId":null,"restored":true,"seq":1}`).
  4. Back online, the phone's request got `409 Conflict`. The note stayed in Home, and the snackbar said "“Pear tart” was restored on another device, so it was left out of Trash." ([p3a-refused](p3a-refused.png)).

The rest of the walk-through was not repeated, since its screens are unchanged. Two exceptions, both covered by tests: the waiting rows' reason against an undeployed server, and a second snackbar replacing the first.

## After the second review of #94

One blocker, two should-fix items and four nits:

| Item | Fix | Tests |
| --- | --- | --- |
| B1. A request that got no answer (offline mid-request, a 5xx, the app stopped) went back to "not sent", and Undo or Restore then cancelled it, though the server may have applied it | `trashTried` (schema 8): set when a request goes out, kept when it is queued again, cleared only by an answer. Only a request never tried is cancelled; otherwise the opposite request is queued (both routes are idempotent: one extra request) (A430) | the five **no answer** sync tests, `onlyARequestNeverTriedIsCancelled`, `aRequestLeftInFlightByAStoppedPassIsNeverCancelledLater` |
| S1. Notes unchanged since the upgrade kept seq 0, so their moves to Trash were refused over a restore the phone had seen | Schema 8's migration clears the changes clock: the next pass reads every row again and fills each seq (A430) | both `MigrationTest` cases above |
| S2. Any 404 other than "No such endpoint" dropped the phone's copy | Only "No such note" does: `note_not_found` from the Trash routes, or an older server's `not_found`. Any other 404 waits for a later pass; to a move to Trash it is said as a server that cannot take it yet. Delete for good keeps the copy on such a 404 too (A430, A431, A433) | `aNotFoundPageThatIsNotJson…` (move, restore, Delete for good), `aNotFoundPageThatIsNotJsonSaysNothingOfTheNote` |
| Nit: refusals were held in memory | Kept on the note's row (`trashNotice`), said once by the app's snackbar, also after a background pass (A430) | `aRefusedMoveToTrashIsKeptToSayEvenAfterTheAppStopped` |
| Nit: Back while the note closed dropped the move | Launched on the app's scope (`trashAfterClosing`, A432) | `leavingANoteWhileItClosesForTrashKeepsTheMove` (the helper; `NoteScreen`'s call to it is not under test) |
| Nit: schema 7 was changed in place | Schema 7 is back to what 5b85fea shipped, and schema 8 adds the new columns by auto-migration, so a device with that build upgrades | `aT40P3aBuildsSchema7Opens…` |
| Nit: decorative clock-skew settings | Removed from `FakePenmoss` and `TrashSyncTest`; one Trash, Undo, Trash test is kept | `trashUndoTrashIsNeverRefusedOverThePhonesOwnRestore` |
| Nit: a row at the restore's own seq may already show it | Documented in A431: it errs towards refusing, and a later move goes once the next row arrives | none |

Found while fixing S2: the server never answers "No such endpoint". `api.notFound` is not reached through `app.route('/', api)`, so a route the server does not have answers Hono's plain "404 Not Found". So the first review's "No such endpoint" check never matched a real server: a phone on 99b5440 against a server from before the route would have dropped its copy of every note moved to Trash. Now that answer leaves the move waiting with the reason shown, and `trash-route.test.ts` pins what the server answers. `FakePenmoss` answers the same.

Mutation checks, each run against the Trash sync, store and migration tests:

| Change made to the code | What failed |
| --- | --- |
| B1: Move to Trash cancels a restore that was tried | `onlyARequestNeverTriedIsCancelled`, `aRequestLeftInFlightByAStoppedPassIsNeverCancelledLater`, `aMoveToTrashThatNeverArrivedWithUndoAndTrashMeanwhileIsSentAgain` |
| B1: Restore cancels a move that was tried | the two store tests, `aRestoreThatNeverArrivedWithTrashAndUndoMeanwhileIsSentAgain`, `aMoveToTrashWhoseAnswerWasLost…`, `aMoveToTrashAnsweredWithAServerError…`, `aMoveToTrashInFlightWhenTheAppStopped…` |
| B1: queued again without `trashTried` | `onlyARequestNeverTriedIsCancelled`, `aMoveToTrashWhoseAnswerWasLost…`, `aMoveToTrashAnsweredWithAServerError…` |
| S2: any 404 to a move to Trash drops the copy | `aServerWithoutTheTrashRoute…`, `aNotFoundPageThatIsNotJsonLeavesTheMoveToTrashWaitingAndTheNoteKept` |
| S2: any 404 to a restore drops the copy | `aNotFoundPageThatIsNotJsonLeavesTheRestoreWaitingAndTheNoteKept` |
| S1: the migration without clearing the changes clock | both `MigrationTest` cases |

No emulator session this round: the screens are unchanged, and the changes are in what the phone stores and sends, which the tests above exercise against the fake server.

## Deploy

The server route needs a deploy. Until then, a move to Trash from the phone gets the server's plain "404 Not Found" and waits: the note stays in the phone's Trash, Trash and Sync and storage say Penmoss can't take it until its server is updated (Restore keeps the note), and it goes with the first pass after the deploy (`aServerWithoutTheTrashRouteLeavesTheMoveWaitingAndTheNoteKept`). Each pass tries again meanwhile. The Pixel checklist is in [`docs/android.md`](../../../android.md#test-trash-on-the-pixel-t40-p3a).
