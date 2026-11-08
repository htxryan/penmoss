# T53 on Android · the feedback pass on the emulator

The manual pass of T53's twelve items ([issue #181](https://github.com/htxryan/penmoss/issues/181), PR #182, D46, A976–A987) on Android, with checks against the web through the same local server. The web and Mac pass is in this folder's other files.

## How it was run

- **Device.** AVD `penmoss37` (API 37, 1080 × 2400, 420 dpi), `emulator-5556` only, in light and dark. Dark was the emulator's night mode (`cmd uimode night yes`) with Penmoss on System. A narrow phone was `wm size 840x1866` (320 dp), at font scale 1.0 and 2.0; font 2.0 was also tried at full width. All of these were reset afterwards.
- **Build.** The debug APK from `codex/t53-feedback-pass` (head `bbc33e8`), from `task android:build`, installed with `adb install -r`. It was rebuilt after the fixes below and checked again. The worktree had no `apps/android/local.properties`, so the first APK pointed at production. A gitignored one was added with `penmoss.appOrigin=http://localhost:5173` and `penmoss.apiOrigin=http://localhost:8787`, as in the T52 worktree.
- **Server.** `task dev` (Vite :5173, Worker :8787), reached through `adb reverse`. The Worker first ran without DEV_AUTH (there was no `.dev.vars`). The coordinator added one and restarted it. The phone signed in through its own flow: Sign In, the code, then Sign In Again and Approve in the emulator's browser.
- **Driving.** `adb shell input` (taps, `motionevent DOWN` for a held press), `uiautomator dump`, and `screencap`. Search was caught frame by frame with back-to-back `screencap`s. The clipboard was read by pasting (`KEYCODE_PASTE`) into Search's field. Item 11 compared rows of dark pixels in the body between screenshots.
- **Server reads.** `GET /api/settings` and `/sync/tree`, with a DEV_AUTH session (`POST /auth/session`). The recent count was unset with `PUT /api/settings` (`set` null).
- **The web side.** A standalone Playwright (Chromium) script against `localhost:5173`. It read the sidebar's sections, used the sidebar's ⋯ toggles, and read `navigator.clipboard` after the note's Copy Agent Reference.
- **Fixtures** (suffix `k4t53`, left in place). In Personal: folder "T53 Droid k4t53", holding notes Alpha, Beta and Gamma and subfolders SibFolder and SelFolder. Also "Top k4t53" at Personal's top level.

## The items

