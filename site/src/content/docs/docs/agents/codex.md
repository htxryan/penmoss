---
title: Codex
description: Give OpenAI's Codex your Penmoss notes through the local MCP server, step by step.
---

This page shows you how to let Codex search, read and edit a notebook through Penmoss's MCP server.

You need Penmoss on your Mac with the notebook added, and the [Codex CLI](https://github.com/openai/codex) installed.

## Connect it

1. In Penmoss, open **Settings → Agents** and choose the notebook.
2. In **Another agent's name**, type `Codex`, and choose **Connect an Agent**.
3. Confirm with Touch ID or your password. Penmoss makes Codex its own copy of the notebook, such as `notes-codex`.
4. Under **Codex: add to ~/.codex/config.toml**, choose **Copy**, and paste the lines at the end of `~/.codex/config.toml` (make the file if it does not exist). They look like this:

   ```toml
   [mcp_servers."penmoss-notes-codex"]
   command = "/Applications/Penmoss.app/Contents/Helpers/Penmoss CLI.app/Contents/MacOS/Penmoss"
   args = ["--penmoss-cli", "mcp", "--notebook", "notes-codex"]
   ```

5. Start a new Codex session. Run `/mcp` to check that the Penmoss tools are there.

Then ask Codex to use your notes, for example: "Find my Penmoss note about the release checklist and tick off the first item."

## With the CLI instead

Codex can also run the [`penmoss` command](/docs/reference/cli/) in its shell. [Install the command](/docs/reference/cli/#install), and tell Codex how to use it in your project's `AGENTS.md` (see [Agents and the CLI](/docs/reference/cli/#agents-and-the-cli)).

Codex runs shell commands in a sandbox. The CLI writes to `~/.penmoss` and reaches your repository's host, so allow both in Codex's sandbox settings, or use the MCP server above.

## If it does not work

- **No Penmoss tools.** Check that `config.toml` has the lines exactly as copied, and start a new session. Run the `command` with its `args` in Terminal by itself: it should wait for input without an error (⌃C stops it).
- **Its edits do not show in the app.** The server pushes a minute after edits settle. Choose **Sync Now** in the app to pull them at once.
