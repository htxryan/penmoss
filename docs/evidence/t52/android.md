# T52 on Android · the feedback pass on the emulator

The manual pass of T52's twelve items ([issue #179](https://github.com/htxryan/penmoss/issues/179), D45, A952–A975, the Android rules A971–A975) on Android. It includes checks against the web app through the same local server. The web and Mac pass is in this folder's `web-*`, `webkit-*` and `mac-*` files and [`web-mac.md`](web-mac.md).

## How it was run

- **Device.** AVD `penmoss37` (API 37, 1080 × 2400, 420 dpi), `emulator-5556`, light and dark. Dark was the emulator's night mode (`cmd uimode night yes`) with Penmoss on System, so the synced `theme.mode` was never changed. A narrow phone was emulated with `wm size 840x1866` (320 dp wide), at font scale 1.0 and 2.0. Both were reset afterwards.
- **Build.** The debug APK from `codex/t52-feedback-pass` (base `6005009`), built with `task android:build` and installed with `adb install -r`. It was rebuilt after each fix below and checked again.
- **Server.** `task dev` from the same worktree: Vite on :5173 and the Worker on :8787 with DEV_AUTH, reached through `adb reverse`. The server's state was new to this phone, so it signed in through its normal flow: Sign In, then the code, then Approve on `localhost:5173`, after the browser's Sign In Again.
- **Driving.** `adb shell input`, `uiautomator dump` for labels, content descriptions and accessibility state, and `screencap`. The clipboard was read by pasting (`KEYCODE_PASTE`) into a native text field: Search's field, or the Comments composer, which keep line breaks. The emulator has no `cmd clipboard`.
- **Server reads.** `GET /api/settings`, `/sync/tree` and `/api/devices`, with a session minted by DEV_AUTH (`POST /auth/session`).
- **The web side.** Playwright (Chromium) against `localhost:5173`. It clicked the note's Copy Agent Reference and read `navigator.clipboard`, and it wrote and read comments in the real Comments tab. A 390 px phone viewport was used for the table check.
- **Test note.** "T52 Android check" in a new folder "T52 Android", made with New Note Here. It holds a paragraph with five symbols and a table whose first cell has symbols. It also has three comment threads: one on the note from the phone, one on the note from the web, and one on the web on the passage "Budget".
- **Shared settings.** No synced setting was changed. The Personal heading's sort was switched to A–Z and back to Manual (`rootSortMode` is `manual` again). `GET /api/settings` matched the saved baseline at the end. A note made in another agent's notebook ("T52 notebook note", in "Work …") was moved to Trash.

## The items

