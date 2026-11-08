# T40 P1b · The theme editor on Android

Evidence for the second half of T40's P1 ([issue #76](https://github.com/htxryan/penmoss/issues/76)): the theme editor (ST5) with the editor page's preview, custom themes saved from the phone, and the contrast contract. Decisions A416–A419 in [`decisions.md`](../../../decisions.md). P1a's evidence is in [`p1a.md`](p1a.md).

## How it was run

- The `penmoss36` emulator (API 36, 1080×2400) on the agent worker, a local Worker (`wrangler dev --local`) with this branch's server, and the web app on Vite, as in P1a. The phone signed in through the real flow. Screenshots are scaled to 1080 px tall.
- The web's edit was made with `PUT /api/settings` and the browser session, as the web app's settings write. What the server held was read from `/sync/tree` after each step.
- The emulator still had the database of a P1a build from before the review of #90, which had schema 6 without `pending_settings.sent`. Room refused to open it ("identity hash"), so the app's data was cleared first. `main` never had that schema (#90 was squashed); only a phone with a branch build from before that review is affected, and it needs the app's data cleared or a reinstall.

## Walk-through

| Step | What happened | Screenshot |
| --- | --- | --- |
| Appearance | With Nord chosen, the Theme editor section explains that built-ins can't be changed and offers Duplicate Nord. | [p1b-appearance-duplicate](p1b-appearance-duplicate.png) |
| Duplicate | The editor opened on "Nord copy", which was chosen. The server had `theme.custom.custom-esdnkb645bci` ("Nord copy") and `theme.id` set to it (A416, A417). | [p1b-editor-nord-copy](p1b-editor-nord-copy.png) |
| Preview | The strip at the top is the editor page in its `preview` mode: "Garden plan" with a link, a highlight, code, a heading and a task list, in the theme (A418). | [p1b-editor-nord-copy](p1b-editor-nord-copy.png) |
| Colour sheet | Accent's sheet: the old and new colour, the saturation and brightness square, the hue, saturation and brightness sliders, the hex field (`#d8b04a` typed) and the theme's own colours. | [p1b-colour-sheet-hex](p1b-colour-sheet-hex.png) |
| Contrast | Use colour: the preview, the editor's own controls and the app took the yellow accent at once. The summary said "8 colour pairs are below WCAG AA in the light variant", with Show all 8, and a warning sat beside each colour concerned, such as "Accent text on the page (1.8:1)" on Page background. The server had the new accent: the warnings advise, and the server decides (A419). | [p1b-contrast-summary](p1b-contrast-summary.png), [p1b-contrast-warning-rows](p1b-contrast-warning-rows.png) |
| Dark | Dark: the preview showed the dark variant, the screen said the app was showing the light one, and the dark variant passed AA. | [p1b-dark-variant](p1b-dark-variant.png) |
| Name | Renamed to "Nord honey"; the title bar and the server followed. | — |
| The web, meanwhile | The web changed the same theme's dark accent to `#e08a5a`. After a pass, Appearance offered Edit Nord honey, and the editor's Dark variant showed the web's accent, `#e08a5a`. | [p1b-appearance-edit-own](p1b-appearance-edit-own.png), [p1b-web-edit-arrived](p1b-web-edit-arrived.png) |
| Delete | Menu → Delete this theme asked "Delete “Nord honey” on every device?". Delete theme closed the editor on Appearance with Nord chosen again; the server held the deletion mark `{id, base: "nord", deleted: true}` and `theme.id` `nord` (A416, A417). | [p1b-delete-confirm](p1b-delete-confirm.png), [p1b-after-delete](p1b-after-delete.png) |
| Type and layout | On a new copy, Serif (book) as the note font and a note width of 42 rem: the preview's text turned serif, and the server had both. | [p1b-type-and-layout](p1b-type-and-layout.png) |

