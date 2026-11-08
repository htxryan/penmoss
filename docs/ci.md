# CI and its runners

**A702 (27 Oct 2026): no job ever runs on GitHub's hosted runners.** Every job names its self-hosted Mac runner in a static `runs-on`, and `task check` fails on a workflow that names a hosted runner or gives `runs-on` as an expression (`.github/scripts/no-hosted-runners.mjs`, A1218). A job waits for a free Mac rather than going elsewhere.

CI is `.github/workflows/ci.yml`; stable releases are `.github/workflows/release.yml` (§10). It runs on every pull request and every push to `main`, and by hand (`workflow_dispatch`). Releases are A400 and A403; the Mac app's build is in [`desktop.md`](desktop.md) §3.

## 1. What runs where

| Job                                     | Runner                           | Why                                                                                                                                          |
| --------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pick` (changed parts)                  | `penmoss-mac-general`            | Works out which parts a change touches, so the other jobs skip what it can't affect (A1095).                                                 |
| `check` (lint, typecheck, unit tests)   | `penmoss-mac-general`            | Binds no fixed port: workerd's test pools take free ones.                                                                                    |
| `e2e` (Playwright smoke)                | `penmoss-mac` (any)              | Each job picks free ports of its own (A1140), so any Mac runner takes it.                                                                    |
| `budgets` (T22 and T31 performance)     | `penmoss-mac` (any)              | The same; the thresholds are the same everywhere (section 6).                                                                                |
| `android` (JVM, Robolectric, debug APK) | `penmoss-mac-general`            | No fixed ports. A push also builds the public APK, the release build signed with the sideload key (A1187), checked by `apk-check.sh`.        |
| `site` (penmoss.app, A1201)             | `penmoss-mac-general`            | Builds the site and runs `site/test` under `wrangler dev` on a free port. Only when `site/` or a shared file changed.                        |
| `desktop` (Electron)                    | `penmoss-mac-vm`, off until #252 | Electron needs a window server; the Tart VM's runner (#252, W10) will have one. Until then, run `task desktop:test` (it runs in the VM, §8). |
| `mac` (the Mac app's dmg, A403)         | `penmoss-mac-general`            | Packaging and signing need macOS. Main pushes and dispatches only. Universal (P7).                                                           |
| `android-release`, `mac-release`        | `penmoss-mac-general`            | Publish the build's release.                                                                                                                 |

Each job's log names its machine under "Set up job" (`Runner name`).

**Only what a change touches runs (A1095).** A change that touches only `docs/`, `site/`, `prototype/`, `spikes/`, `.claude/` or markdown outside `test/` directories starts no run on main. On a pull request it runs only `pick`; the test jobs report as skipped, so the required checks report (A1181). Otherwise `pick` lists the changed files and writes, in the run summary, which parts changed; each job then runs only for its part:

| Changed                                                          | `check` | `e2e`, `budgets` | `android` | `mac` (main) |
| ---------------------------------------------------------------- | ------- | ---------------- | --------- | ------------ |
| `.github/`, the lockfile, `Taskfile.yml`, root configs           | yes     | yes              | yes       | yes          |
| `apps/web`, `packages/{core,editor,git-notebook,sync-client,ui}` | yes     | yes              | yes       | yes          |
| `packages/cli`, `apps/desktop`                                   | yes     | no               | on main   | yes          |
| `apps/android/editor`, `apps/android/play`                       | yes     | no               | yes       | no           |
| the rest of `apps/android` (Kotlin, Gradle)                      | no      | no               | yes       | no           |
| anything else (`apps/relay`, `scripts/`, …)                      | yes     | no               | no        | no           |

A change under `site/`, or to a shared file, also runs the `site` job on a pull request (A1201).

On main, a Mac build brings the Android job with it, so the build's release has its APK (A400, A403). A dispatch, a new branch or a file list GitHub can't give runs everything.

## 2. The runners

Three self-hosted runners on Ryan's MacBook Pro (Apple Silicon, 18 CPUs, 64 GB), registered to this repository only, each in its own folder under `penmoss-ci`, a dedicated macOS account that Ryan set up as a standard (non-admin) user (section 7):

| Runner       | Folder                                       | Labels                                                        |
| ------------ | -------------------------------------------- | ------------------------------------------------------------- |
| `ryan-mac`   | `/Users/penmoss-ci/actions-runner-penmoss`   | `self-hosted, macOS, ARM64, penmoss-mac, penmoss-mac-ports`   |
| `ryan-mac-2` | `/Users/penmoss-ci/actions-runner-penmoss-2` | `self-hosted, macOS, ARM64, penmoss-mac, penmoss-mac-general` |
| `ryan-mac-3` | `/Users/penmoss-ci/actions-runner-penmoss-3` | `self-hosted, macOS, ARM64, penmoss-mac, penmoss-mac-general` |

- **`penmoss-mac`** is on every runner and marks it as one of Penmoss's Macs; no job asks for it alone.
- **`penmoss-mac-ports`** is on exactly one runner. Jobs that bind fixed ports ask for it, so they run one at a time: two at once on one Mac would fight over :5173.
- **`penmoss-mac-general`** is on every other runner. Test jobs without fixed ports and the `mac` job (the dmg) ask for it, so they never hold the ports runner up.
- A runner runs one job at a time. Three runners give three jobs at once; a fourth waits in GitHub's queue.
- `.github/actionlint.yaml` lists the custom labels, so actionlint accepts them.

**How a job is set up on a Mac** (`.github/actions/setup`, used by every job, branching on `runner.os`): Node from `.node-version` (actions/setup-node), pnpm through Corepack, and every cache in that runner's own tool cache, `_work/_tool/penmoss` (`COREPACK_HOME`, the pnpm store, `XDG_CACHE_HOME`, Electron's downloads, Playwright's browsers, `GRADLE_USER_HOME`). Each runner has its own `_work/_tool` and runs one job at a time, so no two jobs ever write one cache, and nothing goes in the account's home folder. The Android job installs Java 21 (actions/setup-java) and the Android command-line tools (checked against the archive's SHA-256), platform 37 and build tools 37.0.0 into `_work/_tool/android-sdk`, and points Java's `user.home` at the tool cache, so Robolectric's downloads and the debug key stay there too. Playwright installs Chromium only (no `--with-deps`). Nothing needs sudo or installs anything system-wide.

**Housekeeping** (`.github/scripts/mac-runner.sh`): unlike GitHub's throwaway machines, a Mac keeps processes, ports and files between jobs. The port jobs (`e2e`, `budgets`) stop any CI server still on :4173, :5173, :8787 or :8791 before they start and again when they end. Every Mac job ends, even when it fails or is cancelled, by stopping the runner's Gradle daemons and emptying its checkout (`git clean -ffdx`). Only processes started from that runner's `_work` folder are stopped; anything else on a port is reported and left alone. The runner also kills a job's leftover processes itself, and checkout cleans the workspace first.

**Disk:** each runner's tool cache grows to a few GB (pnpm store, Gradle, the Android SDK, Chromium, Electron). To reclaim space or recover from a bad cache, delete that runner's `_work/_tool/penmoss` (and `_work/_tool/android-sdk`) while it is idle; the next job refills it.

## 3. No fallback

Until A702, a `pick` job sent jobs to GitHub's hosted runners when no Mac was idle (A404). Now every job waits for a Mac. What that means:

- **A run waits while the Mac sleeps or is off.** GitHub keeps a job waiting for a self-hosted runner for at most 24 hours, then fails it. A pull request's next push starts a new run anyway. Optional, on the Mac: a sleep hook (for example `sleepwatcher` running a script as root) that stops the runner services before sleep and starts them on wake, so GitHub sees the runners go offline at once.
- **GitHub removes a self-hosted runner that has been offline for 14 days.** After a long trip, re-register it (section 4); until then the jobs wait.
- **A pull request from a fork runs nothing** (the fork guard, section 9).
- `PENMOSS_RUNNER_STATUS_TOKEN` is no longer used by CI; it can be deleted from the repository's secrets.

## 4. Adding or removing a Mac runner

Add one (on the Mac, as the runner account):

1. GitHub → the repository → Settings → Actions → Runners → **New self-hosted runner**, macOS, ARM64. Follow its download steps into a new folder, for example `~/actions-runner-penmoss-4`.
2. Configure it with the page's one-time token: `./config.sh --url https://github.com/htxryan/penmoss --name ryan-mac-4 --labels penmoss-mac,penmoss-mac-general --work _work --unattended`, typing the token at the prompt (leave `--token` out) so it stays out of shell history. Never give a second runner `penmoss-mac-ports`.
3. Start it as a service the way the other runners start at boot. That service setup lives on Ryan's Mac, done by Ryan for `penmoss-ci`; the runner's own `./svc.sh install` / `./svc.sh start` installs a LaunchAgent, which runs only while that account is logged in.
4. Check it is online: `gh api repos/htxryan/penmoss/actions/runners --jq '.runners[] | [.name, .status, ([.labels[].name] | join(","))]'`.

