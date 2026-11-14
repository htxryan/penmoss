---
title: The penmoss CLI
description: Every penmoss command and option, its output and exit codes, git notebooks from the terminal, and agents that use the CLI.
---

This page lists everything the `penmoss` command does: search, read and edit notes from a terminal, a script or an agent, and add and sync notebooks.

Each note command works on this machine's copy (clone) of a notebook and syncs it with the repository. Every change is a version in the note's History, named after the clone's writer, and can be reverted there. `penmoss --help` and `penmoss <command> --help` (or `penmoss help <command>`) print the same help in the terminal.

## Install

### From the Mac app

The Mac app is the CLI, so it needs nothing else installed. In **Settings → Agents → The penmoss Command**, choose **Install Command**. It writes `~/.local/bin/penmoss`, a short script that runs the app.

- If `~/.local/bin` is not on your terminal's PATH, the card gives the line to add to your shell's profile, such as `export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc`.
- If you move or rename the app, the card says so, and **Update Command** rewrites the script.
- It never overwrites a `penmoss` it did not write. **Remove Command** removes it.

Without the script, run the app's CLI directly: `'/Applications/Penmoss.app/Contents/Helpers/Penmoss CLI.app/Contents/MacOS/Penmoss' --penmoss-cli <command> …`. A script written by an older Penmoss, which ran `Contents/MacOS/Penmoss`, is rewritten to this when the app starts.

The Mac app's notebooks are already there: `penmoss notebook ls` lists them.

### From the source

