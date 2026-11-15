---
title: History and Trash
description: See every version of a note and who made it, bring back an old one, undo an agent's edit, and use Trash.
---

This page shows you how to see a note's earlier versions, bring one back, undo one edit, and get notes back from Trash.

## Version history

**Version History** (⌘⌥⇧H, or the note panel's **History** tab) lists the note's versions, newest first, one line each under its day (Today, Yesterday, then the date). Each version is a commit in your repository that changed the note. Its line shows who made it as an icon (this Mac, your phone, or an agent's star; hover the icon for the name), the time, a few words on what changed, such as `Added “Book the night train”`, `Checked off “Call Sam”` or the headings it touched, and how many lines it added and removed. A version that changed no text is dimmed. The list shows at once, and what each version changed fills in a moment later, the newest first.

The **Now** row at the top says whether the note has changes that are not synced yet. **Sync Now** beside it syncs, which saves a version now; otherwise each sync makes one. The **ⓘ** beside the panel's Close button says how versions are made, with a link to this page.

Select a version, or move through them with ↑ and ↓, to see what it changed under the list. Drag the handle between the list and the changes to give either more room (or focus it and press ↑ or ↓); Penmoss remembers the split.

The changes have line numbers down the left: the line's number in that version, or, on a removed line, its number in the version before, dimmed. Long runs of unchanged lines are folded, and a fold shows which lines it holds, so the numbers carry on after it. Selecting the changes, or **Copy Text**, never copies the numbers.

Under the changes are four buttons. Each shows an icon and one word, and its full name when you hover over it. In a narrow panel the words drop to keep the buttons on one line, all but Restore's first.

- **View** (View This Version) shows that version beside the note as it is now. See [View a version beside now](#view-a-version-beside-now).
- **Restore** (Restore This Version) brings back the whole note as it was then, as a new change. Nothing is lost: the versions after it stay in the history.
- **Revert** (Revert This Edit) undoes only what that version changed and keeps every edit made since. It works on any version, yours or an agent's, except a move to Trash or back out of it, which Trash undoes. If a later edit changed the same lines, it says so.
- **Copy** (Copy Text) copies the note's text as it was in that version.

On Android, History is a screen of its own that lists the same versions, with Restore and Revert.

On the Mac, Restore and Revert first ask for Touch ID or your password. On Android they ask for your fingerprint, face or screen lock.

To see a whole notebook as it was on any day, or what changed this week, use the [Time Machine](/docs/time-machine/).

Your repository's git history keeps every version, so you can also read it with `git log`, or with [`penmoss history`](/docs/reference/cli/#history).

### View a version beside now

**View** opens the version over the rest of the window, with History still beside it. The version is on the left and the note as it is now on the right, both read-only, laid out as the note is, pictures included, and scrolling together. What differs is tinted on each side: on the left, what is not in the note now; on the right, what was added since. That is what **Restore** would change.

Each side numbers its blocks by their lines in the note's markdown, and the left side is headed by the version's commit, shortened to 7 characters, and its time. Click the commit to copy it whole.

- **Show Diff** shows just the blocks that changed, each with 3 unchanged blocks around it, as a code review does. A row such as **⋯ 12 unchanged lines** stands for the rest: click it to show them. **Show Full File** shows every block again. Diff is the first choice, and this device remembers the one you pick.
- When the version and the note now are the same, Diff says **No changes from now**.
- Pick another version in History, or move with ↑ and ↓, and the left side shows that one instead, in Diff or Full File as before.
- **Restore**, **Revert** and **Copy** are at the top too. Restore and Revert close the view and show the result in the note.
- **×** (Close) or Esc goes back to History.

View is not there in a narrow window, which has no room for two sides.

## Trash

**Move to Trash**, in the note's ⋯ menu, moves a note to its notebook's Trash, with **Undo** for a few seconds. **Trash**, in the ⋯ menu on the notebook's row in the sidebar, lists what is there.

- **Restore** puts the note back in the folder it came from (or the top level, if that folder has gone).
- **Delete for Good** removes the note's files from the notebook. It asks first, then for Touch ID or your password (on Android, your fingerprint, face or screen lock). The repository's git history still keeps it.

Notes stay in a git notebook's Trash until you delete them for good. Deleted folders go to Trash too, and can be restored.

### Only you delete for good

No agent, script or command can delete a note for good: only you, in the app, with the owner check. If a Delete for Good waits a long time to sync, for example offline, Penmoss asks you to confirm it again before it syncs: the notebook's page in Settings lists the notes and asks once more.
