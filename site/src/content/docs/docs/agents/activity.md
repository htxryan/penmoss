---
title: Agent activity and undo
description: See what each agent changed in your notebook and undo it, note by note or change by change.
---

This page shows you how to see what your agents changed and how to undo it.

Every agent edit names the app and session that made it (see [How agents work](/docs/agents/#one-server-every-notebook)), so Penmoss can tell you what each one did.

## Edits to notes: History

An agent's edits to a note are in that note's [Version History](/docs/history/) (⌘⌥⇧H), marked with a star and the agent's name.

An edit made through `penmoss mcp` names the app and its session: **Claude Code · 7736c5e9** is the Claude Code session whose id starts 7736c5e9, and **Codex · 019a8c3e** a Codex thread. Find the session in the app (Claude Code's `/status`, or Codex's `codex resume` list) to see what it was asked to do. An app that gives no session id is named with an id Penmoss made for that run of the server, marked **(Penmoss’s id)**.

- **Revert This Edit** undoes what that one version changed and keeps every edit made since, by you or anyone else. If a later edit changed the same lines, it says so.
- **Restore This Version** brings back the whole note as it was.

## Everything else: Agent Activity

**Agent Activity** lists what agents changed outside the notes' text in the last 30 days: folders they made, renamed or moved, notes they moved, and settings they changed. Each entry names the agent (the app and its session, as in History), the notebook and when, newest first, with **Undo**.

- **On the Mac:** open **Settings → Agent Activity**, beside **Agents**. It lists every notebook's changes together. Use the two menus by the title to show one notebook (**All Notebooks** by default) or one agent (**All Agents**).
- **On Android:** open **Settings → Agent Activity**. It lists every notebook's changes together, with a filter for one notebook, one agent or one kind of change.

**Undo** is a change of your own, made on this device and synced like any other; the entry then says **Undone by** you. If something else changed the same thing since, such as a folder renamed again, Undo says so and changes nothing.

Agent Activity reads the notebook's branch, so it covers every agent, on any machine, that writes as an agent. The CLI and the MCP server cannot read it or undo from it: only you can, in the app.

## Everything: git

Every change is a commit in your repository, with a `Penmoss-Writer` line naming the device or agent that made it. `git log` shows them all. See [Notebooks on disk](/docs/reference/notebook-format/#commits).
