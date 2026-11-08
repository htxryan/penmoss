# The penmoss CLI: for contributors

`penmoss` searches, reads and edits the notes in git notebooks from a terminal, a script or a coding agent. **How to use it is in the user docs: [The penmoss CLI](https://penmoss.app/docs/reference/cli/)** (commands, options, exit codes, git notebooks and agents using the CLI), with [MCP tools](https://penmoss.app/docs/reference/mcp/) and [How agents work](https://penmoss.app/docs/agents/). This page keeps what you need to build and change it.

- **Code:** `packages/cli/`. Node 22 or later, with no runtime dependencies. The git-notebook engine and the local MCP server are `packages/git-notebook/`.
- **Design:** decisions A160–A178, A850–A869, A992–A994 (the Mac app as the CLI, local agents) and A1050 in [`decisions.md`](decisions.md).
- **Help:** `penmoss --help` and `penmoss <command> --help`, written in `packages/cli/src/`. When a command, an option or an exit code changes, change its help and its [docs page](../site/src/content/docs/docs/reference/cli.md) in the same pull request.

## 1. Build from the repo

```sh
pnpm install
pnpm --filter @penmoss/cli build    # writes packages/cli/dist/penmoss.js and penmoss-cli.js
```

Then put `penmoss` on your PATH in either of two ways:

- **pnpm link:** run `cd packages/cli && pnpm link --global`. This needs `pnpm setup` to have been run once, so that `PNPM_HOME` is on your PATH.
- **Symlink:** `ln -s "$PWD/packages/cli/dist/penmoss.js" ~/.local/bin/penmoss`.

After pulling changes, rebuild with the same `build` command. The link and the symlink both point at the rebuilt file.

`penmoss.js` is a small launcher: it checks for Node 22 or later and then loads the CLI from `penmoss-cli.js` beside it, so an older Node prints which version it needs rather than a syntax error. Keep the two files together.

To run the CLI without installing it, use `task cli -- search "garden plan"`. It rebuilds first when the source has changed. Add `-x` (`task -x cli -- …`) to get the CLI's own exit code back instead of Task's.

## 2. Tests

`pnpm --filter @penmoss/cli test`. They cover argument parsing, the implied `--notebook`, the keychain and file stores for git tokens (with fake `security` and `secret-tool`), file modes, the `--json` shapes, exit codes and help. `test/notebook.test.ts` runs commands on real git notebooks over bare repositories on this machine, and `test/process.test.ts` runs the built CLI as a process: stdin at `/dev/null` or an open pipe, and the Node version check.

## 3. How it fits together

- **The Mac app is the CLI (A992).** The app's binary runs the CLI with `--penmoss-cli`, so it needs no Node. Settings → Agents → The penmoss Command writes `~/.local/bin/penmoss`, a two-line script marked as Penmoss's own (`apps/desktop/src/local-agents.ts`), that runs the app. Only the app's binary has `models` and search by meaning (`packages/embed`).
- **Agents' clones (A993, A994, D52).** Settings → Agents → Connect an Agent makes a clone in `~/.penmoss`, as `notebook add --agent` would, named `<notebook>-<agent>`, with the notebook's remote, branch, directory, token, signing and commit identity. The app also makes one clone for every agent by itself, labelled "Agent". Of several clones of one notebook, `penmoss mcp` takes an agent's and the other commands a person's (A1097).
- **Sync (A852).** Each note command syncs before and after its change. Past `PENMOSS_NOTEBOOK_SYNC_TIMEOUT` (15 s) its git is stopped, and a detached `penmoss notebook sync` pushes later, logging to `detached-sync.log` in the clone's folder. `penmoss mcp` does the same (`--wait 120`) when its input ends or a signal arrives with edits unpushed, since Claude Code kills a server half a second after SIGTERM, too soon for a push.
- **Base versions.** An older `baseVersion` is checked only by the process that read it (the MCP server keeps the last 8 per note); from another run it is `base_unknown` (409, exit 5). There is no retry and no idempotency key: the change is made on this machine in the same process (A1050).
- **Locks.** One `penmoss` uses a clone at a time (its `lock` file); another waits up to 10 seconds, then exits 5 naming who has it and the lock file. A lock left by a process that died on this machine (told apart by machine id and boot time, not host name) is taken over. `notebooks.json` changes under its own `notebooks.lock`. After a sync the CLI runs `git gc --auto`.
- **Credentials.** A saved token goes in the keychain (macOS `security`, service `penmoss-git`, or libsecret's `secret-tool`), else in `~/.penmoss/credentials.json` at mode 600; a file readable by others, a symlink or another user's file is refused with exit 3. The token reaches git only through a one-off `GIT_ASKPASS` script and an environment variable, never argv, a URL or the clone's config, and URLs' credentials are blanked out of every message. git never prompts, and speaks only https, ssh and file (http for an http remote).
- **Signing.** A signer waiting for a person (pinentry, Touch ID, 1Password) has a minute at a terminal and 5 seconds where nobody can answer it (the MCP server, a background sync); then the sync fails as a signing error and the change waits.
- **Channel mode (A1061–A1064).** `mcp --channel` declares the `claude/channel` capability, lists the session in the notebook when it starts and hourly, asks the repository for the branch's head (`git ls-remote`) every 10 seconds and syncs only when it moved, and pushes the clone's own writes at once. A comment is delivered once, even across restarts, by the thread's delivery state.
- **Gone with the server (A1050).** `login`, `whoami`, `logout`, `channel`, `export-personal`, `verify-personal` and `--api` are unknown commands (exit 2). Exit 3 no longer means "not signed in".
- **The relay.** claude.ai reaches one git notebook over remote MCP through the relay (T55): [`relay.md`](relay.md).
