# T39 pass 2: Android findings log

Issue [#74](https://github.com/htxryan/penmoss/issues/74). Pass 2 is a fresh-eyes audit of the Android app after pass 1 ([pass1.md](pass1.md)), looking for what pass 1 missed: Back, keyboard insets, rotation, process death, TalkBack, long notes and many notes, offline to online, conflict copies, capture, the widget and the tile. The web and Mac app have their own pass 2 log in `docs/evidence/t39/web-mac/`. Gaps that belong to T40 (Android parity, `docs/evidence/t40/parity-matrix.md`) are not built here; the ones met on the way are listed under Deferred.

## How the app was used

- **Phone.** The pass 1 emulator: API 36 Google APIs x86_64, a Pixel-like AVD (1080×2400, 420 dpi), headless with `swiftshader_indirect`, 2 cores and 1.5 GB of RAM. Four sessions, each under 20 minutes, each holding the shared e2e lock from boot to shutdown, with the emulator stopped after each.
- **Server.** A local Worker (`pnpm run e2e:worker`) and the web app on Vite (`localhost:5173`, dev sign-in), reached from the phone through `adb reverse`. A debug build pointed at them through the git-ignored `local.properties`.
- **Vault.** Seeded through the API: 300 short notes, a 40-section note of about 9,000 words, 25 short "Idea" notes (used for the conflicts), a note with a table, a callout, a checklist and code, a very long title, and tags. The app signed in through the real flow (Custom Tab, approval page with its code, deep link).
- **Driving.** `adb` taps, the soft keyboard, `uiautomator dump` for labels and focus, and screenshots; `settings put system user_rotation` for rotation, `font_scale` for text size, `cmd uimode night` for dark, `am kill` and an app reinstall for process death, and stopping the Worker for offline. The scripts (session start and stop, taps and shots, seeding) were kept in a scratch folder, not in the repository.
- Screenshots are scaled to 1080 px tall. "Before" is `origin/main` (`59e3630`), "after" this branch.

## Findings → fixes

Evidence paths are relative to this folder.

| # | Finding | Fix | Evidence | Decision |
| --- | --- | --- | --- | --- |
| 1 | **A tap below a short note's text did nothing.** On a phone most of a short note's screen is blank, but the editor's box ends with its last line, so the first tap had to hit that line to start writing. | A tap on the blank page below the body puts the caret at the end of the note and raises the keyboard. Only a tap on the page itself counts (`html`, `body` or the note's root): the slash and `[[` menus, links and fields keep their taps, and a read-only note is left alone. | `pass2/before-tap-below-note.png` → `pass2/after-tap-below-note.png`; page tests in `editor/test/host.test.ts` | A527 |
| 2 | **The capture sheet threw away typed text without asking.** Cancel, Back and a tap outside the sheet all closed it at once. Pass 1 (A386) made Discard on a refused capture ask first, but not the sheet itself. | With text typed in the sheet, they ask "Discard this capture?" (Keep editing, Discard). An empty sheet, or one holding only text shared in, still closes at once; nothing asks while a save is in flight. | `pass2/after-capture-discard-ask.png`, `pass2/after-capture-landscape-discard-ask.png`; `CaptureActivityTest.textTypedHereIsThrownAwayOnlyOnceConfirmed` (fails without the fix), `…anEmptySheetClosesOnBackWithoutAsking` | A528 |
| 3 | **The capture sheet was unusable with the phone on its side.** With the keyboard up, the text box was squashed to a sliver under the title, and Save and Cancel were cut to a few pixels. | On a screen under 480dp tall and at least 600dp wide the sheet is one row: the text (up to two lines), the destinations, Cancel and Save, with the pictures count below. With large text, or where that row would leave the text under 200dp, the destinations take a second row, and the sheet scrolls to it when the keyboard covers it. The layout follows the screen's size and text size, not the room above the keyboard, so it does not switch (and drop focus) as the keyboard opens. The sheet keeps clear of the status bar, the cutout and the keyboard. | `pass2/before-capture-landscape.png` → `pass2/after-capture-landscape.png`; at 2× text: `pass2/after-capture-landscape-2x-keyboard.png`, `pass2/after-capture-landscape-2x-scrolled.png`, `pass2/after-capture-landscape-2x.png`; `CaptureActivityTest.onAShortScreenTheSheetIsOneRowWithTheTextAndSaveInView`, `…withLargeTextOnAShortScreenTheTextKeepsItsWidthAndSaveStaysInView` (both fail without the fix) | A529 |
| 4 | **Going offline was not announced to TalkBack.** Home's status line changed to "Offline: showing what's on this phone" (or that Penmoss couldn't sync, for a server failure) silently unless it had focus. | The status sits above Home's list, so it stays on screen however far the list is scrolled, and is a polite live region only while it says Offline or the server is failing (or a pass is running after either). Those are read out; the routine "Synced at…" is not, as on the web (A522). | `pass2/after-home-status-above-list.png`, `pass2/after-home-offline-scrolled.png`; `ScreensTest.homeStatusIsReadOutOnlyWhenItNeedsAttention`, `…goingOfflineIsReadOutWithHomesListScrolledDown` (fails without the move) | A530 |
| 5 | **The sign-in screen cut off its buttons in landscape and at large text.** Below the code, "Open the approval page" and "Start again" were off the screen with no way to reach them. | The screen stays centred when it fits and scrolls when it does not. | `pass2/before-sign-in-landscape-2x.png` → `pass2/after-sign-in-landscape-2x-top.png`, `pass2/after-sign-in-landscape-2x-scrolled.png`; `ScreensTest.onAShortScreenTheSignInCodeAndItsButtonsCanBeReached` (fails without the fix) | A531 |
| 6 | **A sign-in under way lost its code when the screen was rebuilt.** Changing the text size, or Android stopping the app while the browser was in front, brought back a bare "Sign in"; the approval page already open in the browser then matched nothing on the phone, and "Sign in" replaced it. | The pending sign-in already outlived the screen in the token vault; the screen shows it again, with the same code and approval page, for its 10 minutes. Approved after that, the callback is still refused, and the screen now says "This sign-in expired. Start again." instead of doing nothing. Checked both ways on the phone: a text size change, and a reinstall (the process killed) mid sign-in; approving afterwards signed the phone in. | `pass2/before-sign-in-code-after-rebuild.png` → `pass2/after-sign-in-code-after-rebuild.png`, `pass2/after-sign-in-approval-page-same-code.png` (the browser shows the same 846 401); `SessionManagerTest.aSignInUnderWayIsShownAgainWithTheSameCodeAndPageUntilItIsTooOld`, `…aSignInApprovedTooLateIsKnownToHaveExpired` | A532 |
| 7 | **A new sign-in repeated why the phone had been signed out.** After the server refused the token, "Penmoss signed this phone out. Sign in again to sync." stayed in red beside the new sign-in's code, which read as if the new sign-in had failed. | The reason shows until a sign-in starts; a failure of the new sign-in still shows. | `pass2/before-sign-in-stale-notice.png` → `pass2/after-sign-in-code.png`; `ScreensTest.aNewSignInDoesNotRepeatWhyThePhoneWasSignedOut` | none (a bug) |

