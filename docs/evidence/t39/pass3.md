# T39 pass 3 · cross-app consistency (with T40 P9)

Issue [#74](https://github.com/htxryan/penmoss/issues/74). Pass 3 compares the web app, the Mac app and the Android app for wording, icons, shortcuts, empty, error and offline states, and ordering. This first part runs inside T40 P9's branch, as far as it can go without touching the screens that T40 P6 (search, tags), P7 (links, graph) and P8 (editor tools, attachments) are rebuilding. The rest ran with the final parity pass, after those slices merged. Decisions A550–A554 are in [`decisions.md`](../../decisions.md).

## How it was run

By reading each client's strings side by side (`apps/web/src`, `apps/desktop/src`, `apps/android/app/src/main`), and against pass 1 and pass 2's open proposals ([web and Mac](web-mac/pass2.md), [Android](android/pass2.md)). No emulator (T40 P9's rule); each fix has a Robolectric or vitest assertion.

## Findings and fixes

| # | Finding | Fix |
| --- | --- | --- |
| 1 | Trash's verb had three spellings on the web ("Move to trash" on the menu and button label, "Move to Trash" on its tooltip, "Move note to trash" in the palette and the Mac's Note menu); Android said "Move to Trash". Pass 1 left it for this pass. | **Move to Trash** everywhere (A550). |
| 2 | Android named Settings' **Devices and agent tokens** "Devices and tokens". | The web's name, in Settings, on the screen and in Trash's sign-in note (A551). |
| 6 | Settings listed its sections in a different order on the web (Keyboard shortcuts first) and on Android (Appearance first). | Ryan's decision: Android's order everywhere, Appearance first; `/settings` opens on Appearance on the web and the Mac (A551). |
| 3 | Android's ⋮ button was "More options" on Home but "More" in a folder and in the theme editor. | **More options** everywhere; a note's stays **Note actions**, as on the web (A552). |
| 4 | Shortcut names: Android had none to show. | The web's off-Apple names (Ctrl, Alt, ↑, Esc), from the shared contract; Keyboard shortcuts uses the web's words (A553, T40 P9). |
| 5 | Section titles were not headings on Android (pass 2's proposal 4); the web's are `h2`/`h3`. | Headings for TalkBack (A498(f), T40 P9). |
| 7 | A note's title was the size of a first heading (1.6rem on the phone, 1.625rem on a narrow web page, against an H1's 1.6em): a note starting with a heading looked like two titles (Android pass 1's proposal 4, web pass 2). | The title is 1.85rem on both, a step above (the wide web page keeps 1.9rem) (A554). |
| 8 | The phone's formatting bar stayed while the caret was in the title, where its buttons do nothing (Android pass 1's proposal 5). The web has no bar there. | The page says when the caret is in the title, and the bar goes until it is back in the text (A554). |
| 9 | Search's empty state: "No notes match “…”" on the web; Android's matched it once T40 P6 rebuilt Search, but the phone's graph search said "No notes match.". | The graph's says "No notes match “…”" too (A554). |

Checked and consistent already: the offline wording ("Offline: …" on every client), "No notes yet." and "No versions yet.", Quick capture's name (web, Mac menu and tile, Android Home), the sort modes (Manual, A–Z, Last modified), and the Keyboard shortcuts icon.

## Proposals and items left

- Pass 1 and 2's other open proposals (search ranking, empty "Untitled" notes, the table toolbar, the phone app bar repeating the title) were left for part 2, which resolves them (below).

## Tests

`router.test.ts` asserts that `/settings` opens on Appearance; `writing.test.ts` reads the title and heading sizes from both stylesheets; `parity.test.ts`, `BridgeProtocolTest` and `FormatBarTest` the bar in the title; `GraphScreenTest` the graph's empty search; `app.test.tsx` and `mobile.spec.ts` assert Move to Trash; `OrganiseScreensTest` and `AccessibilityTest` assert More options; `SettingsScreensTest` the sections; `ShortcutsContractTest` and `ShortcutsScreenTest` the shortcut names. The assertions changed on purpose are the four that named the old words (the graph's "No notes match." among them), and the two end-to-end lists (`mobile.spec.ts`, `a11y.spec.ts`) that reached Keyboard shortcuts at `/settings`: they now name `/settings/shortcuts`.

