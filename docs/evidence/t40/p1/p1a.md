# T40 P1a · Settings and Appearance on Android

Evidence for the first half of T40's P1 ([issue #76](https://github.com/htxryan/penmoss/issues/76)): the settings channel, Settings as sections, Mode, the theme grid, note width, Daily notes and the quick-capture destination. Decisions A410–A415 in [`decisions.md`](../../../decisions.md). The theme editor (ST5) is P1b.

## How it was run

- The `penmoss36` emulator (API 36, 1080×2400) on the agent worker, a local Worker (`wrangler dev --local`) and the web app on Vite, as in T39. The phone signed in through the real flow.
- The phone reached the Worker through a small TCP relay over `adb reverse`; stopping the relay put the phone offline without touching the server. The web's changes were made with `PUT /api/settings` and the browser session, as the web app makes them.
- **Before** is `main` at `f9f0bac`; **after** is this branch. Screenshots are scaled to 1080 px tall.

## Walk-through

| Step | What happened | Screenshot |
| --- | --- | --- |
| Before | Settings showed the account, workspace, sync status and Sign out, and nothing could be changed. | [before-settings](before-settings.png) |
| Settings home | Sections with a summary each: Appearance (theme · mode), Daily notes (time zone), Quick capture, Sync and storage, This phone (A415). | [after-settings-home](after-settings-home.png) |
| Mode and theme | Dark chosen with Nord: the whole app, the bars and the grid's check mark change at once (ST3, ST4). | [after-appearance-nord-dark](after-appearance-nord-dark.png) |
| Offline | With the relay stopped, Gruvbox and Dark were chosen. They show at once, from the themes the app ships (A412), and Settings says "Offline… · 2 settings to send" (A411). | [after-offline-appearance](after-offline-appearance.png), [after-offline-settings-home](after-offline-settings-home.png) |
| The web, meanwhile | While the phone was offline, the web set the mode to System and the time zone to Europe/London. | — |
| Online again | Sync now: the phone's Dark was refused (409, the web's System had overtaken it) and dropped; Gruvbox went through. The server ended with Gruvbox, System and Europe/London, and so did the phone (A410, A411). | [after-online-sync-storage](after-online-sync-storage.png), [after-online-settings-home](after-online-settings-home.png) |
| Daily template | A heading added and saved; the server's `template.daily` had it within the pass. | [after-daily-template-saved](after-daily-template-saved.png) |
| Time zone | The searchable list (“tokyo”), then Daily notes in Asia/Tokyo with today's date there (ST6). | [after-time-zone-search](after-time-zone-search.png), [after-daily-notes-tokyo](after-daily-notes-tokyo.png) |
| Quick capture | New note in Inbox chosen; the server's `capture.destination` became `inbox` (ST7). | [after-quick-capture-inbox](after-quick-capture-inbox.png) |
| This phone | Account, workspace, version and Sign out. | [after-this-phone](after-this-phone.png) |
| Light on a dark phone | With the phone in dark mode, Light chosen: Appearance, Home, a note and the capture sheet are light, with dark status and navigation icons (A414). The capture sheet starts on New note in Inbox, the setting chosen above. | [after-appearance-light-on-dark-phone](after-appearance-light-on-dark-phone.png), [after-home-light-on-dark-phone](after-home-light-on-dark-phone.png), [after-note-gruvbox-light](after-note-gruvbox-light.png), [after-capture-light-on-dark-phone](after-capture-light-on-dark-phone.png) |
| Full width | `note.fullWidth` set on the web reached the phone. On a phone in portrait the column is already narrower than the theme's 52rem, so nothing visible changes (A413); the page test covers the cap and its lifting. | — |

## Tests

