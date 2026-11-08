# T51 on Android · the UX pass on the emulator

The manual pass of T51's 21 items ([issue #175](https://github.com/htxryan/penmoss/issues/175), D44, A932–A950) on Android, with consistency checks against the web app through the same local server. The web and Mac pass is in this folder's `web-*` and `mac-*` files.

## How it was run

- **Device.** AVD `penmoss37` (API 37, 1080 × 2400), `emulator-5556`, light and dark. Dark was the emulator's night mode (`cmd uimode night yes`) with Penmoss on System, so the synced `theme.mode` was never changed.
- **Build.** The debug APK from `codex/t51-ux-polish` (base `21d30f1`), rebuilt with `task android:build` after each fix below and installed with `adb install -r`. The follow-ups (changes 6–9) were made on `a2bc808` and checked again the same way.
- **Server.** `task dev` from the same worktree: Vite on :5173, the Worker on :8787 with DEV_AUTH, reached through `adb reverse`. The phone signed in through its normal flow: Sign In, then the code, then Approve on `localhost:5173`.
- **Driving.** `adb shell input`, `uiautomator dump` for labels and content descriptions, and `screencap`. Gestures that `input` cannot make (a pinch, an exact double tap) went into the editor's WebView through Chrome DevTools (`Input.dispatchTouchEvent` over `webview_devtools_remote`). A real double tap was also made with two `input tap`s 150 ms apart.
- **Server reads.** `GET /api/settings` with a session minted by DEV_AUTH (`POST /auth/session` from the Worker's own origin).
- **The web side.** Playwright scripts against `localhost:5173`, which read computed fonts, labels and settings, and change Appearance, Symbols, Daily Notes and the note's ⋯ menu in the real UI.
- **Test note.** "T51 Android check": two pictures, an open comment thread, links to two notes and an inline `#t51test`.
- **Shared settings.** Every synced setting changed here was put back exactly as it was before the pass (`font.*`, `symbols.list`, `quickAccess.notes`, `capture.destination`, `sidebar.thisWeek`, `sidebar.commands`). `GET /api/settings` matched the saved baseline afterwards, after both the first pass and the follow-ups.

## The items

| # | Item | On Android | Outcome | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Sidebar nav as icons | Home's row: Search, Today, This Week, Graph, Commands. Each has a tooltip on long press and a content description, and each opens its screen. Home's ⋮ no longer has Graph or Commands. Display hides This Week and Commands, Search stays, and the web's row hides the same two. | **Pass after fix 2.** Search was drawn without its handle and Graph without one edge. | `android-01-home-row-before-fix-light`, `android-01-home-row-light`, `android-01-home-light`, `android-01-home-dark`, `android-01-row-tooltip-light`, `android-01-display-hides-dark` |
| 2 | Sync status as a dot | The account's dot sits on the personal notes' heading, named by the default notebook ("Personal"), as the web's Personal heading. It is never on "Notebooks", and each git notebook's row has its own dot. Accent while synced. Long press or tap shows its words ("Synced at 2:04 PM") and the content description holds them. With the Worker unreachable it turned muted with "Offline: showing what's on this phone". The polite live region above the list stays. | **Pass after change 7.** The dot used to sit on "Notebooks". | `android-02-sync-dot-light`, `android-02-sync-dot-offline-light`, `android-02-sync-dot-personal-dark`, `android-01-home-light`, `android-01-home-dark` |
| 3 | Tags panel collapses | Android has no tags panel on Home (A934) | **N/A** | — |
| 4 | Footer icons | Settings in Home's bar is the gear. Feedback stays in Home's ⋮ and in About as Send Feedback (A935). | **Pass** | `android-01-home-light` |
| 5 | Comments in the note bar | The bar has Info, Comments (badge "1", described "Comments, 1 open"), the sync icon and ⋮ | **Pass** | `android-05-note-bar-light`, `android-05-note-bar-dark` |
| 6 | Tabbed note panel | One full-screen panel with icon tabs Metadata, Comments ("Comments, 1 open"), Version History and Local Graph, plus Close Panel. Info opens Metadata and Comments opens Comments, as do the ⋮ items, and Back closes it. History shows the versions and the diff. Local Graph is drawn natively: "2 linked notes", the two neighbours listed, and Open Full Graph goes to the graph screen around the note, as the web's does (`graphPath(note, true)`). | **Pass after fix 2.** The Local Graph tab's icon had lost an edge. | `android-06-note-panel-{metadata,comments,history,graph}-{light,dark}`, `android-06-open-full-graph-light` |
| 7 | Grouped ⋮ menu | View Metadata, Comments (1), Version History, Local Graph, Markdown Source · Copy Note as Markdown, Copy Note as Rich Text · Find in Note, Word Count · Pin to Quick Access, Move to Folder…, Move to Trash. That is the web's three groups with Android's tools as a fourth. Add a Tag and Send Feedback are gone. | **Pass** | `android-07-note-menu-light`, `android-07-note-menu-dark`, `android-07-home-menu-dark` |
| 8 | Title Case | Menus, buttons, tabs, the Settings list, dialog titles and actions, content descriptions of icon buttons, and Search's actions. All 150 titles in `commands-v1.json` pass a Title Case check; the only small word capitalised is the particle in Sign In Again, which A938 allows. Filter values ("All folders", "Any tag") and prose stay in sentence case. | **Pass after change 9** (About's summary and Devices' sign-out name) | throughout, `android-14-settings-about-dark` |
| 9 | Glyph picker | Edit ★ has a grid of the presets (the web's list, `symbol-presets-contract.test.ts`) and a Custom Glyph field. Choosing ⚑ stored `{glyph: "⚑", name: "⚑"}`. | **Pass** | `android-09-glyph-picker-light`, `android-09-glyph-picker-dark` |
| 10 | Colour picker | Theme colour chips, then Custom Colour: the web's colour wheel (red at the top, hues clockwise, white at the centre, dimmed by brightness), then Brightness (black to the colour), Opacity (clear to the colour, over checks) and a Hex field. A tap at the wheel's top gave `#D51718`; a drag to its right gave `#8CD542`, hue 90°. `#C2185B` typed was stored as `#c2185b`, and the web drew ★ in rgb(194, 24, 91). | **Pass after fixes 4 and 5 and change 6** | `android-10-colour-picker-light`, `android-10-colour-picker-dark`, `android-10-wheel-picked-light`, `android-10-web-colour-wheel-light`, `android-10-web-symbols-custom-light`, `android-10-hue-before-fix-light` (the old pad's hidden spectrum) |
| 11 | No padding overlap | In the symbol dialog no field covers a button. With the keyboard up for Hex or Custom Glyph, the dialog sits above the keyboard and its body scrolls, with Remove, Cancel and Save in reach. Save tapped with the keyboard up saved the colour. | **Pass after change 8** | `android-11-hex-typed-light`, `android-11-hex-typed-dark`, `android-11-glyph-typed-light` |
| 12 | No symbol names | Rows show the glyph, its colour's name or hex, and "Symbol n"; no name is asked for. The move buttons say "Move ⚑ Up". | **Pass** | `android-09-12-symbols-light`, `android-09-12-symbols-dark` |
| 13 | Consistent dropdowns | Material components (A941) | **N/A** | — |
| 14 | Settings layout | Android keeps its collapsing top bar (A942) | **N/A** | `android-14-settings-light`, `android-14-settings-dark` |
| 15 | Back and Forward | The system back (A943). Back closes the panel, the lightbox, the capture sheet and the dialogs before leaving a screen. | **N/A** (system back checked) | — |
| 16 | Fonts | Settings → Appearance → Fonts: Interface Font and Note Font (Theme Default, System, Serif, Rounded, Humanist, Monospace, Custom…; the web's labels), and Note Font Size from 12 to 28. Serif and 20 px changed Home, Settings and the note. A custom "Comic Neue" was stored as `custom:Comic Neue` and fell back to the system sans on both. | **Pass after fix 3.** With Note Font set to Monospace, the note's title stayed in the interface font. | `android-16-font-picker-light`, `android-16-fonts-serif-light`, `android-16-home-serif-light`, `android-16-note-serif-20-light`, `android-16-fonts-from-web-light`, `android-16-note-title-before-fix-light`, `android-16-note-title-light`, `android-16-fonts-dark`, `android-16-custom-font-dark`, `android-16-web-note-serif-20-light` |
| 17 | Mac menu bar | Mac only | **N/A** | — |
| 18 | Quick Access | ⋮ → Pin to Quick Access: "Pinned to Quick Access.", Home's Quick Access section, then Unpin from Quick Access. Personal notes only. | **Pass after fix 1.** The server refused the pin, the phone said so in Settings and undid it. | `android-18-pin-snackbar-light`, `android-18-home-quick-access-light`, `android-18-home-quick-access-dark` |
| 19 | Quick Capture default | Settings → Quick Capture: Today's Note or New Note in Inbox. The capture sheet opens on the default each time. Choosing Today's Note in the sheet and saving left the default at `inbox`, and the next sheet opened on New Note in Inbox. | **Pass** | `android-19-quick-capture-setting-light`, `android-19-capture-sheet-light`, `android-19-capture-sheet-dark` |
| 20 | Image lightbox | The picture's tools have Open in Lightbox, and a double tap (real and over DevTools) opens it on the picture tapped (2 of 2 for the second). Controls: 1 of 2, Zoom Out, Zoom In, Reset, Close, Previous Image, Next Image and the caption, all named for TalkBack. Zoom In twice, then a drag panned; Reset fitted it; a double tap went 100 % → 200 % → 100 %; a pinch reached 400 %. Next went to 2 of 2, and Back closed the lightbox and stayed on the note. | **Pass with two findings** (bugs B and C): a double tap that opens it opens at 200 %, and there is no swipe | `android-20-image-tools-light`, `android-20-lightbox-light`, `android-20-lightbox-zoomed-light`, `android-20-lightbox-pinch-light`, `android-20-lightbox-next-light`, `android-20-lightbox-opened-zoomed-dark` |
| 21 | Traffic lights | Mac only | **N/A** | — |

## Across the clients

Each value was changed on one side and read back on the other: through `GET /api/settings`, on the web through Playwright, and on the phone after Sync Now.

| Setting | Android → server → web | Web → server → Android |
| --- | --- | --- |
| `font.interface`, `font.note`, `font.noteSize` | Serif, Serif, 20 → `serif`, `serif`, `20` → web body and note in the serif stack, note at 20 px (after fix 1) | Humanist, Monospace, 22 in Appearance → the phone's Fonts read Humanist, Monospace, 22 px, and the note is mono at 22 |
| `font.interface` custom | `custom:Comic Neue` → web `"Comic Neue", system-ui, …` | — |
| `symbols.list` glyph and colour | ⚑ with `#C2185B` → `{glyph: "⚑", name: "⚑", colour: "#c2185b"}` → web button "Colour of ⚑: #C2185B", glyph in rgb(194, 24, 91) | `#1565C0` typed in the web's wheel → the phone's row reads `#1565C0` |
| `quickAccess.notes` | Pin → `["01M69HVE…"]` → the web's QUICK ACCESS lists "T51 Android check" (after fix 1) | Unpin from Quick Access in the web's ⋯ → `[]` → Home's section is gone |
| `capture.destination` | New Note in Inbox → `inbox` → web Daily Notes has New Note in Inbox checked | Today's Note on the web → `daily` → the phone's Quick Capture reads Today's Note |
| `sidebar.thisWeek`, `sidebar.commands` | Hidden in Display → `false` → the web's row is Search, Today, Graph | — |

**Labels.** These match the web: the Settings section names (Appearance, Display, Symbols, Notebooks, Daily Notes, Keyboard Shortcuts, Git Mirror, Status, Devices and Agent Tokens), the font presets (core `FONT_PRESET_LABELS`), the capture choices, the menu items and the symbol actions. Android's own sections (Git Notebooks, Quick Capture, Sync and Storage, This Phone, About) are in Title Case too.

## Bugs found and fixed

| # | Bug | Cause | Fix | Test that failed first |
| --- | --- | --- | --- | --- |
| 1 | **The phone could not save Quick Access or Note Font Size.** Pinning showed "Pinned to Quick Access.", then Settings said "Penmoss didn't take your change to Quick Access, so it was undone: quickAccess.notes must be text, true, false or null." `font.noteSize` would have been refused the same way. | `parseSettingsChange` (`PUT /api/settings`, the phone's route) took a list only for `symbols.list` and otherwise only text, true, false or null, so a list of ids and a number were refused before `settingProblem` saw them. | `apps/server/src/do/settings.ts`: `quickAccess.notes` takes a list or null and `font.noteSize` a number or null. Their values are still checked by core's rules. | `apps/server/test/settings.test.ts` "takes a note size and a list of pins through PUT /api/settings, and puts them back" (400 for 200 without the fix) |
| 2 | **Icons drawn wrong.** Search had no handle and Graph (Home's row and the Local Graph tab) had no left edge; Git Notebooks' chevron was offset. | The web draws these as separate `<circle>`/`<rect>` and `<path>` elements, where `m` starts at the origin. Android joins them into one path, so after the closed shape `m20 20` moved relative to the shape's start, to (24.5, 31). | `SettingsIcons.kt`: Search, Graph and Terminal start their path with `M`. `EditorIcons.kt`: Checklist's equivalent relative `m` is written as the web's absolute path; it drew correctly. | New `IconPathsTest`: every point of every icon is on its 24-unit grid, and no path moves relative to a closed shape (Terminal and Search failed) |
| 3 | **The note title ignored Note Font.** With Monospace notes the body and headings were mono and the title was in the interface font. The web's title is in the note font. | `.android-note .doc-title` had `font: inherit`, which takes the page's `--pm-font`. | `apps/android/editor/src/android.css`: `font-family: var(--pm-font-body, var(--pm-font))`, the web's rule. | `writing.test.ts` "sets the title in the Note Font, as the web does, not the interface font" |
| 4 | **The hue slider hid its spectrum.** Only slivers of red and blue showed; Opacity had no gradient. | Material3's `Slider` draws opaque active and inactive tracks over the canvas behind it. | `ColourPicker.kt`: a `GradientSlider` whose tracks and ticks are clear, over its own gradient, with an outline. The wheel (change 6) replaced the hue slider; Brightness and Opacity use `GradientSlider`. | First `theHueSliderShowsItsSpectrum` (pixels at ⅓ and ⅚ were the moss-green track, `3c7a4b`, not green and magenta). It is now `theWheelShowsTheHuesAroundItAndBrightnessItsRamp`. |
| 5 | **Typing a hex quickly lost it.** Typing `#C2185B` ended as `#CC2211`. | `#C21` is a colour, so it was sent and came back as `hex` a frame later. By then the field held `#C218`, which doesn't parse, and the resync replaced it. | `ColourPicker.kt` remembers the colour it last sent and doesn't resync to its own echo. | `SymbolsScreenTest.aHexTypedQuicklyIsNotUndoneByItsOwnPrefix` (the frame clock paused between keys) |

Each test was run without its fix (a copy of the old file put back, then restored) and failed as described; with the fix it passes. After each fix the APK was rebuilt and the item checked again on the emulator.

## Follow-ups (after `a2bc808`)

| # | Change | Where | Test (fails without the change) |
| --- | --- | --- | --- |
| 6 | **The colour wheel.** Ryan asked for "an actual color picker (standard color wheel with manual hex/argb entry)". The square pad and hue slider gave way to the web's layout (`apps/web/src/shell/ColourPicker.tsx`): a hue and saturation wheel with the web's maths (`ColourWheel.point` and `position` are `colour.ts`'s `wheelPoint` and `wheelPosition`). A pick on a black colour turns it bright, as on the web. Then Brightness, Opacity over checks, the preview over checks, and Hex. With a keyboard, the arrows turn the hue and change the saturation (Shift for 10), as on the web. The stored values are unchanged: `#rrggbb`, or `#rrggbbaa` when not opaque, lower case. | `ColourPicker.kt` | `SymbolsScreenTest`: `theWheelShowsTheHuesAroundItAndBrightnessItsRamp` (red at the top, yellow-green right, cyan bottom, violet left; Brightness black to bright), `aTapOnTheWheelPicksItsHueAndSaturation` (hue 90 at the right edge, brightness kept), `theWheelsMathsAreTheWebs` (the cases of the web's `colour.test.ts`) |
| 7 | **The sync dot on the personal heading** (A933). The account's dot is on the personal notes' heading, which is always the default notebook's name, "Personal", as the web's. Before, it sat on "Notebooks" when there were notebooks, otherwise on "Folders", "Recent notes" or "Notes". It is never on "Notebooks" now, and "Recent notes" has no dot. With only the personal notes, Home's folders are under "Personal" instead of "Folders", as the web's tree is. Git notebooks already had a dot each on their rows, as the web gives each git notebook's section its own. | `screens/Screens.kt`, `Components.kt` (the unused `notesTitleDot` removed) | `NotebookScreensTest.homeListsTheOpenNotebooksFirstThenTheDefaultNotebooksFolders` (one dot, under the default notebook's heading, none under Notebooks); `ScreensTest`'s two Home tests (the heading named Personal with no notebooks; the dot on it with no folders) |
| 8 | **The symbol dialog above the keyboard.** It takes the safe drawing insets (the IME and system bars) with `decorFitsSystemWindows = false`, so it shrinks above the keyboard. Its body already scrolls, so Remove, Cancel and Save stay in reach. | `SymbolsScreen.kt` | Checked on the emulator in light and dark, typing in Hex and in Custom Glyph. Robolectric has no keyboard to raise. |
| 9 | **Labels.** Settings → About's summary is "Version … · Send Feedback". Devices' sign-out button is named "Sign Out <device>", as the web's `aria-label` is: the verb is Title Case, and the device's own label (such as "Web browser") stays as it was stored. Its confirmation, "Sign out Mac?", is a question, so it stays in sentence case. | `SettingsRoutes.kt`, `settings/DevicesScreens.kt` | `SettingsScreensTest`, `DevicesScreensTest` updated to the new words |

For change 7 the old `Screens.kt` and `Components.kt` were put back: the three Home tests failed, and they pass with the change.

## Found, not fixed here (shared code)

- **B. A double tap that opens the lightbox opens it at 200 %** (A948). Tapping a picture twice opened the lightbox already zoomed (`.pm-lightbox-level` 200 %, `scale(2)`), whenever the double tap was taken. The picture's `onDoubleActivate` opens it on the second tap's `pointerup`. Its `tapped` guard ignores only the following `dblclick` on that same element. The WebView's own double-tap `dblclick` arrives after the lightbox is open, lands on `.pm-lightbox-img`, and that image's own `onDoubleActivate` zooms it. The fix belongs in `packages/editor/src/lightbox.ts`, for example a `dblclick` within about 600 ms of opening is not a zoom. It likely affects touch on the web too.
- **C. No swipe between pictures.** docs/android.md's Pixel checklist says "swipe through the note's pictures", but the shared lightbox has only Previous/Next and the arrow keys (A948 names those), so a swipe at 100 % does nothing. Either the lightbox gets a swipe or the checklist is reworded.

B and C are being handled in `packages/editor` and the docs, outside this pass.

## Outside T51

- **The Metadata tab's tags and notebook (from before T51).** For the same note the web shows "In the text: #t51test" under Tags and a Notebook row. Android showed "No tags yet." and no Notebook row: its Info sheet never listed inline tags, which the web added in T41. **Fixed in the follow-ups.** The tab now lists a note's inline tags under its frontmatter tags as "In the text: #t51test", the web's words. They are the tags Room holds for the note (`observeTagsOf`, frontmatter and inline) minus the page's frontmatter tags, and "No tags yet." shows only when there are neither. A Notebook row comes first, before Folder, as on the web. It names the note's notebook: the default notebook's name ("Personal") or a notebook folder's, with "(closed on this phone)" for one closed here. As on the web, the row shows only when the personal notes have more than one notebook (the default and a notebook folder), and never in a git notebook, which has no notebooks in it (A912). Code: `ui/NoteInfo.kt` (`infoNotebook`, `rememberInfoNotebook`, `inlineTags`, `inlineTagsLine`, `infoRows`' `notebook`, `InfoSheet`'s `inline`) and `ui/NoteScreen.kt`. Tests: `NoteInfoTest`'s `theNotebookRowNamesTheNotesNotebookAsTheWebs`, `inlineTagsAreTheNotesTagsItsFrontmatterDoesNotHave` and `theSheetListsInlineTagsApartNotAsNoTags`, and `NoteRouteWiringTest.theMetadataTabListsInlineTagsAndTheNotesNotebook`, which fails (it times out waiting for the line) with the old `NoteScreen.kt`. With the final rule, `task android:test` ran 1,203 app tests and 225 engine-bridge tests: 0 failed, 0 skipped.

  **On the emulator** (emulator-5556, the debug APK from this branch, `task dev` from the same worktree, signed in through the DEV_AUTH approval page). A new note "Metadata check" got the body "Garden plans for spring #seedling", then `garden` through Edit Tags…. The Metadata tab showed the `#garden` chip with Edit Tags… and, below them, "In the text: #seedling"; there was no "No tags yet." With only the default notebook there was no Notebook row, and Folder came first (`android-metadata-tags-light`). After Home's ⋮ → New Notebook "Work", the same tab had Notebook "Personal" as its first row, above Folder "Top level" (`android-metadata-notebook-personal-light`). After Move to Folder… → Work it read Notebook "Work", Folder "Work", in light and dark (`android-metadata-notebook-work-light`, `android-metadata-notebook-work-dark`).

## Logcat

`adb -s emulator-5556 logcat -d | grep -iE "penmoss|AndroidRuntime"` over the whole pass: no crash, no `FATAL EXCEPTION` and no uncaught WebView error in `app.penmoss.debug`. The lines that remain come from elsewhere:

- the `uiautomator` and `monkey` runtimes;
- `FrameTracker` IME animation timeouts on the loaded machine;
- `InputDispatcher` "channel is unrecoverably broken" when `adb install -r` replaced the running app;
- a Chromium GL `FATAL` in `com.google.android.gms.ui`, Google Play services' own UI on the emulator's renderer, not Penmoss.

## Tests run

After the follow-ups, on the working tree:

| Suite | Tests | Result |
| --- | --- | --- |
| `task android:test`: app (`testDebugUnitTest`, Robolectric) | 1,199 | 0 failed, 0 skipped |
| `task android:test`: engine-bridge (JVM) | 225 | 0 failed, 0 skipped |
| Android editor (`vitest run` in `apps/android/editor`) | 251 | 0 failed |
| Server, first pass: `settings`, `settings-keys`, `agent-activity`, `folder-scope` (each calls `PUT /api/settings`) | 238 | 0 failed |

New tests, first pass: `IconPathsTest` (1), `SymbolsScreenTest.aHexTypedQuicklyIsNotUndoneByItsOwnPrefix`, `writing.test.ts` "sets the title in the Note Font…", and `settings.test.ts` "Fonts and Quick Access from a phone".

New tests, follow-ups: `SymbolsScreenTest`'s `theWheelShowsTheHuesAroundItAndBrightnessItsRamp` (which replaces `theHueSliderShowsItsSpectrum`), `aTapOnTheWheelPicksItsHueAndSaturation` and `theWheelsMathsAreTheWebs`, plus the dot checks in `NotebookScreensTest` and `ScreensTest`.

Prettier and ESLint pass on the changed TypeScript, CSS and Markdown. `task check` and the E2E suites were not run here.
