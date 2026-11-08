# Software factory

The factory (#253, `tools/factory`) takes issues from Linear's **Penmoss** team (`PEN`) through planning, implementation and review on this Mac. Branches, pull requests, CI and merges stay on GitHub, and every CI job it waits on runs on the self-hosted Mac runners (A702).

The tracker is one line of `tools/factory/factory.config.json`: `"tracker": "linear"` (the default, A1221) or `"tracker": "github"`, which drives it from Project 8 as before. A GitHub App can't reach a project that belongs to a user, so switching back to Project 8 also needs a user's token for the board.

## Board

The card's status drives it:

| Status (Linear) | What happens                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Triage, Backlog | Nothing. The factory never touches these, and new GitHub issues land in Triage (D66).                                                                                                                                                      |
| Todo            | You move a card here to start it. The factory picks Todo cards by Linear's priority (Urgent first; no priority counts as Medium), then by the team's manual order.                                                                         |
| Planning        | The agent writes the plan (and a design artifact when the change affects what you see) and works through it with you in artifact comments, issue comments or a direct chat. Only your explicit yes ("complete", "agreed", "go") ends this. |
| In Progress     | The agent builds the agreed plan on a branch, validates it on each platform in scope and opens the PR.                                                                                                                                     |
| In Review       | The agent fixes failing checks and addresses each of your review comments in the same PR. When you approve, it merges and watches `main`.                                                                                                  |
| Done            | Set by the factory after `main` is verified.                                                                                                                                                                                               |
| Canceled        | Nothing.                                                                                                                                                                                                                                   |

On Project 8 (`"tracker": "github"`) the same steps are called Ready, Planning, In progress, In review and Done, and pickup order comes from the `P1`–`P4` labels, then board position.

**Blocked** is a label. While it is on a card, the factory does nothing with it: no picking, no replies, no pushes. The factory adds it when it is waiting on you; you can add it yourself to pause a card. Only you remove it; the factory has no code path that does. A card that Linear shows as **blocked by** an unfinished issue is held the same way, until that issue is done or canceled (LD8). On Project 8, Blocked is a single-select field instead.

The factory comments and moves cards as its own Linear app, the way its GitHub App opens its pull requests. Only your comments count as instructions; everyone else's, and the text of an issue that came in from GitHub, reach the agent fenced as untrusted (R14).

`task factory:next` prints the card the factory would start next and why, without changing anything.

## Labels

| Label                                              | Meaning                                                                                          | When absent                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `agent:claude`, `agent:opencode`                   | Which agent CLI runs the issue                                                                   | `agent:claude`                     |
| `model:opus`, `model:sonnet`, `model:go`           | A model alias from `tools/factory/factory.config.json`; a model label alone also picks its agent | The agent's default (`opus`, `go`) |
| `plan:skip`                                        | Skip planning and implement straight away                                                        | Plan first                         |
| `platform:web`, `platform:mac`, `platform:android` | Narrows which platforms need proof (CI still tests everything the path classifier selects)       | The path classifier decides        |
| `P1`–`P4` (Project 8 only)                         | Pickup order; on Linear, the issue's own priority does this                                      | P3                                 |

In Linear, `claude` and `opencode` are labels in the group **Agent**, and the model aliases are labels in the group **Model**. A group holds one label per issue, so Linear itself refuses two agents. `task factory:linear:check` lists any that are missing, and `-- --fix` creates them.

Conflicting labels (two `agent:` or two `model:` labels, or `agent:claude` with `model:go`) stop the card from starting: the daemon says why on the issue and sets Blocked, and `task factory:next` says why too.

OpenCode runs under the same sandbox as Claude Code. Its permissions come from `tools/factory/agents/opencode.json`, whose bash deny list mirrors Claude's. The factory passes that file inline with the worktree's own OpenCode config turned off, so the agent can't loosen it.

File factory work with the team's **Task** template, which asks for acceptance criteria in EARS form.

## Setup

Once, on this Mac:

0. **The checkout and the CLIs.** A checkout of `main` (`~/src/penmoss`) with Node 24 and `corepack pnpm install` done (`docs/development.md`), and `task`, `gh`, `claude` and, for `agent:opencode`, `opencode` on the PATH. Every `task factory:*` command runs from that checkout, and the LaunchAgents that `task factory:install` writes run the factory's code from it, so keep it on `main`. The runs themselves work in a clone of their own under the state folder.
1. **The factory's GitHub App** (A1222). It pushes branches, opens and merges pull requests, and comments on them, as `penmoss-factory[bot]`. On GitHub, Settings, Developer settings, GitHub Apps, make a new app:
   - **Name** `penmoss-factory`. **Homepage** the repository's URL. **Webhook** off.
   - **Repository permissions:** Contents, Pull requests and Issues: Read and write. Actions, Checks, Commit statuses and Metadata: Read. Leave **Workflows** unset: GitHub then refuses any push from the factory that changes `.github/workflows`, so an agent can't change what runs on the Mac runners. A change there is yours to make. Nothing at the account level.
   - **Where can it be installed:** only on this account.

   Then **Install App** on `htxryan/penmoss` alone, and **Generate a private key**. Move the downloaded `.pem` to `~/.config/penmoss-factory/github-app.pem` and `chmod 600` it. Put the app's ID (on its settings page) and the key's path in `~/.config/penmoss-factory/github-app.env`, mode 600:

   ```
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY=~/.config/penmoss-factory/github-app.pem
   ```

   The key stays on the host. The factory makes an hour-long token from it for its own pushes and PRs, and a read-only one for each sandbox.

   GitHub takes PR attachments only from people, not apps, so the proof goes to Cloudflare R2 instead (A1223):

   - In the Penmoss Cloudflare account, create the R2 bucket `penmoss-factory-proof`. In its settings, under Public access, connect the custom domain `proof.penmoss.app`.
   - Under R2, Manage API tokens, create a token with **Object Read & Write** on that bucket only. Put its access key ID and secret, and the account ID, in `~/.config/penmoss-factory/proof.env`, mode 600:

     ```
     R2_ACCOUNT_ID=…
     R2_ACCESS_KEY_ID=…
     R2_SECRET_ACCESS_KEY=…
     ```

   The host uploads each run's screenshots and videos there and links them in the PR. Screenshots show inline; a video is a link to its MP4. Like the app's key, this file never reaches a sandbox.

2. **The factory's Linear app.** In Linear, Settings, API, make an OAuth application named **Penmoss Factory** with client credentials turned on. Put its client ID and secret in `~/.config/penmoss-factory/linear.env`, mode 600:

   ```
   LINEAR_CLIENT_ID=…
   LINEAR_CLIENT_SECRET=…
   ```

   The factory gets the app's token from them and acts as the app. This file is read on the host only. It is a different file from `factory.env`, so no sandbox ever sees it (LD4), and `task factory:doctor` checks that.

3. **Your own Linear key, for the Factory UI.** Make a personal API key in Linear (Settings, Security & access) and put it in your keychain: `security add-generic-password -s penmoss-factory-linear -a "$USER" -w`. The UI posts your replies and removes Blocked with it, as you. Nothing else reads it.
4. **The team.** `task factory:linear:check -- --me` prints your Linear user ID: put it in `tools/factory/factory.config.json` as `linear.owner`. Then `task factory:linear:check -- --fix` adds what the factory needs to the Penmoss team (the **Planning** state, the `Blocked`, `plan:skip` and `platform:*` labels, the Agent and Model groups), and `task factory:linear:check` should then pass.
5. **The env file.** `~/.config/penmoss-factory/factory.env`, mode 600 (`chmod 600`), with `KEY=value` lines. Only these names reach a sandbox; any other line is ignored and named (never its value) by `task factory:doctor`:

   | Name                                            | What                                     |
   | ----------------------------------------------- | ---------------------------------------- |
   | `CLAUDE_CODE_OAUTH_TOKEN`                       | from `claude setup-token`                |
   | `OPENCODE_API_KEY`                              | the OpenCode Go key                      |
   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | a token limited to the Penmoss account   |
   | `PLAY_SERVICE_ACCOUNT_JSON`                     | the path of the Play service account key |

6. **Trust the planning folder.** Planning sessions run from `~/Library/Application Support/penmoss-factory/plans`. Make it and run `claude` there once, accepting the trust prompt, or `claude --bg` refuses to start: `mkdir -p ~/Library/Application\ Support/penmoss-factory/plans && cd "$_" && claude`. The trust is kept by path, so it survives the factory moving old plans to `archive/` when the tracker changes.
7. **Toolchain.** The JDK, Android SDK (with the API 37 image `system-images;android-37.0;google_apis;arm64-v8a`, from which the factory makes each slot's emulator itself) and Playwright's browsers at the paths in `tools/factory/factory.config.json` (`toolchain`), and the Tart test VM for Mac proof (`docs/ci.md` §8). Optional: `brew install terminal-notifier`, so a notification opens its card in the Factory UI.
8. **Check it.** `task factory:doctor` starts slot 1's sandbox on a throwaway branch of `origin/main` and checks the toolchain there (pnpm, Chromium, the JDK, `wrangler dev` on the slot's port block), the tokens (the GitHub check uses the app's read-only token, as a run does, and GitHub must refuse it a branch with a 403 and a push), and that your gh login, `~/.ssh`, the keychain, the Mac app's data folder (its `git-secrets.json`), the GitHub App's key, the proof bucket's key, the Linear app's credentials and your home stay out of reach, and that a relay deploy and `task site:deploy` are refused. `-- --full` adds `task check`, the e2e smoke spec, `task android:test`, one recorded instrumented test on the slot's emulator and `task desktop:build`; `-- --slot 2` checks the other slot, and `-- --base <ref>` branches from another ref than `origin/main`.
9. **Start it.** `task factory:install` installs the daemon and the UI as LaunchAgents. Both start now and at every login.

## Daily use

1. **File an issue** in the Penmoss team with the **Task** template and move it to **Todo**. Its priority sets the order; labels choose the agent, model and platforms, or skip planning (Labels, above).
2. **Planning.** The card moves to Planning and its session posts its chat link. When it has questions, it posts them on the issue and adds **Blocked**. Answer in the artifact comments, the chat, the issue or the Factory UI, then remove Blocked. Say **complete** when the plan is.
3. **Implementation** starts when a slot is free. The card moves to In Progress. The run builds on its own branch, runs the gate (`task lint` or `task check`), records proof, validates against the plan, and opens a pull request whose body shows the proof from the R2 bucket. The PR says `Part of PEN-<n>`, so Linear shows it on the issue without moving the card: the factory moves cards itself. CI goes green in the same PR, then the card moves to **In Review** and you get a notification.
4. **Review.** Comment on the PR or request changes: the factory answers each comment in a new round on the same branch. **Approve** to merge. The factory then squash-merges, watches `main`'s CI, says so on the issue and moves the card to Done.

Whenever the factory needs you, it says why on the issue and adds **Blocked**. It never acts on a Blocked card. Add Blocked yourself to pause a card at any point: a run stops before its next step. When you clear Blocked on an In Progress card, its run starts again on the same branch, says so on the issue, and updates its PR if it had opened one (R12).

`task factory:status` shows what the daemon is running and waiting on. `task factory:chat -- 41` opens PEN-41's planning session in the Claude app (`-- 41 --print` only prints its links). `task factory:logs` follows its log. `task factory:run -- 36` runs PEN-36 now in the foreground on slot 1 (`-- 36 --slot 2` for the other), when it is in Todo or Planning, not Blocked, and labelled `plan:skip` or has an agreed plan.

`task factory:report` shows the last seven days' throughput (started, reached In Review, merged), gate and CI rounds per issue, time from claim to In Review, and the share of issues worked that a run left Blocked. `-- --from 2026-11-01 --to 2026-11-08` picks another range (local dates; `--to` is exclusive). It reads only the run ledger, `runs.jsonl` in the state folder, never the tracker, so it counts the runs' own Blocked stops, not planning questions or a Blocked you set yourself, and after a change of `tracker` it covers only the runs since (the older ledger is in `archive/`).

## Troubleshooting

| What you see                                        | Do this                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A card stays in Todo                                | `task factory:next` says why it isn't picked: labels, Blocked, blocked by another issue, closed, or no free slot.                                                                                                                                                                                      |
| "Can't start" on startup                            | The log names which: the GitHub App isn't installed on the repository or its key is for another app; `factory.env`, `github-app.env`, `proof.env`, `linear.env` or the key is missing or not mode 600; the Linear token is your own rather than the app's; or `task factory:linear:check` finds a gap. |
| "Linear's rate limit"                               | The poll is skipped until Linear's reset time; cards aren't Blocked for it.                                                                                                                                                                                                                            |
| Old plans or runs went missing                      | Changing `tracker` moves the state kept by card number into `archive/` in the state folder, since GitHub #36 and PEN-36 are different cards.                                                                                                                                                           |
| A run Blocked on a usage limit                      | It waits for the reset by itself. Blocked after four limits in a row means the plan's quota is spent.                                                                                                                                                                                                  |
| A run Blocked on "CI stayed red"                    | Read the failed job's log from the PR's checks, fix or comment, then clear Blocked.                                                                                                                                                                                                                    |
| "CI waiting for a runner"                           | The Mac runners are busy or offline (A702). They catch up on their own.                                                                                                                                                                                                                                |
| A planning session "idle without writing its state" | Open its chat link and nudge it, or clear Blocked to resume it.                                                                                                                                                                                                                                        |
| A sandbox check fails                               | `task factory:doctor -- --full --only "<check>"`; the full log is in `~/Library/Application Support/penmoss-factory/doctor/`.                                                                                                                                                                          |
| Disk filling up                                     | The janitor removes old sandbox worktrees and run folders every six hours. To clean now, restart the daemon (`task factory:stop`, then `task factory:start`, which loads its LaunchAgent again).                                                                                                       |

## Turning it off

- **Pause one card:** add Blocked.
- **Pause everything:** `task factory:stop`. Runs in progress stop. They restart on the same branch when the daemon starts again (R12).
- **Remove it:** `task factory:stop`, then `launchctl bootout gui/$(id -u)/app.penmoss.factory-ui`, and delete `~/Library/LaunchAgents/app.penmoss.factory*.plist`. Then delete `~/Library/Application Support/penmoss-factory` and `~/.config/penmoss-factory`. Also delete the `penmoss-factory` GitHub App (or uninstall it from the repository), and the Penmoss Factory app in Linear's settings.

## Sandbox

Every run is Sandcastle's Seatbelt sandbox (`tools/factory/src/sandbox.ts`). It sees its worktree, the JDK, Android SDK and Playwright's browsers (read-only), a pnpm store, Gradle home and AVD folder the factory owns under `~/Library/Application Support/penmoss-factory`, the slot's port block (`scripts/ports.mjs`) and emulator, and the env file's tokens. It doesn't see your home, logins or caches. Four rules beyond Sandcastle's profile (Chromium's Mach rendezvous service; the `hw.` and `machdep.cpu.` sysctls the emulator reads; `kern.boottime`; and the `sysctl` command's name lookups), and a longer worktree timeout, are carried as a pnpm patch in `tools/factory/patches/`. A run sets `PENMOSS_FACTORY_RUN=1`, and the relay's deploy script refuses to run under it: production deploys happen after you merge (FD24). The Mac's heavy-job slots (W12) stay outside the sandbox: the factory takes one on the host around its gate, proof and the doctor's slow checks, and each sandbox has a one-slot folder of its own (A1216).

**GitHub from the sandbox.** An agent can't push, comment or merge. Its deny rules refuse `git push`, the clone's push URL is a dead end, and its `GH_TOKEN` is the GitHub App's read-only installation token (contents, metadata, pull requests, checks and actions, read; A1222), so GitHub refuses a push even to an explicit HTTPS URL (`task factory:doctor` checks that). Pushes, PRs and merges come from the host with the app's write token, after the gate passes. A ruleset on `main` that requires a pull request (Ryan's call) keeps even that token off `main`. The app's key, the proof bucket's key and the Linear app's credentials never enter a sandbox (`task factory:doctor` checks all three). (This replaces FD23's known gap, which came from the bot account's token.)

## Planning

A Todo card (Ready on Project 8) without `plan:skip` moves to Planning. Planning doesn't take a slot. The daemon starts one background Claude session for the card (`claude --bg --remote-control "Penmoss PEN-41 plan"`, named after the card as the active tracker numbers it). The session reads a snapshot of `main`, can write only to its own output folder, and has no MCP servers and no Chrome. It publishes the plan, plus a design if what users see changes, as artifacts. The daemon posts its chat link on the issue, and posts the new one each time it resumes the session, since each resume gets a new link. On every poll the daemon reads the session's `state.json`:

- **Waiting on you.** The daemon posts the open points with the links, sets Blocked and stops the session. Questions with a few clear answers list them, so you can pick one in the Factory UI. Answer in the artifact comments, the chat or on the issue, then clear Blocked. The session resumes with your issue comments and checks the artifact for the rest. Anyone else's new comments go along fenced as untrusted data (R14): they never resume the session or end planning.
- **Agreed.** Only an explicit yes ("complete", "agreed", "go") counts; "looks good, but…" is feedback. A yes as an issue comment counts too. When the session reports a yes on the issue, the daemon checks your own comment there holds the words it quotes; if none does, it asks you instead. The daemon keeps a copy of `plan.html` that later edits can't change and stops the session. The card implements next, with that plan in the prompt, ahead of new Todo cards.
- **Trivial.** The session may judge an issue too small to plan (`planning.agentMaySkipTrivial`). The daemon says why on the issue and implements it.
- **Quiet.** If the session is idle for 10 minutes without writing its state, the daemon says so and sets Blocked.

The daemon never acts on a card while Blocked is set, not even on a yes.

## Validation

When a planned change reaches the web, the gate and proof run first, then validation. One agent session starts the app on the slot's port block. It walks each acceptance criterion and screenshots it next to the agreed mockup rendered at the same size. A second, independent session compares each pair and gives a verdict: match, mismatch or deviation. It also reads what the builder said it couldn't do and why (`risks` in `.factory/result.json`), so a reason that holds becomes a deviation with that reason. A mismatch goes back to the builder, using the gate's fix rounds. Whatever is still wrong after the last round goes in the PR as a deviation. The PR shows a fidelity table with each mockup beside its screenshot. Mac and Android walkthroughs come with F7 and F8.

## Factory UI

`task factory:install` also starts the UI at login: a page on `127.0.0.1:7878` (`task factory:ui:open`; `task factory:ui` serves it in the foreground when its LaunchAgent isn't running). It shows the Waiting on you lane (each Blocked card with the factory's reason, or the plan's open points) and a column per status, with each card's step and links: the issue, pull request, CI, the plan and design artifacts, the planning chat, and **Open in Claude**, which opens that session in the desktop app. It updates itself every few seconds.

From the page you can also reply on an issue (and clear Blocked in the same click), pick one of the planning session's proposed answers, say **Complete** to agree the plan, and set or clear Blocked. These writes use your own Linear key from the keychain item `penmoss-factory-linear` (Setup, step 3), never the factory app's, so they appear as yours. Without that key, or when it doesn't answer as `linear.owner`, the page is read-only. On Project 8 the writes use your own `gh` login instead, and the page is read-only unless it is signed in as `htxryan`. A card that Linear holds only because an unfinished **blocked by** issue says so in Waiting on you; it has no Blocked to clear, but you can still set Blocked on it. The daemon can set Blocked but has no code that clears it; a test keeps the UI's writer out of the daemon.

Each launch makes a new token. The link carries it once, then a cookie does. Requests without it, from another `Origin` or for another `Host` get 403. The UI listens on no other interface. With [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) installed (`brew install terminal-notifier`), clicking a factory notification opens its card.
