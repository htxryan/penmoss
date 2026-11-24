# UX conventions

These are the rules every screen follows, on the Mac/web app and on Android. They come from Ryan's reviews, and they've been missed more than once, so check new UI against them before calling it done. Decisions in `docs/decisions.md` hold the details; this page is the short list.

A design for Penmoss (a plan's mockups, a prototype, a deck, a page of the site) starts from the [Penmoss Design System](https://claude.ai/artifact/XPQB6vQP5Q8zYv7mJNmcCW): its tokens, components, logo files and Writing section are these conventions as the app and penmoss.app draw them today (A1658).

## Bars and their controls

- **A control in a bar fills the bar.** Tab strips, title rows, toolbars and the status bar all follow this. The control runs from the bar's top edge to its bottom edge, with no top, bottom, left or right margin. It also has no rounded corners of its own, and its hover fills its whole cell.
- **Controls sit flush against their neighbours.** For example, the tab strip's **+** sits against the last tab, or at the bar's start when there's no tab. A divider (`1px solid var(--pm-border-soft)`) separates groups, not gaps.
- **Tabs fill the strip** from its top to its rule (A1573).
  - Inactive tabs keep a visible edge, so they still read as tabs.
  - An empty window shows only **+**, with no tab (A1576).

## Words

- **Title Case** for every title, heading, button, menu item, tab and dialog name, and every field label, legend, column heading, confirmation question, status or state name, chip, and filter or funnel value (A1645). Articles, conjunctions and short prepositions stay lower case unless first or last ("Move to Folder", "Keep at Most", "Sign In with GitHub"); a verb's particle is capitalised ("Sign In Again"); "ID", never "Id". Sentences, hints and help text stay in sentence case. The factory checks labels with `tools/factory/sandbox/title-case.cjs`.
- **People's names for things**, never raw ids, enum values or keys ("Claude Code", not `claude-code`).
- **British spelling** in the interface: colour, licence, organise.
- Short action names on buttons, such as **Restore**, **Revert** and **Copy**. The full name goes in the tooltip and the accessible name.
- An action that opens something more (a dialog, a picker) ends with **…**.

## Type

- **Text sizes come from type roles only** (A1561):
  - on the web, `apps/web/src/shell/type.css`: `--pm-text-*`, `--pm-weight-*`, `--pm-leading-*`, `--pm-color-*`, or the `.t-*` classes;
  - on Android, `TextRoles.kt`.
- No raw font size, weight or line height. The stylelint rule `penmoss/type-tokens` refuses them.
- Choose a role by the text's place in the page's hierarchy, not by how it looks. Help text under a setting is smaller than the setting's label.

## Reuse

- **Never mock the app's UI.** A preview, or an example of the app inside the app (as in Settings), renders the real components, made inert (A1564).
- **One flow per job.** Adding a notebook later reuses the first-run screens and logic (A1562); the icon and symbol pickers are one component (A1568).
- Use the shared primitives: buttons, `Switch`, `Select` (`@penmoss/ui/controls/Select`), `Segmented` (`apps/web/src/shell/Segmented.tsx`), chips, `NotebookBadge`, `ConfirmDialog`, `ModalOverlay` (the overlay every modal picker and dialog sits on), `DialogClose`, the focus trap (`apps/web/src/shell/focus-trap.ts`), and `SettingsHeader`. Counts in words come from `counted` (`@penmoss/core/words`).

## Every platform the same

- A feature that reaches the Mac (web) and Android has the same structure, the same order, the same kind of control for each thing (a disclosure on one is a disclosure on the other, not a row that navigates; a button is a button, not a text row) and the same words, except "this Mac" / "this phone" (A1646). A difference the platform forces is named, with its reason, in the plan or a decision.
- Both share one source for their words and data where one exists: core's copy exported to Android's contracts (`apps/android/contract/`), as analytics' `copy.ts` is.

## Layout

- Nothing overflows or is clipped: a confirmation, chip or long label stays inside its dialog, group or card, at the window and phone widths, and no page scrolls sideways.
- Answers offered side by side (Share / Don't Share, Keep / Delete) are equal in size and weight unless the design says why one leads.

## Data on screen

- Counts, lists and empty states follow the store live, on every platform: after a delete, a change of setting or a new event, the screen shows what is there now.
- What one screen shows agrees with the rest of it ("Nothing Recorded Yet" never sits beside a count of 50).

## Usage analytics

- Every new control, screen, dialog, setting, CLI command and MCP tool is recorded by name, on every client it reaches ([`analytics.md`](analytics.md), Adding a tracked control; A1635, A1636). Never record text, titles or other data a person wrote.
- Its id goes in the catalogue, and the contracts are written again for Android.

## Settings

- Every page uses `SettingsHeader` (A1560): a large title that shrinks into a pinned bar, with the page's own buttons at its end.
- A setting kept only on this device carries the laptop icon, whose tooltip says it isn't synced (A1559).
- A destructive action (a delete, a reset, a lowered limit that removes records) asks first, in the app's confirm style (`ConfirmDialog`, or the inline confirm block inside its group), naming what goes, on every platform.
- Every row is findable in Search Settings: it has `data-setting` and an entry in `settings-index.ts`, and Android's index has it too.

## Interaction

- Esc closes the topmost dialog, drawer or popover, and focus goes back to what opened it.
- A dialog's close is the shared × (`DialogClose`), never a text button such as **Close**. Its accessible name says what it closes, and its tooltip adds (Esc).
- Hover and keyboard focus both show the same affordance (an overlay or a highlight). A focus ring shows only for keyboard use.
- Motion is brief, and Reduce Motion replaces it with a static state.
