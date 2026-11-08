# T50 G0 git notebooks spike (go/no-go gate)

Throwaway code for [T50 G0](https://github.com/htxryan/penmoss/issues/148), part of [git notebooks](https://github.com/htxryan/penmoss/issues/147). (The issues say "T49", which is now in-app feedback.) It answers one question before any product code: **can a notebook sync only through a git repository, as #147 specifies, and converge?** The results and the go/no-go recommendation are in [`docs/evidence/t50/g0.md`](../../docs/evidence/t50/g0.md).

The product code it led to is [`packages/git-notebook`](../../packages/git-notebook/) (G1+G2: the engine, system-git transport, CLI and local MCP; [`docs/evidence/t50/g1-g2.md`](../../docs/evidence/t50/g1-g2.md)). `src/penmoss-entry.ts` now imports the mirror's code from its shared packages.

Nothing here ships. `spikes/` is outside the pnpm workspace, ESLint, Prettier, `tsc` and every build, like `spikes/android-editor`. The JGit project is a separate Gradle build that the Android app never includes.

## What's in it

| Path                     | What                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/penmoss-entry.ts`   | Today's Penmoss code the spike runs: the server mirror's `renderNote` and paths, the note and WorkspaceDoc helpers, the periodic-note builder. Imported, not copied, so the bytes are the mirror's.                                                                                                                                                                                                     |
| `lib/penmoss.mjs`        | Bundles that entry with the repo's esbuild on first use (into `.build/`, ignored).                                                                                                                                                                                                                                                                                                                     |
| `lib/git.mjs`            | A `GitTransport` over system git, as G2 would build it: no shell, no global or system config, no prompts. It makes a partial clone (`--filter=blob:none`) with a sparse cone on the directory. Commits are built on the fetched remote head in a temporary index, never with merge, rebase or checkout of local work. Fast-forward push only. Tokens reach git through `GIT_ASKPASS`, never argv or a URL. |
| `lib/notebook.mjs`       | The format and engine. Per-writer Yjs logs (A741), the sync cycle with up to 3 rebuilds (A742), and the deterministic render with stored names (A743). Also the writer secret, Delete for good, the render set, and the spike's alternatives (`SPIKE_CLAIMS`, `SPIKE_OWNFILE`) and deliberate bugs (`SPIKE_MUTATE`).                                                                                       |
| `lib/check.mjs`          | The acceptance checks. Every clone holds the same docs and state vectors. Each clone's own full render equals the head byte for byte. The history is linear and passes `git fsck`. Penmoss commits touch only the directory. A file moves only for its title, its folder or a lost concurrent claim. Purged notes never return.                                                                          |
| `converge.mjs`           | The random runs: three clones (two devices and an agent), random offline edits and sync orders, interleaved commits and pushes, and every scenario #148 lists.                                                                                                                                                                                                                                          |
| `sizes.mjs`              | Size and timing runs: a 10,000-word note with 1,000 bursts, a year of daily notes, 1,000 notes.                                                                                                                                                                                                                                                                                                         |
| `jgit/`                  | Gradle build (AGP 9.4.1, JDK 21). `probe/` holds `GitProbe`, plain Java on JGit: shallow clone, fetch, a commit on the remote head, a fast-forward push, a stale push that must be rejected, and a rebuild and push. `jvm/` runs it on the worker. `app/` is a throwaway Android activity around it with R8 on, in flavors `jgit661`, `jgit610` and `bare` (no JGit, for the size difference).        |
| `server-blocked/run.mjs` | The Mac app's build under xvfb with `*.penmoss.app` blocked three ways (connections dropped, refused, names not resolved). It uses Chromium's `--host-resolver-rules` for that one process. It records every request from Chromium's net log, and the launch time.                                                                                                                                       |
| `server-blocked/netlog.mjs` | Summarises a net log. No dependencies, so it also reads one recorded on Ryan's Mac.                                                                                                                                                                                                                                                                                                                 |

## Run it

```sh
node spikes/git-notebook/converge.mjs --runs 200                     # the gate's verification (local bare repos)
node spikes/git-notebook/converge.mjs --seed 123 --keep --verbose    # replay one seed
node spikes/git-notebook/converge.mjs --remote github --runs 3       # htxryan/penmoss-git-notebook-scratch (private)
node spikes/git-notebook/converge.mjs --dir docs/notes --committer --runs 30
node spikes/git-notebook/converge.mjs --remote github --repo htxryan/penmoss-git-notebook-code-scratch --dir docs/notes --committer --runs 3
SPIKE_CLAIMS=local node spikes/git-notebook/converge.mjs --from 1 --runs 30   # #147's claims as written
SPIKE_OWNFILE=spec node spikes/git-notebook/converge.mjs --from 1 --runs 30  # #147's own-file formula as written
SPIKE_MUTATE=purge node spikes/git-notebook/converge.mjs --runs 5            # must fail: the checks have teeth
node spikes/git-notebook/sizes.mjs --scenario big-note|daily-year|thousand [--remote github --branch <name>]
```

The `--remote github` runs check the repository is private (A761) before writing, and use the worker's `gh` token. Each random run uses its own branch and deletes it afterwards.

JGit (heavy: under the machine-wide lock, and stop Gradle afterwards):

```sh
cd spikes/git-notebook/jgit
export ANDROID_HOME=$HOME/Android/sdk JAVA_HOME=$HOME/opt/jdk-21
flock /tmp/penmoss-e2e.lock sh -c './gradlew -q :jvm:installDist :app:assembleRelease; r=$?; ./gradlew --stop; exit $r'
GIT_TOKEN=$(gh auth token) jvm/build/install/jvm/bin/jvm https://github.com/htxryan/penmoss-git-notebook-scratch.git pixel-1000
```

Server blocked (needs `task desktop:build`; Playwright, so under the lock):

```sh
flock /tmp/penmoss-e2e.lock xvfb-run -a node spikes/git-notebook/server-blocked/run.mjs --observe 60
```