## Part 2: after T41–T50 (issue #74)

Part 2 checks everything merged since part 1: T41 and T42, T43 (notebooks, the git mirror per notebook), T44 (line symbols), T45 (note windows), T46 and T47, T48 (comments), T49 (feedback), #141 and T50 (git notebooks). It ran on the worker against the local Worker, by reading the three clients' strings side by side and running every suite. There was no emulator: each Android change has a Robolectric test, and the Pixel steps are in [`docs/android.md`](../../android.md) (Check the T39 pass on the Pixel, pass 3's second part). Decisions A890–A914 are in [`decisions.md`](../../decisions.md).

### Consistency: what drifted, and the choice made

| # | Finding | Fix | Decision |
| --- | --- | --- | --- |
| 10 | A note's menu ended differently: the web's ⋯ with Send feedback, then Move to Trash; Android's with Move to Trash, then Send feedback; the Mac's File menu put Move to Trash between Markdown source and Move to folder…. | Move to Trash comes last everywhere; the Mac's File menu sets it apart, after the note's other commands. | A890 |
| 11 | Android's folder and notebook actions had no "…" where they ask first, the folder sheet said only "Delete", the turn-back question's button said "Turn back", and a notebook's delete text differed from the web's. | The web's names and text. | A891 |
| 12 | Feedback: Android called the outbox "Feedback on this phone", offered Retry for a report still waiting, said "Refused (403): …. Not sent.", and its form's problems were its own sentences; both clients mixed straight and curly apostrophes. | The web's words on Android, curly apostrophes on both. | A892 |
| 13 | Git notebooks: Android's labels differed from the Mac's (Confirm private, the token and cadence buttons, the units), and the Mac's git Delete for good had a "…" that Trash's and Android's lack. | The Mac's labels on Android; no "…" on the Mac. | A894 |
| 14 | Android's empty Trash lacked the web's second line; Android's History said "Undo this change" for the web's Revert this edit. | The web's words. | A895, A896 |
| 15 | The web's Devices page was headed "Devices" under the section Devices and agent tokens, and said nothing after Sign out or Revoke (Android says what it did). | The section's name, and a status line: "Signed out …" or "Revoked …". | A898 |
| 16 | Settings icons: the web used the refresh arrow for Git mirror and a globe for Sync; Android used one glyph for both Git notebooks and Git mirror. | One icon per section, the same on both. | A902 |
| 17 | Comments on Android: the thread's delete button said "Delete", "Resolved by X when" had no separator, and the delivery lines had straight apostrophes. | Delete thread, " · ", curly apostrophes. | A909 |
| 18 | Git mirror on Android said "Set repository…", "Use the server's own" and "Folder in the repository (optional)". | The web's words. Offline search's notice on results already matched the web's; part 2 changed it to the web's empty-search line by mistake, and the review put it back. | A910 |

Kept on purpose, with reasons (A911): the Mac's menus use the palette's command titles; the web's sidebar Feedback label; Android's question before discarding a feedback draft; Android's empty comments line naming its New comment button; the two clients' error voice ("Could not …", "Penmoss couldn't …"); and "Open or close notebooks…".

Checked and consistent already: feature and section names (Notebooks, Git notebooks, Git mirror, Symbols, Comments, Version history, Send feedback); Move to Trash, Delete for good, Keep note, Restore and Undo; Sign in again; Touch ID and BiometricPrompt wording ("Penmoss is trying to …"); git refusal messages between the Mac and Android; sentence case and "…" (never "...") everywhere; the Open in new window, Keep on top and Compact title bar names (web and Mac only).

### The rules

