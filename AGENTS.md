# Penmoss: agent instructions

Read these before doing any work in this repository:

1. [`docs/decisions.md`](docs/decisions.md): every decision (D-series), architecture rule (A-series) and working agreement (W-series). Read the working agreements in full (the `## Working agreements` section at the end; they cover autonomy, branches, notifications and machine limits). The file is too big to read whole, so search the D- and A-series for the area you touch, and cut the long rows, e.g. `grep -n 'search' docs/decisions.md | cut -c1-300`.
2. [`docs/architecture.md`](docs/architecture.md): what Penmoss is and how it fits together. [`docs/development.md`](docs/development.md): how work is planned and checked, and the Definition of Done.
3. The Linear issue for your task, `PEN-<n>` in Linear's **Penmoss** team, read through the Linear MCP (`get_issue`). The roadmap is the team's open issues; nothing in the repository holds a task list. A `#n` in an older decision or doc is a GitHub issue or pull request in `htxryan/penmoss-private` (W14).

## Rules

- When a decision changes, record it in `docs/decisions.md` in the same commit.
- A user-facing change (a menu, a setting, a shortcut, a CLI command or flag, an MCP tool, what a screen says or does) updates its page in the user docs, `site/src/content/docs/docs/`, in the same pull request. User docs live only there; `docs/` is for contributors (A1215).
- Plan new work as Linear issues in the Penmoss team (`PEN`, the **Task** template), never as files in the repository. A large piece of work is a parent issue with sub-issues, and work that spans several pull requests also gets a Linear project. The plan itself (spec, decisions, diagrams, prototype, tasks) is a Claude artifact linked from the parent issue. Each task is a sub-issue that tracks progress. No planning or roadmap file of any kind goes in the repository: no `tasks/`, `plans/`, `docs/ideas/`, `docs/notes/`, `plan.md`, `plan.html`, `SPEC.md`, `todo.md` or roadmap. `task lint` fails on such files (W13).
- Mark a task done only when its acceptance criteria and the Definition of Done (`docs/development.md`) are met. Then record evidence in the pull request or the issue. A pull request that says `Fixes PEN-<n>` marks the issue Done when it merges.
- Use Taskfile commands (`task --list`) and pnpm via corepack. Run `task check:changed` before each commit and `task check` before pushing. `task check` waits for a free heavy-job slot, since several sessions share this Mac (W12); `task check:changed` waits only when it has heavy work (A1224).

## Tests never open windows on this Mac

This Mac is Ryan's, and he is using it. A test that opens a window takes over his screen (W10).

- **The Mac app's suite (Electron):** `task desktop:test`, with Playwright arguments after `--`, such as `task desktop:test -- test/e2e/feedback.spec.ts --repeat-each=5`. On a Mac it runs in the test VM (`penmoss-test`, Tart), not on this screen. The log is in `test-results/vm/desktop-test.log`, and Playwright's report and traces are beside it. One run uses the VM at a time; others wait their turn. Never start Electron's suite any other way (`pnpm … playwright test` in `apps/desktop`, `_electron.launch` in a script): it refuses on a Mac outside the VM.
- **The web suite (`task e2e`):** headless Chromium, so it runs here. Never pass `--headed`, `--ui` or `--debug`, or set `PWDEBUG`: those refuse on a Mac outside the VM. To see a failure, open its trace with `pnpm exec playwright show-trace`.
- **Anything else that would open a window** (an app, a browser, a simulator) for a test runs in the VM too. If there is no VM path for it yet, stop and ask Ryan rather than opening it here.
- **Setting up the VM** (Tart, the image, the screen size, starting again) is in [`docs/ci.md`](docs/ci.md) §8.

## Inside a factory run

If `PENMOSS_FACTORY_RUN` is set, you are running in the software factory's sandbox (`docs/factory.md`):

- The factory pushes, opens and edits pull requests, and moves issues between statuses, after it checks your work. Don't do any of those yourself. Don't deploy.
- Follow the prompt's instructions on `.factory/result.json`. Name the proof specs for each platform in scope.
- Use the port block in `PENMOSS_PORT_BLOCK` (`node scripts/ports.mjs`), never fixed ports.
- Number new decisions `A-NEW-1`, `A-NEW-2`, and so on; the factory assigns the real numbers.
- If you skip or loosen a test, the gate sends it back, unless a decision you add names that test's file and says why.
