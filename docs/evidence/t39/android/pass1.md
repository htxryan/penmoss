# T39 pass 1 · Android

Findings log for the first UX fidelity and hardening pass on the Android app (issue #74), 24 Oct 2026. Each finding has its fix and evidence, or the reason it waits.

## How it was run

- Android emulator on the agent worker: API 36 Google APIs x86_64 image, a Pixel-like AVD (1080×2400, 420 dpi), headless with `swiftshader_indirect`, 2 cores and 1.5 GB of RAM. A 2 GB AVD and an API 37 image were tried first: the emulator ran out of memory, and API 37's screen capture crashed.
- A local Worker (`wrangler dev --local`) with a seeded vault. The vault has 55 notes in 17 folders, one folder 9 levels deep and one with a very long name. It also has long notes, code, tables, pictures, tags, wikilinks, very long titles and 4 daily notes. The app signed in through the real flow (Custom Tab, approval page, deep link) against the built web app on `localhost:5174`.
- The phone was driven with `adb` and screenshots, and the WebView was inspected over CDP. The one-off scripts for this (seeding, emulator start, taps) were throwaway and are not kept. The phone was tested in light, dark and 2× font, in portrait and landscape, offline (Worker stopped), across process death, and with quick repeated taps.
- Screenshots are scaled to 1080 px tall.

## Findings and fixes

| # | Finding | Fix | Evidence and tests |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | **Two quick taps on a top-bar Back arrow emptied the back stack and left a blank window.** Two quick taps on a note opened it twice. | Navigation acts only from the resumed entry; a second tap during the transition does nothing (A387). | [before](before-double-back-blank.png) → [after](after-double-back.png). `NavigationTest` (failed before: back stack `[]`, the note twice). |
| 2 | **The slash and `[[` menus collapsed into a sliver a few pixels tall.** The WebView had a wrap-content height, so the page's viewport height was 0 and the menus' height cap (`vh`) was 0. | The WebView fills its slot (A393). | [before](before-slash-menu.png) → [after](after-slash-menu.png). |
| 3 | **A long title in the `[[` menu made the menu wider than the screen** (839 CSS px), which scrolled the page sideways. | Shared with the web: both menus shift to stay 8 px inside the viewport, are at most the viewport less 1 rem wide, and end long names with "…" (A393). | [before](before-link-menu.png) → [after](after-link-menu.png). |
| 4 | **Material's baseline purple leaked into the theme:** the Today button, chips, the progress track, the tonal tint and the snackbar's action. | Every colour role is set from the theme's tokens (A388). The review found the dark snackbar still lavender, its action at 3.68:1: the inverse roles now come from the theme too, the action at 4.5:1 or more. | [before](before-home-theme.png) → [after](after-home-theme.png), [dark](after-home-dark.png). `AppearanceTest.noColourRoleIsLeftAtMaterialsBaselinePurple` (failed before), `…aSnackbarIsTheThemeTurnedOverWithAReadableAction`. |
| 5 | **A long note title was cut off** in the one-line title field. | The title wraps; a line break typed or pasted into it becomes a space (A389), as on the web. | [before](before-long-title.png) → [after](after-long-title.png). Page test "keeps a pasted title on one line" (failed before). |
| 6 | **Settings signed out with one tap,** removing every note from the phone without asking, unless something was unsent. **Discard on a refused capture** deleted its text at once. | Both ask first (A386). | [before](before-sign-out-one-tap.png) → [after](after-sign-out-dialog.png). `ScreensTest.aCaptureThatCannotGoCanBeCopiedTriedAgainSentWithoutItsPicturesOrDiscarded` now confirms the discard; `…discardOnARefusedCaptureCanBeCancelled`, `…signOutAsksFirstAndCancelKeepsTheSignIn`, `…signOutWithRefusedCapturesSaysTheyGoAndOffersToCopyThem`. |
| 7 | **New note opened with no keyboard,** so a second tap was needed before typing, though the caret was in the title. | A new note raises the keyboard once the page is ready (A392). | [before](before-new-note-no-keyboard.png) → [after](after-new-note-keyboard.png). |
| 8 | **Search: an outlined box crammed inside the top bar,** and a one-line excerpt that often cut off before the matched word ("…the ga…"). | The field is the bar, with Clear, and the keyboard's search key hides the keyboard. A server result shows two lines with the matched words in bold (A395). | [before](before-search.png) → [after](after-search.png). `ItemsTest.findsWhereASnippetMatched`, `ScreensTest.searchShowsTheMatchedWords`. |
| 9 | **Home flickered every minute:** the status switched to "Syncing…" and a progress bar flashed for each background pass. There was no way to ask for a sync. | Pull to refresh, and **Sync now** in the top bar for TalkBack, Switch Access and anyone who doesn't pull; the spinner ends when the pass it asked for ends. The bar shows only for a pass over a second. The status keeps the last result while a pass runs (A390). Home's note list also gained a **Recent notes** heading, matching **Folders** above it. | `ScreensTest.homeShowsTheSyncBarOnlyForASlowPass`, `…syncNowOnHomeAsksOnceAndIsBackWhenItsPassEnds`; `SyncStatusTest.syncNowWaitsForItsOwnPassAndNoLonger`. |
| 10 | **A server failure was shown as "Offline".** | A 5xx or unreadable reply says "Penmoss couldn't sync just now and will try again"; "Offline" is kept for no network (A390). | `SyncStatusTest` (failed before). Offline with the Worker stopped: [after](after-offline-status.png). |
| 11 | **A note that could not be fetched was a dead end:** "isn't on the phone yet" with nothing to press, and it stayed so after the network came back. | **Try again**, and the note opens by itself when a sync pass brings it (A391). The review found it blank on a phone: the screen built a second WebView. The editor now stays on screen, hidden under the message, so the note opens on its one page. | `NoteEditorControllerTest.aNoteThatCouldNotBeFetchedOpensOnceTriedAgainOnline`, `…OpensWhenSyncBringsIt`, `…aPageReadyBeforeTheFetchFailedGetsTheNoteOnceTriedAgain`, `…OnceSyncBringsIt`, `…aPageThatLoadsAgainGetsTheNoteAgain`; `NoteBodyTest.tryAgainOpensTheNoteOnTheSamePageAndBuildsNoOther`; `ScreensTest.aMessageOffersItsAction`. |
| 12 | **Search could show a stale answer:** a search cancelled by a newer query was caught as a failure and replaced the newer results with the offline notice. A revoked sign-in during search did not sign the phone out. | Cancellation is rethrown; a 401 in search signs out as sync does. | Code review; covered by the search flow on the emulator. |
| 13 | **Sign-in text was left-aligned under a centred title and code.** | Centred. | [before](before-sign-in-code.png) → [after](after-sign-in-code.png). |
| 14 | **The launcher icon was a square drawing inside the launcher's white circle,** with no themed icon. | An adaptive icon: the nib on the accent green, with a monochrome layer (A394). Superseded by the Moss Pen logo (A402); `after-launcher-icon.png` shows the interim nib icon, which never shipped. | [before](before-launcher-icon.png) → [after](after-launcher-icon.png). |

## Hardening checks that needed no change

- **Process death mid-edit.** Typed into a long note, pressed Home, then `am kill`: reopening restored the same note with the text ([after](after-process-death-mid-edit.png)). Sign-in also survives process death.
- **Rotation.** The editor in landscape keeps its column width and the formatting bar ([after](after-landscape-editor.png)); rotating back keeps the text.
- **Large font (2×).** Home's Today and All notes buttons, folders and the status line fit without clipping ([after](after-home-large-font.png)).
- **Dark mode.** Home's text and controls have enough contrast, and its accent comes from the theme ([after](after-home-dark.png)).
- **Offline.** With the Worker stopped, Home says "Offline: showing what's on this phone" ([after](after-offline-status.png)). Note that `adb reverse` ignores the emulator's radios, so offline was tested by stopping the Worker.
- **Share target.** Sharing text from another app opens the capture sheet over Home, and Save files it in Today's note.
- **Rapid taps.** Covered by finding 1 and by A362 (New note).
- **Logcat.** There were no crashes, no app `E/` lines and no StrictMode violations from the app. The only app error is a `hiddenapi` notice from Compose's accessibility code (`AccessibilityNodeInfo.setSelection`), which comes from the library.

## Not checked here, and why

- **Frame timing.** On the emulator, `dumpsys gfxinfo` while flinging All notes reported 84% janky frames (median 109 ms; [the numbers](gfx-allnotes.txt)). The emulator renders in software (SwiftShader) on 2 shared cores with a debug build, so these numbers say nothing about the Pixel. The real check is `NoteListJankTest`, which flings 5,000 notes on the Pixel and fails if over 5% of frames are janky (A285).
- **1,000+ notes, low memory and battery saver on the device.** These were not run, to keep the shared emulator lock short (Ryan asked that emulator sessions stay brief). Coverage today: `NoteListJankTest` (5,000 notes on the Pixel) and the T35 background-sync checklist (battery saver, Doze) in `docs/android.md`.
- **Server 500 and a revoked token on the device.** These are covered by `SyncStatusTest` and the new `SyncStatusTest.aRevokedSignInSignsOut` and `NoteFilerTest.aRevokedTokenStopsThePass`; the emulator session was kept to the visual checks.
- **TalkBack.** Labels were checked in the accessibility tree (`uiautomator dump`): the icon buttons seen (Search, Settings, New note, Clear, the note menu) have labels. A spoken TalkBack pass needs the Pixel.

## Proposals and deferred items

1. **Search ranking.** For "garden", notes that mention the word in their text rank above "Garden plan 2027", whose title matches. The web shows the same order, because ranking happens on the server (FTS5 bm25). Proposal: weight title matches higher in the server's query. This is a server change for its own task, with a ranking test.
2. **Back from an empty new note keeps an "Untitled" note.** The web behaves the same way. Proposal: a new note left with no title and no text is moved to Trash on leaving, on all clients. This is a design choice for Ryan.
3. **Today needs the network.** This is known (A356) and is planned in T40 P5.
4. **The title and a first heading look alike.** In "A very long note for scrolling", the title and the "Part one" H1 are almost the same size and weight. Proposal: set the title one step larger, or give it more space below, on all clients.
5. **The formatting bar stays while the caret is in the title,** where its buttons do nothing. Proposal: disable or hide the bar while the title has focus.
6. **The share sheet shows a shared link as `<https://…>`** (its Markdown autolink form) in the text box. Proposal: show the plain address and add the brackets when saving.
7. **The widget's corner radius** does not follow the launcher's (minor). Proposal: use `system_app_widget_background_radius` on Android 12+.

## Tests and assertions changed on purpose

- `ScreensTest.aCaptureThatCannotGoCanBeCopiedTriedAgainSentWithoutItsPicturesOrDiscarded`: Discard now opens a dialog. The test checks the dialog, checks that nothing is discarded before confirming, and confirms with `refusedDiscardConfirm` before its last assertion.
- `apps/android/editor/test/host.test.ts`: the `page()` helper builds the title as a `textarea`, as the page now does.

No test was skipped or weakened, and no timeout was raised.
