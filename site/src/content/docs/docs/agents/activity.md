---
title: Agent activity and undo
description: See what each agent changed in your notebook and undo it, note by note or change by change.
---

This page shows you how to see what your agents changed and how to undo it.

Every agent writes as itself (see [How agents work](/docs/agents/#each-agent-has-its-own-copy)), so Penmoss can tell you what each one did.

## Edits to notes: History

An agent's edits to a note are in that note's [Version History](/docs/history/) (⌘⌥⇧H), marked with a star and the agent's name.

- **Revert This Edit** undoes what that one version changed and keeps every edit made since, by you or anyone else. If a later edit changed the same lines, it says so.
- **Restore This Version** brings back the whole note as it was.

## Everything else: Agent Activity

**Agent Activity** lists what agents changed outside the notes' text in the last 30 days: folders they made, renamed or moved, notes they moved, and settings they changed. Each entry names the agent and when, newest first, with **Undo**.

- **On the Mac:** **Settings → Git Notebooks**, choose the notebook, then **Agent Activity**.
- **On Android:** open the notebook's **Sync** screen and tap **Agent Activity**.

**Undo** is a change of your own, made on this device and synced like any other; the entry then says **Undone by** you. If something else changed the same thing since, such as a folder renamed again, Undo says so and changes nothing.

Agent Activity reads the notebook's branch, so it covers every agent, on any machine, that writes as an agent. The CLI and the MCP server cannot read it or undo from it: only you can, in the app.

## Everything: git

Every change is a commit in your repository, with a `Penmoss-Writer` line naming the device or agent that made it. `git log` shows them all. See [Notebooks on disk](/docs/reference/notebook-format/#commits).
