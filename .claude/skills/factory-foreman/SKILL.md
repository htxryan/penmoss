---
name: factory-foreman
description: Operate, observe, fix and redeploy Penmoss's software factory (tools/factory) on Ryan's Mac. Run a real PEN card through it end to end as a meta-test, watch every step, take notes, fix what blocks, ship the fixes and update the installed factory. Use when Ryan asks to run a card through the factory, test the factory, check on or unstick a factory run, update or restart the factory, or fix what a factory run found.
---

# Factory foreman

The factory picks a PEN card from Linear and has an agent implement it in a sandbox. It checks the work, opens a PR as `penmoss-factory[bot]`, watches CI, merges once Ryan approves, verifies `main` and sets Done. **The foreman** runs the factory and checks each step against what should have happened. It writes down what goes wrong, fixes what blocks the run, then ships the rest and updates the installed factory.

Read first: `docs/factory.md` (the runbook), the factory decisions (`grep -n 'A12[2-9][0-9]\|F[0-9]' docs/decisions.md | cut -c1-300`), and AGENTS.md's working agreements.

## Ground rules

- **Never read secret stores:** `~/.config/penmoss-factory/*` (factory.env, linear.env, proof.env, github-app.*), keychain items, `~/Library/Application Support/Penmoss/git-secrets.json` and `~/.penmoss/credentials.json`. To check a token, use the app or a command that uses it without printing it, such as `task factory:linear:check`. Agents never get Ryan's logins.
- **Nothing opens a window on this Mac** (W10). Electron runs in the Tart VM, Playwright runs headless.
- **Use Ryan's `gh` and the Factory UI's token only when Ryan has delegated the run** ("run it through to merged and deployed"). Approve with his `gh`. Clear Blocked **only through the UI's `/action`**, never through the app.
- **Keep PEN ids out of PR titles.** Linear's GitHub integration closes a card named in a PR title the moment that PR merges. That happened to PEN-75 with #62. Write `Part of PEN-n` in the body instead.
- **Use scoped checks while fixing:** `pnpm exec tsc --noEmit -p .` and `pnpm exec vitest run` in tools/factory, `node --test` for scripts, and eslint/prettier on changed files. Ryan dislikes long foreground `task check` runs; CI runs the full check. When load is high (`uptime` above ~30), real-git tests time out: rerun the suite on its own before calling it a failure.
- **Keep PRs few and small, to keep CI load down.** Merge green PRs without asking. Install a change to the app.
- **Commits end with** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Put no model names anywhere else.
- **Interrupts stop background agents.** When Ryan interrupts the turn, every background agent is killed. Long fix work belongs in a separate session (`create_session` in the `penmoss` bridge environment; it needs Ryan's approval). Otherwise tell the agents to commit after each item, so a restart can pick up their branch.
- **Other sessions share `~/src/penmoss`.** Do fix work in a git worktree, never by switching that checkout's branch.

## The factory's moving parts

| Thing          | Where                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State folder   | `~/Library/Application Support/penmoss-factory/` (it has a space: quote it)                                                                             |
| Daemon's code  | `code/`, its own clone of `main`, moved only by `task factory:update` (A1226)                                                                           |
| Runs' clone    | `repo/`, with worktrees in `repo/.sandcastle/worktrees/factory-<n>-<slug>`. **The host never runs git there** (A1230)                                   |
| Publish repo   | `publish/` (bare). The host pushes from here with the App's token                                                                                       |
| Ledger         | `runs.jsonl`: claimed, agent-started, agent-finished, decisions-numbered, gate-passed, proof-recorded, pushed, pr-opened, in-review, failed, blocked, … |
| Logs           | `daemon.log`, `ui.log` (its last line has the UI's link and token), `runs/<run>/agent.log`, `doctor/`                                                   |
| Status         | `status.json`, written each poll (pid, commit, running, waiting, paused)                                                                                |
| LaunchAgents   | `app.penmoss.factory` (the daemon) and `app.penmoss.factory-ui` (the UI on 127.0.0.1:7878), in `~/Library/LaunchAgents/`                                |
| Agent's result | `<worktree>/.factory/result.json`: status, summary, tests, platforms and proofSpecs, decisions, risks                                                   |
| Linear         | Team PEN: Todo → (Planning) → In Progress → In Review → Done. Blocked is a label, Agent and Model are label groups, `plan:skip` skips planning          |

How a card's scope is decided: `platforms.ts` classifies the changed paths. `site/` is ci-only, so the gate runs `task check` and no product proof is made. App code gets web proof, and Mac or Android proof where it applies, uploaded to R2 (`proof.penmoss.app`, A1223).

## Scripts (`scripts/`)

Run the `.ts` scripts from `tools/factory`, with Node from `~/.nvm/versions/node/v24.21.0/bin`. They act as the factory's Linear app, through its own client, and never print a token.

| Script                                                  | Does                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `candidates.ts`                                         | Lists Triage, Backlog and Todo cards with creator and labels, for picking a test card                                      |
| `card.ts PEN-n`                                         | Prints a card: state, labels, creator, description, comments                                                               |
| `history.ts PEN-n`                                      | Prints status and label history with the actor, plus linked PRs. Use it when a status changes unexpectedly                 |
| `label.ts PEN-n plan:skip Agent/claude`                 | Adds labels. Use `Group/name` for a grouped label                                                                          |
| `move.ts PEN-n "In Progress"`                           | Sets a card's status                                                                                                       |
| `unlink.ts PEN-n <pr-url>`                              | Removes a PR attachment that Linear's GitHub integration added                                                             |
| `comment.ts notes.json`                                 | Posts `{"PEN-n": "markdown"}` comments                                                                                     |
| `sandbox.ts <slot> <sha> '<cmd>'`                       | Runs a command in a slot's real Seatbelt sandbox on a throwaway branch, then delete the `factory/probe-*` branch it leaves |
| `ui.sh view` / `ui.sh block <n> on\|off` / `ui.sh link` | The Factory UI's API as Ryan                                                                                               |
| `watch.sh`                                              | Prints ledger and daemon-log events as they come in. Use it as a Monitor command                                           |

## Operate

- **Status:** run `task factory:status`, then check that the pid is alive: `launchctl list | grep penmoss.factory`, where a `-` in the first column means it isn't running. Also check that `status.json`'s `updatedAt` is recent and `code.commit` is the `main` you expect.
- **Update to a new `main`:** `task factory:update`. Afterwards, always check that **both** LaunchAgents are running and that the daemon logged `Factory daemon <pid> at <sha>`. Known failures:
  - The daemon exits 1 with `could not lock config file …/repo/.git/config`, a startup race with the UI. Run `task factory:start`.
  - `Bootstrap failed: 5: Input/output error`: retry `task factory:start` until a pid shows.
  - `factory:start` starts only the daemon. Start the UI by hand: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.penmoss.factory-ui.plist`, retried.
  - KeepAlive may be off, so a crashed daemon stays down. Check after any exit.
- **Stop everything mid-step:** `task factory:stop`. Setting Blocked doesn't stop a step that's already running, such as a gate or a push. Stopping the daemon kills the run's process tree. Clearing Blocked later lets the daemon recover the run (R12).
- **Doctor:** `task factory:doctor -- --full`, per slot. Run it with the LaunchAgent's PATH, not your shell's: `PATH="$(plutil -extract EnvironmentVariables.PATH raw ~/Library/LaunchAgents/app.penmoss.factory.plist)" task factory:doctor -- --full`. A missing `claude` on that PATH is what broke the first run.
- **What will start next:** `task factory:next`.
- **The UI:** `task factory:ui:open` opens it signed in. The bare URL won't load without the token.

## Run a card through: the meta-test

1. **Pick the card** (`candidates.ts`). It should be Ryan's own: the factory trusts only his words, and a card filed by the app is fenced off as untrusted. Pick something small, unambiguous and readable as text, since the agent can't see Linear's images. Each test should exercise something new: planning (no `plan:skip`), product proof (app code), OpenCode (`Agent/opencode`), a review round, a CI repair. Agree the card with Ryan.
2. **Preflight on the factory's own commit:** status, the doctor with the LaunchAgent's PATH, `task factory:linear:check`. Run a no-bail test pass in a sandbox (`sandbox.ts 2 <main-sha> 'corepack pnpm install --frozen-lockfile >/dev/null && corepack pnpm -r --no-bail run --if-present test'`), because the gate's `task check` stops at the first failure.
3. **Start notes and the map:**
   - Notes go in a scratchpad file, `<card>-run-notes.md`, with the legend `[BLOCKING]` fixed on the spot, `[FIX]` for the follow-up, `[OK]` verified and `[NOTE]` worth knowing. Every line gets a UTC timestamp.
   - Publish the live test map: copy `assets/test-map.html`, reset its `STATE`, and republish it to the same path on every change. It colour-codes each component and step as validated, in progress, left or bug.
4. **Label and start:** `label.ts PEN-n Agent/claude` (add `plan:skip` only to skip planning), then `move.ts PEN-n Todo`. `task factory:next` should name the card, agent, model and phase.
5. **Watch:** start a Monitor on `scripts/watch.sh` (persistent) and re-arm it when it expires. Expect claimed → agent-started → agent-finished → (decisions-numbered only if the card added a decision) → gate-passed → proof-recorded → pushed → pr-opened → in-review. Then, after approval: "approved, merging" → merged → done.
6. **Validate every step:**
   - **Linear:** each status move, each comment's wording and the factory's marker, the Blocked label with its reason.
   - **The run folder:** the agent's tool calls in `agent.log`; `result.json`, whose risks and test results are a good signal.
   - **The UI:** `ui.sh view` shows the card in the right lane.
   - **The PR:** title (short, no PEN id), body (`Part of PEN-n`, scope, gate, risks, proof from proof.penmoss.app), author `app/penmoss-factory`, commit author `penmoss-factory[bot]`, CI jobs as the path filter predicts.
7. **Review like a reviewer:** read the diff, then approve with Ryan's `gh` if he delegated it (`gh pr review <n> --approve --body …`). The factory merges, waits for `main`'s CI on the merge commit and sets Done.
8. **Deploy by hand** when the change ships somewhere (A1225; runs deploy nothing). For the site, `task site:deploy` from an up-to-date `main`, then `git checkout -- site/src/data/release.json`, which the build rewrites. Check production with `curl`.
9. **Close out:**
   - Ship every [FIX] as one follow-up PR.
   - On each PEN-30 sub-issue the run exercised, post evidence as a comment (`comment.ts`). Judge strictly: a criterion counts only if the run exercised it. Move a card to Done only when every criterion is met.
   - Note any bug found in the product itself as a new card.

## Fix

- **Blocking or not.** Fix only what stops the run, and put everything else in the notes. To pause a run before it does something wrong, set Blocked from the UI, and if a step is already in flight, also stop the daemon (`task factory:stop`).
- **Reproduce sandbox-only failures in the real sandbox and at the real path.** The factory's path has a space, and that alone broke `ports.mjs`, the `ci:lint` hosted-runner check and the CLI's build (`URL.pathname` keeps `%20`; use `fileURLToPath` and `realpathSync`). Use `sandbox.ts` on a commit you've made. The sandbox refuses `ps` (exit 126) and makes `pgrep` exit 3. Its temp folder is `$TMPDIR`, not `/tmp`, so `mktemp -d` needs a template under `${TMPDIR:-/tmp}`.
- **Repair a run's branch** only after looking:
  - Read `repo/.git/worktrees/<w>/commondir` (it should be `../..`) and `repo/.git/config` (no url rewrites, no `hooks/` other than samples).
  - Then run hardened git in the worktree: `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.hooksPath=/dev/null -c core.fsmonitor=false …`. For example, `reset --keep <good-sha>` drops a bad factory commit.
  - Keep `decision-numbers` (the reservation high-water mark) consistent with `main`'s highest A-number.
- **When Linear moved a card by itself:** `history.ts` shows who moved it. If Linear's GitHub automation did it, run `unlink.ts` on the PR, then `move.ts` the card back to where the factory left it. The daemon recovers on its next poll.
- **Decision numbers in a fix PR:**
  - Agents write `A-NEW-n`. When you open the PR, take the numbers with `task decision:next` (`-- --count n`), which reserves them from the factory's counter, and number only lines the branch added. The factory's own code and tests use `A-NEW-n` as data, so never sed whole files: diff against `main` first.
  - Re-run prettier on `docs/decisions.md` after numbering.
  - zsh doesn't split `$FILES`; use an array.
- **Write a test that fails without the fix.** Real git in temp repos where it fits, fakes for Sandcastle. Never plant anything that executes. Real-git suites get `{ timeout: 30_000 }`.
- **Delegate in parallel** with worktree-isolated agents for independent fixes. Each gets the ground rules above, and is told never to push or touch the installed factory. Cherry-pick their commits onto one branch for one PR. Review each diff before shipping.

## Redeploy

1. Push the branch, open a PR (ready for review, the repo's PR layout, no PEN id in the title, `Part of PEN-30.` in the body), and wait for CI in the background (`until ! gh pr checks <n> | grep -qE '\s(pending|queued|in_progress)\s'; do sleep 45; done`).
2. Merge when green (`gh pr merge <n> --squash --delete-branch`).
3. Run `task factory:update`. Then check that both agents are running, the daemon logged the new commit, and `status.json` is fresh. Fix any launchd trouble as described under Operate.
4. Resume what was paused. Clear Blocked through `ui.sh block <n> off`, check the card's status first (`history.ts`), and watch for the recovery line `PEN-n on slot k (recovered)`.

## Known failures from the first run (PEN-75, 8–9 Nov 2026)

These are fixed in #61, #62, #64 and #65, or are in the follow-up. If one comes back, look here first.

- `claude: command not found` (exit 127): the LaunchAgent's PATH lacked `~/.local/bin`.
- The factory numbered AGENTS.md's own `A-NEW-1` examples. It now numbers only rows the branch added (A1232).
- `task check` failed in the sandbox: process-listing tests, `$TMPDIR` versus `/tmp`, and the space in the path (A1231).
- `spawn terminal-notifier ENOENT` failed a run after In Review. A notification must never throw (#64).
- Linear set a card Done because a PR's title named it.
- The daemon/UI startup race, launchd I/O error 5, and KeepAlive off.
- Recovery reruns the agent at round 0 even when its work is committed, and on its old base, so it reports failures that `main` has already fixed.
- The PR title is the agent's whole summary sentence.
- Blocked doesn't stop a step in flight.

## Known failures from the second run (PEN-70, 9 Nov 2026)

Fixed in #69–#78 and the follow-up, or still true. Look here first:

- **Where a step's output is.** The run folder (`runs/<run>/`) keeps `gate.log` (the gate's whole check output), `proof-<platform>.log` (each web and Android proof's output), `raw/` (the proof videos and screenshots), `validation/<n>/` (each validation's `review.json`, `captures.json` and image pairs) and `result.json`. The gate's worktree is gone once it closes, so read these, not the worktree.
- **A recovered run resumes at the gate.** When you clear Blocked on a run whose agent had finished (`agent-finished done`), the new run starts from that result at the gate, with no new agent round (R12). Expect `recovered` and `agent-finished done from <old run>` in the ledger, then `rebased` or `gate-passed`.
- **`factory:update` while the daemon is busy** refuses ("Not updating: the daemon is busy"). Use `task factory:update -- --wait`, which holds new work and updates once the active step ends. A Blocked run doesn't count as busy.
- **The gate fails on a test outside the card.** The agent fixes it in its round, as PEN-70's did with `android-proof.test.ts`'s race. Don't race it with a PR to main: the gate's rebase then conflicts on the same file. Close your PR if the agent's fix lands first.
- **Don't merge decision-adding PRs to main while a run is in its gate rounds** if the branch's decisions table was re-padded; #74 resolves most of these conflicts now, but each one still costs a rebase. Take hand-made numbers with `task decision:next`, never by hand.
- **Proof platforms.** Without `platform:*` labels, the classifier decides: `packages/` or `apps/web/` puts web, Mac and Android in scope, even when the plan says "no Android change". The agent then needs an Android spec that shows nothing changed. The build prompt says so now; if a round is refused with "names no proof spec for android", that's why.
- **Validation and fidelity rows.** Validation walks only the web build in headless Chromium. A Mac row's screenshot is the web build standing in for the Mac app, and the table says so. Judge Mac fidelity from the Mac proof recording. Native-only details (a select's popup) are deviations, not mismatches.
- **Check the proof videos, not just the screenshots.** PEN-70's web and Mac videos stayed at the top of Settings → Display, and the new row below the fold never appeared; its Android screenshot was the launcher. A good proof scrolls the change into view, holds it and ends on it; an Android spec calls `ProofShot.take()` at its last assertion. Download the MP4s from the PR and watch them.
- **Main's CI after merge can fail on a hosted-runner flake** (PEN-70: `TypingInstrumentedTest` on the hosted emulator). The factory sets Blocked and names the job, which is right. Re-run the failed job (`gh run rerun <id> --failed`), wait for green, then clear Blocked through the UI's `/action` (`ui.sh block <n> off`), so the factory verifies main and sets Done.
- **The planning chat link** comes from Claude Code's job file (`~/.claude/jobs/<id>/state.json`, `bridgeSessionId`), not from `claude --bg`'s output. If `factory:chat` says there is none, that file had no Remote Control id.
- **`factory:doctor`'s "unreadable" checks** for the key files and the keychain used `head -c 0`, which macOS refuses for its own reason, so they passed whatever the sandbox did. They now read one byte and pass only on a refusal (A1258). Rerun the doctor after updating.
- **In the sandbox, main is `origin/main`.** Its local `main` is stale; an agent's `git diff main...HEAD` shows every factory change since the run began.

## Asset

`assets/test-map.html` is the live test map from the PEN-75 run: an animated component and data-flow diagram with the run's steps and a bug table, all driven by its `STATE` object. Copy it to the scratchpad, rewrite `STATE` for the new run, and publish it with the Artifact tool. Republish the same path on every change.
