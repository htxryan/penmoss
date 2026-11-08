# T52: manual pass on the web and the Mac app

Issue [#179](https://github.com/htxryan/penmoss/issues/179), D45 and A952–A975. Ryan's twelve items, checked by hand on 1 Nov 2026 on Ryan's Mac (macOS 26), against `task dev` (the Worker on :8787 with DEV_AUTH, Vite on :5173). The branch was `codex/t52-feedback-pass` at `6005009`, plus the two fixes below, then the coordinator's decisions on the first pass's "For Ryan" list (see "Decided and done"), each checked again by hand. Android was checked at the same time by another agent against the same servers. Its evidence is the `android-*` files in this folder.

**How.**

- **Web.** Playwright scripts drove Chromium at 1280 × 800 (1440 × 900 for symbols, 1200 × 800 for the pane-width rule), in light and dark (`colorScheme`), then a phone at 390 × 844 (touch, `isMobile`). WebKit (Playwright's build) spot-checked comments, the panel modes, the Sort menu, symbols and the phone layout. Each step read:
  - accessible names, tooltips (`data-testid="tooltip"`) and `data-tip`s;
  - `aria-pressed`, `aria-checked` and `data-mode`;
  - bounding boxes and the clipboard.

  I looked at every screenshot.
- **Mac.** `task desktop:build`, then Playwright's `_electron` launched `apps/desktop` with `PENMOSS_API_ORIGIN`/`PENMOSS_APP_ORIGIN`. It used a fresh `PENMOSS_USER_DATA` in `/tmp`, so the installed Penmoss and its data were never touched. It signed in as `test/e2e/support.ts` does: the stubbed browser, `/api/auth/native/code`, then the loopback callback. Dark mode was the page's `prefers-color-scheme` (`emulateMedia`). Window screenshots are macOS's own (`screencapture -l <CGWindowID>`), so they show the real traffic lights. The Mac app was rebuilt after the decisions were in, and every `mac-*` screenshot was captured again from a fresh, signed-in `PENMOSS_USER_DATA` (deleted afterwards).
- **MCP.** `curl`-style JSON-RPC calls to the local Worker's `/mcp` with a DEV_AUTH session token: `list_comment_threads`, `read_comment_thread`, `create_comment_thread`, `read_note` and `replace_text`.
- **Fixtures** left on the local Worker:
  - the folder "T52 Pass xgq0l7" with the note `Here xgq0l7 "q" \ end`;
  - "Comments light/dark xgsfw2";
  - "Symbols light/dark h…";
  - the "Narrow …", "Collapse …" and "Default compact …" notes.
- **Console and network.** Every run collected errors, warnings, `pageerror`, failed requests and 4xx/5xx responses. There were **none** in Chromium, WebKit, the phone layout, the Mac main window or a Mac note window. The only exceptions were the expected refusals during the deliberate offline step of the sync dot check.

## Outcome per item

✅ pass · 🔧 passed once fixed (below) · — not on this platform

| #   | Item                                    | Web (Chromium) | WebKit | Phone (web) | Mac app |
| --- | --------------------------------------- | -------------- | ------ | ----------- | ------- |
| 1   | New Note Here on a folder               | ✅ The folder's menu starts with New Note Here (then Turn into Notebook, Rename, Delete Folder…). A notebook row's starts with it too. The note opens in the folder (level 2, folder expanded) with its title focused. The crumbs read "T52 Pass xgq0l7 › …". | not checked | not checked | ✅ `mac-01` |
| 2   | Symbols in table cells                  | ✅ ⌃1, ⌃3 in a body cell, ⌃4 in the next, ⌃2 in a header cell. The symbols sit inside the cell before the text. Markdown is `\| ? Task \| Owner \|` / `\| ★ ! Budget \| 💡 Ryan \|`, read back through MCP. | ✅ | ✅ | ✅ `mac-02-03` |
| 3   | "+N" overflow and popover               | ✅ Beside the side panel (3rem gutter) and at full width: `!` with a `+2` badge on its top corner. The drag handle has its own slot left of it (handle 273–295 px, symbols from 296 px), so it never covers a glyph. Hover shows `! 💡 →` in a popover inside the pane. The text starts at the same x as a plain line (320 px both). Hiding the panel refits to all three (handle 357–380, symbols 381–435); Compact and Expanded again go back to the badge. A click opens the picker. | ✅ `+2` | ✅ three before the text | ✅ badge clear of the handle, popover, refit on Hidden |
| 4   | Copy Agent Reference                    | ✅ All three copy the exact core format: the top bar ✦ ("Copy Agent Reference" tooltip, before Comments), the ⋯ menu's copy group, and the sidebar's right-click. The title's `"` and `\` are escaped (`"Here xgq0l7 \"q\" \\ end"`), and the place is `Personal › T52 Pass xgq0l7`. The status says "Copied Agent Reference" from all three, the sidebar's included (no full stop now). | — | ✅ in the ⋯ sheet (not clicked) | ✅ Same text through Electron's clipboard from all three. It is also in the Edit menu. |
| 5   | Comments float; note comments; MCP      | 🔧 The composer floats at the selection (above it when there is no room below), at the caret ("At a point in …"), and at a clicked passage. Escape and × close it and focus returns to the editor. A click outside closes an empty composer or a thread, and keeps a composer with text. The list's quote or Reply opens the thread floating with the reply box focused. Add Note Comment works from the tab and the ⋯ menu, and the thread is listed first with no marker. While a floating composer is open, its passage carries a pending mark: a dashed underline and a faint wash, lighter than a thread's (a dashed point marker at a caret). It goes on Cancel, ×, Escape and send. The note-level label reads "The note as a whole". **Fixed:** the selection toolbar showed under the composer. | 🔧 | ✅ (full-screen dialog) | 🔧 pending mark on "needs compost", gone after Escape |
| 6   | Note panel Hidden / Compact / Expanded  | ✅ The button cycles Expanded → Hidden → Compact → Expanded, `aria-pressed` true/false/mixed, with the tooltip "Note Panel: <mode>". Compact's strip is 4 icons at the pane's edge, each with its keys in its tooltip and the count on Comments. Its dialog covers the pane and has one visible heading (the tab's own is kept for screen readers only), 4 tabs and Close ("Close (Esc)"). Close and Escape return focus to the icon. A press anywhere outside it closes it, the sidebar's empty foot included, without changing the page; a press inside keeps it. Each note remembers its mode across a reload, and new notes take the default. Settings → Appearance → Note Panel works (Compact default → new note Compact; put back to Expanded). At 1200 px the panel is Compact with the sidebar and Expanded with it collapsed, and the cycle there skips Expanded. Nothing shows below the note. | ✅ | ✅ Hidden by default (no strip); the ⋯ sheet reads "Note Panel: Hidden"; Comments opens full screen | ✅ Compact's dialog starts below the lights' row (y 48) in the main window, a 640 px window and a 720 px note window. A press on the sidebar closes it. |
| 7   | Bottom spacing                          | ✅ The last line ends 53 px above the status bar: 2.5 rem plus the paragraph's margin. The side panel stops above the status bar. | seen, not measured | not measured | seen, not measured |
| 8   | One row, New Note first, accent-filled  | ✅ New Note, Search, Today, This Week, Graph, Commands. Each is 32 px with tips and keys (`New Note (⌘⌥N)`). New Note is filled with the accent in light and dark, with a focus ring. | ✅ | ✅ (drawer) | ✅ |
| 9   | No Top Level label                      | ✅ None in the sidebar. | ✅ | ✅ | ✅ |
| 10  | Sort icon menu with a check; Trash      | ✅ The bar has Sort Order, Open or Close Notebooks, New Folder and Trash, all icons with tips. Sort is a menu of Manual / A–Z / Modified with a check on the current one (`menuitemradio`, `aria-checked`). Its name is "Sort Order for the Top Level". | ✅ | ✅ | ✅ same name |
| 11  | Notebook name in the accent; dot by shape | ✅ "PERSONAL" is in the accent mix in both themes. The dot is solid when synced and a ring when offline (`web-11-dot-states`). | ✅ | ✅ | ✅ |
| 12  | One-button rail; lights in the title row; Back/Forward pair | ✅ The rail is 35 px (34 px buttons + 1 px border). Back and Forward are one chip of two 17 × 28 halves with tooltips (`Back (⌘[)`). | not checked | — (drawer head only); the app bar names the notebook ("Personal") for a top-level note | 🔧 The rail is one button wide. The lights are in the note's title row and the rail starts below it. The chip sits beside the lights in the sidebar head and in a note window (x 88), and on the rail. With the rail, the note's title starts at 88 px, 12 px after the green light. **Fixed:** in Settings, Back/Forward sat 5 px below the lights. |

## Bugs fixed

1. **The selection toolbar stayed visible under a floating comment composer** (item 5, web and Mac).
   - **Cause.** Clicking the toolbar's Comment sets TipTap BubbleMenu's `preventHide` (its mousedown), so the editor's blur, as focus moved into the composer, never hid it. The toolbar then peeked out beside the composer (`web-05-bug-toolbar-under-composer-before-dark.png`).
   - **Fix.** The toolbar now hides itself whenever a comment is requested (`COMMENT_ADD_EVENT`), from the button or ⌘⌥⇧M. It comes back over the selection when the note gets focus again (Escape).
   - **Files.** `packages/editor/src/extensions/bubble-toolbar.ts`, with a test in `packages/editor/test/bubble-toolbar.test.ts` that fails without the change.
   - **Checked after the fix:** Chromium, WebKit and the Mac app.
2. **Settings' Back and Forward were 5 px below the traffic lights on the Mac** (item 12).
   - **Cause.** The Settings bar was 56 px tall (`--pm-bar`), so its contents centred at y 28, while the lights' row is 48 px (centre ≈ 23–24).
   - **Fix.** With the compact title bar, the bar is now the lights' row's height, as the sidebar head and the note's top bar are.
   - **Files.** `apps/web/src/styles.css`.
   - **Evidence.** `mac-12-settings-title-row-before-fix-light.png` and `mac-12-settings-title-row-light.png`. The T51 capture had the same offset.

Tests:

- editor: 597 passing; web: 701 passing (87 files); desktop: 185 of 186 (below).
- tsc clean in web, editor and desktop; ESLint and Prettier clean on the changed files.
- desktop's one failure is `git-notebooks.test.ts › reads a process’s group, start and command from ps` ("expected 3600239.94 to be less than 3000"). It reads `ps`'s local start time on 1 Nov 2026, the day the clocks went back an hour, so it is off by 3600 s. It has nothing to do with this pass.
- Not run: the web and Electron Playwright suites. They need the ports `task dev` holds. Their expectations were updated for the new names (`folders`, `clipboard`, `mobile`, `comments` specs; `mac-window.spec.ts` already reads the constants).

## MCP: where a thread is (item 5)

On "Comments dark xgsfw2", the browser made a thread on "plant the garden" and a note-level thread.

- `list_comment_threads`:
  - lists the note thread first (`kind: "note"`, no `position`);
  - gives the range thread a short `position`: `found: "anchor"`, `text`, `matchesQuote: true`, `headings: ["Garden"]`, `block: 9`.
- `read_comment_thread` adds:
  - `paragraph`: the sentence;
  - `context`: 60 characters `before` and `after`, headings, block and paragraph, as made.
- `create_comment_thread` with no quote made a `kind: "note"` thread, which shows in the web list as "The note as a whole".
- After `replace_text` changed the passage to "plant the vegetable garden", the anchor held: `found: "anchor"`, `text: "plant the vegetable garden"`, `matchesQuote: false`.
- After the sentence was replaced outright and the words added to a later paragraph, the anchor was orphaned. The read gave `found: "refound"`, `how: "exact"`, `similarity: 1`, `block: 12`, and the new paragraph. The web list still shows the thread as "The text this was on was deleted" (refinding is a read only, A967).

## Decided and done

The first pass ended with six questions for Ryan. The coordinator decided them, and a seventh was added. Each is implemented, has unit tests where they make sense, and was checked again by hand on the web (Chromium light and dark, WebKit, the phone layout) and in the rebuilt Mac app.

1. **Title bar inset 88 px** (was 80).
   - macOS 26 draws the lights from x 16 to x 76 (14 px buttons, 23 px apart), measured on the captures.
   - `TRAFFIC_LIGHTS` is now `{ x: 16, y: 16, width: 60, height: 16 }` and `TITLE_BAR_INSET` 88 (`apps/desktop/src/mac-window.ts`); `--pm-titlebar-inset` is 88px (`apps/web/src/styles.css`). Everything else reads one of the two.
   - The unit test now checks the lights' width and a 12 px gap after them; the e2e spec reads the constants.
   - Seen: Back/Forward at x 88 in the sidebar head and a note window, the title at 88 with the rail (`mac-12-rail-title-row-*`, `mac-12-sidebar-head-*`).
2. **A pending highlight while a floating composer is open.**
   - `showPendingComment(editor, anchor | null)` in `packages/editor/src/extensions/comments.ts` sets a decoration: `pm-comment-pending` over a range, or a dashed point marker at a caret. It maps through edits and is re-placed after a remote change. It never goes in the undo history.
   - `NoteView` sets it from the draft's anchor and clears it when the draft goes (send, Cancel, ×, Escape, a click outside).
   - Seen: `web-05-pending-highlight-*`, `web-05-pending-point-*`, `mac-05-composer-at-selection-*`.
3. **The phone defaults to Hidden.** With no mode on the note and no default chosen on the device, a phone (≤ 700 px) shows no strip (`apps/web/src/notes/panel-mode.ts`). Seen: `web-phone-note-*`, `webkit-phone-note-light`.
4. **The drag handle has its own slot.** The margin's cap now leaves the handle's 24 px (`HANDLE_PX`, `packages/editor/src/extensions/symbol-overflow.ts`).
   - In a 3rem gutter (full width, or beside the panel) that leaves one slot: the first symbol, with the count as a small badge on its top corner.
   - Wider gutters show more.
   - Moving the handle instead was considered: reserving keeps A969's rule (the handle is left of the symbols) and needs no second position.
   - Seen: `web-03-badge-*`, `web-03-full-width-*`, `web-03-plus-n-beside-panel-*`, `mac-02-03-symbols-*`.
5. **A press anywhere outside Compact's dialog closes it**, the sidebar included. Menus, tooltips and other dialogs opened from it don't count. Seen on the web and the Mac: the dialog closed, the URL unchanged.
6. **Nits:**
   - The dialog's heading no longer repeats the tab's own (`web-06-compact-dialog-*`, `mac-06-compact-dialog-*`).
   - The Sort button reads "Sort Order for the Top Level".
   - The sidebar says "Copied Agent Reference" with no full stop.
   - The phone app bar names the notebook for a top-level note ("Personal"; a git notebook's name for one of its notes), and "Top level" only when no notebook is known. Android has its own "Top level" in its bars; that is for the Android pass.
7. **"The note as a whole"** replaces "On the note as a whole" in the web's Comments list and its Add Note Comment composer, as Android and A965/A973 say.

## Not covered

- **The sync dot's "stopped" bullseye.** Only synced (solid, pulsing while syncing) and offline (ring) were seen.
- **Real ⌘C into another app.** The clipboard was read back through the page and through Electron's `clipboard`.
- **Shared settings.** The Android agent was using the same account. This pass changed only Full Width (synced, put back to off each time), notes' own panel modes (put back to Expanded) and the device-local Note Panel default (put back to Expanded). The Sort Order menu was opened but not changed.

## Files

Screenshots are named by platform, item and mode: `web-NN-*` (Chromium), `webkit-*`, `web-phone-*` / `webkit-phone-*`, and `mac-NN-*`, where the Mac's are macOS's own captures. Each is under 400 KB (palette PNGs).

- **Item 12, Mac:**
  - `mac-12-sidebar-open-*`, `mac-12-sidebar-head-*`, `mac-12-back-tooltip-*`;
  - `mac-12-rail-*`, `mac-12-rail-back-tooltip-*`, `mac-12-rail-title-row-*`;
  - `mac-12-settings-*` and the title-row crops;
  - `mac-12-note-window-*`, `mac-12-note-window-back-tooltip-*`.
- **Item 6:**
  - web: `web-06-expanded-*`, `web-06-hidden-*`, `web-06-compact-strip-*`, `web-06-compact-dialog-*`, `web-06-1200-*`, `web-06-setting-*`;
  - Mac: `mac-06-hidden-*`, `mac-06-compact-*`, `mac-06-compact-dialog-*`, `mac-06-narrow-*`, `mac-06-note-window-dialog-*`, `mac-06-setting-*`;
  - Expanded on the Mac is `mac-12-sidebar-open-*`.
- **Item 5:** `web-05-pending-highlight-*`, `web-05-pending-point-*`, `web-05-composer-at-*`, `web-05-thread-at-passage-*`, `web-05-from-list-*`, `web-05-note-comment-panel-*`, `webkit-05-composer-*`, `mac-05-*`; before the toolbar fix, `web-05-bug-toolbar-under-composer-before-dark`.
- **Items 2–3:** `web-02-*`, `web-03-*` (the badge, the full width and beside-panel cases, Hidden's refit), `webkit-03-*`, `web-phone-symbols-*`, `mac-02-03-symbols-*`.
- **Phone:** `web-phone-*` and `webkit-phone-*` (note, Comments, drawer, ⋯ sheet, home, symbols).
