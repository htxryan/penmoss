# T40 P7b · The graph on Android

Evidence for the second half of T40's P7 ([issue #76](https://github.com/htxryan/penmoss/issues/76)), delivered in the same PR as [P7a](p7a.md):

- The global graph (LK7): Home ⋮ → **Graph**, every live note from Room coloured by its top-level folder, with the links between them.
- A note's local graph (LK8): the note's ⋮ → **Local graph**, 1 to 3 links deep.
- Touch: drag to pan, pinch to zoom, a tap shows a chip with the note's title, and a tap on the chip opens the note. **Find a note** brings a note to the middle. Past 1,500 notes the graph opens around the note edited last, with **Show everything**.

Decisions A478 and A479 are in [`decisions.md`](../../../decisions.md).

## How it was run

- **No emulator session.** As in P7a, the worker's AVD never boots for this session's user (no KVM permission). The Pixel checklist (in [`docs/android.md`](../../../android.md#test-the-graph-on-the-pixel-t40-p7b)) is for Ryan; the tests below cover what they can.
- **What covers it instead:**
  - Page tests (`@penmoss/android-editor`, `graph.test.ts`, 17) in happy-dom:
    - The contract both ways: every `graph-v1.json` example is read or written as given, the malformed ones are refused, and the answers use contract types only.
    - Nothing is posted but `ready` until both the notes and the scope arrive.
    - The layout of a fixture: the same nodes as the web's `buildGraph`, all inside the screen, no two on the same spot, with the canvas's TalkBack name.
    - The local graph at depths 1 and 3, the note near the middle, with its name.
    - A tap shows the chip (title, and an `aria-label` with links and folder in the web's words). Only the chip posts `open`, and a tap on empty space hides it.
    - A fingertip 10 px off a small node still hits it.
    - One finger pans and never taps. Two fingers zoom 2× and keep the note between them in place.
    - `focus` centres a shown note and ignores one that is not shown.
    - A title with markup stays text.
    - With no notes it says "No notes yet.".
    - When the notes change, the old positions are kept.
  - Kotlin `GraphProtocolTest` (5): the same contract from the app's side, the depths, and over-long titles and link lists cut rather than refused.
  - Robolectric model tests (`GraphInputTest`, 7):
    - Each note's group is its top-level folder, with the folders in the lists' manual and A–Z orders then the top level.
    - Untitled notes are named as in the lists, and a folder that is gone means the top level.
    - Only links between live notes are kept. A folder cycle stops.
    - The start: around the note asked for; past 1,500 notes, around the newest; at exactly 1,500, every note.
    - Search puts titles that start with the query first.
    - The count is in the web's words.
    - A burst of Room changes sends the graph once more, not once per change: the first at once, then the latest at most every 250 ms (review N5).
  - Robolectric store test (`GraphStoreTest`, 1): `observeGraph` reads live notes newest first, the links, the folders and the root's sort, with Trash left out.
  - Robolectric screen tests (`GraphScreenTest`, 11, using a fake page that records what it is sent):
    - Theme, then notes, then scope are sent once the page is ready, and all three again after a reload. A new note list is sent without the scope again.
    - From a note: local at depth 2, and the depth, All notes and Around chips. From Home: Around stays disabled until a note is picked.
    - A large vault starts around the newest note, with the notice and **Show everything**.
    - Search results lead to `focus` or re-centre the local graph, and "No notes match." shows when nothing does.
    - The page's `open` opens the note.
    - The graph waits while a note's WebView is alive, never makes a second, and holds the note's page back while it is alive.
    - When the renderer dies the screen says "Graph unavailable", and **Reload** makes a new page.
    - Home's menu has **Graph**, and the route carries the note it is around.
  - Full runs: see [Tests](#tests).

**Not checked by tests, so on the Pixel checklist:**

- Real finger gestures on a WebView canvas, and drawing itself (happy-dom has no 2D canvas, so drawing is skipped there and hit-testing is checked with layout positions).
- Frame rate with 2,000 notes.
- Theme colours on the canvas.
- Rotation keeping the scope.
- TalkBack reading the canvas and the chip.

## Tests

- **Page (`@penmoss/android-editor`, 131):** `graph.test.ts` (17).
- **Kotlin (`engine-bridge`):** `GraphProtocolTest` (5).
- **Robolectric (`app`):** `GraphInputTest` (7), `GraphStoreTest` (1), `GraphScreenTest` (11).
- **Full runs:** on the PR's head with P7a, P7b and the review fixes, on `main` at 6dfa435 (after P8): `task android:test` (902 JVM/Robolectric tests: 119 `engine-bridge`, 783 `app` — 0 failures), `task android:build`, `task check` (lint, typecheck, every node suite and the releases test: the page 178, the shared editor 479, desktop 88, web 338, the server in workerd 40 files and 656 tests) — all green.
- **Mutation checks** (each change made to the code alone, then reverted):

  | Change made to the code | What failed |
  | --- | --- |
  | A tap on a note opens it at once instead of showing the chip | `shows a note’s chip on a tap…`, `names the folder…`, `a fingertip near a small node…`, `keeps a title as text…` |
  | Pinch zooming about the wrong point | `pinches to zoom about the fingers, never tapping` |
  | No touch reach beyond a node's circle | `a fingertip near a small node still hits it` |
  | Depth 4 (or any number) accepted | `refuses malformed messages and other versions` |
  | A note's group is its own folder, not the top-level one | `coloursEachNoteByItsTopLevelFolderInTheListsOrder` |
  | No large-vault start | `opensAroundTheNoteAskedOrTheNewestPastFifteenHundredNotes`, `aLargeVaultOpensAroundTheNoteEditedLastWithShowEverything` |
  | The graph not waiting for a note's WebView | `waitsForTheNotesWebViewAndNeverMakesASecond` |
  | A search pick in a local graph focusing instead of re-centring | `searchBringsANoteToTheMiddleOrCentresTheLocalGraph` |
  | The scope sent before the notes | `sendsTheThemeTheNotesThenWhatToShowOnceThePageIsReady`, `aRendererThatDiesSaysSoAndReloadMakesAnother` |
  | Room's changes sent on unbatched (review N5) | `aBurstOfChangesSendsTheGraphOnceMoreNotOncePerChange` (every change of a burst laid out) |

## Deploy

No server change. The graph uses the `links` that P7a adds to `/sync/changes`, so it needs P7a's deploy (A477), which is part of the same PR.
