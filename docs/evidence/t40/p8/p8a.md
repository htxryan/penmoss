# T40 P8a · Editor parity on Android

Evidence for the first part of T40's P8 ([issue #76](https://github.com/htxryan/penmoss/issues/76)):

- Copy as Markdown and Copy as rich text, from the note's ⋮ menu and the selection menu (ED9), and the code block's Copy button through the same clipboard (ED7);
- Penmoss's own Paste as plain text in the selection menu (ED11);
- View Markdown source (ED17) and Find in note, with Ctrl+F (ED18);
- the format bar's **+** sheet (the slash catalogue) and **Block** menu (Move up, Move down, Turn into…, Duplicate block, Delete block; ED3, ED4, ED5, _adapted_ from the drag handle);
- headings 4–6, and the table and code buttons (ED4, ED6, ED7);
- toggles remembered per note in Room (ED8, schema 13);
- counts and the save status in words (NT24, _adapted_ from the status bar), and the Pixel check for pictures on their own line (ED22).

No server half. Decisions A480–A485 are in [`decisions.md`](../../../decisions.md). Files and pictures from web addresses (ED12, ED13) follow in P8b.

## How it was run

- **No emulator session: blocked on KVM**, as in P3b–P5: the worker's AVD exists but this session's user has no KVM permission. The Pixel checklist in [`docs/android.md`](../../../android.md#test-the-editor-tools-on-the-pixel-t40-p8-part-one) is for Ryan, and the flows are covered by the tests below.
- **What covers it instead:**
  - Page tests (`parity.test.ts`, 22): the whole-note Markdown copy carries the web's frontmatter (`id`, `title`, `created`, `tags`); a selection copies only itself, as HTML with readable text for rich text; an empty selection copies the note; a read-only note copies; the code block's Copy goes to the app as `format: text`; `insertPlain` keeps the marks at the caret and refuses a read-only note; the source view shows the frontmatter and body, blocks inserts while shown, follows a remote title change, and goes when the note closes; the + catalogue ranks "tab" → Table first, keeps the slash menu's order, hides File, offers inline blocks only in a cell and nothing to turn into there; Turn into marks the current kind and turns into a heading and a toggle; Move up/down, Duplicate and Delete; the state's `canMoveUp`, `canMoveDown`, `canTurnInto`, `inTable`, `inCode`; Next cell (a new row from the last cell), Previous cell, Add row, Add column; Heading 5 runs and shows on; Indent/Outdent in code; toggles open as the app's `folds` say, and a change reports every kept toggle; folds for another note are ignored; counts after 400 ms (not before), and the selection's after 150 ms.
  - Shared editor tests (`@penmoss/editor`): Duplicate block and Delete block (`block-move.test.ts`, +5: caret in the copy, a whole list, one undo step, the last block, the only block, dry runs); `pastePlainText` equals ⌘⇧V's paste (`clipboard.test.ts`, +3); the code block's Copy through a native writer (`code-block.test.ts`, +1).
  - The contract (`bridge-v1.json`): `copy`, `insertPlain`, `source`, `blocks`, `insert`, `turnInto`, `block`, `folds` (to the page), `clipboard`, `blocks`, `folds`, `counts` (from the page), seven new format commands and five state fields, with 19 malformed examples, read both ways by `contract.test.ts` and Kotlin's `BridgeProtocolTest`.
  - Robolectric (`NoteToolsTest`, 10): the note's toggles are sent right before `open` and each change is stored; none kept sends none; a reloaded page gets the reported toggles; an unreadable row opens anyway; copy and paste wait for the note, the paste is capped at a million characters, an empty clipboard says so; the page's clipboard payload reaches the screen; the source resets on a reload; the + sheet's, Turn into's and the Block menu's messages; the counts' labels in the web's words; the bar state's new fields.
  - Robolectric (`SelectionMenuTest`, 11): against a fake menu with Chromium's ids (its own for Cut, Copy, Share and Select all; the framework's for Paste and Paste as plain text), the selection menu gains Copy as Markdown and Copy as rich text after Copy, found by the system's word for it (a German "Kopieren" too), or at the end when no Copy is found but text is selected, and Penmoss's Paste as plain text in place of the system's, once each across repeated prepares; a caret's menu gets no copies; the page is told to keep the selection each time the menu shows, before any action; our items reach the note and finish the mode, the WebView's go to it; no paste on a read-only note; Ctrl+F (not Ctrl+Shift+F) opens find; rich text is `text/html` with its text, Markdown plain text; a copy Binder refuses falls back to its text, or says it is too much; the copied confirmation only below Android 13; HTML on the clipboard pastes as its text, and a file's URI is not text. Whether the Pixel's real WebView shows the items is checklist step 2.
  - Robolectric Compose (`EditorToolsTest`, 10): the find bar counts "1 of 12", steps, closes, and clears its highlights when it goes; the insert sheet searches through the page and ignores an older search's answer; Turn into marks the current kind and says when nothing applies; the bar's +, Block menu (Move up off at the top) and table buttons; headings 4–6 in the text-style menu, and no + or Block without the tools; the ⋮ items and their wording; Word count in the web's words.
  - `MigrationTest` (+1): a schema 12 database opens at 13 with no toggles kept, and keeps and drops them.
  - Full `task check` (lint, typecheck, every package's unit tests: the editor page 118, `@penmoss/editor` 472, the server in workerd 642) and `task android:test` (750 JVM and Robolectric tests: 647 app, 103 engine-bridge; 0 failures; and the instrumented tests assembled) — all green.

## Walk-through (by test, against the page and the Robolectric screens)

| Step | What happens |
| --- | --- |
| Copy note | ⋮ → **Copy note as Markdown**: the page runs the shared `copyNoteAs('markdown')`, whose native writer posts `clipboard { format: markdown, text }` (frontmatter and body, the web's payload); Kotlin writes `ClipData.newPlainText`. **Copy note as rich text**: `clipboard { format: rich, text, html }` → `ClipData.newHtmlText`. Android 13+ confirms itself. |
| Copy a selection | Select text: the floating menu shows Copy, then **Copy as Markdown** and **Copy as rich text** (`SelectionMenu`); each sends `copy { scope: selection }` and finishes the menu. |
| Paste as plain text | The selection menu's **Paste as plain text** is ours: Kotlin reads the clipboard's text (HTML coerced to text) and sends `insertPlain`; the page pastes it as ⌘⇧V does. Read-only notes do not offer it. |
| Source | ⋮ → **View Markdown source**: the editor hides, a `note-source` view shows the codec's markdown with frontmatter, following edits; the format bar goes; ⋮ → **View note** brings the editor back. |
| Find | ⋮ → **Find in note** or Ctrl+F: the bar under the top bar finds through `findAllAsync`; "3 of 12", ↑, ↓, ✕; Back closes it. |
| + sheet | **+** opens the slash catalogue as a sheet; each search asks the page (`blocks`), which filters and ranks as the slash menu does; a tap inserts (`insert`). |
| Block menu | **Block** → Move up, Move down, Turn into… (the sheet with the kinds, current marked), Duplicate block, Delete block: shared commands, one undo step each. |
| Tables and code | In a table: Previous cell, Next cell, Add row, Add column on the bar. In code: Indent and Outdent are Tab and Shift+Tab. The text style menu has H1–H6. |
| Toggles | Collapse a toggle and reopen the note: still collapsed (Room's `folds`, sent before `open`). Sign-out clears them with the cache. |
| Counts | ⋮ → **Word count**: words, characters, reading time and the selection's counts; the sync icon's long press says the save status. |

**Not walked through on a device:**

- **The WebView's real floating menu.** `SelectionMenu` is tested against a callback that fills the menu as Chromium does (create and prepare); the Pixel checklist checks the extra items survive the Pixel's WebView version (the ⋮ menu is the fallback, A480).
- **`findAllAsync` itself**: the bar is tested against a fake target; the Pixel checklist finds in a long note.
- **The typing protocol** (`TypingInstrumentedTest`): assembled, to be run on the Pixel (checklist step 14).

## Tests

Counts are for the whole PR, both parts; [part two's evidence](p8b.md#tests) has the totals.

- **Page (`@penmoss/android-editor`):** `parity.test.ts` (35, new; 22 before the review, 32 before the re-review), and the contract suite reading every new example both ways.
- **Shared editor (`@penmoss/editor`):** `block-move.test.ts` (+5, and the pending-update path exercised after the review), `clipboard.test.ts` (+3), `code-block.test.ts` (+1). The web's word counts now come from `@penmoss/editor/stats`, and its frontmatter from `@penmoss/editor/note-fields`; its own tests pass unchanged.
- **Kotlin (`engine-bridge`):** `BridgeProtocolTest` over the grown contract.
- **Robolectric (`app`):** `NoteToolsTest` (16), `SelectionMenuTest` (11), `EditorToolsTest` (11), `MigrationTest` (+1).
- **Mutation checks:**

  | Change made to the code | What failed |
  | --- | --- |
  | Page without the `foldState` it is given | `opens toggles as the app says this phone left them, and reports each change` |
  | Page dropping `html` from the clipboard message | `copies the selection as rich text: HTML and readable text, no frontmatter` |
  | Page's + sheet over every block, not `availableBlockItems` | `lists the slash menu's blocks…`, `offers only inline blocks in a table cell…` |
  | `SelectionMenu.amend` keeping the system's Paste as plain text | `addsTheCopiesAfterCopyAndPutsItsOwnPasteAsPlainText`, `offersNoPasteOnANoteThatCannotChange…` |
  | `NoteClipboard.clipData` always plain text | `writesRichTextAsHtmlWithItsTextAndTheRestAsPlainText` |
  | The controller not sending the toggles before `open` | `sendsTheNotesTogglesRightBeforeItOpensAndKeepsEachChange`, `aReloadedPageGetsTheTogglesItReportedAgain` |


## Review fixes

The review of [PR #101](https://github.com/htxryan/penmoss/pull/101) found two blockers and six should-fix items. Each fix was proved by putting the old behaviour back and watching the named test fail.

| Finding | Fix |
| --- | --- |
| B1: Chromium's Copy has its own id, so the copies never appeared | `SelectionMenu` finds Copy by `android.R.id.copy` or by the menu's own word (any language), and otherwise puts the copies at the end; a selection is known by Cut, Share or Web search too. The tests use Chromium's ids. |
| B2: the items acted on the body whatever was selected, after the WebView cleared it | Each time the menu shows, the app sends `captureSelection`; the page keeps the body's selection (mapped through later edits), or the title or callout field and its range, or the source's text. Copy as and Paste as plain text act on that, once, for that note only; with nothing selected, Copy says "Select some text to copy" and never copies the whole note. |
| S1: toggle saves could land out of order | One collector saves the newest toggles; overlapping saves keep the last. |
| S2: a large copy could crash the app; the snackbar held up later copies | `NoteClipboard.write` catches Binder's limit, falls back to plain text, and otherwise says the copy is too large; Android 12 and below get the snackbar in its own coroutine. |
| S3: the clipboard was read on the main thread, and a paste was cut silently | The clipboard is read on IO; only text is pasted (a picture or URI says so); a paste over the limit is cut at a whole character and says so. |
| S4: Delete block took a whole list with no word, and did nothing during sync | The page names what went (`blockDeleted`), and the app offers Undo ("List deleted"); while another device's update waits, the Block menu says "Wait until the note has finished syncing". |
| S5: test names and claims the code did not back | The pending-update test now reaches that path; the copy test's name says what it checks; NT24's design text and the SelectionMenuTest claim are corrected. |
| S6: the source view's notice and state drifted | The page says what shows after each change (`source { on }`), and pasting in the source view says "Show the note to paste into it". The codec loads lazily, as P5 made it. |
| Nits | Over-long toggle keys stay on the page; purge drops a note's toggles; `noteFields` is shared with the web; TalkBack skips the + sheet's glyphs and hints, the Block button is **Block actions**, and the find bar is labelled **Find in note**; the find count refreshes with each edit; the KDoc, the comment wrap and the unused variable; the Mac app's code-block Copy in A480. The find bar's keys are left to P9's keyboard pass. |

**Putting the old behaviour back:**

| Old behaviour put back | What failed |
| --- | --- |
| B1: Copy found by id only | `addsTheCopiesAfterCopyAndPutsItsOwnPasteAsPlainText`, `findsCopyByTheSystemsWordAndOtherwisePutsTheCopiesAtTheEnd` |
| B2: no `captureSelection` when the menu shows | `tellsTheNoteToKeepTheSelectionEachTimeTheMenuShowsBeforeAnyAction` |
| B2: paste ignoring the capture | `pastes as plain text into the title, over its selection, not into the body`, `pastes into a callout's title, which keeps it` |
| B2: copy falling back to the whole note | `copies a selection as Markdown, and never the whole note when nothing is selected`, `uses a capture once, and only for its note` |
| B2: the capture not mapped through edits | `follows edits made between the menu opening and the copy` |
| B2: the body capture unused | `pastes over the body's selection even after the WebView cleared it` |
| S1: unserialised saves | `theNewestTogglesAreKeptWhenSavesOverlap` |
| S2: no overflow fallback | `aCopyTooLargeForTheClipboardFallsBackToTextAndOtherwiseSaysSo` |
| S3: no cap at a whole character | `saysWhenAPasteWasCutShortAndNeverSplitsACharacter` |
| S4: no notice while an update waits | `says to wait while another device's update waits for what it builds on` |
| S6: the source state not reported | `shows the stored markdown with frontmatter, read-only, and the note again`, `says what shows when the source cannot be shown…`, `followsWhatThePageSaysShowsAndOffersUndoForADeletedBlock` |

**Not proved by a failing test:** the S2 snackbar's own coroutine. The flow behind it is tested.

### After the re-review

The re-review of 3cf0aad found part one's fixes held and left these, each now proved the same way:

| Left by the re-review | Fix | Old behaviour put back | What failed |
| --- | --- | --- | --- |
| S3's picture-paste test could not fail: Robolectric had no provider for its URIs | A test `ContentProvider` serves a URI as the text "secret contents" (the test first checks it does) | `coerceToText` | `aClipOfAFileIsNotText` |
| The snackbar's Undo undid the newest edit, so typing within its 10 seconds was undone instead | Undo sends `undoDelete`; the page undoes the delete only while it is still the newest undo step, and otherwise says "The note changed after the delete: use Undo on the bar" | Undo whatever is newest | `never undoes typing made after the delete, and says so` |
| A selection kept by the menu outlived a reload of the note | The page forgets it, and the last delete, whenever a note closes or opens | The kept selection not cleared | `forgets a selection the menu kept once the note is opened again` |
| Stale comments on Copy's scope (`protocol.ts`, `EditorParity.kt`) | Both say a selection copy never falls back to the note | — | — |

`theSnackbarsUndoAsksThePageToUndoTheDeleteNotTheNewestEdit` (Robolectric) checks the app's side sends `undoDelete`, not the bar's Undo.

## Deploy

None: this part has no server half. The schema is 13 (a new `folds` table, an auto-migration from 12).
