# T39 pass 2: web and Mac findings log

Issue [#74](https://github.com/htxryan/penmoss/issues/74). Pass 2 is a fresh-eyes audit of the web app and
the Mac app after pass 1 ([pass1.md](pass1.md)) and T41 (the Info panel, the status bar, the sidebar rail
and the wider column). Android has its own pass 2 log in `docs/evidence/t39/android/`. Gaps that belong to
T40 (Android parity) are not built here, and cross-platform consistency waits for pass 3.

## How the app was used

- **Vault.** A local Worker (`wrangler dev --local`) and Vite, seeded through the agent API: 30 notes, a
  note with a table, a callout, a checklist and code, an 8,700-word note, a 130-character title, tags and
  wikilinks. The e2e suite's runs added more.
- **Tours.** Playwright scripts (throwaway, not kept) at 1440×900, 1000×800 and 390×844 (touch), in
  Penmoss light and dark and Nord dark: home, notes, the Info panel and status bar, the rail, full width,
  a new note, the palette and search (with no match), every Settings section, Trash, the graph, and an
  unknown address.
- **Probes.** Sidebar rows at window heights from 760 to 1300 px; typing, Undo and Redo, paste of
  several paragraphs, select-all counts and IME composition (CDP) in the body and the title; offline and
  back online with the status bar and the pill; focus after each toggle, after Escape and after Move to
  Trash; the Tab order of the sidebar; a server-side restore of an open note with offline edits.
- **Mac app.** The Electron suite under xvfb (`task desktop:test`), plus a look at the main process:
  window state, the capture window, the menus and the admin flow.
- **Console.** No errors or warnings on any tour screen.

## Findings → fixes

Evidence paths are relative to this folder. "Before" was taken on `origin/main` (`0521d93`), "after" on
this branch, with the same script and a fresh seed. `pass2/before-probes.json` and
`pass2/after-probes.json` hold the measured values.

| # | Finding | Fix | Evidence | Decision |
| --- | --- | --- | --- | --- |
| 1 | **Redo failed in a new note.** Type a line, pause, type more, Undo twice (the note is empty), Redo: the first Redo did nothing, and the text came back only on a later Redo, after stray empty paragraphs (`"First words\n\n\n"`). Undoing the first keystroke emptied the Yjs type, and the binding then wrote the empty paragraph ProseMirror needs outside the undo step. | The undo manager keeps the note's last block, whatever its kind, with a list's item and paragraph and the attributes it was made with (its text still goes): nothing is written outside the step, and one Redo restores the text where it was (`keepsLastBlock`, `packages/editor/src/collab/yjs14.ts`). Shared by the web, the Mac app and the Android editor page. | `pass2/before-desktop-undo-redo.png` → `pass2/after-desktop-undo-redo.png`; probes `bodyAfterTwoUndosOneRedo`; unit `note-editor.test.ts` (three tests that fail without the fix, for a paragraph, words typed with no pause, and a first heading, list or code block; one that a later change to a heading's level still undoes); e2e `polish-2.spec.ts` | A520 |
| 2 | **Three notes in the sidebar at 900 px.** Beside the calendar and the Tags panel, A507's 7rem floor left 2–3 rows at 820–1000 px tall, while a window under 800 px (which scrolls as one) showed 16. A taller window showed fewer notes. | The list's floor is 12rem (six rows); the Tags panel gives way first; under 54rem the sidebar scrolls as one. | `pass2/before-desktop-sidebar-900.png` → `pass2/after-desktop-sidebar-900.png` (list 120 → 192 px); e2e `polish-2.spec.ts` | A521 |
| 3 | **The sync pill chattered to screen readers.** It was a live region, so Syncing and Synced were read out around every edit. | Plain text with a "Sync status:" prefix; a separate always-present live region carries only Offline, Signed out, Sync stopped and failed uploads. | probes `syncPillRole`; unit `sync-pill.test.tsx`; e2e `polish-2.spec.ts` | A522 |
| 4 | **The calendar was 48 Tab stops.** Every day and week number took one, so getting past the calendar by keyboard took 48 presses. | One Tab stop (today, the open note's day, or where the keyboard last was); arrows, Home, End, Page Up and Page Down move within it; Left from Monday reaches the week number. Announced as a grid (`role="grid"`, `gridcell`). | probes `calendarTabStops` 48 → 1, `calendarFocusAfterTab`; unit `calendar-keys.test.ts`; e2e `polish-2.spec.ts` | A523 |
| 5 | **Move to Trash was silent, and focus fell to the page body.** The trash button sits beside the Info panel's; a mis-click closed the note with no word and no Undo, and a keyboard user had to start again from the top. | A toast, “Moved “…” to Trash”, with Undo (restores to its folder and reopens) and a close button. Focus goes to Undo; Escape or the close button dismisses it and focus goes to the main column. Undo waits for the move to Trash to finish, then reopens the note with focus in its body. The toast waits while it is pointed at or focused. Same path from the Mac menu and the phone's note sheet. | `pass2/before-desktop-move-to-trash.png` → `pass2/after-desktop-move-to-trash.png`; probes `focusAfterMoveToTrash`; e2e `polish-2.spec.ts` | A524 |
| 6 | **A restore hid where this device's edits went.** With offline edits, a server restore reopened the note on the restored text; the edits were safe in a conflict copy, but the only sign was a new row in the tree. | A notice on the note says what happened and links the copy (Open the copy, Dismiss). | `pass2/after-desktop-conflict-notice.png`; unit `notes-service.test.ts` (two tests); e2e `restore.spec.ts` (new assertions) | A525 |
| 7 | **Mac menus never greyed anything out.** Move to Trash, Version history or Bold with no note open were enabled and did nothing when chosen. | The page marks unavailable commands `enabled: false`; the main process validates the flag and builds the item disabled. Sent after each change's effects: on a registry or route change, and when a handler's own state changes what it can do (a failed upload, an expired sign-in, a daily note), which `useCommand` notices after each render. | unit `desktop.test.ts`, `desktop-menu-refresh.test.tsx` (Retry failed image uploads and the journal's items follow their screen's state), `shell.test.ts`; Mac e2e `feedback.spec.ts` "menu items that cannot run now are greyed out" | A526 |
| 8 | **A refused admin action's message could vanish (Mac app).** Settings → Devices loaded its list after the refused Touch ID check had set its error, and the load cleared it. On the worker the Mac suite's admin test failed every run on `main`; CI passed it only on a retry. | The list's own load error is kept apart from an action's error; a new action clears the old message. | Mac e2e `account.spec.ts` "admin in the Mac app" (failed on `main`, passes here; no assertion changed) | none (a bug) |
| 9 | **Escape in the Info panel's tag field dropped focus to the page body.** | Focus goes back to Add a tag. | probes `focusAfterEscapeInTagField`; e2e `polish-2.spec.ts` | none |
| 10 | **Search's empty state was a small "No results" in the status line**, unlike the palette's centred “No matches for …”. | The list says “No notes match “…””, as the palette does; the status line still counts. | `pass2/before-desktop-search-empty.png` → `pass2/after-desktop-search-empty.png`; e2e `polish-2.spec.ts` | none (copy) |
| 11 | **The Info panel's Length broke mid-count** (“· 1” at a line's end, “min read” below). | Each count stays on one line, and a wrapped line starts with a count, not “· ”. | `pass2/before-desktop-info-counts.png` → `pass2/after-desktop-info-counts.png` | none |
| 12 | **Settings → Status: the sub-headings (Backups, Errors) were larger than the section title.** They took the browser's default `h3`, as `.settings h3` did not reach a `.settings-section`. | Sub-headings one step below the title in every section. | `pass2/before-desktop-status-headings.png` → `pass2/after-desktop-status-headings.png` | none |
| 13 | **Theme cards' names did not line up** across a row when one description wrapped (Nord and Gruvbox 8 px below Solarized). | The card's rows start at the top. | `pass2/before-desktop-theme-cards.png` → `pass2/after-desktop-theme-cards.png` | none |
| 14 | **The Mac admin test was flaky on CI** (PR #86, run 40136709922; `main`, run 40118382903): after a refused Touch ID check, the next action said “Not done: this Mac did not confirm it was you.” where “this Mac cannot check it is you” was due. The fake owner check does not leak between tests (each launch has its own auth folder). The cause was the page: `useCommand` updated its handler in a passive effect, so a menu command that arrived between a render and its effects ran the previous screen's handler. That handler still saw the first action as busy and returned without a word, and the alert kept the earlier message. | `useCommand` updates its handler in a layout effect, before any later event can run it; Devices guards a second action with a ref rather than render state, and each action clears the old message first. The subframe test waits for the page to load before it reaches into it. | unit `use-command.test.tsx` (runs a command between a render and its effects; it saw the old value before the fix); Mac e2e `account.spec.ts` “admin in the Mac app” `--repeat-each 30`: 30/30 under the lock (no retries, no timeout raised) | none (a bug) |

## Checked, no change needed

| Probe | Result |
| --- | --- |
| Offline, then back online | The pill says Offline, then “Offline · 1 pending” after typing; the status bar says “Saved here · offline”. Back online, both say synced within about 0.5 s. |
| IME composition (CDP `imeSetComposition`) | Composed text lands once in the body and in the title. |
| Paste of several paragraphs and a list | Paragraphs and a list, one undo step. |
| Select all | The status bar counts the selection, then the note again. |
| Focus after the Info panel toggle and ⌘\ | Stays in the note body. |
| Tab order of the sidebar | Collapse, New note, Search, Today, This week, Graph, Commands, the tree's header controls, one tree row, then the calendar (now one stop) and the tags. |
| Long note (8,700 words) | Scrolls and counts without errors; the counts wait for typing to pause (A505). |
| Phone (390×844) | Note, Info section, format bar, Settings and Trash fit with no sideways scroll. |
| Dark themes | The Info panel, the status bar, the rail and the new toast and notice use theme tokens only. |
| Mac app | Window size and place, the capture window, menus with shortcuts, deep links, relaunch and offline reopen: the suite's 23 tests pass. |

## Proposals and deferred items

- **New note and Settings in the rail.** A508 lists five rail buttons; New note, the most used action,
  is only on its shortcut while the sidebar is collapsed. A change to A508, for Ryan.
- **A sticky Info panel and tree header.** In a long note the Info panel scrolls away with the text, and
  the tree's header (Top level, sort, New folder) scrolls away with the list. Both could stay put at
  desktop widths; a layout change for pass 3.
- **Frontmatter values break mid-string** in the Info panel (the ULID, the ISO time). A smaller monospace
  size or a copy button; design.
- **The phone's format bar shows while reading**, not only while writing. Android pass 1 proposed the
  same for the title; one decision for both clients in pass 3.
- **Title and first heading look alike** (Android pass 1's proposal 4), on the web too. Pass 3.
- **Undo groups by Yjs's 500 ms capture.** Fast typing (or a paste followed at once by more typing) is
  one undo step. That is y-prosemirror's grouping; a word-level grouping would need our own capture
  rules. Noted only.
- **“1 min read” for a two-word note.** Reading time rounds up to a minute by design (A505); noted.
- Still open from pass 1: identical “Web browser” rows in Devices (a server change), agents' unresolved
  `[[links]]` that never become backlinks (A124), and empty “Untitled” notes. Move to Trash with Undo on
  Android is T40 P3.
- **Other Mac suite flakes seen in repeated runs** (not caused or touched here): the native sign-in
  callback sometimes answered 400 (“exchange failed”) for several repeats in a row; `app.spec.ts`'s New
  note sometimes missed its `toHaveURL`; one run logged a 401 in “signing in again revokes”. Each passed
  on the next run; a hardening item for a later pass. In the web suite, `feedback.spec.ts`'s note-width
  shortcut (also flaky on `main`, run 40138142204) and once `kept-editors.spec.ts`'s caret test (“oXne”
  for “oneX”) failed in a full run and passed `--repeat-each 8` alone; the same.

## After review

The PR's review found no blockers; these were fixed on the same branch:

- **A526:** menu items whose availability follows a screen's state stayed greyed (Retry failed
  image uploads after a failed upload, Sign in again once a sign-in expired). The menus are now
  sent again when a handler's `enabled` answers differently; `useCommand` also registers in the
  commit, so a menu choice just after leaving a screen cannot run its handler.
- **A524:** the close button dropped focus to the body, and after Undo focus fell to the body
  too: both fixed, with an e2e check of each. Undo waits for the move to Trash, which it could
  overtake. The timer no longer restarts on every render.
- **A520:** a first step that made a heading, a list or a code block still left Redo broken;
  the undo manager now keeps any last block (four unit tests).
- The conflict-copy notice is sent after the note shows the restored text, and a failing
  listener stops nothing else. The calendar is announced as a grid. The Info panel's counts
  never start a line with “· ”.
- `git-mirror.spec.ts` rewrote `docs/evidence/t27/settings-git-mirror-off.png` on every run;
  it now writes to the test's output unless `EVIDENCE_DIR` is set (as `themes.spec.ts` does),
  and the picture is back as it was on `main`.
- The parity matrix's NT21 notes A525's notice for Android (with NT14, in P3).

## Tests

New, each failing without its fix:

- editor unit: four in `note-editor.test.ts` (A520);
- web unit: `calendar-keys.test.ts` (5), one in `sync-pill.test.tsx`, two in `notes-service.test.ts`,
  one in `desktop.test.ts`, one in `use-command.test.tsx`, three in `desktop-menu-refresh.test.tsx`;
- desktop unit: two in `shell.test.ts` (one test, one set of `parseMenus` cases);
- web e2e: `polish-2.spec.ts` (7 tests), and assertions added to `restore.spec.ts`;
- desktop e2e: one in `feedback.spec.ts`.

No existing assertion was changed or weakened, no test skipped, no timeout raised.

## Verification

On the worker, each heavy run alone under the shared lock:

- `task check`: green.
- `task e2e`: 131 passed (the full web suite, a fresh local Worker).
- `task desktop:test`: 58 unit tests and 23 Playwright tests passed, including the admin test that
  failed on `main` here.
- The admin test alone, `--repeat-each 30`: 30 of 30.
