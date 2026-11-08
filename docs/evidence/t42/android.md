# T42 on Android · Items 1–9 on the phone

Evidence for bringing the Android app to parity with T42's web and Mac UI ([issue #104](https://github.com/htxryan/penmoss/issues/104) items 1–9, merged as #119, `ed60f22`). The rows are ST12, AC12, NT26–NT30, TG6 and PL19 of the [T40 parity matrix](../t40/parity-matrix.md), which A579 added; item 2 (one search, always Hybrid) is FD2, present on Android since P6.

Decisions A650–A657 are in [`decisions.md`](../../decisions.md). No Room schema change (main is at 16, from #133). No server change: the Display keys and the hybrid floor are #119's server halves, already deployed with it (main `ed60f22`, Worker `b373a29c`).

## How it was run

- **No emulator** (the lane's rule, and no KVM on the worker). The Pixel checklist is [`docs/android.md` → Test T42's UI changes on the Pixel](../../android.md#test-t42s-ui-changes-on-the-pixel-t42-on-android), for Ryan.
- **What covers it instead:** Robolectric Compose tests of each screen, sync tests of the app's real engine, Room store and HTTP client against the fake Penmoss server, the contracts read from both sides (`settings-v1.json`'s `display` block; `commands-v1.json`), and JVM tests of the engine.
- Full runs, each alone under the shared lock: after the review round, rebased onto `origin/main` at `640d7b6`, `task android:test` (app 989 tests, engine-bridge 149; 0 failures, 0 skipped) and `task android:build`. `task check` (lint, types and every workspace's tests, 3,080 passing, plus the release script's 10) ran on `ed60f22` before the rebase; CI's Check job runs it on the rebased head.

## Rows

| Row | Before | Now | Decision | Tests |
| --- | --- | --- | --- | --- |
| ST12 Display | Missing | **Present.** Settings → Display, after Appearance: a switch for Today and This week (Home's buttons) and Graph and Commands (Home's ⋮; Commands is new there, Search with every action). The web's `sidebar.*` keys through the settings channel, offline too; only `false` hides; shown again stores `true`. Search always shows. `app.display` is native and a Search action. | A650 | `SettingsContractTest.readsTheDisplaySettingsAsTheWebDoes`; `DisplayAndSyncStopTest`: `homeHidesTheShortcutsDisplayHidesAndKeepsSearch`, `displayHasASwitchPerShortcutThatSendsTheWebsKeys`, `theSettingsHomeSaysWhatDisplayHides`; `AndroidCommandsTest`, `SearchScreensTest.eachActionCallsTheTargetItNames`, `SearchActionsTest`; web `android-commands-contract.test.ts` |
| AC12 Sync stopped | Missing | **Present.** `SyncCoordinator.stop`: a 403 (forbidden), notes Penmoss keeps refusing (`ExchangeResult.refused`), or the phone's storage failing. Home's status line says "Sync stopped: …" and opens Sync and storage: what happened, what Penmoss said, and Sign in again or Try again. A 401 is the sign-in screen (A283); offline and server failures retry by themselves. | A651 | `ExchangeTest.saysWhenTheServerRefusedEditsThatStayWaiting`; `SyncStopTest` (6); `DisplayAndSyncStopTest`: `aStoppedSyncsStatusLineLeadsToWhatResolvesIt`, `eachStopSaysWhyInPlainWordsWithItsOneRemedy`, `syncAndStorageOffersTheRemedyAndSignsInAgainWithTheCode` |
| NT26 Several notes | Partial | **Present.** A long press in Home, a folder, All notes or a tag's notes starts selection mode: a contextual bar with the count, Move (one picker), Move to Trash (one Undo) and Rename for one; taps add and take out notes; Back, ✕ or leaving ends it. Folders keep Rename and Delete (NT3, NT4). Search keeps its sheet. | A652 | `NoteSelectionTest` (6), `SelectionRootTest` (4) |
| NT27 Kind | Missing | **Present.** A Daily note or Weekly note label with its period at the top of Info; no Kind row. | A653 | `NoteInfoTest.theDetailsReadAsTheWebsInfoPanel`, `…theSheetShowsDetailsTagsFrontmatterAndBacklinksAndOpensThem`, `…theSheetSaysSoWhenNothingLinksHere` |
| NT28 History | Partial | **Present.** The web's explanation under History's title; Save a version now a text button beside it. | A654 | `HistoryScreensTest.historySaysVersionsAreAutomaticWithSaveAVersionNowBesideIt` |
| NT29 ⋮ menu | Present (adapted) | **Present (adapted), confirmed.** A575's order; Info and the sync icon on the bar; Full width in Appearance (ST11). | A653 | `NoteMenuTest.theMenuListsTheNotesActionsInTheWebsOrder` |
| NT30 Trash moves | Missing | **Present.** Trash's rows say who moved each note there, ✦ for an agent, from `deletedBy`; ✦ is taken out of names; History offers no Undo this change on "Moved to Trash" or "Restored from Trash". | A654, A655 | `TrashModelTest.eachNoteSaysWhoMovedItToTrashAnAgentWithItsMark`, `TrashModelTest.aDeletedByThatIsNoObjectNamesNoOneAndKeepsTheList`, `DeletedByTest` (3), `TrashFoldersTest.eachFolderSaysWhatItHeldWhereFromByWhomAndItsDaysLeft`, `HistoryScreensTest.anAgentsMoveToTrashOffersNoRevert` |
| TG6 Tags | Partial | **Present.** Every live note's tags from Room, then `/api/tags`'s others, ranked as the web's `tagSuggestions`, without the note's own (frontmatter and inline). | A656 | `TagsTest.ranksAsTheWebDoes` (the web's own cases), `TagsTest.everyTagIsTheIndexsThenTheListsOthers`, `TagStoreTest.suggestsEveryTagOnAnyNoteButTheNotesOwn` |
| PL19 Tooltips | N/A | **N/A, with its reason.** No hover and no rail on a phone; icon buttons' long-press labels (PL14); a row's long press selects (A652). | A657 | — |
| FD2 Search | Present | **Present, checked.** Hybrid only; the 0.45 floor is the server's, and an empty hybrid answer shows "No notes match", never the phone's typing results. | A657 | `SearchServiceTest.aHybridAnswerWithNothingCloseIsNoNotesNotThePhonesOwn`, `…asksTheServerForHybridWithTheFiltersAndReadsWhatItFound` |

## Tests

| Suite | Tests | Result |
| --- | --- | --- |
| Android app (`testDebugUnitTest`, Robolectric) | 989 | 0 failed, 0 skipped |
| Android engine-bridge (JVM) | 149 | 0 failed, 0 skipped |
| `task check`: cli 46, core 380 + 379 (workers), sync-client 197, ui 108, editor 497, Android editor 203, desktop 93, server 772, web 405 (on `ed60f22`, before the rebase) | 3,080 | 0 failed |
| `task check`: release script (`node --test`) | 10 | 0 failed |

New test classes: `SyncStopTest` (6), `DisplayAndSyncStopTest` (6), `NoteSelectionTest` (6), `SelectionRootTest` (4), `NoteMenuTest` (1), and engine-bridge's `DeletedByTest` (3). New cases are in `ExchangeTest`, `SettingsContractTest`, `TagsTest`, `TagStoreTest`, `SearchServiceTest`, `TrashModelTest`, `TrashFoldersTest`, `HistoryScreensTest` and `NoteInfoTest`. Tests that a new layout pushed below Robolectric's small screen now scroll to what they check; none was weakened or skipped. The web's `android-commands-contract.test.ts` wrote `commands-v1.json` again and passes.

## Mutation checks

Each change below was made to the committed code, then the matching test classes were run. All ten mutants were caught. The code was restored with `git checkout` afterwards.

| Mutant | Caught by |
| --- | --- |
| `Exchange`: a 503 "Unavailable" counts as refused | `ExchangeTest.saysWhenTheServerRefusedEditsThatStayWaiting` |
| `Tags.suggest`: no rank for a level that starts with the query | `TagsTest.ranksAsTheWebDoes` |
| `Settings.shows`: a non-boolean value hides | `SettingsContractTest.readsTheDisplaySettingsAsTheWebDoes` |
| `SyncCoordinator`: a 403 does not stop sync | `SyncStopTest.aSignInThatMayNotSyncStopsItUntilAPassGoesThrough`, `…signingOutForgetsWhatStoppedTheSession` |
| `revertible`: Trash moves offer Revert | `HistoryScreensTest.anAgentsMoveToTrashOffersNoRevert` |
| `deletedByText`: ✦ left in names | `TrashModelTest.eachNoteSaysWhoMovedItToTrashAnAgentWithItsMark`, `TrashFoldersTest.eachFolderSaysWhatItHeldWhereFromByWhomAndItsDaysLeft` |
| `NoteRowView`: taps never select | `NoteSelectionTest.aLongPressStartsSelectionAndTapsAddOrTakeOutNotes` |
| `HomeScreen`: Today always shows | `DisplayAndSyncStopTest.homeHidesTheShortcutsDisplayHidesAndKeepsSearch` |
| `kindLabel`: every note gets a label | `NoteInfoTest.theDetailsReadAsTheWebsInfoPanel` |
| `moveNotesAndSay`: only the first note moves | `NoteSelectionTest.moveSendsEveryNoteToTheOneFolderPickedInTheOrderChosen` |

## Review round

[The review](https://github.com/htxryan/penmoss/pull/129) found nothing blocking. These went in before merge, each test written first and seen failing:

| Review item | Change | Tests |
| --- | --- | --- |
| S1 Stale deploy wording | #119's server half is live (main `ed60f22`, Worker `b373a29c`): the PR body, the Pixel checklist's first line, line 5 above, A650 and the matrix's ST12 row say so. | — |
| S2 A selection out of sight | Each list keeps only the chosen notes it shows; with none left, selection mode ends. Only the screen in front prunes. | `NoteSelectionTest.aChosenNoteThatLeavesTheListLeavesTheSelection`, `SelectionRootTest.aChosenNoteAPassTakesOffHomeIsNoLongerChosen` |
| S3 The root's wiring | Tested through `MainActivity`: the bar's Move to Trash takes every chosen note, with one Undo; Back and leaving the screen end selection. | `SelectionRootTest.theBarsMoveToTrashTakesEveryChosenNoteWithOneUndo`, `…selectionEndsWhenTheScreenGoesAndOnBack` |
| S4 TalkBack under the bar | The list screens' own top bar is cleared from the semantics tree while notes are chosen. | `SelectionRootTest.talkBackSkipsHomesBarUnderTheSelectionBar` |
| N4 `deletedBy` | Read per entry as the web's `parseDeletedBy`; a string, a number or any other odd value names no one and the list still loads. | `DeletedByTest` (3), `TrashModelTest.aDeletedByThatIsNoObjectNamesNoOneAndKeepsTheList` |
| N2 Folders while choosing | Folder rows are dimmed and disabled while notes are chosen (TalkBack reads them unavailable), so a tap cannot drop the selection. | `NoteSelectionTest.foldersWaitWhileNotesAreChosen` |
| N1 Partial moves | Notes already in the folder count as neither moved nor refused, as the web's `moveSummary`. | `NoteSelectionTest.moveSendsEveryNoteToTheOneFolderPickedInTheOrderChosen` |

Nine more mutants, each applied alone on the rebased branch and run against `NoteSelectionTest`, `SelectionRootTest`, `TrashModelTest`, `TrashFoldersTest`, `SyncStopTest` and `DeletedByTest`. All were caught, and the code was restored after each:

| Mutant | Caught by |
| --- | --- |
| The review's survivor: the root's multi-note Move to Trash sends only the first note, and the selection survives a screen change | `SelectionRootTest.theBarsMoveToTrashTakesEveryChosenNoteWithOneUndo`, `…selectionEndsWhenTheScreenGoesAndOnBack` |
| Its first half alone: `picked.take(1)` | `SelectionRootTest.theBarsMoveToTrashTakesEveryChosenNoteWithOneUndo` |
| Its second half alone: no clearing on a screen change | `SelectionRootTest.selectionEndsWhenTheScreenGoesAndOnBack` |
| `retain` does nothing | `NoteSelectionTest.aChosenNoteThatLeavesTheListLeavesTheSelection`, `SelectionRootTest.aChosenNoteAPassTakesOffHomeIsNoLongerChosen` |
| The top bar stays in TalkBack's tree | `SelectionRootTest.talkBackSkipsHomesBarUnderTheSelectionBar` |
| Folders stay enabled while choosing | `NoteSelectionTest.foldersWaitWhileNotesAreChosen` |
| Any `kind` accepted in `deletedBy` | `DeletedByTest.anythingElseNamesNoOne` |
| A non-object `deletedBy` fails the decode | `DeletedByTest.anythingElseNamesNoOne`, `TrashModelTest.aDeletedByThatIsNoObjectNamesNoOneAndKeepsTheList` |
| Notes already there counted as moved | `NoteSelectionTest.moveSendsEveryNoteToTheOneFolderPickedInTheOrderChosen` |

## Follow-up: #137 (A658, A659, A701)

The review's leftover nits (N1, N3, N5–N7), from `origin/main` at `3a31f08`. No Room schema change (main is at 16). No server change. Each test was written first and seen failing (8 failed, against the new API shapes with the old behaviour). Full runs, under the shared lock: `task android:test` (app 997 tests, engine-bridge 149; 0 failures, 0 skipped) and `task android:build`.

| Nit | Change | Tests |
| --- | --- | --- |
| N1 Nothing could go to Trash | Said: "None of the 2 notes could move to Trash: they aren't on this phone any more", or "This note can't be moved to Trash: …", from the bar and a note's sheet; no Undo. | `NoteSelectionTest.whenNoNoteCanGoToTrashItSaysSo` |
| N1 A folder gone | `NoteStore.Move.NO_FOLDER`, checked first: "Kitchen isn't on this phone any more" from the bar, "That folder isn't on this phone any more" from a note's sheet. | `NoteSelectionTest.aMoveToAFolderNoLongerOnThePhoneSaysTheFolderIsGone`, `OrganiseStoreTest.aNoteInTrashGoneOrUnknownAndAFolderNotOnThePhoneAreRefused` |
| N3 The stop line's flicker | A storage stop clears only after a pass; a 403's still clears on any exchange. | `SyncStopTest.aFullPhoneStaysStoppedUntilAPassGoesThroughNotOneNotesExchange`, `…aSignInRefusedIsClearedByANotesOwnExchangeToo` |
| N5 A name that is only ✦ | "a device", or "an agent ✦"; TalkBack hears "(agent)" for ✦, and folder names as they are. | `TrashModelTest.aNameThatIsOnlyTheMarkNamesADeviceOrAnAgentAndTalkBackHearsAgent`, `TrashFoldersTest.aFoldersDeleterIsSpokenAsTheNotesAre`, `TrashScreensTest.anAgentsMarkIsSpokenAsAgent` |
| N6 Tag ranking | Each tag ranked once per keystroke, not per comparison; the order is unchanged. | `TagsTest` (unchanged, still passing): a speed-up with no behaviour to fail first |
| N7 Select, app-wide | `NoteList(selectable = true)` on Home, a folder, All notes and a tag's notes only; any other list keeps its own long press, also while a selection is up. | `NoteSelectionTest.aListThatDoesNotTakePartKeepsItsOwnLongPressUnderASelection`; `SelectionRootTest` for the four lists |

Eleven mutants, each applied alone and run against those classes, were all caught, the code restored after each: the folder check returning `REFUSED`; the bar's folder-gone message dropped; either Trash message dropped (bar, sheet); a storage stop cleared by any exchange; a 403 never cleared by a note's exchange; a lone ✦ kept as the name; ✦ spoken as is; the spoken text never set; `selectable` ignored; and Home not opting in.

## Not checked off a device

The look of the selection bar over each list, the switches' and the stopped card's colours in every theme, TalkBack's speech for the selected rows and the stopped line, and a real 403 or full phone. Each is a step of the Pixel checklist, or covered by the tests above where a device cannot be made to fail on purpose.
