---
title: Time Machine
description: See a notebook as it was on any date, read any note as it was then, and see what changed this week.
---

This page shows you how to look back at a notebook: its folders and notes as they were on any day, a note's text then, and everything that changed in a week. It is on the Mac.

Everything here comes from your notebook's git history, already on your Mac. Nothing goes to a server, and the Time Machine never changes the past.

## Open it

- **Time Machine** in the command palette (⌘K) opens it for the notebook of the note you have open, or for your Primary Notebook.
- The **Time Machine** button on a notebook's name row in the sidebar (it shows when the pointer is over the row) opens it for that notebook.
- If you have more than one notebook, the **Notebook** list at the top of the page switches between them.

## Notebook Then

**Notebook Then** shows the notebook at one moment: its folders and notes as they were then, with notes in Trash left out.

- **Date** picks a day. The page shows the notebook at the end of that day, in your notebook's time zone (**Settings → Daily Notes**).
- The slider moves through the notebook's commits, one sync or agent edit at a time. **Earlier Commit** and **Later Commit** step one at a time. Under it you see the commit's date and who made it: your Mac, your phone, or an agent (marked with a star).

Select a note to read its text as it was then. It is read-only.

- **Restore This Version** brings the note back to that text, as a new change, the same as [Restore This Version](/docs/history/#version-history) in History. It asks for Touch ID or your password first.
- **Restore Note** shows for a note deleted since. If it is in Trash, it comes back from Trash with its text then. If it was deleted for good, it comes back as a new note with that text, in the folder it was in when that folder still exists.
- **Open the Note** opens the note as it is now.

## What Changed

**What Changed** lists the notes that changed in a range of days, this week by default (Monday to Sunday, in your notebook's time zone).

- **From** and **To** set the range. **Previous Week**, **This Week** and **Next Week** move it a week at a time.
- Each note shows what happened to it: **Created**, **Edited**, **Renamed** (with its old title), **Moved** (with its old folder), **Deleted** or **Restored**, and who did it.
- **Show Changes** shows the note's text changes over the range, lines added and removed.

A weekly note has a **What changed this week** link under its title, which opens What Changed for that note's week. It is a link on the page, not text in the note.

## What it can see

The Time Machine reads what has synced. A change that has not synced from its device yet shows once it has. It reads the notebook's last 10,000 commits.