- **Server** (`apps/server/test/settings.test.ts`, workerd): the contract's values both ways, `/sync/tree` settings and hash, a change and a reset, a 409 that writes nothing, a resent request, 400s, and 403 for agent and read-only tokens; `folder-scope.test.ts` probes the new route.
- **Contracts:** `settings-v1.json` (server suite and Kotlin `SettingsContractTest`), `themes-v1.json` (page vitest generates and checks it; Kotlin reads it), `bridge-v1.json`'s `width` examples (page vitest and `BridgeProtocolTest`).
- **Kotlin and Robolectric:** `SettingsSyncTest` (offline then online, a web change meanwhile, a tree that overtakes a pending change, a change back to the base, a reset, a server without the channel), `SettingsStoreTest`, `SettingsScreensTest`, `SystemBarsTest`, `AppBackgroundTest` (a background run sends a setting; sign-out keeps it), `MigrationTest` (5 to 6), `EditorPageServicesTest`.
- **Page:** "the note width (A413)".

## After the review of #90

Five should-fix items and four nits, each fixed with a regression test that fails with the fix reverted:

| Item | Fix | Tests |
| --- | --- | --- |
| 1. A change back to the base while a value is out was lost | The row stays while a value sent for it has no answer, and puts the base back once that lands (A411) | `aChangeBackToTheBaseWhileOneIsOutStaysToPutTheBaseBack`, `aChoiceMadeBackToWhatTheServerHadWhileTheChangeIsOutStillWins` |
| 2. A waiting capture's `remember` beat a later Settings choice | With settings known, the capture sheet's choice goes by the settings queue and the capture carries no `remember`; a Settings choice clears it on captures waiting from before (A411) | `aDestinationChosenInSettingsAfterACaptureWaitingOfflineStands`, `aDestinationChosenInSettingsStopsWaitingCapturesChangingIt` |
| 3. A template over 10,000 characters showed Saved, then was dropped | A counter under each template; over the limit it says so and Save is off. `SettingLimits` is checked against `templateMaxChars` in `settings-v1.json` | `aTemplateOverTheServersLimitIsCountedAndCannotBeSaved`, `SettingsContractTest` |
| 4. A settings body over 1 MiB was a 500, retried for ever | 413 `too_large`; the phone drops the change and Settings home says so, as it now does for a 400 (nit 9) (A410, A411) | server "refuses a body over the size limit as too large (413)"; `aChangeTheServerWillNotTakeIsDroppedAndSettingsSaysWhy`, `aRefusalDropsTheChangesAndIsShownUntilDismissed`, `aRefusedChangeIsSaidOnTheHomeUntilDismissed` |
| 5. A web template over the limit read as unset, so a phone save overwrote it | The limit applies to writes only; a template is sent and compared as stored (A410) | server "reads a template longer than the limit made on the web…" |
| 6. A lost reply plus a later change dropped that change | Each row keeps the values sent without an answer; a tree or 409 showing one is the phone's own change, rebased on (A411) | `aTreeShowingAValueSentWithoutAnAnswerIsThePhonesOwnChange`, `aChangeMadeAfterALostReplyIsNotTakenForOneMadeElsewhere`, `aTreeShowingTheValueOfALostReplyKeepsTheChangeMadeSince` |
| 7. SystemBarsTest's System test could not fail; no capture sheet test | System is now chosen while the app shows Light; a capture sheet test (Light on a dark phone) added. With the bars following the phone all four fail (A414). The earlier claim that a mutation "fails all three" was about an inverted mode, not one following the phone. | `systemChosenWhileOpenFollowsThePhone`, `theCaptureSheetOnADarkPhoneWithLightChosenHasDarkIcons` |
| 8. Rows that open a screen read "Not selected" | They are buttons (`clickable`, role Button); "Use this phone's zone" sits above the zones' radio group | `rowsThatOpenAScreenAreButtonsNotUnselectedChoices`, `useThisPhonesZoneIsAButtonOutsideTheListOfZones` |
| 10. `resources.include` filtered the whole source set | A `contractResources` copy task feeds the resources | The APK holds `themes-v1.json`; `SettingsContractTest` reads it |

