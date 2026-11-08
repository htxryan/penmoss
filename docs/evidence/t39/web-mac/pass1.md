# T39 pass 1: web and Mac findings log

Issue [#74](https://github.com/htxryan/penmoss/issues/74). Pass 1 covers the web app at 1440×900 (desktop)
and 390×844 (phone, touch) and the Mac app (Electron, run under xvfb on Linux). Android is a separate
pass 1 log in `docs/evidence/t39/android/`.

## How the app was used

- **Vault.** A local Worker (`wrangler dev --local`, its own persisted state) and Vite were seeded through
  the UI and the agent API. The seeded vault has:
  - 67 notes, including a six-level folder chain with a long folder name;
  - a note with a 130-character title;
  - a table with a callout, a code-heavy note, images and wikilinks;
  - daily and weekly notes, tags, Trash entries and agent tokens.

  Hardening then added a 50,000-word note and 1,000 notes.
- **Tour.** A Playwright tour took 40 screens per run: home, drawer, tree, notes (scrolled and not), long
  title, slash menu, bubble and table toolbars, backlinks or note sheet, graph, tags, today, this week,
  palette, quick open, recent, search, shortcut sheet, history, Trash, every Settings section, capture
  page and dialog, offline, back online, missing note and not found. It ran in these combinations:

  | Width   | Themes and modes                                                  |
  | ------- | ----------------------------------------------------------------- |
  | Desktop | Penmoss light, Penmoss dark, Nord dark, Paper light               |
  | Phone   | Penmoss light, Penmoss dark, Gruvbox light, Rosé Pine dark        |

  That is 320 before-screenshots and a second round after the fixes. The tour shots are not kept here;
  the pairs below are.
- **Mac app.** A tour under xvfb checked:
  - sign-in, the menus and their accelerators, a note, This Mac in Settings;
  - the quick-capture window, empty and with a long capture.

  The desktop Playwright suite already covers sign-in and sign-out, offline reopen, relaunch with the
  window restored, `penmoss://` deep links, outside links and the theme at launch. Those ran green, see
  Verification.
- **Console.** No console errors or warnings on any tour screen except the expected ones:
  - failed requests while offline or answered with 500;
  - search's warning that it fell back to this device.

## Findings → fixes

Evidence paths are relative to this folder. "Before" was taken on `origin/main` at the start of the pass.

| # | Finding | Fix | Evidence | Decision |
| --- | --- | --- | --- | --- |
| 1 | **A long title was cut off** at the column edge (single-line `<input>`). The 130-character note showed half its title. | The title is a `<textarea rows=1>` that grows with its text (`field-sizing: content`, or height from `scrollHeight`). Enter and pasted line breaks still keep it one line (`notes/title-field.ts`, `NoteView.tsx`). | `before-desktop-long-title.png` → `after-desktop-long-title.png`; e2e `polish.spec.ts` "a long title wraps"; unit `title-field.test.ts` | A372 |
| 2 | **Pasted titles kept control characters** (NUL and BEL showed as boxes in the tree). | `pastedTitle` drops control characters other than tab and line breaks (`packages/editor/src/title.ts`). | `before-desktop-pasted-title.png` → `after-desktop-pasted-title.png` (tree row); unit `title.test.ts` | A372 |
| 3 | **The note column changed width per note** beside Backlinks: a short note's column shrank to its text (roadmap vs code note shifted). | `.doc { width: 100% }`. | `before-desktop-column-roadmap.png`, `before-desktop-column-code.png` → `after-desktop-column-roadmap.png`; e2e "the note column keeps its width" | none (a bug) |
| 4 | **No way to move a note without dragging**: keyboard and phone users could not refile a note. | `note.move` "Move to folder…" in the palette, the Mac File menu, the desktop note menu and the phone note sheet. It opens a combobox of Top level and all folders (fuzzy by path, current folder marked), then a "Moved to …" toast. `planMoveTo` and `folderChoices` live in `workspace/model.ts`. | `before-phone-note-sheet.png` → `after-phone-note-sheet.png`, `after-desktop-folder-picker.png`, `after-desktop-moved-toast.png`, `after-phone-folder-picker.png`; e2e `polish.spec.ts` (desktop and phone); unit `workspace-model.test.ts` | A373 |
| 5 | **Tab left modal dialogs** (palette, search, theme picker, capture, shortcut sheet) for the page behind. **Phone search and palette had no close control** (Escape only). | One capture-phase focus trap for the topmost `aria-modal` dialog (`shell/focus-trap.ts`). A `DialogClose` icon button (44 px on touch) in the palette, quick open, search, theme picker and folder picker. The native search-field clear "x" is hidden, so search no longer shows two close glyphs. | `before-phone-search.png` → `after-phone-search.png`; `before-phone-palette.png` → `after-phone-palette.png`; `before-desktop-nord-dark-search.png` → `after-desktop-nord-dark-search.png`; e2e "Tab stays in a modal dialog"; unit `focus-trap.test.ts` | A374 |
| 6 | **Opening a note by its address did not reveal it in the tree** (reload, deep link, Mac restore). Its folders stayed closed: the reveal ran before the workspace knew the note's folder. | `revealFolders` waits until the note is listed and filed (or the workspace synced), and the active row scrolls into view. | `before-desktop-tree-deep-link.png` → `after-desktop-tree-deep-link.png`; e2e "a note opened by its address shows in the tree"; unit `workspace-model.test.ts` | A375 |
| 7 | **Mac quick-capture window had a stray scrollbar** (both axes). The page was `min-height: 100vh` plus the form, and the textarea was resizable; `clientHeight` 285 < `scrollHeight` 300. | The window is a fixed-height flex column; the text takes the free room and scrolls inside itself; `box-sizing: border-box`. | `before-mac-capture-long.png` → `after-mac-capture-long.png`; `before-mac-capture-overflow.json` → `after-mac-capture-overflow.json`; desktop e2e `capture.spec.ts` "the capture window fits its window" | A376 |
| 8 | **Settings dates were raw** ("10/24/2026, 5:52:08 AM") and device rows said "Web browser · web". **This device sat anywhere in the list.** A double click on Create token made two live tokens. Copy gave no feedback. The phone Settings tab strip did not show the current tab. | `shortWhen` ("Oct 24, 5:52 AM") in Devices, Status and Git mirror. Device rows show the name with "Last seen" beneath. Tokens show "Read and write" or "Read only". This device is listed first. Buttons are disabled while a request is in flight; Copy turns into Copied. The current tab is scrolled into view. | `before-desktop-settings-devices.png` → `after-desktop-settings-devices.png`; `before-phone-settings-devices.png` → `after-phone-settings-devices.png`; unit `when.test.ts`, `device-order.test.ts` | A377 |
| 9 | **A double click on New note made two notes** (one left as an empty "Untitled"). Measured: 2 notes per double click. | `isRepeatedNewNote`: a second New note within 1 s, while the note it just made is open and still untitled, does nothing except give the title its focus back from the button (`notes/new-note.ts`, `App.tsx`). Re-measured: 69 → 70 notes. A deliberate New note 1 s later still works (70 → 71). | `before-desktop-double-click-new-note.png` → `after-desktop-double-click-new-note.png`; e2e "a double click on New note makes one note"; unit `new-note.test.ts` | A378 |
| 10 | **Slow 3G showed a blank white page** for the whole load (over 120 s on the unbundled dev server; seconds on production). | `index.html` holds "Opening Penmoss…" in the muted colour. It fades in after 0.8 s, so fast starts never flash it, and React replaces it. | `before-desktop-slow-3g.png` → `after-desktop-slow-3g.png` (both at 3 s) | A379 |
| 11 | **A 500 read like being offline**: History and Status said to check the connection, and Status had no retry. | The message says the server failed and gives the code. A Try again button sits beside both errors. Back up now and Clear errors got icons and a done message. | `before-desktop-history-500.png` → `after-desktop-history-500.png`; `before-desktop-status-500.png` → `after-desktop-status-500.png` | A379 |
| 12 | **The signed-out banner pushed the app below the window** (the page scrolled by the banner's height, and the sidebar footer went off screen). Seen on the Mac app and the web. | `#root` is a flex column when the banner shows; the app takes the remaining height. Probe: `scrollHeight` equals `innerHeight` (772 desktop, 844 phone). | `before-mac-signed-out.png` → `after-mac-signed-out.png`, `after-phone-signed-out.png` | A379 |
| 13 | **The table toolbar of a table at the top of a note** sat over the title and was clipped at the column edge. | For a table that is the first block, the toolbar opens below it instead. | `before-desktop-table-toolbar.png` → `after-desktop-table-toolbar.png` | none (follows A187) |
| 14 | **The Trash empty state repeated the 30-day sentence** shown just above it. | The empty state now says "Nothing has been deleted lately." | `before-desktop-trash.png` → `after-desktop-trash.png` | none (copy) |
| 15 | Small spacing: the tag row sat too far from a wrapped title; the history empty state had no paragraph gap. | Margin tweaks via tokens. | in `after-desktop-long-title.png` | none |

## Hardening results

| Probe | Result |
| --- | --- |
| Console errors on the tours | None beyond expected network failures (offline, injected 500s). |
| Slow 3G (400 ms latency, 50 kB/s) | Blank page before; now the loading placeholder (#10). The app arrives when the bundle does; nothing breaks. |
| Offline | Offline pill, edits keep and sync on reconnect (tour "offline" and "back online" screens, all themes). |
| 500s on every GET `/api/*` | Settings sections, History, Trash and search degrade. Search falls back to the device index. The wording is fixed in #11. No crash. |
| Revoked token (another session's "sign out everywhere") | Signed-out banner; the edit typed after revocation stays on the device and survives a reload; the layout is fixed in #12. |
| Reload mid-edit | The edit typed just before the reload is there after it. |
| Two tabs on one note | Both tabs' edits converge in each tab. |
| Long titles | #1. |
| 50,000-word note (two API calls, 256 KB limit each) | Opens in about 300 ms; typing 17 characters takes 215 ms in Playwright. No errors. |
| 1,000 notes | Quick open 0.12 s, a fresh device's first sync 11 s; see "1,000 notes" below. |
| Deep nesting (six folders, long folder name) | Long names end in an ellipsis in the tree, and the breadcrumb shows the full path. #6 fixed the reveal. |
| Pasted junk into the body (`<script>`, `onerror`, `javascript:` link, `<iframe>`, `<style>`, 200 nested divs, nested tables) | Reduced to a table and plain paragraphs; no script, style, frame or handler survived, and nothing executed (`window.__pwned` unset). |
| Pasted junk into the title | #2. |
| Double submits | New note #9. Create token #8. Save version twice: one version. Move to folder twice: the second says "Already in …". |

### 1,000 notes

949 notes were added through the agent API, to 1,000 in all (46 s for 20 parallel creates at a time). Then
a fresh browser profile, standing for a new device, opened the app:

| Measure | Desktop | Phone |
| --- | --- | --- |
| App shell rendered | 0.6 s | 0.3 s |
| Tree lists the last of 1,000 notes (first sync on a new device) | 11.4 s | (drawer) |
| Tree rows rendered | 955 (all of them; no virtualisation) | not applicable |
| 20 fast scroll steps over the tree | 0.8 s, no jank seen | not applicable |
| Quick open: type "bulk 0742" until the match shows | 0.12 s | 0.23 s |
| Full-text search for "harbor" | results within the 1.5 s wait | the same |
| Console errors | none | none |

Evidence: `after-desktop-1000-notes-quick-open.png`, `after-phone-1000-notes-home.png` (home shows "1000
notes"). The 11 s first sync and the unvirtualised tree are acceptable at 1,000 notes. The proposal is to
virtualise the tree before about 5,000 notes, and to show progress during a new device's first sync
(deferred; see below).

## Proposals and deferred items

- **Table toolbar as icon buttons.** Seven text buttons are wide and wrap on phones. Icon buttons need new
  glyphs in `packages/ui` and the editor's toolbar markup. That is a design change for pass 2 or 3, not
  a fix.
- **The phone app bar repeats the note title** shown just below it (as on Android, A350). For the
  cross-platform consistency pass (pass 3), together with Android.
- **"Move to trash" vs "Move note to trash" vs "Move to Trash".** The capitalisation and wording differ
  across the sheet, the menu and the palette. Unifying them changes existing e2e assertions, so it is
  left for pass 3, where Android's wording is decided too.
- **Opening an unknown note id silently creates an empty note** (`/notes/<random ULID>`). A "This note
  does not exist" state needs a server existence check, because a brand-new note is also unknown to the
  server for a moment. Proposed for pass 2 with the sync owners.
- **Unresolved `[[Title]]` links written by agents never become backlinks** when the target appears
  later: they resolve at write time only (A124). Re-resolving is a server change; logged for the agent
  API owners.
- **Graph labels overlap** in dense clusters at desktop width. Label culling or a collision pass is a
  graph redesign item.
- **The palette repeats group headings** when results interleave areas. Grouping by area after fuzzy
  ranking would change the T20 ranking tests.
- **Every web session is named "Web browser"**, so Devices shows a long list of identical rows (on Ryan's
  production account, one per sign-in). Proposal: name the session from the browser and OS at sign-in,
  and prune sessions unseen for 90 days. That is a server change.
- **Native `<select>`s** in search filters and the token form look like the OS, not the theme. A themed
  listbox is a design system item.
- **Two Format menu items show ⌘K** ("Link selected text" in the editor, and the palette app-wide). This
  reflects the A70 bindings, where the editor wins inside a note. It needs a binding decision, not a fix.
- **Typing over a selected image replaces it** (ProseMirror's default for a node selection). That is
  expected editor behaviour; noted only.
- **Empty "Untitled" notes accumulate** from abandoned New note clicks. Proposal: discard a note that is
  still empty and untitled when it is closed. That touches deletion and sync, so it goes to pass 2.
- **The slash and `[[` menus can overflow the page sideways** at phone width: `@tiptap/suggestion` sets
  `width: max-content`, a long note title is not wrapped, and the menu does not shift at the right edge.
  The Android pass found this. Because the code is shared (`blocks.css` and the editor's menu
  extensions), it is fixed in the Android pass 1 PR, not here.
- **Tree virtualisation and first-sync progress.** At 1,000 notes the tree renders every row and a new
  device needs about 11 s to list them all, with only the Syncing pill to show for it. That is fine now;
  proposed before vaults reach about 5,000 notes.
- **Three-pane layout from the prototype** (list beside tree beside note). This is a large redesign; it
  is a proposal only.

## Review follow-ups

The PR review found no blockers. These were fixed on the branch:

- **The title stays one line however text gets in (A372).** Dictation, autocorrect, a text replacement
  or a keyboard's clipboard chip can insert a line break as plain input. Each run of line breaks
  becomes a space as it is typed, before the title is stored, and the caret stays put. C1 controls,
  bidi overrides and isolates are dropped too; the Unicode line and paragraph separators count as line
  breaks; tabs are kept. Unit `title-field.test.ts`, `title.test.ts`.
- **Focus after Move to folder… (A373).** It went to the page body: the note menu and the phone sheet
  unmount, and from the palette nothing was recorded. Focus now goes back where it was, or to the
  note's body. The desktop and phone e2e tests check it; the phone test now really moves a note.
- **A held Alt+N (A378)** made a note every second. Its key repeats now do nothing. Unit
  `new-note.test.ts`.
- **Status (A379).** Offline or signed out it says "Status needs a connection to the server." instead
  of "Failed to fetch", and after a failed Back up now or Clear errors, Try again does that action
  again. Unit `status-settings.test.ts`.
- **Smaller:**
  - copy failures no longer name the browser (the Mac app shows them too);
  - the title has `aria-multiline="false"`;
  - the folder picker's close button says what it closes, and its tree is built only while it is open;
  - the move toast shows a tick only for a move and sits in a live region that is always present;
  - History's Try again shows that it is loading;
  - the boot placeholder adds no scroll;
  - on a touch screen the folder picker indents at most six levels (A363) and hides its keyboard hints;
  - `after-phone-settings-devices.png` was retaken with this device listed first.

## Changed assertions

None in tests that were there before this branch. In this branch's own `polish.spec.ts`, the phone
test now moves a note and finds the folder picker's close button by its new name.

The new tests are:

- web unit: `title-field`, `focus-trap`, `when`, `new-note`, `device-order` and `status-settings`;
  additions to `workspace-model` and `title`;
- web e2e: `polish.spec.ts`, 7 tests;
- desktop e2e: one test in `capture.spec.ts`.

## Verification

All on the worker at the branch head after merging origin/main (through #81) and the review
follow-ups, each run alone under the shared test lock:

- **`task check`:** green. 2,489 Vitest tests across the packages and apps, plus 10 node tests, with
  lint, types and formatting.
- **`task e2e`:** 119 passed, 0 failed, including the 7 `polish.spec.ts` tests and the T31 budgets.
- **`task desktop:test`:** 46 unit tests and 21 Playwright tests passed before the review
  follow-ups, including the new capture-window test. CI's Mac app job runs the suite on the head.

One full e2e run during the review follow-ups failed a single axe check: `scrollable-region-focusable`
on the recent-notes switcher's list in `a11y.spec.ts`. The spec passed alone, again after a
`polish.spec.ts` run, and in the next full run, so it is recorded here as a flake to watch.

One earlier full e2e run failed only the T31 typing budget (median p95 16.1 ms). The cause was the
worktree's local Worker state, not this branch. `apps/server/.wrangler/state` had grown to 651 MB
over many runs. The same budget on main's code in this worktree was just as slow (p50 about 7 ms),
and it was back to main's level (p50 about 4.3 ms) once that state was cleared.