On a machine without the app, build the CLI from the [repository](https://github.com/htxryan/penmoss) with Node 22 or later. See [Building from source](https://github.com/htxryan/penmoss/blob/main/docs/cli.md). Search by meaning (`models`) needs the Mac app's `penmoss`.

## Which notebook

Add a notebook once with `penmoss notebook add <remote>` ([below](#git-notebooks)), or let the Mac app add yours. Then every note command runs on a notebook:

- **`--notebook <name>`** names it: a clone's own name, or the notebook's name as the Mac app shows it (`--notebook "Notes"`), ignoring case. A notebook that was renamed is still found by its old names, unless another notebook has that name now. Of several clones of one notebook, `penmoss mcp` picks an agent's and the other commands a person's.
- **Without `--notebook`**, it runs on the only notebook on this machine.
- **With none, or several,** it exits 2 and says so: with none, add one with `penmoss notebook add`; with several, it names them all.

`penmoss mcp` always needs `--notebook`.

## Commands

| Command                                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search <query…> [--mode hybrid\|full-text\|semantic] [--tag] [--folder] [--after] [--before] [--limit]`            | Searches notes. `hybrid` (the default) finds notes by their words and their meaning, `full-text` by words only, `semantic` by meaning alone. Each result says how it was found (`foundBy`). Meaning needs the model (`models fetch`, or the app's Settings → Search by Meaning) and the Mac app's `penmoss`; without it `hybrid` is words only and says so, and `semantic` exits 7. Words accept `"phrases"`, `prefix*`, `-excluded` and `title:word`. |
| `cat <note> [--body]`                                                                                               | Prints the note's markdown, with its frontmatter. `--body` prints the body only.                                                                                                                                                                                                                                                                                                                                                                       |
| `new [<title>] [-] [--text <md>] [--tag <tag>]… [--folder <folder>]`                                                | Creates a note and prints its id. `-t` is short for `--tag`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `append <note> (- \| --text <md>) [--heading <h>]`                                                                  | Adds markdown at the end of the note, or of the section under `--heading`.                                                                                                                                                                                                                                                                                                                                                                             |
| `edit <note> --section <h> (- \| --text <md>) [--mode replace\|prepend\|append] [--allow-empty] [--base <version>]` | Replaces a section. Empty markdown, which would clear it, needs `--allow-empty`.                                                                                                                                                                                                                                                                                                                                                                       |
| `edit <note> --replace <old> --with <new> [--all] [--scope text\|markdown] [--base <version>]`                      | Finds and replaces text. By default it matches the text only, never link targets.                                                                                                                                                                                                                                                                                                                                                                      |
| `daily [--date YYYY-MM-DD] [--weekly] [--body]`                                                                     | Prints today's daily note, or this week's. It makes the note from the template if no device has yet. "Today" is in the notebook's time zone.                                                                                                                                                                                                                                                                                                           |
| `daily --append (- \| <md>) [--heading <h>] [--date] [--weekly]`                                                    | Appends to today's note, or to the note for `--date`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ls [<folder>]`, `ls --recent [--limit]`, `ls --tags`, `ls --tag <tag>`                                             | Lists a folder, recently edited notes (20 by default, at most 500), every tag, or the notes with a tag.                                                                                                                                                                                                                                                                                                                                                |
| `mv <note> <folder>`, `mv --folder <folder> <folder>`                                                               | Moves a note to an existing folder (`/` is the top level), or with `--folder` a folder and everything in it.                                                                                                                                                                                                                                                                                                                                           |
| `trash <note>`, `restore <note>`                                                                                    | Moves a note to Trash, or takes it out again, back into its folder (the top level if that folder has gone). Nothing deletes a note for good from the CLI.                                                                                                                                                                                                                                                                                              |
| `tag <note> [<tag>…] [--remove <tag>]…`                                                                             | Adds and removes tags, with or without `#`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `set-title <note> <title> [--base <version>]`                                                                       | Renames the note; its id and text stay.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `retag <from> <to> [--merge]`                                                                                       | Renames a tag in every note, nested tags included. Renaming to a tag that exists merges them, and needs `--merge`.                                                                                                                                                                                                                                                                                                                                     |
| `attach <note> <file> [--alt <text>] [--heading <h>]`                                                               | Stores a file of at most 700 KB in the notebook and adds it at the end of the note or section: a picture shows in the note, another file is a link. Attach larger files in the app.                                                                                                                                                                                                                                                                    |
| `mkdir [-p] <path>`, `rename <folder> <name>`, `rmdir <folder>`                                                     | Makes, renames or deletes a folder. `mkdir` needs the parent to exist unless `-p`. `rmdir` moves the folder to Trash and its notes up to its parent.                                                                                                                                                                                                                                                                                                   |
| `sort <folder> manual\|alpha\|modified`                                                                             | Sets how the apps sort a folder; `/` is the top level.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `open <note> [--print]`                                                                                             | Prints the note's `penmoss://note/<id>` link and opens it in the Mac app. `--print` only prints it.                                                                                                                                                                                                                                                                                                                                                    |
| `history <note> [--limit]`, `history <note> --version <id>`                                                         | Lists the note's versions with their authors (agents marked ✦), or shows the lines one version changed.                                                                                                                                                                                                                                                                                                                                                |
| `history <note> --save`, `--restore <id>`, `--revert <id>`                                                          | Saves a version now, brings back a version as a new change, or undoes what one version changed while keeping later edits.                                                                                                                                                                                                                                                                                                                              |
| `settings [<key>] [<value>] [--reset]`                                                                              | Shows or changes the notebook's settings: `timeZone`, `template.daily`, `template.weekly`.                                                                                                                                                                                                                                                                                                                                                             |
| `notebook …`                                                                                                        | Adds, lists, syncs and removes notebooks on this machine ([below](#git-notebooks)).                                                                                                                                                                                                                                                                                                                                                                    |
| `mcp --notebook <name> [--channel [--name <name>]]`                                                                 | Runs the MCP server on that notebook ([MCP tools](/docs/reference/mcp/)).                                                                                                                                                                                                                                                                                                                                                                              |
| `models status`, `models fetch`, `models remove`                                                                    | The model for search by meaning: whether it is here and turned on, download it into `~/.penmoss/models`, or delete it and its index. Only the Mac app's `penmoss` has these.                                                                                                                                                                                                                                                                           |

Every note command accepts `--json`, `--notebook <name>` and `--no-sync`. `penmoss --version` prints the version. An option that takes a value never takes another option as it: `--text --json` is an error, and `--text=--json` passes the text `--json`.

### History

`history <note>` lists the note's versions: the commits that touched it, numbered from 1 (the oldest), each with its authors and what changed. Changes not pushed yet show as "not saved as a version yet". `--restore` and `--revert` make new changes, pushed by the next sync. A note in Trash is refused (exit 5): restore it first.

### Naming notes and folders

- **A note** is its id (26 characters), its short id (such as `K7QD-9HTF2CXA`, from **Copy Agent Reference**) or its exact title. Titles match ignoring the case of A–Z only. No match exits 4; several exit 6 and list their ids. A short id names its notebook too, so `--notebook` can be left out: `penmoss cat K7QD-9HTF2CXA` finds the notebook on this Mac.
- **A folder** is its path from the top, such as `Journal/2026` (ignoring case), its id, or `/` for the top level.

### Input

`new`, `append`, `edit --section` and `daily --append` read stdin only when you pass `-`. Use `--text "…"` for inline markdown. A script whose stdin stays open never hangs.

```sh
echo "- Shipped the release" | penmoss daily --append -
penmoss edit "Trip" --section Plans - < plans.md
git log --oneline -5 | penmoss append "Release notes" - --heading "This week"
```

### Edits and conflicts

`edit` reads the note first and sends its `baseVersion`. The edit goes ahead only if the section, or the lines around each match, are as they were when read.

- **On a conflict, nothing changes.** The CLI prints `Conflict:`, the target as it was and as it is now, and exits 5.
- **Then:** read the note again and redo the edit on the current text. Never resend the old edit unchanged.
- `--base <version>` from an earlier `cat` is accepted only while it is the note's current version.

`append` and `daily --append` send no base: adding at the end never conflicts.

### Syncing

`search`, `cat`, `ls` and `open` sync first; the others sync before and after their change. `--no-sync` skips it. A failed sync only warns: the change is kept on this machine, and the next sync pushes it. Each sync waits at most 15 seconds for the host (`PENMOSS_NOTEBOOK_SYNC_TIMEOUT=<seconds>` changes it); after that the change is made here and pushed in the background.

## Output and exit codes

The CLI prints short lines for people. With `--json` it prints one JSON document instead, shaped like the [MCP tools'](/docs/reference/mcp/) results; edits return `{ id, changed, baseVersion, summary }`. Errors then go to stderr as `{"error":{"code","message","details"},"exitCode":N}`. `NO_COLOR` turns off colour.

| Code | Meaning                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done                                                                                                                                                                       |
| 1    | Unexpected failure: git failed, or the repository's host could not be reached (a change is kept on this machine)                                                           |
| 2    | The command line does not fit the command, or no notebook was named where one must be                                                                                      |
| 3    | Not allowed (a setting of the apps), the host refused the credentials, or the credentials file is unsafe to read                                                           |
| 4    | No such note, folder, heading, text, version, notebook or repository                                                                                                       |
| 5    | Conflict: the note changed since the base version, or it is in Trash; another `penmoss` is using the clone; `remove` would lose unpushed changes                           |
| 6    | Ambiguous: a title, heading or text matches more than once                                                                                                                 |
| 7    | Refused for another reason, or by the repository's host: a refused push (branch protection, a hook, GitHub's GH007), a git rewrite of the remote, or a branch that is gone |

## Git notebooks

```sh
penmoss notebook add https://github.com/you/notes.git --name notes
penmoss notebook add git@github.com:you/app.git --dir docs/notes --name app-notes
penmoss notebook add https://github.com/you/notes.git --name notes-agent --agent "Claude Code"
penmoss notebook sync
```

- **`notebook add <remote> [--branch <b>] [--dir <dir>] [--name <name>] [--agent <label>] [--token -] [--token-user <user>] [--no-sign] [--author-name <name>] [--author-email <email>]`** clones the repository and makes a notebook there if the branch has none, or opens the one it has. It writes only inside `--dir`. The clone writes as this device, or as the agent `--agent` names: give each agent its own clone. A branch that does not exist yet is made by the first push. If the first push is refused, nothing is added.
- **`notebook ls`** lists them; **`notebook status <name>`** shows its writer, unpushed changes, last synced commit, sizes and signing.
- **`notebook sync [<name>] [--full] [--wait <seconds>]`** syncs now.
- **`notebook remove <name> [--force]`** removes the clone and its saved token, never the repository. It refuses while changes are unpushed (exit 5), unless `--force`.
- **`notebook token <name> (- | --forget)`** saves a token from stdin, or forgets it.
- **`notebook set <name> [--sign | --no-sign] [--author-name <name>] [--author-email <email> | --git-author]`** changes signing and the commit identity for this notebook only.

### Credentials

git's own credential helpers and SSH keys are used. For HTTPS with a personal access token, pass it on stdin with `--token -`, never on the command line, or set `PENMOSS_GIT_TOKEN`, which is sent only to `PENMOSS_GIT_TOKEN_HOST` (default `github.com`). The token's user name is `x-access-token` unless `--token-user` says otherwise (Bitbucket: `x-token-auth`). A remote with a user name or password in it is refused.

A saved token goes in the keychain (macOS, or libsecret on Linux), else in `~/.penmoss/credentials.json` with mode 600. It reaches git only through a one-off helper, never the command line, a URL or the clone's config.

### Commits

Commits carry your git identity (read for each commit), or the notebook's own (`notebook set --author-email`), and a `Penmoss-Writer` trailer naming the device or agent. They are signed when your git config signs commits; `--no-sign` never signs.

### On disk

`~/.penmoss/notebooks.json` lists the notebooks, and `~/.penmoss/git/<id>/` holds each clone. One `penmoss` uses a clone at a time; another waits up to 10 seconds, then exits 5. `PENMOSS_HOME` moves the whole folder.

## Agents and the CLI

The CLI suits agents that run shell commands. For most agents the [MCP server](/docs/agents/) is simpler.

1. **Give the agent its own clone**, with **Connect an Agent** in **Settings → Agents**, or `penmoss notebook add <remote> --name notes-<agent> --agent "<Agent name>"`, and have it pass `--notebook` with that name.
2. **Tell the agent how to use it**, for example in the project's `CLAUDE.md` or `AGENTS.md`:

   ```md
   ## Penmoss notes

   Use the `penmoss` CLI with `--json` and `--notebook notes-claude-code` (`penmoss --help` lists the commands).

   - Find notes: `penmoss search "<query>" --json`, then read one: `penmoss cat <id> --json`.
   - Today's journal: `echo "<markdown>" | penmoss daily --append - [--heading Notes]`.
   - Edit a section: `penmoss edit <id> --section "<heading>" - --base <baseVersion from cat> < file`.
     Exit 5 means it changed since that base: run `penmoss cat <id> --json` again and redo the edit on the new text.
   - Name notes by id; exit 6 means a title matched several notes.
   - Use `penmoss open <id> --print`, never plain `open`, which would bring up the Mac app.
   ```

3. **Allow the commands**, so the agent does not ask for each one. In Claude Code, add `Bash(penmoss:*)` to `permissions.allow` in `.claude/settings.json`. Codex needs its sandbox to allow writing `~/.penmoss` and reaching the repository's host.
