# Development

How work on Penmoss is planned, built and checked. Setup and commands are in the [README](../README.md) and `task --list`; how the code fits together is in [`architecture.md`](architecture.md).

## Planning: Linear

The roadmap is the open issues in Linear's **Penmoss** team (`PEN`), which agents reach through the Linear MCP (W14). Work that spans several pull requests is a Linear project (Software factory, Public release, Search by meaning). GitHub issues on [htxryan/penmoss](https://github.com/htxryan/penmoss/issues) are where anyone outside reports bugs and ideas, and Send feedback files there too. A workflow (`.github/workflows/linear-intake.yml`) copies each new one into PEN Triage, one way only, with a link back; it needs the `LINEAR_API_KEY` repository secret. Linear's own GitHub issue sync stays off: it is two-way, and would copy PEN issues into this public repository. The plan itself (spec, decisions, diagrams, a clickable prototype for UI work, and the tasks) is a Claude artifact, linked from the parent issue. Issues track progress. No planning or roadmap file of any kind lives in the repository. `task lint` fails on files such as `tasks/`, `plan.md`, `plan.html`, `SPEC.md` or `todo.md` (`scripts/no-plan-files.sh`, W13).

- **One issue per task.** Use the Penmoss team's **Task** template in Linear: goal, acceptance criteria, automated checks, manual checks, evidence. A large piece of work is a parent issue with sub-issues, each one a pull request.
- **One sub-issue per branch (W11).** Each sub-issue gets its own worktree, branch and pull request. Open the pull request as a draft once the first slice is committed, so CI runs while the work goes on. Don't build several sub-issues on one branch: it delays every review and piles up merge conflicts.
- **Flaky tests get their own issue (W11).** A test that fails at random and passes alone isn't retried into green, and isn't fixed inside an unrelated feature's branch. File an issue with the failure and fix it in its own pull request. A feature's pull request may still merge on a rerun if the flake is filed and unrelated to its change.
- **The issue owns status:** Triage (not yet weighed), Backlog, Todo, In Progress, In Review, Done, Canceled. A pull request that delivers a task says `Fixes PEN-<n>`, and Linear marks the issue Done when it merges.
- **Evidence** (test output, before and after screenshots, measurements) goes in the pull request or the issue. Screenshots that need to stay with the code go in `docs/evidence/<issue number>/`.
- **Decisions** go in [`decisions.md`](decisions.md), in the same pull request as the change they explain.
- **Every pull request has a Release note (A1294).** The description's `## Release note` section (in the template) holds one line per user-facing change, `New`, `Improved` or `Fixed`, then `(Mac)` or `(Android)` if the change is only there, a colon and one sentence ending in a full stop: `Fixed (Android): The keyboard no longer hides the last line.` Write it for someone using Penmoss: what they can now do or no longer suffer, not how the code changed. Write `none` for a change nobody using Penmoss would notice: CI, tests, refactors, contributor docs, the factory. Keep the notes together: a blank line ends the section. The **Release note** check (`.github/workflows/release-note.yml`) fails until the section reads right, and runs again when the description is edited. These lines become the release notes on GitHub and in the apps (PEN-76).

## Definition of Done

**Every task:**

- Its acceptance criteria are met and checked in the running app, not only in tests.
- New tests fail without the change.
- `task check` and the E2E suite are green, with no new suppressions or skipped tests.
- The manual check is done and its evidence is linked from the issue or the pull request.
- The change stays within the task; lint and format pass.
- A user-facing change updates its page in the user docs (`site/src/content/docs/docs/`, served at penmoss.app/docs) in the same pull request, and `task site:build` passes (W9, A1215).

**Every feature:**

- It works with the rest of the app on a real notebook, on every client it touches.
- Migrations and config are accounted for, and the notebook format is raised only with a reason (`packages/git-notebook/src/layout.ts`).
- The user docs, the contributor docs in `docs/` and the decisions are updated.
- Input, auth and data handling have had a security review.
- Ryan has reviewed it before merge.

## Code style

```ts
// packages/core/src/periodic.ts
export function dailyNotePath(date: PlainDate): string {
  const { year, month } = date;
  return `Journal/${year}/${pad2(month)}/${date.toString()}.md`;
}
```

- Pure functions in `core`; side effects at the edges (transports, the engine's storage, the UI).
- Named exports, no default exports; kebab-case files; PascalCase React components.
- Every user action goes through the command registry, and every colour through a theme token.
- Errors are typed results across module boundaries; no silent catches.

## Testing

| Level             | What                                                                | Where                                                  |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| Unit and property | Codec round-trips, merge cases, the engine, sorting, periodic notes | `packages/*/test`, `apps/*/test` (Vitest, fast-check)  |
| End to end        | User flows on git notebooks, offline and online, clipboard, axe     | `apps/web/test/e2e` (Playwright)                       |
| Mac app           | Launch, edit, capture, menus, git notebooks, local agents           | `apps/desktop/test` (Playwright for Electron, in a VM) |
| Android           | The sync engine, the bridge, Room and Compose UI                    | `apps/android` (JVM and Robolectric)                   |
| Manual            | The running app on the Mac and the Pixel                            | Evidence in the issue or pull request                  |

## Boundaries

**Always:**

- Run `task check:changed` before each commit and `task check` before pushing (A1176). CI runs `task check` on every push, too.
- Run heavy commands (`task check`, `task check:changed`, `task e2e`) through the Taskfile, which waits for a free heavy-job slot on this Mac when the work is heavy (W12, A1175, A1224). Don't call Playwright or the whole Vitest run directly to skip the wait.
- Put a wall-clock budget (a unit test that times itself with `performance.now()`) in a `*.budget.test.ts` file beside the unit test, which keeps the correctness checks. `task check` leaves budget files out; `task budgets` runs them alone, one file at a time (CI's `Performance budgets` job doesn't run them yet). A bound that only shows a call didn't hang stays a unit test and uses `Date.now()`. `task budgets:test` enforces this (A1244).
- Run the Mac app's Electron tests with `task desktop:test`. On a Mac they run in the test VM, never on Ryan's screen, one run at a time (W10, [`AGENTS.md`](../AGENTS.md)).
- Add codec fixtures for any new block.
- Route actions through commands and colours through tokens.

**Ask Ryan first:**

- A change to the notebook format that older clients cannot read.
- A dependency over 50 kB gzipped in the editor bundle.
- Anything that costs money (Ryan buys domains, plans and accounts).

**Never:**

- Commit secrets or tokens.
- Skip or delete failing tests to get to green.
- Send note content to third-party services other than GitHub and Cloudflare (the relay).
