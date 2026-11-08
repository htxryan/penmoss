# T2 Android editor spike (go/no-go gate)

Throwaway app for T2 ([issue #2](https://github.com/htxryan/penmoss/issues/2)). It answers one question before Phase 1 continues: **is a TipTap/ProseMirror editor in an Android WebView good enough for real long-form writing on the Pixel 10 Pro?** (D5, D15.) If not, Phase 6 is re-planned around a native Compose editor.

Nothing here ships. Production Android work starts in `apps/android` (T32–T35).

## What's in it

| Path                     | What                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/`                   | Standalone Vite project (not part of the root pnpm workspace): bare TipTap 3.32 editor with StarterKit, task list, table, lowlight code blocks, image, link and highlight. Loads a 5,038-word sample note (headings, nested lists, checklists, 8 code blocks, 4 SVG images, links, a table, quotes). |
| `web/src/main.ts`        | The `window.penmoss` bridge API: `exec(command, arg?)`, `getJSON()`, `getStats()`, `startTest(label)`, `checkTest()`, `getTestText()`, `getTestJSON()`, `requestExport(mode)`, `exportLog()`, `logNative(note)`.                                                                                     |
| `web/src/metrics.ts`     | Cold-open timings (navigation start → editor ready → note painted), long tasks and long animation frames (PerformanceObserver), scroll frame intervals.                                                                                                                                              |
| `web/src/ime-log.ts`     | In-memory IME log (up to 50,000 entries): `beforeinput`, `input`, `composition*`, `keydown`/`keyup` with `inputType`, `data`, `isComposing` and the ProseMirror selection, plus every document-changing transaction's steps.                                                                         |
| `web/src/consistency.ts` | The test paragraph and the consistency checker: a character diff of what you typed against the paragraph, reporting lost, duplicated and other extra characters.                                                                                                                                     |
| `web/scripts/verify.mjs` | Headless Chromium check of the built bundle at 412×915 (see "Verified on the worker").                                                                                                                                                                                                               |
| `app/`                   | Kotlin single-Activity app (`app.penmoss.spike`, "Penmoss Spike"), Jetpack Compose shell around a WebView. Loads the bundle through `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/editor/index.html`.                                                                        |
| `app/src/androidTest/`   | Instrumentation tests that type through the WebView's `InputConnection` and assert the ProseMirror JSON.                                                                                                                                                                                             |
| `build.sh`               | Builds the web bundle, copies it into `app/src/main/assets/editor/` and builds both APKs.                                                                                                                                                                                                            |

### The app

- **Top bar:** "Opened in N ms" (process start → note painted), **Protocol** (the steps below, the test paragraph and buttons that start a typing test per keyboard), **Stats** (cold open, long tasks, scroll frame intervals, JankStats frame numbers, document size, typing-test results; "Reset frames" before a scroll run) and **Export log**.
- **Formatting bar** pinned above the keyboard (`navigationBarsPadding().imePadding()`; edge-to-edge): Check (during a typing test), Bold, Italic, Bullet list, Checklist, Code block, Link, Undo, Redo. Buttons can't take focus, so the keyboard stays open. Active formats are highlighted.
- **Caret visibility:** the WebView shrinks above the bar when the keyboard opens. The editor scrolls the selection back into view when the viewport shrinks, and ProseMirror keeps a 72 px margin below the caret.
- **Export log:** "Share file…" writes one JSON file (device and WebView version, current and enabled IMEs, display refresh rate, native cold-open and JankStats numbers, web timings, typing-test results with full diffs, the IME log) and opens the share sheet. "Copy to clipboard" copies the same JSON, trimming the IME log to its last 3,000 entries if the whole log is too big for the clipboard.
- Web contents debugging is on: with USB debugging, `chrome://inspect` on a computer shows the editor's DevTools.

## Toolchain (pinned 22 Oct 2026, latest stable)

| Tool                             | Version                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| Android Gradle Plugin            | 9.4.1 (built-in Kotlin)                                         |
| Gradle (wrapper)                 | 9.8.2                                                           |
| Kotlin + Compose compiler plugin | 2.4.21                                                          |
| JDK                              | Temurin 21.0.12.1 (system Java 25 on the worker has no `javac`) |
| compileSdk / targetSdk / minSdk  | 37 / 37 / 30                                                    |
| Compose BOM                      | 2026.09.00; activity-compose 1.13.0; core-ktx 1.19.1            |
| AndroidX WebKit                  | 1.18.0; metrics-performance (JankStats) 1.0.0                   |
| AndroidX Test                    | runner/rules/core 1.7.0, ext-junit 1.3.0                        |
| TipTap                           | 3.32.0 (lowlight 3.3.0)                                         |
| Vite / TypeScript                | 8.3.5 / 6.0.3                                                   |

## Build

Needs Node 24 with Corepack, a full JDK 21+ and the Android SDK (platform 37, build-tools 37). On the agent worker everything is in place:

```sh
cd spikes/android-editor
./build.sh             # web bundle + assembleDebug + assembleDebugAndroidTest
./build.sh --web-only  # just rebuild the bundle into the app's assets
```

`build.sh` sets `ANDROID_HOME` (default `~/Android/sdk`) and, when `JAVA_HOME` is unset, uses `~/opt/jdk-21`. The worker has little free memory, so Gradle runs with `--no-daemon`, a 1.5 GB heap, in-process Kotlin compilation and two workers. Don't start two builds at once.

Outputs (not committed):

- `app/build/outputs/apk/debug/app-debug.apk`: the app, signed with the worker's debug key
- `app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`: the instrumentation tests

The web bundle alone: `cd web && pnpm install && pnpm build && node scripts/verify.mjs [screenshot.png]`.

## Install on the Pixel

**With adb (simplest).** On the Pixel: Settings → About phone → tap Build number 7 times, then Settings → System → Developer options → USB debugging (or Wireless debugging). From the Mac:

```sh
scp worker:src/penmoss-wt/phase-0/spikes/android-editor/app/build/outputs/apk/debug/app-debug.apk .
adb install -r app-debug.apk
```

**Without a computer.** Put `app-debug.apk` somewhere the phone can reach (Google Drive, or email it to yourself), open it on the Pixel and allow "Install unknown apps" for that app when asked. Play Protect may warn about an unknown developer; choose "Install anyway". adb installs are not affected by Android's developer-verification rollout.

If an earlier build signed with a different debug key is installed, uninstall it first (`adb uninstall app.penmoss.spike`).

## Run the instrumentation tests (device needed)

The worker has no emulator (no KVM), so the tests are compiled here but run on a device:

```sh
# from the worker with the Pixel connected over adb, or on any machine with the SDK:
./gradlew --no-daemon connectedDebugAndroidTest

# or with only adb and the two APKs:
adb install -r app-debug.apk
adb install -r app-debug-androidTest.apk
adb shell am instrument -w app.penmoss.spike.test/androidx.test.runner.AndroidJUnitRunner
```

`TypingInstrumentedTest` has four tests:

1. `testParagraphMatchesWebBundle`: the Kotlin and JS copies of the test paragraph are identical.
2. `inputConnection_composeAndCommit_producesExactParagraph`: gets the WebView's `InputConnection` (Chromium's `ThreadedInputConnection`) and, on the handler that `InputConnection.getHandler()` reports (the thread the framework uses for IME calls), composes each word letter by letter with `setComposingText` inside a batch edit, then commits it. Every other word finishes with `finishComposingText` instead, so both ways keyboards finish a word are covered. It asserts the ProseMirror JSON is exactly one paragraph with the exact text, that the consistency checker reports an exact match and that the IME log saw composition events.
3. `inputConnection_enterAndBackspace_inBulletList`: Enter, `deleteSurroundingText` and DEL key events inside a bullet list, then Enter twice to leave it. It asserts the text and the list structure.
4. `keyEvents_produceExactParagraph`: a baseline through key events (`Instrumentation.sendStringSync`), the hardware-keyboard path.

Why `InputConnection` is called directly: no real soft keyboard can be scripted reliably in a test. The WebView's own connection gets the same calls a keyboard makes, on the same thread, so this is the closest automated stand-in. It can't reproduce a keyboard's own heuristics (autocorrect, swipe, voice), which is why the manual protocol below is the real gate. If a future WebView stops returning a connection from `onCreateInputConnection` while it's called outside an IME binding, test 4 still covers the input path, and test 2 fails with "Timed out … waiting for WebView InputConnection" rather than a wrong-text assertion.

## Test protocol (Ryan, on the Pixel 10 Pro)

Allow about 90 minutes. Record the screen (Quick Settings → Screen record, with touches shown) for each keyboard session; the recordings go with the verdict.

### 0. Set up

1. Install the APK (above). Turn on Developer options → **Profile HWUI rendering → On screen as bars**.
2. Make sure Gboard is up to date. Install one alternative keyboard: **Microsoft SwiftKey** from the Play Store (Samsung Keyboard isn't available on Pixel).

### 1. Cold open (target: under 1 s)

1. Settings → Apps → Penmoss Spike → Force stop. Open the app from the launcher.
2. Read "Opened in N ms" under the title (process start → note painted). Repeat 3 times and note all three.
3. Optional, with adb: `adb shell am force-stop app.penmoss.spike && adb shell am start -W -n app.penmoss.spike/.MainActivity`, then `adb logcat -d | grep "Fully drawn"` (the app calls `reportFullyDrawn()` when the note is painted).

### 2. Scrolling (target: 60 fps)

1. Open **Stats** and tap **Reset frames**. Close it.
2. Fling through the whole note from top to bottom and back, twice, including over the code blocks, images and the table. Watch the HWUI bars: they should stay under the green line (16 ms).
3. Open **Stats** and note the JankStats line (janky %, p95/p99) and the web scroll lines (avg fps, p95 interval, frames over 16.7 ms).

### 3. Keyboard sessions (15 minutes each)

Do this once for each of: **Gboard tap**, **Gboard swipe** (glide typing), **Gboard autocorrect** (tap typing with autocorrect and suggestions on, accepting suggestions), **Gboard voice** (dictate the paragraph), and **SwiftKey**. Switch keyboards with the keyboard icon in the navigation bar.

1. **Protocol** → tap the session's button. This adds a "Typing test N" heading and an empty paragraph at the end of the note, puts the caret there and opens the keyboard.
2. Type (or dictate) the test paragraph shown in the Protocol dialog, exactly, without correcting anything by hand. In the autocorrect session, accept the keyboard's corrections; a correctly autocorrected word is fine, but a doubled or missing letter is not.
3. Tap **Check** in the formatting bar. The result panel shows lost (red, struck through), duplicated (purple) and other extra (yellow) characters. Note the numbers. Expected: 0 lost and 0 duplicated.
4. For the rest of the 15 minutes, write freely in the note and deliberately exercise the risky spots. Note every misfire:
   - Enter and Backspace at the start, middle and end of a bullet item, a nested bullet item and a checklist item; Enter twice to leave a list; Backspace at the start of the first item.
   - Enter and Backspace inside a code block, at its first and last line, and in the paragraph right after it.
   - Backspace in the paragraph directly after an image (it should select the image, not delete text) and Enter directly before one.
   - Typing right after a link and after bold text: the formatting shouldn't leak or get lost.
   - Each formatting-bar button while typing; the keyboard must stay open.
   - Long-press to move the caret, select a word and replace it, and paste.
5. **Caret check:** scroll to the very bottom of the note, tap at the end of the last paragraph so the keyboard opens, and type 5 to 10 lines. The caret and the line being typed must stay visible above the formatting bar at all times. Also rotate the phone once.
6. **Export log** → **Share file…** → send it to yourself (email or Drive). Name or note it by session.

### 4. Real note (at least 500 words)

In any keyboard you like, write a real note of at least 500 words: something you'd actually write. Then rate each of these from 1 to 5 against **Google Keep** and **Notion** on the same phone: typing feel and latency, autocorrect and suggestion behaviour, caret and selection handling, scrolling, and formatting. Write a few sentences on what felt worse or better. Export the log once more.

### 5. Send back

Send the exported JSON files, the screen recordings, the cold-open numbers, the Stats numbers after scrolling, the misfire notes and the ratings. The agent writes the verdict into the plan's Decisions log from these.

## Go/no-go criteria

**Go** when all of these hold on the Pixel 10 Pro:

1. Every keyboard session (Gboard tap, swipe, autocorrect, voice; SwiftKey) shows **0 lost and 0 duplicated characters** in the consistency check, and free writing shows none either.
2. **Backspace and Enter never misfire** around lists, checklists, code blocks and images (a misfire is any result a plain text field wouldn't give, such as a deleted image, a merged block, a jumped caret or a character inserted in the wrong block).
3. The **caret stays visible** when the keyboard opens and while typing at the bottom of the long note.
4. **Cold open under 1 s** on at least 2 of 3 runs, and no run over 1.5 s.
5. **Scrolling holds 60 fps:** HWUI bars stay under the green line apart from isolated spikes, and Stats shows under 5% janky frames.
6. Ryan rates the overall writing feel **no worse than Notion** on Android.

**No-go** if any of 1–3 fails in a way the spike can't fix with a small, understood change (for example a keyboard that duplicates characters on every swipe, or a caret hidden behind the keyboard). Criteria 4–5 failing by a small margin is a "go with follow-up" when the cause is understood (bundle size, image decoding). On no-go: stop, record the failure modes from the IME logs, and re-plan Phase 6 around a native Compose editor before Phase 1 continues.

## Reading the IME log

Each entry in `web.imeLog.entries` has `t` (ms since page load), `ev` and, depending on the event, `inputType`, `data`, `isComposing`, `key`/`keyCode` (Android soft keyboards usually report `keyCode` 229) and `sel` (the ProseMirror selection). `tx` entries list the steps a transaction applied as `[from, to, insertedText]` (⏎ marks a block boundary). `mark` entries bracket each typing test (`test-start`, `test-check`) and formatting command, and `native` entries record keyboard inset changes and the active IME. To find a duplicated character, search the log for the `test-check` mark of a failing run and walk back through the `tx` entries for the step that inserted the extra text.

## Verified on the worker

- `./build.sh`: `assembleDebug` and `assembleDebugAndroidTest` succeed (JDK 21). `app-debug.apk` is about 30 MB (unminified debug build; the editor bundle is 652 kB, 209 kB gzipped) and is signed with the Android Debug certificate. `app-debug-androidTest.apk` is about 1 MB.
- `node web/scripts/verify.mjs` (headless Chromium, 412×915 at 2.625×, served from the same origin as the app):
  - The note loads with zero console errors. Note painted about 130–150 ms after navigation start on the worker.
  - Typing the paragraph with the keyboard gives an exact match, and a corrupted paragraph is flagged (1 lost, 5 duplicated).
  - Typing it through IME composition (CDP `Input.imeSetComposition` + `Input.insertText`) gives an exact match. The IME log records `compositionstart`/`update`/`end`, `beforeinput:insertCompositionText` and transactions.
  - Every `exec()` command runs.
  - With a stubbed `penmossNative` object, the `ready` (with timings), `state`, `testResult` and `export` messages the Android shell relies on all arrive.
- Screenshots: [`docs/evidence/t2-web-editor.png`](../../docs/evidence/t2-web-editor.png) and [`docs/evidence/t2-web-editor-diff.png`](../../docs/evidence/t2-web-editor-diff.png).

Not verified here (needs the Pixel): everything that depends on a real keyboard, the WebView's real frame rate and cold open on device, and the instrumentation tests.
