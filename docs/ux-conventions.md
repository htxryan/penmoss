# UX conventions

These are the rules every screen follows, on the Mac/web app and on Android. They come from Ryan's reviews, and they've been missed more than once, so check new UI against them before calling it done. Decisions in `docs/decisions.md` hold the details; this page is the short list.

## Bars and their controls

- **A control in a bar fills the bar.** Tab strips, title rows, toolbars and the status bar all follow this. The control runs from the bar's top edge to its bottom edge, with no top, bottom, left or right margin. It also has no rounded corners of its own, and its hover fills its whole cell.
- **Controls sit flush against their neighbours.** For example, the tab strip's **+** sits against the last tab, or at the bar's start when there's no tab. A divider (`1px solid var(--pm-border-soft)`) separates groups, not gaps.
- **Tabs fill the strip** from its top to its rule (A1573).
  - Inactive tabs keep a visible edge, so they still read as tabs.
  - An empty window shows only **+**, with no tab (A1576).

## Words

- **Title Case** for every title, heading, button, menu item, tab and dialog name. Sentences stay in sentence case.
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
- Use the shared primitives: buttons, `Switch`, chips, `NotebookBadge`, `ConfirmDialog`, the picker overlay, the focus trap (`apps/web/src/shell/focus-trap.ts`), and `SettingsHeader`.

## Settings

- Every page uses `SettingsHeader` (A1560): a large title that shrinks into a pinned bar, with the page's own buttons at its end.
- A setting kept only on this device carries the laptop icon, whose tooltip says it isn't synced (A1559).
- A destructive action asks first, in a `ConfirmDialog`.

## Interaction

- Esc closes the topmost dialog, drawer or popover, and focus goes back to what opened it.
- Hover and keyboard focus both show the same affordance (an overlay or a highlight). A focus ring shows only for keyboard use.
- Motion is brief, and Reduce Motion replaces it with a static state.
