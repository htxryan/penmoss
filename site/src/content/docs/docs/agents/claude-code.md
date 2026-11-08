---
title: Claude Code
description: Give Claude Code your Penmoss notes through the local MCP server, step by step.
---

This page shows you how to let Claude Code search, read and edit a notebook, and how to send it comments from your notes.

You need Penmoss on your Mac with the notebook added, and [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) installed.

## Connect it

1. In Penmoss, open **Settings → Agents** and choose the notebook.
2. In **Another agent's name**, keep **Claude Code** (or type another name), and choose **Connect an Agent**.
3. Confirm with Touch ID or your password. Penmoss makes Claude Code its own copy of the notebook, such as `notes-claude-code`, and shows how to add it.
4. Under **Claude Code: run in a terminal**, choose **Copy**, then paste the command into Terminal and run it. It looks like this:

   ```sh
   claude mcp add penmoss-notes-claude-code -- /Applications/Penmoss.app/Contents/MacOS/Penmoss --penmoss-cli mcp --notebook notes-claude-code
   ```

   This adds the server for the folder you run it in. To have it in every project, add `--scope user` after `add`.

5. Start a new Claude Code session in that folder. Run `/mcp` to check that `penmoss-notes-claude-code` is connected.

Then ask Claude Code to use your notes, for example: "Search my Penmoss notes for the garden plan and add today's watering to it."

## Receive comments from your notes

Claude Code can also receive the [comments](/docs/comments/) you send it from a note, read the thread, edit the note and reply. This uses Claude Code's channels, a research preview.

1. In **Settings → Agents**, turn on **Receive comments sent to this agent** for Claude Code.
2. Copy and run the new **Claude Code: run in a terminal** command, which adds `--channel`. If you added the server before, run `claude mcp remove penmoss-notes-claude-code` first.
3. Start Claude Code with the command under **Then start Claude Code with its channel**:

   ```sh
   claude --dangerously-load-development-channels server:penmoss-notes-claude-code
   ```

Now a thread you send to this session with **Send to** arrives in it. See [Comments to agents](/docs/agents/comments/).

## With the CLI instead

Claude Code can also use the [`penmoss` command](/docs/reference/cli/) through its shell. [Install the command](/docs/reference/cli/#install), then:

1. Tell Claude Code how to use it, in your project's `CLAUDE.md`. See [Agents and the CLI](/docs/reference/cli/#agents-and-the-cli) for a block to paste.
2. Allow the commands, so it does not ask each time: add `Bash(penmoss:*)` to `permissions.allow` in `.claude/settings.json`.

## If it does not work

- **`/mcp` shows the server failed.** Run the command after `--` in Terminal by itself; it should wait for input without printing an error. Press ⌃C to stop it. An error names the problem, such as a notebook name that does not match.
- **The server is missing.** `claude mcp list` shows what Claude Code has, for this folder. Add it again with `--scope user` to have it everywhere.
- **Its edits do not show in the app.** The server pushes a minute after edits settle. Choose **Sync Now** in the app to pull them at once.
