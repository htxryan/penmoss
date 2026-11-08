# T40 P7a · Links, embeds, backlinks and deep links on Android

Evidence for the first half of T40's P7 ([issue #76](https://github.com/htxryan/penmoss/issues/76)); the graph page is P7b:

- `[[Title#` heading completion (LK2) and a link opening at its heading (LK3).
- Live note embeds `![[Title]]` and `![[Title#Heading]]` (LK4).
- Backlinks with the text around each link (LK5) and unlinked mentions (LK6), in an Info sheet (NT23) with the note's details, tags and frontmatter.
- `penmoss://note/<id>` and `penmoss://capture` deep links (PL5).
- Server: each note's `links` in `/sync/changes`.

Decisions A470–A477 are in [`decisions.md`](../../../decisions.md); A478–A479 are kept for P7b.

## How it was run

- **No emulator session.** As in P3b–P5, the worker's AVD never boots for this session's user (no KVM permission), so the Pixel checklist (in [`docs/android.md`](../../../android.md#test-links-embeds-backlinks-and-deep-links-on-the-pixel-t40-p7a)) is for Ryan, and the flows it checks are covered by the tests below.
- **What covers it instead:**
  - D1 cost in workerd (`perf/sync-changes-links.d1.perf.ts`, run with `perf:d1`): a 1,001-row `/sync/changes` page on a 5,000-note vault with 3 links each reads 5,006 D1 rows, and the last 10 changes 50. The first version of the query read 15,016,002: SQLite, with no statistics, looked each row's links up through `links_target` (workspace, target) and so read every link in the workspace per row. The query works out links after the `LIMIT`, and the conditions on `target_note_id` carry a unary `+`, so the planner takes the primary key with no hint and no reliance on its index's name; `android-links.test.ts` asserts that plan in `task check` (A473).
  - Server route tests in workerd (`android-links.test.ts`, 4): `links` in `/sync/changes` are the distinct sorted ids a note links to or embeds, never itself or an unresolved title; none for a note in Trash; kept in step as the note is edited (one replica edited to drop its first link and link another gives exactly the other, and renaming that target keeps it); each row's links read through the primary key (`EXPLAIN QUERY PLAN`).
  - Page tests (`@penmoss/android-editor`, `links.test.ts`, 16) through the real shared editor in happy-dom: headings from another note's stored updates; one request for several readers and a fresh read after 5 s; a body no embed shows dropped after 5 s, and at most 16 kept; `missing`, `tooLarge` and a request that never answers all give no body; updates that build on rows not sent give no partial note; the open note read from its own document; an embedded section rendered from stored updates and rendered again on `noteChanged`; a self-embed and a cycle through another note shown as links; a missing note's notice; a watch let go 2 s after its last embed; `openNote` with the heading; `showHeading` scrolling and marking for 2 s; `noteInfo` fields, links, kind, period and tags, sent at most every 300 ms and only when changed. The contract suite reads every new `bridge-v1.json` example both ways, as Kotlin's `BridgeProtocolTest` does.
  - Desktop (`deep-links-contract.test.ts`, 3): the Mac's `parseDeepLink` against `contract/deep-links-v1.json`, which Kotlin's `DeepLinksTest` (3) also reads.
  - Kotlin (`engine-bridge`): `BacklinksTest` (4: grouping per note with each block once, malformed parts and rows dropped, mention marks, link labels as the web's), `DeepLinksTest` (3), `BridgeProtocolTest` (the new messages, malformed and oversized ones refused).
  - Robolectric store tests (`LinksStoreTest`, 9) through the real Room store: the index's links fill `note_links` and a later row replaces them; an older server's rows leave them; a note with unsent edits keeps the page's links; linking notes newest first and only while live; purge and sign-out forget links and the cached backlinks, and a purge the links to the purged note; the cache replaced on each load; the content stamp moving with what the page reads.
  - Robolectric bridge tests (`LinkedNotesTest`, 14): answers with exactly what an open would send (synced and pending, never the conflict copy); fetches a note the phone lacks; `missing`; `tooLarge`; `noteChanged` when a watched note's rows move and not after unwatching, and for a change between the answer and the watch, but not for what was just answered; a watched note the server changed fetched while in front; at most eight followed with the ninth waiting a turn; a reloaded page starts with nothing watched; `openNote` with and without a heading; `showHeading` once after `opened` (not again on a reopen); a heading link into the open note scrolls there rather than opening it again; the open note's details kept and its own links stored.
  - Robolectric UI tests (`NoteInfoTest`, 10): the details in the web's words; the phone's links laid over the server's lists, and a recent note's removed link taken out of them, with the recent notes from the store; where the backlinks came from; context with link titles and bold for this note; online load, cache and offline read; the Info button's badge and TalkBack text; the sheet's sections and taps opening notes; the empty texts.
  - Robolectric deep-link tests (`DeepLinkTest`, 3: the merged manifest's filters, VIEW only, a held link replaced by a later one), `DeepLinkActivityTest` (4, through `MainActivity` with a stand-in note page: a held link opens the note once signed in, and after the activity is recreated; a second link to the note in front opens no other screen; `penmoss://capture` sent to the app is not read as a sign-in), `CaptureActivityTest` (+2: a capture link opens the sheet empty, reading neither its query nor `EXTRA_TEXT`; any other link closes it saving nothing), `NavigationTest` (+1: the note route carries the heading), `MigrationTest` (+1: schema 13 (P8's) opens as 14 and the next pass reads every note's links again; schema 14 generated).
  - Robolectric note-screen wiring (`NoteRouteWiringTest`, 3, through the app with a stand-in page): the page's `noteContent` is answered on its channel; the Info button's description counts a link Room gets from the index; the sheet's Length row says the page's `counts` and its Saved row the sync icon's words (P8's counts, added here as P7 merges after P8).
  - Full runs: see [Tests](#tests).

## Walk-through (by test, against the canned servers)

| Step | What happens |
| --- | --- |
| Heading completion | `[[Garden#` asks `noteContent` for Garden; Kotlin answers with its stored updates (`answersWithTheStoredUpdatesAnOpenWouldSend`), fetching it first when the phone lacks it (`fetchesANoteThePhoneLacksAsOpeningItWould`); the page lists its headings (`lists a linked note’s headings…`). |
| Heading links | A tap on `[[Garden#Paths]]` sends `openNote { noteId, heading: "Paths" }` (`opens a link at its heading through the app`); the app opens `note/<id>?heading=Paths` (`aNotesRouteCarriesTheHeadingALinkNamed`) and sends `showHeading` once the note is shown (`scrollsToTheHeadingItWasOpenedAtOnceTheNoteShows`); the page scrolls and marks it for 2 s (`scrolls to the heading the app names…`). |
| Live embeds | `![[Garden#Beds]]` renders the section; when Garden's stored rows move (a sync or this phone), `noteChanged` comes and the embed renders again (`renders an embedded section…`, `saysWhenAWatchedNoteChangesAndStopsWhenUnwatched`). Another device's edit to a watched note is fetched within the open note's poll (`fetchesAWatchedNoteTheServerChangedWhileTheAppIsInFront`). Self-embeds and cycles show as links; a note the phone cannot get says so. |
| Info sheet | The top bar's Info button carries the number of notes linking here (`theInfoButtonSaysHowManyNotesLinkHere`); the sheet lists Folder, Created, Edited, Kind, tags, frontmatter, then Backlinks with linked and unlinked mentions, and a tap opens that note (`theSheetShowsDetailsTagsFrontmatterAndBacklinksAndOpensThem`). |
| Offline | The last answer read is shown with when it was read; with none, the phone's own links by title (`loadsOnlineCachesAndReadsTheCacheOffline`, `theSheetSaysWhereTheBacklinksCameFrom`). A link typed offline shows at once and survives an older index row (`aNoteWithEditsNotSentKeepsTheLinksThePageReported`, `thePhonesOwnLinksAreLaidOverTheServersLists`). |
| Deep links | `penmoss://note/<ULID>` opens the note (held until signed in, across a rebuilt activity too), not again over itself; `penmoss://capture` opens the sheet empty; anything else is ignored (`DeepLinksTest`, `deep-links-contract.test.ts`, `DeepLinkTest`, `DeepLinkActivityTest`, `CaptureActivityTest`). |
| Older servers | Without `links` in `/sync/changes`, Room keeps what it has (`anOlderServerSendsNoLinksAndLeavesWhatThePhoneHas`): the badge and offline backlinks show the phone's own links; online backlinks, embeds, headings and deep links use routes that are old. |

**Not walked through on a device:**

- **Scrolling and the 2 s mark on a real WebView**: happy-dom checks the `scrollIntoView` call and the class; the Pixel checklist checks the motion.
- **An embed's IntersectionObserver**: happy-dom has none, so the shared editor treats every embed as on screen (its own fallback); watching only visible embeds is checked by hand.
- **A link from another app**: the merged manifest's filters are read in `DeepLinkTest` and the intents are handed to the activities, but Android's own chooser is checked on the Pixel.

## Tests

- **Server (workerd):** `android-links.test.ts` (4); `perf/sync-changes-links.d1.perf.ts` (D1 rows read, outside `task check`).
- **Page (`@penmoss/android-editor`, 114 before P7b):** `links.test.ts` (16), `host.test.ts` (one exact-sequence test widened to the new `noteInfo` message), `contract.test.ts` (the new fixtures both ways).
- **Desktop:** `deep-links-contract.test.ts` (3).
- **Kotlin (`engine-bridge`):** `BacklinksTest` (4), `DeepLinksTest` (3), `BridgeProtocolTest` (new messages).
- **Robolectric (`app`):** `LinksStoreTest` (9), `LinkedNotesTest` (14), `NoteInfoTest` (10), `DeepLinkTest` (3), `DeepLinkActivityTest` (4), `NoteRouteWiringTest` (3), `CaptureActivityTest` (+2), `NavigationTest` (+1), `MigrationTest` (+1).
- **Full runs:** `task android:test` (774 JVM/Robolectric tests: 110 `engine-bridge`, 664 `app` — 0 failures), `task android:build`, `task check` (lint, typecheck, every node suite and the releases test: the page 114, the shared editor 463, desktop 61, web 335, and the server in workerd, 40 files and 646 tests) — all green, on P5's reviewed head. `MigrationTest`'s schema 11 test now expects the changes cursor started again: schema 12 leaves it, and schema 14, which an 11 database also passes through, clears it (A473). An earlier full run had one failure in `NoteFilerTest`: a query from a `LinkedNotesTest` controller still running when its test closed the database surfaced in the next `runTest`; the new tests now wait for their coroutines before closing it (`cancelAndJoin`), and the run above is after that fix.
- **Mutation checks:**

  | Change made to the code | What failed |
  | --- | --- |
  | `bodyOf` without the pending-structs check | `reads no partial note…` (a partial note would render) |
  | `LinkedNotes.body` without joining a request already asked | `asks once for several readers of one note…` (one `noteContent` per reader) |
  | `showHeading` matching case and outer spaces exactly | `scrolls to the heading the app names and marks it for a moment` |
  | `CHANGES_SQL` without the `+` on `target_note_id` (SQLite's own pick) | `reads each row’s links through the primary key…` (the plan names `links_target`); `sync-changes-links.d1.perf.ts` (15,016,002 rows read, over its 10,010 bound) |
  | The indexer never deleting a note's old links | `keeps the links in step with the note as it is edited` (`[first, second]` for `[second]`), `sends no links for a note in Trash` |
  | `/sync/changes` without `target_note_id != notes.id` | `lists the distinct, sorted notes each note links to or embeds` (a note listed as linking to itself) |
  | `saveChanges` replacing links while the note has unsent edits | `aNoteWithEditsNotSentKeepsTheLinksThePageReported` (an older index row takes the offline link away) |
  | The watch without `drop(1)` (what was read counted as a change) | `saysWhenAWatchedNoteChangesAndStopsWhenUnwatched` (a `noteChanged` for what was just read: every embed renders twice) |
  | No cap on followed notes | `followsAtMostEightNotesAndTheNextWaitsForATurn` (nine followed) |
  | `showHeading` sent on every `opened` | `scrollsToTheHeadingItWasOpenedAtOnceTheNoteShows` (a restore jumps back to the heading) |
  | `backlinksView` without the phone's own links | `thePhonesOwnLinksAreLaidOverTheServersLists`, `loadsOnlineCachesAndReadsTheCacheOffline` (a link made on the phone missing until the server indexes it) |
  | `DeepLinks` taking any id, not only a ULID | `ignoresEverythingElse` (`penmoss://note/not-a-note` opens a note route) |

## Review fixes (PR #102)

Each should-fix and the cheap nits, with the test that failed first (a fix's test run before the fix, or the fix undone afterwards):

| Item | Fix | Failing first |
| --- | --- | --- |
| S1 | The held note link is kept in `MainActivity`'s saved state; note screens build their page through `NotePages`, so `DeepLinkActivityTest` drives the activity with a stand-in page | `aLinkHeldWhileSignedOutOutlivesTheActivity` failed before the fix (`[]`). Undoing `PenmossRoot`'s link effect fails three of its four tests; navigating without the note-in-front check fails `aSecondLinkToTheNoteInFrontOpensNoOtherScreen`; dropping the `host != "auth"` guard fails `aCaptureLinkSentToTheAppIsNotASignIn` |
| S2 | The edit test changes one replica: its first link deleted, another added, the target renamed | With the indexer never deleting old links, it fails with `[first, second]` for `[second]` |
| S3 | `backlinksView` drops the server's entry for a recent note (edits not sent, or links changed on the phone in the last minute) unless Room still has its link | `aNoteEditedHereToRemoveItsLinkLeavesTheServersList` and `theModelTakesRecentNotesFromTheStore` failed against a stub |
| S4 | A heading link into the open note sends `showHeading` | `aHeadingLinkToTheOpenNoteScrollsThereInsteadOfOpeningItAgain` failed before the fix |
| S5 | The page drops an unwatched body after 5 s, and keeps at most 16 | `keeps a note no embed shows only for a few seconds, and only a few such notes` failed before the fix |
| S6 | No `INDEXED BY` and no `DISTINCT`; a unary `+` on both `target_note_id` conditions; the plan asserted in `android-links.test.ts` | Without the `+`, the plan test fails (`links_target`) and the perf test reads 15,016,002 rows; with it, 5,006 |
| S7 | `NoteRouteWiringTest` through the app with a stand-in page | Removing `linked.onPageMessage` fails `thePagesAskForAnotherNoteIsAnsweredOnItsChannel`; a badge of 0 fails `theInfoButtonCountsTheNotesRoomSaysLinkHere` |
| N2 | A purge tombstone also deletes the phone's links to the purged note | `aPurgedNoteIsLinkedFromNowhere` failed before the fix |
| N3 | A470 names the `tooLarge` wording gap | — (docs) |
| N4 | A comment on `GraphScreen`'s stand-in branch | — (comment) |
| N5 | Room's changes reach the graph at most every 250 ms after the first | With the batching undone, `aBurstOfChangesSendsTheGraphOnceMoreNotOncePerChange` fails |
| N6 | The capture-link test also puts `EXTRA_TEXT` on its VIEW | With `draftOf` reading a VIEW's `EXTRA_TEXT`, `aCaptureLinkOpensTheSheetEmptyReadingNothingFromTheLink` fails |
| N7 | `LinkedNotes` reads the note's stamp before each answer; a watch starting past it says `noteChanged` | `aChangeBetweenTheAnswerAndTheWatchIsStillSaid` failed before the fix |
| N8 | The checklist says "read" Garden's id | — (docs) |
| P8 counts | After P8 merged, the Info sheet gains Saved and Length rows from `controller.tools.counts` and the sync state, as the web's panel | `theInfoSheetSaysTheNotesLengthAsThePageCountedIt` failed before the rows (no Length row) |
| N9 | The PR body says "a 1,001-row page on a 5,000-note vault" | — (PR body) |

N1 (pinning that schema 12 alone leaves the changes cursor) is left: it needs `room-testing`'s `MigrationTestHelper`, which the app does not use yet.

## Deploy

This slice has a server half: `links` in `/sync/changes`. **Deploy before the Pixel checklist in [`docs/android.md`](../../../android.md#test-links-embeds-backlinks-and-deep-links-on-the-pixel-t40-p7a)** (A477).