| # | Item | On Android | Outcome | Evidence |
| --- | --- | --- | --- | --- |
| 1 | New Note Here | A folder's long-press sheet starts with New Note Here, then Rename, New Subfolder, Move to…, Turn into Notebook and Delete Folder…. A notebook's sheet ("Work …") starts with it too, before Rename, New Subfolder, Close on This Phone, Turn Back into a Folder… and Delete Notebook…. Tapping it made a note in that folder (crumb "T52 Android"), or at that notebook's top (crumb "Work …"), and opened it with the caret in the title and the keyboard up. | **Pass** | `android-01-folder-sheet-light`, `android-01-new-note-here-light`, `android-01-notebook-sheet-dark`, `android-01-notebook-new-note-dark` |
| 2 | Symbols in table cells | With the caret in a header cell, the bar's Symbol button is enabled (Indent is not), and the picker (★ ? ! 💡 →, Edit Symbols…) puts the symbol inline before the cell's text: `★ Budget`. Backspace at the start of the cell's text removed the last symbol, so `★ ! 💡 →` became `★ ! 💡`. The cell's node reads "★ Important ! Follow-up 💡 Idea: Budget". | **Pass.** Shared bug A was found here and fixed by the coordinator. | `android-02-cell-bar-light`, `android-02-cell-picker-light`, `android-02-bug-symbols-over-toolbar-light`, `android-02-toolbar-fixed-dark` |
| 3 | "+N" overflow | Before the text, at most three slots show. Five symbols on a paragraph show as `★ ? +3`, and four in a cell as `★ ! +2`. Three symbols show all three, with no chip. Tapping the chip opens a popover with every symbol in its colour: below the chip on a paragraph, and against the table on a cell. A tap elsewhere closes it, and tapping a glyph in it opens the picker with all five ticked. The paragraph's text starts after the chip. Screen readers still get every symbol's name: the widget's text is "★ Important ? Question ! Follow-up 💡 Idea → Next:". | **Pass** | `android-03-paragraph-overflow-light`, `android-03-paragraph-popover-light`, `android-03-paragraph-popover-dark`, `android-03-cell-overflow-light`, `android-03-cell-popover-light`, `android-03-glyph-opens-picker-light`, `android-03-overflow-dark`, `android-03-popover-after-fix-dark` |
| 4 | Copy Agent Reference | It is in three places: the note's ⋮ menu (after Copy Note as Rich Text), Home's selection bar ⋮ for one note (after Rename), and a search result's long-press sheet (after Rename). Each says "Copied Agent Reference". The text pasted from the clipboard is byte-identical to the web's for the same note in all seven cases checked (see Across the clients). | **Pass** | `android-04-note-menu-light`, `android-04-note-menu-dark`, `android-04-note-menu-copied-light`, `android-04-selection-menu-light`, `android-04-selection-copied-light`, `android-04-search-sheet-light` |
| 5 | Note comments | The Comments tab has Add Note Comment under its title. Its composer quotes "The note as a whole", and the thread it makes reads the same, with Edit, Reply, Resolve, Send to… and Delete Thread. The web listed it as "On the note as a whole". The web's note-level thread and its passage thread on "Budget" reached the phone live: note-level threads first, oldest first, then the passage thread ("Comments, 3 open"). There is no marker for a note-level thread. "Budget" is underlined, and tapping it opens its thread in the tab. | **Pass**, with fix 2 (the empty list's words). Decision 1 is about the wording. | `android-05-comments-tab-light`, `android-05-note-composer-light`, `android-05-note-composer-dark`, `android-05-note-thread-light`, `android-05-comments-from-web-light`, `android-05-comments-dark`, `android-05-markers-light`, `android-05-web-comments-light` |
| 6 | Panel modes | Web-only on purpose (A975). The phone's panel is T51's full-screen panel with Metadata, Comments, Version History and Local Graph, plus Close Panel. Its ⋮ menu has no "Note Panel: <mode>" item, and there are no Hidden, Compact or Expanded settings. | **Pass after fix 1.** With the keyboard up in the note, opening the panel left the hidden note taking the typing. | `android-06-panel-metadata-light`, `android-06-panel-keyboard-away-dark`, `android-05-comments-tab-light` |
| 7 | Less room below the note | The bottom space is the web's (A975), not checked further here | **N/A** | — |
| 8 | New Note in the row of icons | The FAB stays (A975). Home's row is Search, Today, This Week, Graph and Commands, with no New Note, and the floating New Note button is bottom right. | **Pass** | `android-10-home-bar-light`, `android-10-home-bar-dark` |
| 9 | No Top Level label | Home never had one (A974) | **N/A** | — |
| 10 | Notebook bar | The Personal heading reads: name, dot, then Sort, New Folder and Trash as icons. They line up under the top bar's Sync Now, Settings and More Options. Each has a tooltip on long press ("Sort Order for Personal") and a content description. Sort is gone from the top bar. Sort's menu is Manual, A–Z and Last Modified, as radio items: the order in use is `checkable` and `checked`, the others `checked=false`. Picking A–Z sorted the folders (Archive, Before, Desk…), said so, and moved the check; Manual put it back. New Folder opened the New Folder dialog, which made "T52 Android". On a 320 dp phone, at font scale 1.0 and 2.0, the bar fits on one line, with room between the dot and the icons. | **Pass** | `android-10-home-bar-light`, `android-10-home-bar-dark`, `android-10-sort-menu-light`, `android-10-sort-menu-dark`, `android-10-sort-az-light`, `android-10-narrow-320dp-dark`, `android-10-narrow-320dp-font200-dark` |
| 11 | Accent name, dot by shape | "Personal" is in the accent: #3c7a4b on #fbfaf7 is 4.93:1 in light, and #7fbf8e on #161a17 is 8.16:1 in dark, measured from the screen. The dot is a solid accent dot when synced ("Synced at 1:42 AM"). It is a muted hollow ring offline, with the Worker's reverse removed ("Offline: showing what's on this phone"). Stopped is a ring, a gap and a dot in the error colour. A row of pixels through its centre reads ring 4 px, gap 4 px, dot 10 px, gap 4 px, ring 4 px (1.5 dp, 1.5 dp, 4 dp at 420 dpi). It reads clearly at 10 dp in both schemes. | **Pass** (see note on stopped) | `android-10-home-bar-light`, `android-11-dot-offline-light`, `android-11-dot-stopped-light`, `android-11-dot-stopped-dark`, `android-11-dot-stopped-zoom` |
| 12 | Rail and traffic lights | Mac and web only | **N/A** | — |