## Checked, no change needed

| Area | Result |
| --- | --- |
| Back | Back in a note first closes the keyboard, then leaves the note; on other screens it goes back one step. In the capture sheet it now asks first (finding 2). |
| Keyboard insets | The tags sheet's field and its suggestions sit above the keyboard (`pass2/checked-tags-sheet-keyboard.png`); the slash menu at the end of a long note opens above the caret and the formatting bar (`pass2/checked-slash-menu-keyboard.png`); the formatting bar rides on the keyboard in portrait and landscape. |
| Rotation | Typing with the soft keyboard, rotating keeps the note, the caret and the keyboard. (An early report of lost focus came from `adb input text`, which leaves touch mode; it is not what a person sees.) |
| Process death | Sign-in survives it (as in pass 1), and so does a sign-in under way (finding 6). |
| Many notes | With 300 more notes, Home and All notes load and scroll in order, online and offline (`pass2/checked-many-notes-offline-home.png`). |
| Long note | The 9,000-word note opens and scrolls to its end, and the slash menu works there with the keyboard up. |
| Offline to online | With the Worker stopped, Home says Offline, an edit is kept on the phone (`pass2/checked-offline-edit.png`), and it reached the server within a pass of the Worker coming back. |
| Conflict copies | An offline edit to "Idea 07", then a server restore of that note: Home said that edits from this phone could not sync and are kept apart as conflict copies (`pass2/checked-conflict-home-notice.png`); opening the note showed the restored text and a snackbar naming "Idea 07 (conflict copy)" with Open (`pass2/checked-conflict-copy-snackbar.png`). |
| Capture | The sheet opens over the app and over the launcher with the keyboard up, and offers Today's note and New note in Inbox. |
| Widget and tile | The Capture widget in light and dark (`pass2/checked-widget-light.png`, `pass2/checked-widget-dark.png`) and the Quick Settings tile (`pass2/checked-tile-capture.png`) open the capture sheet with the keyboard up. |
| Large text and landscape | Settings at 2× text, in portrait and on its side, fits (`pass2/checked-settings-2x-landscape.png`). |
| TalkBack labels | In the accessibility tree (`uiautomator dump`), the icon buttons on Home and in a note have labels (Sync now, Search, Settings, New note, Back, the note menu). |

