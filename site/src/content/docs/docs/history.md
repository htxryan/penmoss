---
title: History and Trash
description: See every version of a note and who made it, bring back an old one, undo an agent's edit, and use Trash.
---

This page shows you how to see a note's earlier versions, bring one back, undo one edit, and get notes back from Trash.

## Version history

**Version History** (⌘⌥⇧H, or the note panel's **History** tab) lists the note's versions, newest first. Each one is a commit in your repository that changed the note, with when it was made, who made it (this Mac, your phone, or an agent, marked with a star) and a summary such as `Appended · +1 −0 line`. Changes that have not synced yet show as **Not saved as a version yet**. The list shows at once, and each version's summary fills in a moment later, the newest first.

Select a version to see what it changed.

- **Restore This Version** brings back the whole note as it was then, as a new change. Nothing is lost: the versions after it stay in the history.
- **Revert This Edit**, on an agent's version, undoes only what that version changed and keeps every edit made since. If a later edit changed the same lines, it says so.
- **Sync Now** saves a version now. Otherwise each sync makes one.

On the Mac, Restore and Revert first ask for Touch ID or your password. On Android they ask for your fingerprint, face or screen lock.

To see a whole notebook as it was on any day, or what changed this week, use the [Time Machine](/docs/time-machine/).

Your repository's git history keeps every version, so you can also read it with `git log`, or with [`penmoss history`](/docs/reference/cli/#history).

## Trash

**Move to Trash**, in the note's ⋯ menu, moves a note to its notebook's Trash, with **Undo** for a few seconds. **Trash** at the foot of the sidebar lists what is there.

- **Restore** puts the note back in the folder it came from (or the top level, if that folder has gone).
- **Delete for Good** removes the note's files from the notebook. It asks first, then for Touch ID or your password (on Android, your fingerprint, face or screen lock). The repository's git history still keeps it.

Notes stay in a git notebook's Trash until you delete them for good. Deleted folders go to Trash too, and can be restored.

### Only you delete for good

No agent, script or command can delete a note for good: only you, in the app, with the owner check. If a Delete for Good waits a long time to sync, for example offline, Penmoss asks you to confirm it again before it syncs: **Settings → Notebooks** lists the notes and asks once more.
