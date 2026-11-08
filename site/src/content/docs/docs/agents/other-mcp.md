---
title: Other MCP clients
description: Connect any MCP client that runs local stdio servers, such as the Claude desktop app, to a Penmoss notebook.
---

This page shows you how to give your notes to any MCP client on your Mac, not only the ones with their own page.

Penmoss's MCP server is a local server over stdio: the client starts it as a program and talks to it on its standard input and output. Any client that can run a local MCP server can use it, such as the Claude desktop app, Cursor, or an agent you write yourself.

## Connect it

1. In Penmoss, open **Settings → Agents**, choose the notebook, type the client's name and choose **Connect an Agent**. Note the copy's name, such as `notes-cursor`.
2. Give the client this program and these arguments:

   - **Command:** `/Applications/Penmoss.app/Contents/MacOS/Penmoss`
   - **Arguments:** `--penmoss-cli`, `mcp`, `--notebook`, `notes-cursor`

   If you have [installed the `penmoss` command](/docs/reference/cli/#install), the command can be `penmoss` and the arguments `mcp`, `--notebook`, `notes-cursor`.

Many clients, such as the Claude desktop app (`~/Library/Application Support/Claude/claude_desktop_config.json`) and Cursor (`.cursor/mcp.json`), take a JSON file in this shape:

```json
{
  "mcpServers": {
    "penmoss": {
      "command": "/Applications/Penmoss.app/Contents/MacOS/Penmoss",
      "args": ["--penmoss-cli", "mcp", "--notebook", "notes-cursor"]
    }
  }
}
```

Restart the client after you change it.

## What the server offers

- **Tools only.** It has the [34 tools](/docs/reference/mcp/) and no resources or prompts.
- **One notebook per server.** For two notebooks, connect the agent to each and add two servers.
- **Instructions.** The server tells the client how to use its tools: search first, pass `baseVersion` to edits, and read again after a conflict.
- **MCP versions** from 2024-11-05 to 2025-11-25.

## If it does not work

Run the command with its arguments in Terminal by itself. It should wait quietly for input; ⌃C stops it. If it prints an error, such as a notebook it cannot find, fix that first. `penmoss notebook ls` lists the copies on this Mac.
