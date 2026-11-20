---
name: penmoss-review
description: Review a Penmoss change (a branch, a pull request, a plan and its mockups, or the factory's evidence) for whether it follows the app's conventions and patterns, the way Ryan reviews: Title Case and wording, Mac and Android parity, visual consistency, the real components reused rather than new ones, usage analytics wired in, confirmations before destroying, live and consistent data, proof that shows each criterion, and the decisions and docs that go with it. Use when asked to review a PR, a diff, a plan or a design, before marking work done, or as the factory's reviewer.
---

# Reviewing a Penmoss change

Review like Ryan, who will review it next: everything he would send back should be found here first. This skill is the procedure. The rules themselves live in the repository, and this skill never restates them, so read them each time:

- [`docs/ux-conventions.md`](../../../docs/ux-conventions.md): the conventions every screen follows (bars, words, type, reuse, every platform the same, layout, data on screen, usage analytics, Settings, interaction).
- [`docs/analytics.md`](../../../docs/analytics.md): how usage is recorded, and Adding a tracked control.
- [`docs/development.md`](../../../docs/development.md): the Definition of Done. [`AGENTS.md`](../../../AGENTS.md): decisions, user docs, the Release note.
- The [Penmoss Design System](https://claude.ai/artifact/XPQB6vQP5Q8zYv7mJNmcCW) (read its `project/README.md` with the Artifact tool): the app's and the site's tokens, components, logo and writing, read from the code. A plan's mockups and a design are built from it.
- `docs/decisions.md`: search it for the area the change touches (`grep -n '<area>' docs/decisions.md | cut -c1-300`). A change that contradicts a decision without amending it is a finding.

## What you're reviewing

Work out the change and what it was meant to do:

- **A branch or PR:** `git diff origin/main...HEAD` (or `gh pr diff <n>`), and the Linear issue it names (`PEN-<n>`, through the Linear MCP, with its comments). In the factory's sandbox, main is `origin/main`.
- **The plan and design:** the acceptance criteria and mockups, when there are any. The plan's words win over its mockup.
- **Evidence:** screenshots, the factory's captures and audits (`.factory/validation/`), proof recordings and their stills.

Which platforms it reaches: `packages/` and `apps/web/` reach web, Mac and Android; `apps/desktop/` the Mac; `apps/android/` Android. A feature on one client that the others have, or should have, needs its twin.

## The checks

Go through every check for every screen and criterion the change touches. Each one names the convention section it applies.

1. **Words** (Words). Every title, button, tab, menu item, legend, field label, column heading, confirmation question, state name, chip and filter value in Title Case; people's names, never raw ids; British spelling; `…` on an action that opens more. On a web page or the Mac app, `tools/factory/sandbox/ui-audit.cjs` finds misses for you (below). In code, read every new string literal shown to a person, in TSX and in Kotlin (`stringResource`, literals in composables, core's `copy.ts`).
2. **Parity** (Every platform the same). Put the Mac's (web) and Android's version of each screen side by side, in code and on screen: the same rows in the same order, the same control kinds, the same words except "this Mac" / "this phone", the same destructive and secondary styles. A feature built on one client only, when the other has the surface, is a finding unless the plan says why. Shared words come from one source (core's copy and Android's contracts), never typed twice.
3. **Visual consistency** (Bars and their controls, Type, Layout). Type from roles only (`--pm-text-*`, `.t-*`, `TextRoles.kt`), colours and spacing from tokens, controls filling their bars, nothing overflowing or clipped, equal answers equal. Compare a new screen with its neighbours in the app (the Settings page beside it, the dialog it resembles): spacing, alignment, icon size and stroke, the destructive style. A difference from the neighbours that the design doesn't ask for is a finding. A mockup or design that picks its own colours, type, radii or components instead of the design system's (the app's `pm-*`, the site's `site-*`) is a finding too.
4. **Reuse** (Reuse). Before accepting a new component, hook or helper, search for one that already does the job: `apps/web/src/shell/` (ConfirmDialog, ConfirmBlock, DialogClose, Menu, pickers, focus trap, SettingsHeader), `packages/ui/src/` (controls, icons, panels, theme), `apps/android/app/src/main/java/app/penmoss/ui/common/` and the settings screens' shared pieces, and core for logic both clients need. A second copy of logic that core could hold for both clients, a hand-drawn imitation of an app component, or a new flow beside one that does the same job (one flow per job) is a finding. Name the existing piece to use.
5. **Usage analytics** (Usage analytics; `analytics.md`). Every new control has a tracked id (`data-event` or `data-command` on the web, `Modifier.tracked` or a command on Android), every new screen, dialog and setting is recorded by name, a new CLI command or MCP tool is too, and every id is in the catalogue with the contracts written again. No event carries text a person wrote. If the change adds catalogue names, the PR says the ingest Worker must be deployed before release. The lint rule and the catalogue tests catch a missing id; you catch a screen or dialog that is never recorded, and a client that records what the other doesn't.
6. **Destructive actions and Settings** (Settings). Anything that deletes, resets or loses data asks first in the app's confirm style, naming what goes, on every platform. New settings rows carry `data-setting` and an entry in `settings-index.ts` and Android's index; a device-only setting carries the laptop icon; every page uses `SettingsHeader`.
7. **Data on screen** (Data on screen). Counts, lists and empty states follow the store as it changes, on every client; nothing on a screen contradicts the rest of it or what was just done. In code, look for a value read once and never observed (a `remember` without a flow on Android, a `useMemo` without the store in its dependencies).
8. **Interaction** (Interaction). Esc and focus return, the shared ×, hover and focus showing the same affordance, Reduce Motion.
9. **Proof** (`docs/development.md`, Definition of Done). For each acceptance criterion someone sees, on each platform it is about, a proof spec brings that state on screen and holds it: the panel scrolled to, the dialog or preview open, the rows visible. A spec that only passes near it is thin. Budget tests (`*.budget.test.ts`) assert on medians or percentiles, never the slowest sample.
10. **Decisions, docs and notes** (`AGENTS.md`). A changed decision recorded in `docs/decisions.md` in the same change; the user docs in `site/src/content/docs/docs/` updated for anything a person sees; a `## Release note` that says what changed for them.

## Tools that check for you

- `task check:changed -- origin/main`: lint (including `penmoss/type-tokens` and `penmoss/tracked-control`), typecheck and the changed packages' tests.
- The UI audit, on any page you can open in headless Playwright (never headed on this Mac): `const { auditTo } = createRequire(import.meta.url)('<repo>/tools/factory/sandbox/ui-audit.cjs')`, then `await auditTo(page, '<file>.json')` on each screen. It reports Title Case misses, overflow, a page wider than its window and unequal answers. In the factory, the validator runs it and `<id>-audit.json` sits beside each capture.
- The factory's design check (`tools/factory/src/design-check.ts`) for a plan's mockups.

## Reporting

List findings, most serious first. For each: the check it fails (by number and name), where (`file:line`, or the screen and platform), what is wrong, and what to do instead, naming the existing component, token, convention section or decision. Say "none" for a check that passes, so the reader knows it was looked at. Don't soften a finding because the mockup or the plan missed it too: say so, and that the plan needs the fix as well.

In the factory, the reviewer's prompt says where the findings go (`review.json`'s `code` list); outside it, give them in the review or the PR comment.