| Rule | What was found | What changed |
| --- | --- | --- |
| R1, every client can do everything | Android could close a notebook only in Settings, and make one only from Home's ⋮ (the web: the notebook's menu, and Settings → Notebooks). | Close on this phone in a notebook's sheet, New notebook in Settings → Notebooks (A897). |
| R1 | Android can't sign git commits (the Mac and the CLI can); Android's Remove has no Push first; Android lacks Delete for good on a mark never confirmed on this phone, and Undo after Keep note; the Mac's capture can't choose a notebook (Android's can). | Fixed in the review (A913, A914), except commit signing, left for the next lane. |
| R2, native clients guard destructive actions | Every admin action asks Touch ID (Mac) or BiometricPrompt (Android); none is guarded by a plain dialog alone. A git notebook's History restore and revert asked BiometricPrompt on Android but not Touch ID on the Mac. | The review made the Mac ask too (A901). |
| R3, agent changes stay undoable | Personal notes: Agent activity with Undo on every client, and History's Revert this edit. Git notebooks: an agent's folder and settings changes can't be undone in one step (no Agent activity there), and the CLI's help still promised Agent activity for `rmdir` and `retag` with `--notebook`. | The help says what does bring the change back (A899). The missing undo itself is listed under Items left (L). |
| R4, Settings Appearance-first | Appearance is first on the web, the Mac, Android and an Android git notebook's own Settings. | Nothing. |

### Hardening

| # | Finding | Fix | Test (fails without the fix) |
| --- | --- | --- | --- |
| H1 | **Privacy.** In a git notebook's note on the Mac, Comments' Send to asked the Penmoss server for the note's agent sessions, with its id; a git notebook's notes never reach the server (A826, A828). | No Send to for a git note, on the Mac and on Android (A908). | `comments-send-to.test.tsx`; `CommentsSheetTest` |
| H2 | **Wrong status.** Android said files edited by hand in a git notebook's repository were "read back"; the engine writes them again from the notes, so the edit is gone. | The card says what happened (A893). | `GitNotebooksScreenTest` |
| H3 | **Leaking test flows.** Trash's and History's Room flows outlived their database in model tests, and failed `AndroidCommandsTest` later in the run with "leftover" database errors. | `cancelAndJoin` and `stopScope` before closing the database (A903). | The full Robolectric run, which no longer shows them |
| H4 | **A vanishing capture.** The hotkey pressed while the app was starting could open the capture window just before the main window's first show, which took the focus; the capture window hid on losing it, with what was typed kept but out of sight. | The main window shows without taking the focus while a capture is open (A904). | `capture.spec.ts` "a capture opened while the app starts keeps its focus when the main window shows" |

Checked, with no new defect: the console during every web and Electron e2e test (each asserts no errors); offline, slow and server-error states (the suites from passes 1 and 2 cover them: Status at 500, Slow 3G, an offline launch, a refused upload, a token that can't be renewed); token expiry (Sign in again, `auth.spec.ts`, `account.spec.ts`); data loss (note windows' last keystrokes, captures saved offline, drafts kept on blur).

### Open proposals, resolved

| Proposal | Resolution | Decision |
| --- | --- | --- |
| Search ranking (pass 1) | Notes whose title holds the words come first in the fused list. | A905 |
| Empty "Untitled" notes (pass 1) | Kept: removing them would be a Delete for good, an owner's action. | A900 |
| Table toolbar (pass 2) | Icon buttons, each with its name as its tooltip. | A906 |
| The phone's app bar repeating the title (pass 2) | The bar shows the note's notebook and folders, as Android's does. | A907 |

### Flaky tests

- **`capture.spec.ts:161` and `:259`** (the capture window not shown within 5 s of the first hotkey after a launch): a real race, now fixed (A904). A probe logged the windows' show, hide and focus events around the press in 24 launches: the main window's first show came 10–150 ms after the press, the capture window's 120–190 ms. The full run here then failed once, and the new diagnostic said the capture window had loaded and was hidden. When the capture's small page paints first, the main window's first show takes the focus and the capture window hides on losing it. The main window now shows without taking the focus while a capture is open. The new test fails without the fix; with it, `capture.spec.ts` and `account.spec.ts` passed twice over (34 of 34).
- **`account.spec.ts` "signing in again revokes the replaced token"** (a 401 that Chromium logged): not reproduced in 15 repeats. Signing in again mints the new page token, which signs the old one out on the server, before the page is told of it (`main.ts` `signIn`); a page request sent in that moment gets a 401 that the page handles, but Chromium logs it. The test already waits out the one request known to fall there (`/sync/batch`, A698). The Electron tests' errors now name the request's address, so the next failure says which; the admin test that holds `/api/agent-activity` on purpose now names it in its expected error. No product change.
- **`TrashFoldersTest` timeout and `AndroidCommandsTest` leftover database flows:** the second came from H3 and is fixed; the first passed in every run here, alone and in the full run (it timed out once before only while the worker was compiling).
- **`agent-undo.spec.ts:64`** (a 401 on its first request) failed once, in a baseline run made while this lane's files were being edited (the local Worker and the page reload on each edit); it passed in the clean full run. The page's token is stored before the tree shows (checked 10 times), and a page load signs in once.

### Screenshots

In [`pass3/`](pass3/), each light and dark, before (`origin/main` at 410c7187) and after. Made-up notes only.

- The table toolbar, web and Mac: `before-web-table-toolbar-*.png` → `after-web-table-toolbar-*.png`; `before-mac-table-toolbar-*.png` → `after-mac-table-toolbar-*.png`.
- Settings' sections and their icons, web and Mac: `before-web-settings-icons-*.png` → `after-web-settings-icons-*.png`; `before-mac-settings-icons-*.png` → `after-mac-settings-icons-*.png`.
- The phone-sized app bar on a note in a folder: `before-phone-app-bar-*.png` → `after-phone-app-bar-*.png`.
- Settings → Devices and agent tokens after revoking a token: `before-web-devices-status-*.png` → `after-web-devices-status-*.png`.
- Android: the Pixel steps in `docs/android.md` (no emulator in this pass).

### Tests

New tests that fail without their fix: `semantic.test.ts` (A905), `blocks.test.ts` (A906), `comments-send-to.test.tsx` (A908), `desktop.test.ts` (A890), `packages/cli/test/help.test.ts` (A899), the Mac's `capture.spec.ts` (A904); on Android, `WordingTest` and new tests in `CommentsSheetTest`, `NotebookScreensTest`, `GitNotebooksScreenTest`, `SettingsScreensTest`. `app.test.tsx` gains the Settings icons test. Assertions changed on purpose, each naming the old words or order: `NoteMenuTest`, `FolderScreensTest`, `NotebookScreensTest`, `FeedbackFormTest`, `FeedbackScreenTest`, `NoteCommentsTest`, `CommentsSheetTest`, `TrashScreensTest`, `HistoryScreensTest`, `git-sources.test.ts` (a test name), the end-to-end `auth.spec.ts`, `mobile.spec.ts` and `polish.spec.ts`, and the Mac's `account.spec.ts`, whose expected 401 now carries the request's address. Nothing skipped or weakened.

Full runs on the worker, under the e2e lock: `task check` passed (lint, types, and the unit suites: core 440 and 437, sync-client 314, ui 110, editor 554, git-notebook 416, the Android editor page 240, the Mac's units 152, web 580, CLI 77, server 936); `task e2e` 174 of 174; `task desktop:test` 152 unit and 47 of 47 Electron tests; `task android:test -- --rerun-tasks` 1,175 app and 213 engine-bridge tests, none failed or skipped. The one failure in a full Electron run (`capture.spec.ts`, the first press after a launch) is H4, fixed since, with `account.spec.ts`'s expected error that the address diagnostic changed.

### Review fixes (PR #171)

| # | What the review found | Fix | Decision | Test |
| --- | --- | --- | --- | --- |
| 1 | Android offered Close on this phone for a notebook inside a git notebook, whose Settings has no Notebooks section to open it again; Turn into notebook was offered in git notebooks on Android and the Mac. | No notebooks inside a git notebook, on any client: no Turn into notebook, New notebook, Close or Open or close notebooks there. | A912 | `NotebookScreensTest`; the Mac's `git-notebooks.spec.ts` |
| 2 | Part 2 gave Android's offline results the web's empty-search line. | Back to the web's notice on results. | A910 | `SearchServiceTest` (fails with part 2's) |
| 3 | A bidi override in a folder's name could reorder the app bar's path. | Each part in `<bdi>` on the web, FSI…PDI on Android's bars. | A907 | `polish.spec.ts`; `FolderScreensTest` (fails without) |
| 4 | Stale docs: the feedback steps in `docs/android.md`, "Delete for good…" in `docs/desktop.md`. | Updated. | — | — |
| 5 | Closing a capture opened while the app started hid the whole app on a Mac, the main window Ryan had opened included. | The main window gets the focus; the app hides only when it started at login. | A904 | `shell.test.ts` |
| 6 | Android's Remove had no Push first. | Push first and Remove anyway, as on the Mac. | A913 | `GitNotebooksScreenTest` |
| 7 | Android lacked Delete for good on a mark never confirmed here, and Undo after Keep note. | Both, the first behind BiometricPrompt. | A913 | `GitNotebooksScreenTest` |
| 8 | The Mac's quick capture couldn't choose a notebook. | Into, with a picker, starting as Android's sheet does; a Journal choice made in another window reaches the capture window. | A914 | `capture-into.test.ts`; the Mac's `git-notebooks.spec.ts` |
| 9 | Git History's owner check was Android's only. | The Mac asks Touch ID too, in main's words naming the note. | A901 | `git-notebooks.test.ts`; `git-sources.test.ts` (fails without); the Mac's `git-notebooks.spec.ts` |
| 10 | The parity matrix had no rows for T43 and T50; AC5 was out of date; PL22 said Yes; the counts stopped at T48. | NT32 and NT33 added (NT33 partial: commit signing), AC5 and PL22 updated, two count columns added. | — | — |

The new Android Remove, purge and notebook tests failed first by not compiling (the parameters were new); the breadcrumb and search tests failed against part 2's code; the web restore test failed with the check taken out.

### Delta review fixes (PR #171 at ecb41ec1)

| # | What the review found | Fix | Decision | Test |
| --- | --- | --- | --- | --- |
| 1 | A912 stranded notebook folders already closed inside a git notebook: the closed set still left them out of its tree, lists and Recent, with no way left to reopen them. | Inside a git notebook the closed set is ignored, on the web and Mac and on Android. | A912 | `notebooks.test.tsx` "a git notebook has no closed notebooks"; `ClosedNotebooksTest` |
| 2 | The quick capture's notebook went back to the Journal notebook whenever the settings were read again with nothing typed. | A pick holds until the capture is saved or cancelled; only a new capture starts afresh. | A914 | `capture-form-into.test.tsx` |
| 3 | Android's Remove counted the engine's changes only, so it could say "Everything here is pushed" with edits still in Room. | It counts `hub.unpushed()` (engine and Room); unknown counts as maybe lost, with Push first. | A913 | `GitNotebooksScreenTest` `removeCountsRoomsUnsentEditsAsNotPushed` |
| 4 | Nothing showed whether `wasOpenedAtLogin` is reliable. | Each Mac launch adds `getLoginItemSettings()` to `launch.log`; `docs/desktop.md` §5 step 17 checks it. | A904 | `shell.test.ts` (the launch log) |

Each new test failed first against the code it fixes. The new parameters (`ClosedNotebooks`' `inGitNotebook`, the Remove dialog's `unpushed`) went in unused before the tests ran.

### Items left for Ryan

| Item | Size |
| --- | --- |
| R3: an agent's folder and settings changes in a git notebook can't be undone in one step (no Agent activity for git notebooks; their Trash, each note's History and the repository's history remain). Done in #172: Agent activity for git notebooks (A920, [`../t50/agent-undo-signing.md`](../t50/agent-undo-signing.md)). | L |
| R1: Android can't sign git commits, so it can't push to a branch that requires signed commits (NT33, partial). Done in #172: Sign commits on Android (A921; NT33 present). | L |