Remove one: `./svc.sh stop`, `./svc.sh uninstall`, then `./config.sh remove` with a removal token from the same Settings page, and delete its folder. If it was the `penmoss-mac-ports` runner, move that label to another one or the port jobs run on Ubuntu.

Labels change without touching the Mac, through the API (`gh` signed in as Ryan): find the runner's id with the command in step 4 (`.id`), then add a label with `gh api -X POST repos/htxryan/penmoss/actions/runners/<id>/labels -f 'labels[]=penmoss-mac-general'` or remove one with `gh api -X DELETE repos/htxryan/penmoss/actions/runners/<id>/labels/penmoss-mac-general`. A runner has exactly one of `penmoss-mac-ports` and `penmoss-mac-general`. A new label must also go in `.github/actionlint.yaml`.

## 5. Proving the Mac path by hand

`gh workflow run ci.yml --ref <branch> -f ci_on_mac=true` runs the whole CI on that branch with the test jobs forced onto the Mac runners, without asking whether they are online (so with the Mac off they wait, up to 24 hours). It also builds the Mac app, as every dispatch does (A403), and publishes nothing. Use it after changing the Mac setup, the picker or the runners, or before the token exists. Without `ci_on_mac`, a dispatch only builds the Mac app.

## 6. What the Mac changes