**On "stopped".** No way to make this phone's sync stop could be found against the local server. Revoking the phone's device (`DELETE /api/devices/:id`) is a 401, which signs the phone out at once (A283): it showed "Penmoss signed this phone out", not a stopped dot. A 403, refused notes and full storage could not be arranged. So the bullseye was drawn by a throwaway build whose Home dot was forced to `DotState.STOPPED` (a one-line change in `Screens.kt`). That build was screenshotted in light and dark, then the file was restored from a copy and the APK rebuilt and reinstalled. The rule that picks STOPPED is covered by `NotebookHeadingTest`.

**TalkBack.** TalkBack 17 is installed, but on this emulator it got no TTS engine and did not take injected taps, so the Sort menu's reading was checked through the accessibility tree that TalkBack reads: the menu item of the order in use is a radio item with `checked=true`.

## Across the clients

| Check | Android → web | Web → Android |
| --- | --- | --- |
| Copy Agent Reference, same note | Identical bytes (`diff`) for seven notes: the test note via the ⋮ menu and Home's selection bar; a note in a notebook (`… (id …; QDK mvxdde20585)`); one two folders down (`Personal › Garden … › Beds …`); a journal note (`Personal › Journal › 2026 › 11`); a top-level note (`Personal`); a title with quotes and a backslash, from the search sheet (`"Here xgq0l7 \"q\" \\ end"`); and a note made with New Note Here at a notebook's top (`Work mvxgi8u1501`). The web's text was read from `navigator.clipboard` after its top bar's Copy Agent Reference. | (same pairs) |
| Note-level comment | Made on the phone; the web's Comments tab lists it first, "On the note as a whole", by "Android app (sdk_gphone64_arm64)" | Made in the web's tab with Add Note Comment; the phone's tab lists it second (oldest first), "The note as a whole", by "Web browser" |
| Passage comment | — | Made on the web on "Budget" (a table cell); the phone lists it after the note-level threads with the quote "Budget", and underlines "Budget" in the note |
| Example reference | `Penmoss note "T52 Android check" (id 01M6AXR91RJJN4TTBY4Q0HMAW8; Personal › T52 Android)`<br>`Read it with the Penmoss MCP tool read_note {"id":"01M6AXR91RJJN4TTBY4Q0HMAW8"}` | |

## Bugs found and fixed (Android)

| # | Bug | Cause | Fix | Test that failed first |
| --- | --- | --- | --- | --- |
| 1 | **Typing went into the hidden note while the panel was open.** With the caret in the note and the keyboard up, opening the panel (the bar's Comments, Info, or a commented passage) left the keyboard up. What was typed with no panel field chosen went into the note behind the full-screen panel ("zz" ended up in the note). `dumpsys input_method`: `mInputShown=true`, served view `SelectionWebView`. Pre-T52 (T51's panel); found here while testing comments. | `NotePanel` is a Compose `Surface` over the note. It never took the focus, so the page's WebView kept it and kept the keyboard's connection. | `apps/android/app/src/main/java/app/penmoss/ui/NotePanel.kt`: the panel's Surface is a focus target. On showing, it requests the focus, which takes it from the page, and hides the keyboard. A field tapped in the panel raises it again. On the emulator, after the fix: `mInputShown=false` once the panel opens, and "zz" no longer reaches the note. | New `NotePanelTest.thePanelTakesTheFocusFromThePageItCovers` (a focusable view stands in for the page; it kept the focus without the fix) |
| 2 | **The empty Comments list named the buttons wrongly.** "…, or use New comment." The button is "New Comment" (Title Case, A938), and since T52 the tab also offers Add Note Comment, which the web's empty list mentions. | Text from T48, not updated in T51's Title Case pass or for T52's note comments | `CommentsSheet.kt`: "No open comments. Select text in the note, then Comment, or use New Comment or Add Note Comment." | `CommentsSheetTest.theEmptyListNamesNewCommentAndAddNoteComment` |

Each test was run first without its fix and failed (`expected:<false> but was:<true>`, and the old words), then passed with it.

## Follow-up: a top-level note's crumb names its notebook

The web's phone app bar now names a top-level note's notebook instead of "Top level" (the default notebook's current name, or a git notebook's). It says "Top level" only when no notebook is known. Android's note breadcrumb now does the same.