On the page, a plain link in a note takes the accent colour (`.note-body a` in the web's stylesheet), on the web as on the phone. The Links token colours wikilinks, so changing it does not recolour the preview's link.

## Tests

- **Server** (`apps/server/test/settings.test.ts`, workerd, "custom themes from the theme editor (A416)"):
  - the contract's valid and invalid custom values;
  - a theme made and chosen in one change, then resent;
  - a merge that keeps another device's edits and a field this build does not know;
  - a 409 for an edit of a theme deleted meanwhile, and for a new theme whose id is taken;
  - a deletion with `theme.id` going back to its base;
  - 400s, including choosing a theme deleted in the same change.
- **Contracts:**
  - `settings-v1.json` gains `customTheme` (duplicates, copy names, an edit, a deletion, valid and invalid values), checked by the server suite and `ThemeEditsTest`;
  - `theme-contrast-v1.json` (new), generated and checked by the page's vitest and checked by `ContrastContractTest`;
  - `bridge-v1.json`'s `preview` example, checked by the page's vitest and `BridgeProtocolTest`.
- **Kotlin and Robolectric:**
  - `ContrastContractTest` and `ThemeEditsTest`, the latter with an HSV round trip over every built-in colour;
  - `SettingsSyncTest`:
    - a theme duplicated offline is made and chosen;
    - an edit survives another device's edit to the same theme;
    - an edit of a theme deleted elsewhere is dropped;
    - a deletion goes even after another device's edit.
  - `ThemeEditorScreenTest`:
    - a colour saved once edits pause;
    - a WCAG warning beside the colour, and the colour still saved;
    - the dark variant edited apart;
    - the name rules;
    - Delete asks first;
    - a deleted theme says so;
    - Appearance's Duplicate and Edit;
    - the preview waits while a note's WebView is alive and never makes a second.
  - `SettingsScreensTest`: Duplicate Gruvbox through the real route makes "Gruvbox copy", chooses it, and leaves it to send.
- **Page:** "the theme editor's preview (A418)".
- **Mutation checks:**
  - With `NoteStore.themeEditStands` disabled, the merge test fails.
  - With the preview's gate removed, the one-WebView test fails.

## After the review of #91

Four should-fix items and six nits, each with a regression test that fails with the fix reverted:

| Item | Fix | Tests |
| --- | --- | --- |
| 1. A colour put back after a lost reply never reached the server | For a field put back to the base's value while a version is out without an answer, the base sent is that version's value, so the server's merge writes it (`ThemeEdits.sendingBase`, A416, A417) | `aColourPutBackAfterALostReplyIsPutBackOnTheServerToo`, `aFieldPutBackAfterALostReplyIsSentAgainstTheValueSent` |
| 2. A deletion mark was stored as sent, with whatever else it carried | Stored as `{id, base, deleted: true}` only; deleting a theme never had stores nothing; at most 50 custom themes, a new one past that a 400 naming its key (A416) | server "stores a deletion as the web does and nothing else…", "refuses a theme past 50, naming it…"; `SettingsContractTest` (`customThemesMax`) |
| 3. More than 20 waiting settings were all dropped | At most 20 a request, custom themes first (A417) | `moreThanTwentySettingsGoTwentyAtATimeThemesFirst`; `SettingsContractTest` (`settingsPerRequest`) |
| 4. After a restart the editor said the theme was deleted | A loading bar until the settings are read | `justAfterARestartTheEditorLoadsRatherThanSayingTheThemeWasDeleted` |
| 5. A dead renderer left a dead WebView | It is removed and destroyed; "Preview unavailable" with Reload (A418) | `aPreviewWhoseRendererDiesGoesAndReloadMakesAnother` |
| 6. One WebView only one way round | A note's WebView waits while the preview is alive (A418) | `theNotesPageWaitsWhileTheThemePreviewIsAliveAndStaysOnceMade` |
| 7. A theme made here, edited elsewhere before the reply, lost the phone's later edit | It is based on the version sent, and both edits stand (A417) | `aThemeMadeHereWhoseReplyWasLostKeepsTheEditMadeSinceAndTheWebsToo` |
| 8. The contrast check could crash on a theme missing a token, and some pairs did not name `fg` | Checked only when every token is there; every pair names the tokens its derived colours are made from (A419) | `aThemeMissingAColourIsShownWithoutAContrastCheck`, `everyPairNamesEveryTokenThatChangesIt` |
| 9. The colour sheet with TalkBack | Quick picks say their tokens and whether chosen; the square has a state; each slider is read once (A417) | `theColourSheetSaysWhichTokensAPickIsAndWhichIsChosenOnce` |
| 10. The open colour sheet was lost on a restart | Its state is saveable, with the delete question (A417) | `anOpenColourSheetAndWhatWasTypedInItOutliveARestart` |

The test fake now merges theme edits as the server does, rather than storing them as sent, and refuses more than 20 settings as the server does.