Measured on 24 Oct 2026, the same pull request on both paths. On Ubuntu (no token yet, run 40113232626): check 8m17, e2e 10m39, budgets 2m21, android 3m26, desktop 2m03, about 11 minutes of wall time and about 29 billed minutes. Through the picker on the Macs (run 40128514531): check 6m37 (ryan-mac-3), e2e 6m17 and budgets 2m05 (both ryan-mac, one after the other), android 2m11 (ryan-mac-2), desktop 2m30 on Ubuntu, about 9 minutes of wall time and about 4 billed minutes (the picker and `desktop`). On main the release jobs add about a billed minute each, and `android` runs on Ubuntu (about 4 more).

By 26 Oct 2026 the suite had grown to 130–140 tests: e2e took 14–16 minutes on Ubuntu (runs 40330622365, 40355251984) and about 7 on the Mac. A slow apt mirror then made `playwright install --with-deps` take 9–15 minutes, and three main runs were cancelled at the job's old 20-minute limit. The job now has 40 minutes, the install step 15 and the Playwright step 25 (A620), and apt on every Ubuntu job drops a stalled connection after 15 s, so the mirror list moves on to another mirror (A623).

The tests check the same things on both paths, with one exception that predates A404: the shortcut editor's e2e test presses Ctrl+Alt+M to check that an AltGr combination is refused, and skips that step on a Mac, which has no AltGr (`commands.spec.ts`). The AltGr rule itself is unit-tested on every host (`commands.test.ts`, pinned to Linux). A few tests assumed Linux and now say what they mean on any host: caret keys in the Playwright suite (`apps/web/test/e2e/keys.ts`: on a Mac, Playwright sends the macOS editing command for a key, so End scrolls and ⌘End does nothing; the tests use ⌘← / ⌘→ / ⌘↓ there), paste and match style (Chrome's Mac shortcut is an Edit menu item, ⌥⇧⌘V, which the test sends with the menu's editing command), the web unit tests' platform (pinned to Linux in `test/unit/support/platform.ts`; tests that need another platform stub it themselves), and the CLI's fake keychain helper (`security` on a Mac, `secret-tool` on Linux).

