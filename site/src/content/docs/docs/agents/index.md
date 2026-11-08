---
title: How agents work
description: How AI agents such as Claude Code read and edit your notes through Penmoss's local MCP server and CLI, and what keeps your notes safe.
---

This page explains how an AI agent on your Mac reads and edits your notes, and what keeps your notes safe while it does. To set one up, go to [Claude Code](/docs/agents/claude-code/), [Codex](/docs/agents/codex/), [OpenCode](/docs/agents/opencode/) or [another MCP client](/docs/agents/other-mcp/).

## Two ways in

- **The MCP server**, `penmoss mcp`, gives an agent [tools](/docs/reference/mcp/) such as `search_notes`, `read_note` and `append_to_note`. It works with any agent that speaks the [Model Context Protocol](https://modelcontextprotocol.io) over stdio. This is the usual way.
- **The CLI**, `penmoss`, is for agents that run shell commands, and for scripts. See [The penmoss CLI](/docs/reference/cli/#agents-and-the-cli).

Both run on your Mac, from the Penmoss app itself, and need no account, token or server. They work on a copy of the notebook on your Mac and sync it through your repository, just as the app does.

## Each agent has its own copy

When you connect an agent, Penmoss makes it its own copy (a clone) of the notebook, in `~/.penmoss`, that writes as that agent. So:

- [History](/docs/history/) shows which agent made each edit, marked with a star, and **Revert This Edit** undoes one without losing later edits.
- [Agent activity](/docs/agents/activity/) lists what each agent moved, made or renamed, with **Undo**.
- Comments you [send to an agent](/docs/agents/comments/) reach its session.

Connect each agent in **Settings → Agents**: choose the notebook, type the agent's name, and choose **Connect an Agent**. The copy is named after both, such as `notes-claude-code`. Penmoss also makes one copy for every agent by itself, marked **Made by Penmoss for every agent on this Mac**, but its edits are all named "Agent".

## Safe edits

- **Edits are checked against what the agent read.** Each read gives a `baseVersion`, and an edit sent with it goes ahead only if that part of the note is still as the agent saw it. If you changed it meanwhile, nothing changes, and the agent is told to read the note again.
- **Edits are small.** Agents append, replace one section, or find and replace text. They do not rewrite a whole note to change a line.
- **Nothing deletes a note for good.** An agent can move a note to Trash, which you can undo. Only you can [delete for good](/docs/history/#only-you-delete-for-good).
- **Every edit is a commit** in your repository, so git keeps every version too.
- **An agent sees only the notebook it was given.**

:::caution
An agent reads your notes as text, and a note can contain anything, including text written to mislead an agent. Give an agent only the notebooks it needs, and check its edits in History.
:::

## The penmoss command

The setup commands Penmoss gives you name the app itself (`/Applications/Penmoss.app/Contents/MacOS/Penmoss --penmoss-cli`), so they work without anything else installed. To type `penmoss` in a terminal, install the command: **Settings → Agents → The penmoss Command → Install Command**. See [Install the CLI](/docs/reference/cli/#install).

## When agents sync

The MCP server syncs when it starts, pushes a minute after the agent's edits settle, and pulls every two minutes. When the agent stops it, the server pushes what is left in the background. Edits reach your Mac's app and your phone with their next sync.

## Disconnect an agent

In **Settings → Agents**, choose the notebook and **Disconnect** the agent. Penmoss removes its copy, never your repository. If the copy has changes it has not pushed, Penmoss says so and offers **Disconnect Anyway** (with Touch ID) or **Keep It**. Then remove its server from the agent too, for example with `claude mcp remove penmoss-notes-claude-code`.

## Claude on the web and phone

Agents need to run on your Mac. Claude on the web and on your phone cannot reach your notebooks through Penmoss. An app on your Mac that runs local MCP servers can: see [Other MCP clients](/docs/agents/other-mcp/).
