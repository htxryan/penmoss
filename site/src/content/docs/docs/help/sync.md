---
title: Sync, offline and merging
description: How Penmoss syncs through your repository, works offline, and merges edits made on several devices at once.
---

This page explains how your notes get from one device to another, what happens offline, and why two devices editing the same note never leave you a conflict to sort out.

## How sync works

Each device keeps a full copy of its notebooks and works on that copy. Sync is a git pull and push to the notebook's repository, using that device's own sign-in. There is no Penmoss server in between.

|                     | Pushes                                                                     | Pulls                                                                                |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Mac app             | 12 seconds after your edits settle (within a minute while you keep typing) | Every minute while Penmoss is open, and when you come back to it                     |
| Android, app open   | 12 seconds after your edits settle                                         | When you open the notebook, and every minute                                         |
| Android, app closed | Soon after you leave the app                                               | About every 15 minutes ([The Android app](/docs/android/#syncing-in-the-background)) |
| Agents (MCP server) | A minute after the agent's edits settle, and when it stops                 | Every two minutes                                                                    |

**Sync Now** syncs at once. Each notebook's timing can be changed in **Settings → Git Notebooks**.

Each notebook's section in the sidebar shows its state with a dot; its tooltip says **Synced**, **Offline**, **Pushing…** or why it stopped.

## Offline

Everything works offline: reading, writing, search, capture, history you already have. Changes wait on the device.

- When the device loses its network, the notebook says **Offline** at once and stops trying.
- When the network comes back, it syncs straight away.
- If the host cannot be reached for another reason, Penmoss tries again after 30 seconds, then less and less often, up to every 10 minutes.

## Merging

Edit the same note on your Mac and your phone, both offline, and when they sync the note has both edits. There are no conflict copies and no merge to resolve.

This works because Penmoss does not sync the markdown files. Each device and agent keeps a log of its own edits in the notebook's `.penmoss` folder, and every device combines the logs the same way. Git never sees two writers change one file, so a pull never conflicts. See [Notebooks on disk](/docs/reference/notebook-format/#the-penmoss-folder).

If two devices change the same words at the same time, both changes are kept side by side, and you tidy them as you like.

Agents are careful in one more way: an agent's edit is refused if the part of the note it changes has changed since it read it, and the agent reads it again. See [Safe edits](/docs/agents/#safe-edits).

## When sync stops

If the host refuses a push, the notebook says **Sync stopped** with the host's own words, and your changes wait on the device. Nothing is lost. Common reasons:

- **The token expired or was revoked.** Save a new one in **Settings → Git Notebooks**.
- **GitHub refused your email (GH007).** Set the notebook's **Commit email** to your GitHub no-reply address. See [Commits and your email](/docs/first-notebook/#commits-and-your-email).
- **The branch is protected**, or requires signed commits. Allow pushes to it, or turn on signing.
- **The branch was deleted.** Penmoss will not start it again by itself.

## Quitting with changes

When you quit the Mac app, it pushes what waits, for up to 10 seconds. A push that cannot finish then is pushed first at the next launch. On Android, leaving a notebook pushes its changes within a few seconds.

## Files edited by hand

Edit notes in Penmoss, not by editing their `.md` files in the repository: the next sync writes the file back from the notebook and says so. See [Files you did not write](/docs/reference/notebook-format/#files-you-did-not-write).