- **Change.** `BreadcrumbBar` (`apps/android/app/src/main/java/app/penmoss/ui/FolderScreens.kt`) takes the notebook's name for an empty path, isolated (FSI…PDI) like any other name. `NoteScreen.kt` passes the git notebook's name or the default notebook's current one, from `observeDefaultNotebookName`, the source A475's Notebook row uses. A note in folders still shows only its folders.
- **Unchanged.** "Top level" as a destination you pick (`FolderChoice`, Move to Folder…). Also the Metadata tab's Folder row, which reads "Top level" under its own Notebook row, as the web's Info panel's Folder row does (`NoteInfo.tsx`).
- **Tests.** `FolderScreensTest.aTopLevelNoteNamesItsNotebook` (the crumb reads "Personal", not "Top level", and a tap still opens the top level) and `aNoteInFoldersShowsOnlyItsFolders`. They did not compile against the old `BreadcrumbBar`. `aTopLevelNoteSaysSo` still covers the case with no notebook.
- **Emulator.** On the rebuilt APK, the top-level note "Axe themes …" shows "Personal" in its bar in light and dark. A tap opens Home at the Personal heading. A note two folders down still reads "Garden … › Beds …". Its Metadata tab reads Notebook "Personal" and Folder "Top level". The web at 390 px shows the same crumbs for both notes ("Personal", and "Garden … › Beds …"). Evidence: `android-10-top-level-crumb-light`, `android-10-top-level-crumb-dark`.

## Found here, fixed in shared code

- **A. A line's symbols drew over a table's toolbar** (web at 700 px and below, and Android). T52 made the before-the-text widget `position: relative`, in `blocks.css`' narrow rule and `android.css`. Its `.pm-symbols { z-index: 4 }` then took effect above `.pm-table-toolbar { z-index: 3 }`. A paragraph with symbols directly above a table showed `★ ? +3` painted over the toolbar's first buttons. In Chromium at 390 px, `elementFromPoint` there gave `.pm-symbol`. This was reported to the coordinator, who fixed it with `z-index: auto` on the before-the-text widget (`apps/web/src/blocks.css` in the narrow media query, `apps/android/editor/src/android.css`), with 6 kept while it is open or hovered. Checked after the fix: on the rebuilt APK the toolbar covers the symbols and the "+3" popover still opens over the table below. At 390 px the widget's `z-index` is `auto` and `elementFromPoint` gives a toolbar `BUTTON`. Evidence: `android-02-bug-symbols-over-toolbar-light`, `android-02-web-narrow-same-bug-light` (before), `android-02-toolbar-fixed-dark`, `android-03-popover-after-fix-dark`, `android-02-web-narrow-fixed-light` (after).

## Decisions needed

1. **"The note as a whole" or "On the note as a whole".** A973 and the phone say "The note as a whole" for a note-level thread and its composer. The web's list and its Add Note Comment composer say "On the note as a whole", with a comment icon. The web keeps "The note as a whole" only as a fallback quote. `CommentsSheet.kt` calls its words "the web's words". One of them should change: the phone to "On the note as a whole" (and A973 with it), or the web to A973's words.

## Logcat

`adb -s emulator-5556 logcat -d | grep -iE "penmoss|AndroidRuntime"` over the pass, and the crash buffer (`logcat -b crash`), show no crash, no `FATAL EXCEPTION` and no uncaught WebView error in `app.penmoss.debug`. What remains is `uiautomator` and `monkey` runtime lines and `AccessibilityNodeInfoDumper` "Skipping invisible child" notes from the dumps.

## Tests run

On the working tree, with fixes 1 and 2 and the shared fix A:

| Suite | Result |
| --- | --- |
| `task android:test` (app Robolectric, engine-bridge JVM) | 1,224 app tests and 226 engine-bridge tests: 0 failed, 0 skipped (after the follow-up) |
| Android editor (`vitest run` in `apps/android/editor`) | 255 passed. One of four runs timed out on `git-page.test.ts` "a pass and Save … over 4 MB" (5 s), with Gradle running alongside. It passed in the other three; it is T50's, not touched here. |

New tests: `NotePanelTest.thePanelTakesTheFocusFromThePageItCovers`, `CommentsSheetTest.theEmptyListNamesNewCommentAndAddNoteComment`, and `FolderScreensTest`'s `aTopLevelNoteNamesItsNotebook` and `aNoteInFoldersShowsOnlyItsFolders`.

## Afterwards

Night mode is off, the screen size and font scale are reset, and the `adb reverse` rules for :5173 and :8787 are removed.
