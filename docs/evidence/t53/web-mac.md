# T53: manual pass on the web and the Mac app

Issue [#181](https://github.com/htxryan/penmoss/issues/181), PR #182, D46 and A976–A987. Ryan's twelve items were checked by hand on 1 Nov 2026 on Ryan's Mac (macOS 26), against `task dev` (the Worker on :8787 with DEV_AUTH, Vite on :5173). The branch was `codex/t53-feedback-pass` at `bbc33e8`, plus the fixes below. Android was checked at the same time, against the same servers, by another agent; its evidence is the `android-*` files in this folder.

**How.**

- **Web.** Standalone Playwright scripts drove:
  - Chromium at 1280 × 800 (and 1100–1300 tall for the sidebar's sections), in light and dark;
  - a phone at 390 × 844 (touch, `isMobile`);
  - WebKit for spot checks on the desktop and the phone.

  Each step read accessible names, `aria-current`, `aria-selected`, computed `border-radius`, bounding boxes, the clipboard and the settings on the server. I looked at every screenshot.
- **Search (item 2).** `page.route` held `/api/search` for 1.5 s and 5 s. The result list was sampled every 40 ms from the first keystroke. Offline was `context.setOffline`.
- **Steady text (item 11).** A note held a wrapped paragraph, a nested bullet list, a numbered list, a quote with a list inside, a checklist and a last paragraph. A `requestAnimationFrame` recorder logged every block's top and height on each frame across body → title, title → body and body → outside.
- **Mac.** `task desktop:build`, then `_electron` launched `apps/desktop` with `PENMOSS_API_ORIGIN`/`PENMOSS_APP_ORIGIN` and a fresh `PENMOSS_USER_DATA` in `/tmp`. It signed in as `test/e2e/support.ts` does. Window shots are macOS's own (`screencapture -l`). The installed Penmoss and its data were never touched. The app was rebuilt after the fixes and checked again.
- **Console and network.** Every run collected `console` errors and warnings, `pageerror`, failed requests and 4xx/5xx responses. There were **none** in Chromium, WebKit, the phone layout, the Mac main window or a Mac note window.
- **Fixtures** (local Worker):
  - the folder "T53 Pass q9r23b", with "Inside", "Next to it" and the folder "Sibling";
  - notes named "Rail …", "Panel … \"q\" \ end", "Narrow …", "Steady …", "Steady text …", "Pin A/B/C a9zaza" (unpinned), "Mac …", "Window najsn0" and "Pane loop …".

## Synced settings

My baseline, from `GET /api/settings` at 14:13:

- `sidebar.sectionOrder` [quickAccess, recent, notebooks, tags, calendar]
- `sidebar.hiddenSections` []
- `sidebar.recentCount` unset
- `quickAccess.showNotebook` false
- `quickAccess.notes` []

Each of my changes was undone right after it was checked: hide/show, ↑↓, drag and back, the count 3 → unset, my three pins removed, and Alt+↑/↓ and drag on the Android agent's pins and back.

The Android agent changed the same keys during my run: its pins, `showNotebook` true, and Notebooks before Recent. Once my blanket reset put its section order back to my baseline; I set its order again at once.

## Outcome per item

✅ pass · 🔧 passed once fixed (below) · — not on this platform

| # | Item | Web (Chromium) | WebKit | Phone | Mac app |
| --- | --- | --- | --- | --- | --- |
| 1 | Rail | ✅ Back and Forward sit at y 0 (17 × 28 each), with no gap. Every rail button is 34 × 34 with `border-radius: 0`, hover included. Today, then This Week, is `aria-current="page"` on its note, on the rail and in the sidebar. `web-01-*` | ✅ `webkit-01-rail` | — | ✅ Back/Forward sit right under the lights' row (y 49). Square, current on the journal notes. `mac-01-*` |
| 2 | Search never reorders | ✅ Held 1.5 s: spinner and "Searching…" (`aria-busy`), then one list. Held 5 s: the preview shows at 2.6 s with the spinner still on, and the server's answer comes in the same order. Typed key by key: the same. Offline: results at 128 ms. `web-02-*` | not checked | not checked | ✅ spinner while held. `mac-02-*` |
| 3 | Square corners | ✅ A computed-radius sweep of the home view, note, toolbar, slash menu, the four panel tabs, ⋯ menu, palette, search, every Settings page, Graph and Trash found only round-by-nature things: the sync dot, colour dots and graph swatches. `web-03-*` | ✅ same sweep | ✅ | ✅ same sweep |
| 4 | Notebook actions on its row | ✅ Hidden at rest. On hover: New Note in This Notebook, Sort Order, New Folder, Trash; the dot stays last (actions 126–225, dot at 231). New Note makes a top-level note. Open or Close Notebooks is in the top row. `web-04-*` | ✅ | ✅ Shown without hover, 44 px each; dot last | ✅ `mac-04-*` |
| 5 | Folder + | ✅ Hover actions: New Note in …, Rename, Delete. + made "Inside" at level 2 with its title focused. `web-05-*` | — | ✅ always shown | ✅ `mac-05-*` |
| 6 | Menu bar icon on by default | — | — | — | ✅ Fresh user data: `preferences.json` has no `menuBarIcon`, `trayShown()` is true, the tray menu lists Quick Capture, Today and the pins, and Settings → Display's switch is on. `mac-06-*` |
| 7 | Agent reference names the id once | ✅ `Penmoss note "Panel light … \"q\" \\ end" (Personal)` then the `read_note` line: the id appears once. The top bar, the ⋯ menu and the sidebar copy the same text. `web-07-*` | — | in the ⋯ sheet | ✅ through Electron's clipboard, id once. `mac-07-*` |
| 8 | Sidebar sections | 🔧 ✕ and the handle show on title hover. Drag (HTML5) and ↑/↓ reorder, and focus stays on the handle. ⋯ lists Hide/Show A–Z. Recent Notes' count works (3 → 3 rows, synced). Lines are 1 px full-width `--pm-border`. The calendar's month buttons stay at x 146/175/235 on hover. Hidden or collapsed Notebooks: ⌘⌥⇧N shows it with the name field focused. **Fixed:** ⋯ was cut off, the count field, Recent squeezed. `web-08-*` | 🔧 `webkit-08-*` | ✅ tools always shown | 🔧 the same, plus ⌘⌥⇧N. `mac-08-*` |
| 9 | Vertical tabs | 🔧 A vertical `tablist` runs down the right edge, with no tab row in the panel and no Comments button in the bar. A tab opens the panel; clicking it again closes it. Escape inside the panel closes it. A new note in a 1100 px window opens closed, and the panel lies over the text. **Fixed:** Escape on a tab, History's entry. `web-09-*` | ✅ `webkit-09-panel-open` | ✅ No strip while closed. Comments covers 0–335 px with the strip at 335–390 beside it; Close hides both. `phone-comments-*` | 🔧 A 720 px note window opens closed (`mac-09-note-window-*`). Escape on a tab fixed. |
| 10 | Quick Access | 🔧 Right-click and Shift+F10 open Remove from Quick Access. Alt+↑/↓ keeps focus. Drag reorders and syncs. The setting shows "Personal" under each title. **Fixed:** the setting's name. `web-10-*` | — | — | 🔧 Remove, Alt+↑/↓ and drag all checked. `mac-10-*` |
| 11 | Text holds still | ✅ One layout on every frame of every transition, in light and dark. `web-11-*` | ✅ | ✅ (Chromium and WebKit) | ✅ One 0.1 px sub-pixel rounding change in the last two blocks, not visible. |
| 12 | Menus | ✅ Folder: New Note Here, New Folder Here, … Note: New Note Here, New Folder Here, then the rest. Both make a sibling in the note's folder (level 2). `web-12-*` | — | — | ✅ `mac-12-*` |

## Bugs fixed

Each fix has a unit test that fails without it, and each was checked again by hand in Chromium, WebKit and the rebuilt Mac app.

1. **⋯ was cut off at the sidebar's edge** (T53; web and Mac, `web-08-top-row-before-fix-light`, `mac-08-top-row-before-fix-dark`).
   - Cause: `.sb-shortcuts` is a grid item, so its minimum was its icons' full width. With T53's Notebooks and ⋯ added, the row was 283 px in a 272 px sidebar.
   - Fix: `min-width: 0`, so the icons narrow as intended. The row now ends at 263 px. `styles.css`.
2. **Recent Notes shrank to a row and a half** whenever the sidebar was 864–1300 px tall, while Tags kept 30% (T53; `web-08-recent-before-fix-light`).
   - Fix: the section keeps its title and up to three notes, counted with `:has(li:nth-child(n))`, so a short list asks only its own height. `styles.css`.
3. **Notes in Recent Notes was a bare, full-width number field** (T53; `web-08-display-before-fix-light`).
   - Fix: it takes the app's `.input` style and is 6 rem wide. `DisplaySettings.tsx`, `styles.css`.
4. **The Quick Access setting's label didn't match A984** (T53).
   - Fix: "Show each Quick Access note's notebook under its title" is now "Show Notebook Names in Quick Access". The always-on list in the help text now names Open or Close Notebooks too. `DisplaySettings.tsx`.
5. **Escape didn't close the panel when focus was on its tab** (T53). A click on a tab leaves focus there, so tab-then-Escape did nothing.
   - Fix: Escape on the strip closes an open panel, and focus stays on the tab. `NoteView.tsx`, with a test in `note-panel.test.tsx`.
6. **History's "Now" entry ran about 20 px under the tab strip** (pre-existing since T21's dashed current entry; T53's strip made it visible).
   - Cause: the entry is a `div` with `width: 100%` plus padding and a border.
   - Fix: `box-sizing: border-box`. `styles.css`; `web-09-history-entry-fixed-light`.

7. **A link to a note made a moment ago said "Note not found"** (pre-existing since B12; found after the pass, by `feedback.spec.ts`'s picture test failing about half the time).
   - Cause: the server lists a note a little after it is made, and the page decided from that list alone. A note an agent made through MCP, opened at once from its link, showed "Note not found".
   - Fix: an id missing from every list is asked of the server once (`GET /api/notes/:id/content`) before the page says there is no such note; meanwhile it shows "Opening the note…". `notes/service.ts`, with a test in `notes-service.test.ts`. The picture test and the phone suite then passed three times each.

Tests are in `apps/web/test/unit/t53-pass.test.tsx` (new), `note-panel.test.tsx` and `notes-service.test.ts`.

- Web: 702 passing (88 files).
- tsc clean; ESLint, Prettier and Stylelint clean on the changed files.
- A later sweep for elements overflowing their parent, on every screen above and the phone, found nothing.
- Not run: the Playwright suites, which need the ports `task dev` holds.

## For Ryan

1. **On a phone, ⋯ wrapped onto a row of its own** under the eight 44 px icons (`phone-drawer-*`, before). Fixed after the pass: in the drawer, ⋯ sits in the head beside ✕ and the icons keep one row (`styles.css`; `mobile.spec.ts` checks it; `phone-more-in-head-light`). Re-checked in Chromium and WebKit at 390 px; the desktop row is unchanged.
2. **Escape in the note body doesn't close the panel**, only Escape in the panel or on its tabs. This seems right, because Escape also leaves comment drafts and pickers, but it's your call.
3. **A crowded sidebar, 864–1000 px tall**, with Quick Access pins and all five sections: the sections need more than the room, so the list scrolls as a whole. Since fix 2, the overflow is about 60 px. One option is to raise the 54 rem breakpoint at which the sidebar scrolls as one.
4. **Android's label** for the same setting reads "Notebook under each Quick Access note" (`DisplayScreen.kt`) and "Notebook names in Quick Access" (`Settings.kt`), not A984's "Show Notebook Names in Quick Access". I didn't change it, as Android is out of scope here.