## Not checked here, and why

- **A spoken TalkBack pass.** TalkBack was turned on, but `adb` swipes do not move its focus on the emulator (it stayed on Back), so reading order and gestures need the Pixel. The live region (finding 4) and labels are covered by tests and the accessibility tree.
- **Fling smoothness of the long note.** Flinging it left blank bands for a moment on the emulator; SwiftShader renders in software on two shared cores, so this says nothing about the Pixel (pass 1 has the same caveat). `NoteListJankTest` covers the list on the Pixel; a long note has no such test yet (Deferred 5).
- **WebView renderer log lines.** Leaving a note sometimes logs a renderer exit (code -1) from the WebView. Nothing visible follows and the next note opens normally; it was not chased on the emulator.

## Proposals and deferred items

Not built here.

1. **The discard question closes when the phone is rotated** (the text stays in the sheet). The capture activity is rebuilt on rotation and the question is not kept. Proposal: keep `discarding` across the rebuild with `rememberSaveable` or a saved state.
2. **In landscape the formatting bar leaves a gap on the cutout side.** The bar follows the safe area while the page behind it reaches the edge. Proposal: let the bar's background reach the edge and inset only its buttons.
3. **Per-note sync state and a count of unsynced edits on Home** belong to T40 PL10.
4. **Heading semantics for the section titles on Home and in Settings** (TalkBack's heading navigation) belong to T40 PL14(f).
5. **A frame-timing test for a long note on the Pixel**, like `NoteListJankTest` for the list, would settle whether the blank bands are only the emulator's.
6. **A notice inside the note when a restore keeps this phone's edits apart** (the web's A525) is T40 NT21; the phone has Home's notice and the snackbar today.
7. Pass 1's proposals (search ranking, empty new notes, the title's size against a first heading, the formatting bar in the title, shared links in `<…>`, the widget's corner radius) are still open.

## After review

- **A527 took taps meant for the slash and `[[` menus.** Both menus sit on the page's body and close as they apply a choice, so a tap on an option bubbled up as a tap below the text: in a short note, "/" on a middle line then Heading 1 made the heading and moved the caret to the note's end. The handler now acts only on a tap on the page itself (`html`, `body` or the note's root). Two page tests open each menu on a middle line and tap an option low on the screen.
- **A529's row had no room at large text.** At 2× text on a phone on its side, the one row left the text a sliver and clipped Save. The row is kept only where the text keeps at least 200dp beside the destinations, Cancel and Save (their width grows with the text size); otherwise the destinations take a second row, and the sheet scrolls to it when the keyboard covers it.
- **A530's live region was in Home's list,** so with the list scrolled past it going offline was silent. The status line now sits above the list, always on screen.
- **A530 also covers a failing server:** the decision's wording now says so, as the code did.
- **A532: a sign-in approved after its 10 minutes** is still refused, and the screen says "This sign-in expired. Start again." rather than doing nothing.

## Tests

New, each failing without its fix unless noted:

- editor page, in `apps/android/editor/test/host.test.ts`: "puts the caret at the end of the note for a tap below its text"; "applies a slash-menu choice where it was typed, not at the note's end" and "links a [[ choice where it was typed, not at the note's end" (both fail on the first version of A527, the caret at the note's end); "leaves a read-only note alone when tapped below its text" (a guard; it passes either way);
- `CaptureActivityTest`: `textTypedHereIsThrownAwayOnlyOnceConfirmed`, `onAShortScreenTheSheetIsOneRowWithTheTextAndSaveInView`, `withLargeTextOnAShortScreenTheTextKeepsItsWidthAndSaveStaysInView` (fails on the first version of A529), and `anEmptySheetClosesOnBackWithoutAsking` (a guard);
- `ScreensTest`: `onAShortScreenTheSignInCodeAndItsButtonsCanBeReached`, `homeStatusIsReadOutOnlyWhenItNeedsAttention`, `goingOfflineIsReadOutWithHomesListScrolledDown` (fails with the status in the list), `aNewSignInDoesNotRepeatWhyThePhoneWasSignedOut`;
- `SessionManagerTest`: `aSignInUnderWayIsShownAgainWithTheSameCodeAndPageUntilItIsTooOld`, `aSignInApprovedTooLateIsKnownToHaveExpired`.

No existing assertion was changed or weakened, no test skipped, no timeout raised.

## Verification

On the worker, each heavy run alone under the shared lock:

- `task check`: green.
- `task android:test`: green (the engine and bridge tests, the app's Robolectric tests and the instrumented test build).
- The fixed build on the emulator for findings 1, 2, 3, 5, 6 and 7, as in the screenshots, and after review for findings 3 (2× text on its side, with and without the keyboard) and 4 (Home scrolled down, then offline).