**Universal Mac builds (P7, A1186).** The `mac` job packages with `PENMOSS_MAC_ARCH=universal`, so one dmg runs on Apple Silicon and Intel Macs, and `.github/scripts/mac-archs.sh` fails the job if any Mach-O file in the app (15 of them: the main executable, four helper apps, Electron's framework and its libraries, Squirrel, Mantle, ReactiveObjC, ShipIt and the owner check) lacks `arm64` or `x86_64`. Measured on 7 Nov 2026 on Ryan's Mac, unsigned, the same commit: the dmg grows from 128.0 MB (arm64) to 231.8 MB (universal), and the zip from 124.1 MB to 224.8 MB; packaging took 39 s for arm64 and 77 s for universal (electron-builder builds both halves, then merges them). Before the change, main's signed and notarised `mac` job took 4m44 to 5m20 (runs 477, 480, 489 and 503); expect about a minute more for the second half and the larger notarisation upload, and each release job that carries a Mac app moves about 100 MB more. The first universal main build's `mac` time goes here once it has run.

**The budgets have more headroom on the Mac.** The thresholds are the same, but the Mac is faster: typing p95 7.2 ms of 16 (Ubuntu 10.1), opening the long note 46 ms of 150 (Ubuntu 94), switching notes about 5 ms (Ubuntu 8). So the Mac is a looser gate: a regression that takes Ubuntu over a budget can still pass on the Mac. The budgets keep running on Ubuntu whenever the Mac is busy or off, and `task e2e` runs them locally; a jump in the Mac's numbers (the job prints them) is worth a look before a budget fails.

## 7. Safety

- **Who can run code on the Macs: anyone who can push to this repository.** A workflow runs from the branch's own copy of `ci.yml`, so a pushed branch can change any job's `runs-on`, `if:` or steps, for any event. The `if:` conditions are not a boundary; the only boundary is push access (Ryan, and the agents working with his credentials).
- **Forks cannot reach the Macs: two layers (P10, A1183; [§9](#9-pull-requests-from-forks)).** While the repository is private, only collaborators can fork it, and "Run workflows from fork pull requests" is off (checked 7 Nov 2026: `gh api repos/htxryan/penmoss/actions/permissions/fork-pr-workflows-private-repos` says `run_workflows_from_fork_pull_requests: false`), so no fork's pull request runs any workflow. Once it is public: every self-hosted job's `if:` starts with the fork guard, so a fork's pull request that runs this repository's `ci.yml` starts nothing on a Mac; and "Require approval for all external contributors" holds every fork's run until a maintainer approves it. The guard alone is not a boundary, because a fork's pull request runs the fork's own copy of `ci.yml`, which can drop it. So **never approve a fork's workflow run**: read the change, then push it to a branch here (§9).
- **The runners run as `penmoss-ci`, a dedicated macOS account.** Verified from the run logs: every job's workspace and tool cache is under `/Users/penmoss-ci`. That it is a standard (non-admin) user is Ryan's setup, not something CI can see. Check it on the Mac now and then: `dseditgroup -o checkmember -m penmoss-ci admin` must say it is not a member; `sudo -u penmoss-ci ls /Users/redhale/src` must fail with "Permission denied" (if it lists the folder, close Ryan's home with `chmod 700 /Users/redhale`). Keep it that way: no admin rights, no saved passwords, nothing in its keychain. Without a login session there is no window server: headless Chromium works (the e2e and budgets jobs run that way), but Electron does not, which is why the `desktop` job stays on Ubuntu. Packaging the dmg needs no window server; it needs Xcode's command-line tools (`swiftc`, for the owner check, A504) available to that account.
- **Least privilege per job.** Every job declares `permissions:`; the jobs that can run on a Mac get `contents: read` only, and the `pick` job none. No write token reaches a Mac. Checkouts use `persist-credentials: false`, so no token stays in the Mac's `.git/config`.
- **Secrets on a Mac:** none. The sideload key and password (A400) live in the `android-sideload` environment, limited to main; only pushes' `android` job names it, and the picker always sends that job to Ubuntu. The `mac` job names the `mac-signing` environment on pushes to main only; it is empty (next point). The picker's token stays on Ubuntu.
- **Jobs can change the runners themselves.** Each runner's folder (its binaries, configuration and `_work`) belongs to `penmoss-ci`, the account its jobs run as. So any job, a pull request's included, can leave something behind in a runner that runs in a later job, such as main's dmg build, and reads what that job is given. A job can also read the runner's own credentials and pose as that runner from another machine. Root-owned folders would not stop that. **Ryan accepted this risk on 24 Oct (A406), so main's dmg build signs and notarises with the secrets in `mac-signing`.** If a signing secret may have leaked, revoke the Developer ID certificate and the App Store Connect key, re-register the runners, and reissue both.
- **Every action is pinned to a full commit SHA** with its version in a comment. Update them deliberately (read the release, then replace the SHA and comment).

**Known limits.**

- **Caches are shared between branches and main.** A runner's tool cache (pnpm store, Gradle caches, Electron and Chromium downloads, the Android SDK) serves every job it runs: a pull request's or dispatched branch's job, and main's dmg build, which is published (main's APK is built on Ubuntu). A branch that writes something malicious into a cache could reach a later dmg. That needs push access, which already allows running code on the Mac; the fix, if it ever matters, is a separate runner (and label) for main's release builds.
- **Ryan's laptop is the machine.** While CI runs, it uses the Mac's CPU, and a heavy session of Ryan's slows CI. The budgets have a wide margin there, but a timing budget that failed only while the Mac was busy would be a reason to re-run, never to loosen it.

## 8. Tests in a macOS VM

The Mac app's Electron suite opens real windows, and has no headless mode on macOS. So it runs in a macOS VM on Ryan's Mac, never on his screen (W10). On a Mac, `task desktop:test` goes to the VM by itself; `task desktop:test:vm` is the same thing by name. Playwright arguments go after `--`, such as `task desktop:test -- -g T82`.

- **Enforced, not only agreed (A1174).** The Electron suite refuses to start on a Mac outside the VM. Its Playwright config and the tests' `launch` helper (`apps/desktop/test/e2e/host-guard.ts`) both check, so starting it any other way fails too (`pnpm … playwright test` in `apps/desktop`). They read `kern.hv_vmm_present` from the kernel, which is 1 only in a VM, so no environment variable gets round it. The web suite's config refuses `--headed`, `--ui`, `--debug` and `PWDEBUG` on a Mac outside the VM. Inside the VM, `task desktop:test` runs the suite there (`task desktop:test:here`). On Linux it runs under xvfb.
- **One run at a time.** Every agent and worktree shares the one VM, and a run starts by stopping it. So `desktop-test.sh` takes a lock (`lockf` on `/tmp/penmoss-vm-penmoss-test.lock`) for the whole run, and another run says the VM is busy and waits its turn.

- **The VM** is `penmoss-test`, made by [Tart](https://tart.run) (Apple's Virtualization framework). It is cloned once from Cirrus Labs' `ghcr.io/cirruslabs/macos-tahoe-base:latest` (33 GB on disk; Homebrew, Xcode's command-line tools, SSH and the Tart guest agent included; user `admin`, auto-login, so Electron has a window server) and kept, so its Homebrew tools, Node 24 and pnpm store survive between runs. 8 CPUs and 16 GB by default (`PENMOSS_VM_CPUS`, `PENMOSS_VM_MEMORY_MB`).
- **A run** (`scripts/vm/desktop-test.sh`) boots it with no window, shares the checkout read-only and `test-results/vm/` read-write, copies the checkout into the VM without `node_modules`, `dist` or `.git`, installs with `pnpm install --frozen-lockfile`, runs `task desktop:test`, copies the log (`desktop-test.log`), Playwright's report and its traces back to `test-results/vm/`, and stops the VM. Nothing in the VM can write to the checkout. A first run installs `go-task` and `node@24` with Homebrew; later runs take about as long as `task desktop:test` here plus a minute to boot.
- **Installing Tart.** Its Homebrew tap's formula fails on current Homebrew, so it is installed from its release: `gh release download --repo cirruslabs/tart --pattern 'tart.tar.gz'`, check `shasum -a 256` against the release's checksums file and `spctl -a -vv tart.app` (Notarized Developer ID, Cirrus Labs 9M2P8L4D89), copy `tart.app` to `~/Applications` and link `~/Applications/tart.app/Contents/MacOS/tart` into the `PATH`. Then `tart pull ghcr.io/cirruslabs/macos-tahoe-base:latest` (27 GB download); the first `task desktop:test:vm` makes the VM.
- **Its screen** is 1920 × 1200 points (`PENMOSS_VM_DISPLAY`), set on every run, so a VM made afresh gets it too: `tart set --display` sizes the VM's display, and `scripts/vm/screen-size.swift`, run in the VM, switches macOS to it (it keeps the mode it had otherwise). The base image's 1024 × 768 is smaller than the windows the suite asks for (up to 1300 × 900), and macOS shrinks a window to fit its screen, which made `feedback.spec.ts`'s View menu test and `note-window.spec.ts` flaky. The suite's `mainBounds` sets bounds only once the app has shown the main window (macOS fits a window to its screen as it first shows), and fails with the screen's size when the window did not get the size asked for.
- **Starting again.** `tart delete penmoss-test`; the next run clones it afresh from the pulled image. `tart prune` frees images no VM uses.
- **Licence.** Apple allows two macOS VMs per Mac; this is one. Tart is free for personal use (Fair Source licence).
- **In CI (planned, #252).** The same VM can carry a self-hosted runner (label `penmoss-mac-vm`) so CI's `desktop` job runs again, on the Mac and off Ryan's screen; until then the job stays off (A702) and `task desktop:test` in the VM is how the suite is run.

## Required checks and auto-merge (A1181)

`main` requires five checks, set by the repository ruleset "main: CI checks":

- `Pick runners (the Mac if one is idle)`
- `Check`
- `E2E smoke`
- `Performance budgets`
- `Android app (JVM and Robolectric tests, debug APK)`

A job that `pick` turns off for a change it doesn't touch reports as skipped, which GitHub counts as passing. If `pick` itself fails, its own check fails, so the skipped jobs behind it can't pass a pull request.

A pull request merges, and GitHub's auto-merge (`gh pr merge --auto --squash`) arms, only once all five are green. Repository admins can bypass the rule, for an emergency only.

These five replace A1178's single `CI result` job. That job only summed the others, but it needed a Mac runner of its own. So a pull request whose tests had passed queued again for it, behind every other run's tests.

## 9. Pull requests from forks

A pull request from a fork never runs on the Mac runners (P10, A1183).

- **The guard.** Every job on a self-hosted runner starts its `if:` with `(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && …`, so the job is skipped for a fork's pull request. `task workflows:test` (part of `task check`) fails if a self-hosted job in any workflow that runs on pull requests lacks it, or if a workflow uses `pull_request_target` or `workflow_run`, or has default permissions other than `contents: read`.
- **The setting (Ryan).** Settings → Actions → General → "Approval for running fork pull request workflows from contributors": **Require approval for all external contributors**. GitHub offers it only on a public repository, so it is set as the repository is made public, before anyone can open a pull request (T80.13). Check it with `gh api repos/htxryan/penmoss/actions/permissions/fork-pr-contributor-approval`, which must say `"approval_policy": "all_external_contributors"`. Set it with `gh api -X PUT repos/htxryan/penmoss/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors`.
- **A fork's pull request is never merged as it is.** Its jobs are all skipped, and GitHub counts a skipped required check as passing (A1181), so its checks look green without having run. It merges only through a maintainer's branch, below.
- **Never approve a fork's run.** An approved run uses the fork's copy of the workflows, guard or not.
- **How a fork's change gets CI.** A maintainer reads the whole diff (workflows, scripts, `package.json` and lockfile changes included), then pushes it to a branch here and opens a pull request from that branch, or pushes to the contributor's pull request only after reading it: `gh pr checkout <n>`, `git push origin HEAD:refs/heads/fork/<n>`, `gh pr create --head fork/<n>`. That pull request runs CI as any other, and the original can be closed with a link to it, keeping the contributor's commits.

## 10. Releases: Alpha and Stable

**Alpha: every merge to main (P3–P5, A1188).** The `android-release` and `mac-release` jobs publish each build as the prerelease `build-<run>` (never Latest; the last 10 are kept) and replace its files on the rolling `alpha` prerelease: `Penmoss.apk`, `Penmoss.dmg`, `penmoss-mac-<build>.zip`, `SHA256SUMS.txt` and `alpha-mac.yml`, the feed last, and the `alpha` tag moves to that build's commit. The version is `X.Y.(Z+1)-alpha.<build>` from the newest stable tag (`node .github/scripts/releases.mjs version --run <build>`). `.github/scripts/releases.mjs` holds the rules and `task releases:test` checks them against an in-memory Releases page; `--dry-run` prints what a command would change against the real repository without changing it.

To check an alpha by hand: `curl -sIL https://github.com/htxryan/penmoss/releases/download/alpha/alpha-mac.yml` ends in `200`, and `curl -sL` of it names the build's zip; `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` in a folder holding the downloads passes.

**Stable: a version tag (P3, A1189).** Ryan runs `task release -- X.Y.Z` on a clean `main` that matches `origin/main`. It fetches (tags with `--force`: the rolling `alpha` tag moves), then refuses if the checkout is on another branch, has changes, is not `origin/main`, the tag `vX.Y.Z` exists here or on origin, or the version is not newer than the newest stable tag; otherwise it pushes the annotated tag `vX.Y.Z` (`-- X.Y.Z --dry-run` checks and prints the two git commands instead). `.github/workflows/release.yml` runs on that tag, on the Mac runners:

1. `info` reads the tag (`releases.mjs release-info`: the version, whether it is an `-rc.N` rehearsal, and the stable tag before it; a tag at or below an existing stable release fails) and takes the build number from ci.yml's newest run plus 1000, so the stable APK installs over every alpha APK before it and the next alpha installs over it.
2. `mac` (environment `mac-signing`) fails without a certificate and notary key, packages the universal app as version `X.Y.Z`, and runs `mac-check.sh` with `NOTARISED=true`: the job fails unless `spctl` says `source=Notarized Developer ID` for the app and the dmg's copy, and `stapler validate` passes.
3. `android` (environment `android-sideload`) builds the release APK, `versionName` `X.Y.Z`, and runs `apk-check.sh`.
4. `draft` creates the draft release `vX.Y.Z` (`releases.mjs draft-stable`): `Penmoss.dmg`, `Penmoss.apk`, `penmoss-mac-X.Y.Z.zip`, `SHA256SUMS.txt` and `latest-mac.yml` last, titled "Penmoss X.Y.Z", with notes GitHub generates since the previous stable tag. An `-rc.N` tag makes a draft prerelease. A re-run replaces the files on the draft; a published release is never touched.

Ryan then edits the notes and publishes the draft, which makes it Latest: `https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.dmg` and `…/Penmoss.apk` then serve it, and `…/latest/download/latest-mac.yml` is the Stable channel's feed (P6).

**The environments (Ryan's setting, not made by CI).** `mac-signing` and `android-sideload` allow only `main` today, so release.yml's `mac` and `android` jobs would get no secrets and fail. Each needs a second deployment rule for tags matching `v*`: Settings → Environments → `mac-signing` → Deployment branches and tags → **Selected branches and tags** → **Add deployment branch or tag rule** → Ref type **Tag**, name pattern `v*`; the same for `android-sideload`. Keep the `main` branch rule. With the API (as Ryan): `gh api -X POST repos/htxryan/penmoss/environments/mac-signing/deployment-branch-policies -f name='v*' -f type=tag` and the same for `android-sideload`; check with `gh api repos/htxryan/penmoss/environments/mac-signing/deployment-branch-policies --jq '.branch_policies[] | [.type, .name]'`, which must list `branch main` and `tag v*`. Anyone who can push a `v*` tag then reaches these secrets, as anyone who can push to main does today (§7); a tag ruleset limiting who may create `v*` tags narrows that.

**A rehearsal.** `task release -- 0.2.0-rc.1`; when the draft prerelease is ready, download its files, check them with `shasum -a 256 -c SHA256SUMS.txt`, open the dmg and run `spctl -a -vv` on the Penmoss.app inside it (it must say `source=Notarized Developer ID`; the dmg container itself is not notarised, only the app in it), and install the APK over an alpha one; then delete the draft and the tag, on Ryan's word (`gh release delete v0.2.0-rc.1 --cleanup-tag`).

## Deploying penmoss.app (A1205)

`.github/workflows/site.yml` builds and deploys penmoss.app when a stable release is published, so its download cards show that release's version, date and sizes (T80.12). A prerelease (an Alpha build or a `-rc.N` rehearsal) never moves it. A dispatch (Actions → Site → Run workflow) deploys the chosen branch, and its `release` input points the cards at another release, such as a rehearsal: `gh workflow run site.yml --ref main -f release=v0.2.0-rc.1`.

- **What it runs.** On a Mac runner (A702), in the `site-deploy` environment: `task site:build` (with `PENMOSS_SITE_RELEASE` set to the release's tag), then `wrangler deploy` of `site/dist` to the `penmoss-site` Worker.
- **Without the token** the job warns and stops; it never fails a release.
- **Ryan sets up once:**
  1. A Cloudflare API token for the Penmoss account with only **Account → Workers Scripts: Edit** and **Zone (penmoss.app) → Workers Routes: Edit**. Cloudflare can't limit a token to one Worker, so it reaches the account's other Workers too; keep it in this one environment.
  2. Settings → Environments → New environment `site-deploy`; Deployment branches and tags: **Selected**, with `main` and the tag rule `v*`.
  3. Its secret `PENMOSS_SITE_CLOUDFLARE_TOKEN`: the token above.
- **By hand**, from a Mac signed in to Cloudflare: `task site:deploy`. With `PENMOSS_SITE_RELEASE=<tag>` it describes that release; with `none` it skips GitHub's API.