| # | Item | On Android | Outcome | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Rail highlights, journal current | Web and Mac only (A977); the phone has no rail | **N/A** | — |
| 2 | Search: spinner, no reordering | While searching, the status line shows a small spinner and "Searching…", with no progress bar. Results then show once ("30 results"), and frames up to 3 s later list the same order. Same in dark. | **Pass** | `android-02-search-spinner-light`, `android-02-search-frames-light`, `android-02-search-frames-dark` |
| 3 | Square corners | Square: TextButton (dialogs), Button (Comment), OutlinedButton (Symbols' Add a Symbol), FilledTonalButton (Duplicate Penmoss), a pressed IconButton's highlight, tooltips, segmented buttons, theme cards, menus, sheets, dialogs, fields, chips (Search filters, Edit Tags…), the FAB, and the panel strip's current tab. Round stays round: the sync dot, radio buttons, switch knobs and the spinner. No stock M3 button is imported outside `ui/square` (the FAB and SegmentedButton use SQUARE). | **Pass** (see decision 2) | `android-03-*`, `android-12-folder-sheet-light`, `android-04-notebook-longpress-light` |
| 4 | Notebook heading | The Personal row holds the name and the dot only. A long press offers New Note in This Notebook, Sort Order…, New Folder and Trash. New Note opened a note at Personal's top level (crumb "Personal") with the keyboard up. Sort A–Z sorted the folders (`rootSortMode` alpha), then Manual again. New Folder made "T53 Droid k4t53". Trash opened Trash. | **Pass** (see decision 1) | `android-04-notebook-heading-light`, `android-04-notebook-longpress-light`, `-dark`, `android-04-new-note-in-notebook-dark`, `android-04-sort-menu-dark`, `android-04-sort-az-dark`, `android-04-trash-dark` |
| 5 | Folder hover actions | Web and Mac only; Android keeps the long-press sheet (A980) | **N/A** | — |
| 6 | Mac menu bar icon | Mac only (A981) | **N/A** | — |
| 7 | Agent reference names the id once | Pasted from the note's ⋮: `Penmoss note "Alpha k4t53" (Personal › T53 Droid k4t53)` then `Read it with the Penmoss MCP tool read_note {"id":"01M6CC5PCM51V2BKE1NQ9YZ3P4"}`. The id appears once. The web's text for the same note is byte-identical. Search's sheet gave the same form for Beta. | **Pass** | `android-07-agent-reference-pasted-light`, `android-09-note-menu-light` |
| 8 | Sections, synced | Home follows `sidebar.sectionOrder`. A title's long press offers Move Up / Move Down / Hide «name», each sent to the server. ⋮ ends with Hide/Show for each, A to Z. Display has a switch per section, in order, and "Notes in Recent Notes" (− 10 +): 8 gave 8 rows on Home. **Phone → web:** hiding Quick Access and moving Recent below Notebooks showed the same in the web's sidebar. **Web → phone:** ⋯ Show Quick Access and ⋯ Hide/Show Notebooks reached the phone. That took 5 s with Sync Now, or 46 s on its own (the 60 s foreground pass, by design). | **Pass after fixes 2 and 3** | `android-08-home-order-light`, `android-08-section-longpress-*`, `android-08-home-menu-*`, `android-08-quick-access-hidden-light`, `android-08-settings-display-*`, `android-08-recent-count-8-light`, `android-08-web-after-phone-change`, `android-08-web-after-web-change`, `android-08-phone-after-web-hide-light` |
| 9 | Vertical note panel | The top bar is Back, crumb, Info, sync and ⋮, with no Comments. The panel has its tab's name and Close at the top, no tab row, and four tab icons (Metadata, Comments, Version History, Local Graph) down its right edge. The current one is marked. Tapping the open tab closed it, and so did Back. ⋮ → Comments opens it on Comments. | **Pass after fix 4** | `android-09-note-topbar-light`, `-dark`, `android-09-panel-metadata-light`, `android-09-panel-comments-light`, `android-09-panel-dark`, `android-09-panel-font200-after-fix-dark` |
| 10 | Quick Access | A long press offers Remove from Quick Access, Move Up and Move Down (only those that apply). Each changed `quickAccess.notes` as expected. Display's switch put "Personal" under each title. That switch is now "Show Notebook Names in Quick Access" (fix 5). | **Pass after fix 5** | `android-10-quick-access-longpress-light`, `-dark`, `android-10-quick-access-notebook-names-light`, `android-10-quick-access-removed-dark`, `android-10-settings-notebook-names-label-light` |
| 11 | Text holds still | A note with a list and a quote: the body's text rows are at the same y with the caret in the title, in the body, and 150 ms after the switch. Only the caret differs. | **Pass** | `android-11-caret-in-title-light`, `android-11-caret-in-body-light` |
| 12 | New Note/Folder Here | The folder sheet reads New Note Here, New Folder Here, Rename, Move to…, Turn into Notebook, Delete Folder…. Home's selection ⋮ and Search's sheet both start with New Note Here and New Folder Here. They made Beta and Gamma, and SibFolder and SelFolder, all inside "T53 Droid k4t53" (`/sync/tree`). | **Pass after fix 1** | `android-12-folder-sheet-light`, `-dark`, `android-12-selection-menu-light`, `android-12-search-sheet-light`, `android-12-new-folder-dialog-after-fix-dark` |

## Bugs found and fixed (Android)

Each test failed before its fix and passes with it: an assertion error, or for fix 1 a compile error, since `NewFolderDialog` is new.

| # | Bug | From | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | **New Folder Here opened a dialog titled "New Subfolder"**, the old command's name (A987). | T53 | `FolderScreens.kt`: new `NewFolderDialog` ("New Folder"). `PenmossRoot.kt` uses it for every folder made. | `FolderScreensTest.aNewFolderIsNamedInADialogCalledNewFolder` |
| 2 | **The Recent count's − and + had no names**: TalkBack would read "minus" and "plus" with no subject. | T53 | `settings/DisplayScreen.kt`: content descriptions "Fewer Notes in Recent Notes" and "More Notes in Recent Notes". | `DisplayAndSyncStopTest.theRecentCountsButtonsAreNamedAndStepTheCount` |
| 3 | **A section shown or moved to the top landed above the screen.** At Home's top, ⋮ → Show Quick Access, or Notebooks → Move Up, left the list where it was, so the change looked like it hadn't happened. The same happened when the web showed a section. The LazyColumn keeps its first visible item by key, and the zero-height first item is skipped as the anchor. | T53 | `screens/Screens.kt`: Home owns its `LazyListState`. When the sections shown change while the list is at its top, a `SideEffect` calls `requestScrollToItem(0)` before the next measure. Checked on the emulator for Show and Move Up. | `ScreensTest.aSectionShownOrMovedFirstAtTheTopStaysInView` |
| 4 | **Metadata labels broke mid-word with large text**: at font 2.0, "Noteboo / k", and at 320 dp "Noteb / ook", "Create / d", "Lengt / h". The label column is a fixed 35%, which the T53 strip makes narrower. | Earlier (T51's table), made worse by T53 | `NoteInfo.kt`: `InfoPair`. When the widest label won't fit in 35% on one line, every label goes over its value; otherwise the layout is unchanged. Used for the rows and Frontmatter. | `NoteInfoTest.labelsGoOverTheirValuesWhenTheyWouldBreakMidWord` (native graphics) |
| 5 | **The notebook-names switch didn't use A984's words.** Display said "Notebook under each Quick Access note", and the settings label (used when a refusal names settings) said "Notebook names in Quick Access". The web says "Show Notebook Names in Quick Access". | T53 | `settings/DisplayScreen.kt` and engine-bridge `settings/Settings.kt` (`SettingLabels`): "Show Notebook Names in Quick Access". Checked on the emulator. | `DisplayAndSyncStopTest.theRecentCountsButtonsAreNamedAndStepTheCount` (the switch's words), `SettingsContractTest` (`SettingLabels`) |

Files changed: `apps/android/app/src/main/java/app/penmoss/ui/{FolderScreens,PenmossRoot,NoteInfo}.kt`, `.../ui/screens/Screens.kt`, `.../ui/settings/DisplayScreen.kt`, `apps/android/engine-bridge/src/main/kotlin/app/penmoss/engine/settings/Settings.kt`, and tests `app/src/test/.../ui/{FolderScreens,DisplayAndSyncStop,Screens,NoteInfo}Test.kt` and `engine-bridge/src/test/.../settings/SettingsContractTest.kt`. Also a local, gitignored `apps/android/local.properties`.

## Not bugs, noted

- **Web → phone takes up to a minute.** Settings come with a sync pass: every 60 s in the foreground, on resume, or with Sync Now. There is no live push to the phone.
- **Same as the web:** the panel's heading is upper case (the web's `.note-side-head h2` too), and the Comments tab repeats "Comments" under it (the web's `CommentsPanel` has the same `<h2>`).
- A "Sync Now" tooltip showed once behind the New Folder dialog. It could not be reproduced.

## After the pass

Settled in review, to keep the clients alike:

1. **The notebook's dot sits at the row's far right**, as on the web (A979). `SectionTitleWithDot` gives the name the row; `NotebookHeadingTest` checks the dot's place. On the emulator: `android-30-moved-section-followed-dot-right`.
2. **Pill tracks stay.** The switches' and the font slider's tracks are Material's own controls, round by nature like the web's switch knobs; A976 now says so.
3. **Home follows a moved section.** After Move Up or Move Down, if the section's title isn't on screen, Home scrolls to it (`aSectionMovedFromFarDownIsFollowed`). On the emulator, Notebooks moved above Recent Notes from the bottom of Home stayed in view (`android-30-…`); the order was put back after.
4. **A dot that isn't syncing no longer animates.** Every dot ran its pulse all the time, drawing frames for nothing (pre-existing since T51); only a syncing dot pulses now.

## Shared settings

Baseline (`GET /api/settings` before) and final (after) are identical over all 12 keys. Only the keys I changed were restored, all from the phone except recentCount, which used the API:

| Key | Baseline | Final |
| --- | --- | --- |
| `sidebar.sectionOrder` | `["quickAccess","recent","notebooks","tags","calendar"]` | same |
| `sidebar.hiddenSections` | `[]` | same |
| `sidebar.recentCount` | unset | unset (`PUT` null) |
| `quickAccess.showNotebook` | `false` | same |
| `quickAccess.notes` | `[]` | same |

`rootSortMode` is `manual` again. `theme.*` and `sidebar.today`/`graph` were not touched.

## Logcat

`logcat -b crash` is empty, and there is no `FATAL EXCEPTION` for `app.penmoss.debug` over the pass. What remains is `uiautomator` runtime lines.

## Tests run

| Suite | Result |
| --- | --- |
| `task android:test` (app Robolectric, engine-bridge JVM), with fixes 1–4 | 1,233 app tests and 227 engine-bridge tests: 0 failed, 0 skipped |
| After fix 5: `DisplayAndSyncStopTest`, `SettingsContractTest` | 7 and 12 tests, 0 failed |

New tests: `FolderScreensTest.aNewFolderIsNamedInADialogCalledNewFolder`, `DisplayAndSyncStopTest.theRecentCountsButtonsAreNamedAndStepTheCount`, `ScreensTest.aSectionShownOrMovedFirstAtTheTopStaysInView` and `NoteInfoTest.labelsGoOverTheirValuesWhenTheyWouldBreakMidWord`, plus a `SettingLabels` assertion in `SettingsContractTest`.

## Afterwards

Night mode is off, the screen size and font scale are reset, and the `adb reverse` rules for :5173 and :8787 are removed.
