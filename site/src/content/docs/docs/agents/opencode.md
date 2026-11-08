---
title: OpenCode
description: Give OpenCode your Penmoss notes through the local MCP server, step by step.
---

This page shows you how to let OpenCode search, read and edit a notebook through Penmoss's MCP server.

You need Penmoss on your Mac with the notebook added, and [OpenCode](https://opencode.ai) installed.

## Connect it

1. In Penmoss, open **Settings → Agents** and choose the notebook.
2. In **Another agent's name**, type `OpenCode`, and choose **Connect an Agent**.
3. Confirm with Touch ID or your password. Penmoss makes OpenCode its own copy of the notebook, such as `notes-opencode`. Note its name.
4. Add the server to OpenCode's configuration: `~/.config/opencode/opencode.json` for every project, or `opencode.json` in one project. Put the copy's name after `--notebook`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "penmoss": {
         "type": "local",
         "command": [
           "/Applications/Penmoss.app/Contents/MacOS/Penmoss",
           "--penmoss-cli",
           "mcp",
           "--notebook",
           "notes-opencode"
         ],
         "enabled": true
       }
     }
   }
   ```

   If the file already has an `mcp` section, add the `penmoss` entry to it.

5. Start OpenCode again, so it reads the new configuration.

Then ask OpenCode to use your notes, for example: "Append a summary of this session to today's note in Penmoss."

Penmoss's settings show ready-made lines for Claude Code and Codex only. For OpenCode, the command is the same as Codex's: the app, `--penmoss-cli`, `mcp`, `--notebook` and the copy's name.

## If it does not work

- **No Penmoss tools.** Check the JSON is valid and the notebook name matches. Run the command in Terminal by itself: it should wait for input without an error (⌃C stops it).
- **Its edits do not show in the app.** The server pushes a minute after edits settle. Choose **Sync Now** in the app to pull them at once.
