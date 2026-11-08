# Software factory

The factory (#253, `tools/factory`) takes Project 8 issues through planning, implementation and review on this Mac. Every CI job it waits on runs on the self-hosted Mac runners (A702).

## Board

Project 8's **Status** field drives it:

| Status          | What happens                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Triage, Backlog | Nothing. The factory never touches these.                                                                                                                                                                                                  |
| Ready           | You drag a card here to start it. The factory picks Ready cards P1 first, then by board position.                                                                                                                                          |
| Planning        | The agent writes the plan (and a design artifact when the change affects what you see) and works through it with you in artifact comments, issue comments or a direct chat. Only your explicit yes ("complete", "agreed", "go") ends this. |
| In progress     | The agent builds the agreed plan on a branch, validates it on each platform in scope and opens the PR.                                                                                                                                     |
| In review       | The agent fixes failing checks and addresses each of your review comments in the same PR. When you approve, it merges and watches `main`.                                                                                                  |
| Done            | Set after `main` is verified. Closing an issue also moves it here (the project's built-in "Item closed" workflow).                                                                                                                         |
| Removed         | Nothing.                                                                                                                                                                                                                                   |

**Blocked** is a separate single-select field. While it is set, the factory does nothing with the card: no picking, no replies, no pushes. The factory sets it when it is waiting on you; you can set it yourself to pause a card. Only you clear it; the factory has no code path that does.

`task factory:next` prints the Ready card the factory would start next and why, without changing anything.

## Labels

| Label                                              | Meaning                                                                                          | When absent                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `agent:claude`, `agent:opencode`                   | Which agent CLI runs the issue                                                                   | `agent:claude`                     |
| `model:opus`, `model:sonnet`, `model:go`           | A model alias from `tools/factory/factory.config.json`; a model label alone also picks its agent | The agent's default (`opus`, `go`) |
| `plan:skip`                                        | Skip planning and implement straight away                                                        | Plan first                         |
| `platform:web`, `platform:mac`, `platform:android` | Narrows which platforms need proof (CI still tests everything the path classifier selects)       | The path classifier decides        |
| `P1`–`P4`                                          | Pickup order                                                                                     | P3                                 |

Conflicting labels (two `agent:` or two `model:` labels, or `agent:claude` with `model:go`) stop the card from starting: the daemon says why on the issue and sets Blocked, and `task factory:next` says why too.

OpenCode runs under the same sandbox as Claude Code. Its permissions come from `tools/factory/agents/opencode.json`, whose bash deny list mirrors Claude's. The factory passes that file inline with the worktree's own OpenCode config turned off, so the agent can't loosen it.

File factory work with the **Factory task** issue template, which asks for acceptance criteria in EARS form.

## Setup

Once, on this Mac:

1. **The bot.** Create the free GitHub account `penmoss-bot`, invite it with Write to `htxryan/penmoss` and to Project 8, and sign it in where only the factory looks:
   `GH_CONFIG_DIR=~/.config/penmoss-factory/gh gh auth login`
2. **The env file.** `~/.config/penmoss-factory/factory.env`, mode 600 (`chmod 600`), with `KEY=value` lines. Only these names reach a sandbox; any other line is ignored and named (never its value) by `task factory:doctor`:

   | Name                                            | What                                                  |
   | ----------------------------------------------- | ----------------------------------------------------- |
   | `GH_TOKEN`                                      | penmoss-bot's token (`GH_CONFIG_DIR=… gh auth token`) |
   | `CLAUDE_CODE_OAUTH_TOKEN`                       | from `claude setup-token`                             |
   | `OPENCODE_API_KEY`                              | the OpenCode Go key                                   |
   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | a token limited to the Penmoss account                |
   | `PLAY_SERVICE_ACCOUNT_JSON`                     | the path of the Play service account key              |

3. **Trust the planning folder.** Planning sessions run from `~/Library/Application Support/penmoss-factory/plans`. Run `claude` there once and accept the trust prompt, or `claude --bg` refuses to start.
4. **Toolchain.** The JDK, Android SDK and Playwright's browsers at the paths in `tools/factory/factory.config.json` (`toolchain`). Optional: `brew install terminal-notifier`, so a notification opens its card in the Factory UI.
5. **Check it.** `task factory:doctor` starts slot 1's sandbox on a throwaway branch of `origin/main` and checks the toolchain there (pnpm, Chromium, the JDK, `wrangler dev` on the slot's port block), the tokens, and that your gh login, `~/.ssh`, the keychain and your home stay out of reach, and that a relay deploy is refused. `-- --full` adds `task check`, the e2e smoke spec, `task android:test` and `task desktop:build`; `-- --slot 2` checks the other slot.
6. **Start it.** `task factory:install` installs the daemon and the UI as LaunchAgents. Both start now and at every login.

## Daily use

1. **File an issue** with the **Factory task** template, add it to Project 8 and set its Status to **Ready**. Labels choose the agent, model and platforms, or skip planning (Labels, above).
2. **Planning.** The card moves to Planning and its session posts its chat link. When it has questions, it posts them on the issue and sets **Blocked**. Answer in the artifact comments, the chat, the issue or the Factory UI, then clear Blocked. Say **complete** when the plan is.
3. **Implementation** starts when a slot is free. The card moves to In progress. The run builds on its own branch, runs the gate (`task lint` or `task check`), records proof, validates against the plan, and opens a pull request with proof attached. CI goes green in the same PR, then the card moves to **In review** and you get a notification.
4. **Review.** Comment on the PR or request changes: the factory answers each comment in a new round on the same branch. **Approve** to merge. The factory then squash-merges, watches `main`'s CI, closes the issue and moves the card to Done.

Whenever the factory needs you, it says why on the issue and sets **Blocked**. It never acts on a Blocked card. Set Blocked yourself to pause a card at any point: a run stops before its next step.

`task factory:status` shows what the daemon is running and waiting on. `task factory:logs` follows its log. `task factory:report` shows the last week's throughput, rounds, time to review and the share Blocked (`-- --from 2026-11-01 --to 2026-11-08` for another range).

## Troubleshooting

| What you see                                        | Do this                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A card stays in Ready                               | `task factory:next` says why it isn't picked: labels, Blocked, closed, or no free slot.                                                                       |
| "Can't start" on startup                            | `gh` in `~/.config/penmoss-factory/gh` isn't signed in as `penmoss-bot`, or the env file is missing or not mode 600.                                          |
| A run Blocked on a usage limit                      | It waits for the reset by itself. Blocked after four limits in a row means the plan's quota is spent.                                                         |
| A run Blocked on "CI stayed red"                    | Read the failed job's log from the PR's checks, fix or comment, then clear Blocked.                                                                           |
| "CI waiting for a runner"                           | The Mac runners are busy or offline (A702). They catch up on their own.                                                                                       |
| A planning session "idle without writing its state" | Open its chat link and nudge it, or clear Blocked to resume it.                                                                                               |
| A sandbox check fails                               | `task factory:doctor -- --full --only "<check>"`; the full log is in `~/Library/Application Support/penmoss-factory/doctor/`.                                 |
| Disk filling up                                     | The janitor removes old sandbox worktrees and run folders every six hours. To clean now, restart the daemon (`task factory:stop`, then `task factory:start`). |

## Turning it off

- **Pause one card:** set Blocked.
- **Pause everything:** `task factory:stop`. Runs in progress stop. They restart on the same branch when the daemon starts again (R12).
- **Remove it:** `task factory:stop`, then `launchctl bootout gui/$(id -u)/app.penmoss.factory-ui`, and delete `~/Library/LaunchAgents/app.penmoss.factory*.plist`. Then delete `~/Library/Application Support/penmoss-factory` and `~/.config/penmoss-factory`. Also revoke the bot's token and remove `penmoss-bot` from the repository and the project.

## Sandbox

Every run is Sandcastle's Seatbelt sandbox (`tools/factory/src/sandbox.ts`). It sees its worktree, the JDK, Android SDK and Playwright's browsers (read-only), a pnpm store, Gradle home and AVD folder the factory owns under `~/Library/Application Support/penmoss-factory`, the slot's port block (`scripts/ports.mjs`) and emulator, and the env file's tokens. It doesn't see your home, logins or caches. Two rules beyond Sandcastle's profile, and a longer worktree timeout, are carried as a pnpm patch in `tools/factory/patches/`. A run sets `PENMOSS_FACTORY_RUN=1`, and the relay's deploy script refuses to run under it: production deploys happen after you merge (FD24). The Mac's heavy-job slots (W12) stay outside the sandbox: the factory takes one on the host around its gate, proof and the doctor's slow checks, and each sandbox has a one-slot folder of its own (A1216).

**Known gap.** The bot's token is in the sandbox (FD23), so an agent that ignores its deny rules can push with an explicit URL. GitHub's fine-grained read-only tokens can't reach a private repository a collaborator doesn't own. A ruleset on `main` that requires a pull request (Ryan's call) is the guard that holds.

## Planning

A Ready card without `plan:skip` moves to Planning. Planning doesn't take a slot. The daemon starts one background Claude session for the card (`claude --bg --remote-control "Penmoss #N plan"`). The session reads a snapshot of `main`, can write only to its own output folder, and has no MCP servers and no Chrome. It publishes the plan, plus a design if what users see changes, as artifacts. It posts its chat link on the issue. On every poll the daemon reads the session's `state.json`:

- **Waiting on you.** The daemon posts the open points with the links, sets Blocked and stops the session. Questions with a few clear answers list them, so you can pick one in the Factory UI. Answer in the artifact comments, the chat or on the issue, then clear Blocked. The session resumes with your issue comments and checks the artifact for the rest.
- **Agreed.** Only an explicit yes ("complete", "agreed", "go") counts; "looks good, but…" is feedback. A yes as an issue comment counts too. The daemon keeps a copy of `plan.html` that later edits can't change and stops the session. The card implements next, with that plan in the prompt, ahead of new Ready cards.
- **Trivial.** The session may judge an issue too small to plan (`planning.agentMaySkipTrivial`). The daemon says why on the issue and implements it.
- **Quiet.** If the session is idle for 10 minutes without writing its state, the daemon says so and sets Blocked.

The daemon never acts on a card while Blocked is set, not even on a yes.

## Validation

When a planned change reaches the web, the gate and proof run first, then validation. One agent session starts the app on the slot's port block. It walks each acceptance criterion and screenshots it next to the agreed mockup rendered at the same size. A second, independent session compares each pair and gives a verdict: match, mismatch or deviation. A mismatch goes back to the builder, using the gate's fix rounds. Whatever is still wrong after the last round goes in the PR as a deviation. The PR shows a fidelity table with each mockup beside its screenshot. Mac and Android walkthroughs come with F7 and F8.

## Factory UI

`task factory:install` also starts the UI at login: a read-only page on `127.0.0.1:7878` (`task factory:ui:open`). It shows the Waiting on you lane (each Blocked card with the factory's reason, or the plan's open points) and a column per status, with each card's step and links: the issue, pull request, CI, the plan and design artifacts, the planning chat, and **Open in Claude**, which opens that session in the desktop app. It updates itself every few seconds.

From the page you can also reply on an issue (and clear Blocked in the same click), pick one of the planning session's proposed answers, say **Complete** to agree the plan, and set or clear Blocked. These writes use your own `gh` login, never the bot's, so they appear as yours. If your `gh` isn't signed in as `htxryan`, the page is read-only. The daemon can set Blocked but has no code that clears it; a test keeps the UI's writer out of the daemon.

Each launch makes a new token. The link carries it once, then a cookie does. Requests without it, from another `Origin` or for another `Host` get 403. The UI listens on no other interface. With [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) installed (`brew install terminal-notifier`), clicking a factory notification opens its card.
