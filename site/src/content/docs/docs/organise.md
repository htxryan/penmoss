---
title: Notebooks, folders and tags
description: Organise notes in notebooks, folders and nested tags, and keep the ones you use most in Quick Access.
---

This page shows you how to organise your notes: several notebooks side by side, folders inside each, nested tags across them, and Quick Access and Recent Notes for the notes you use most.

## Notebooks

Each git notebook has its own section in the sidebar, with its folder tree, its sync state and its own Trash. Add more in **Settings → Notebooks → Add a Git Notebook…**.

- **Search** covers every notebook, and labels each result with its notebook.
- **Links, embeds, tags, the graph and backlinks** stay inside one notebook.
- **New notes** go where you last clicked: a notebook's **Top level**, or a folder.
- **Move to Notebook…** and **Copy to Notebook…**, in a note's or folder's right-click menu, take it to another notebook.
- **Copy Tags**, at the bottom of Copy to Notebook's picker, chooses whether the copies keep the tags you added to their notes. Turn it on or off by default in **Settings → Notebooks → Copy to Notebook**; it is on unless you change it. Tags typed in a note's text, like #idea, are part of the note and always go with it. Move to Notebook always keeps the tags.

### Rename a notebook

Right-click a notebook's row in the sidebar and choose **Rename Notebook**, type the new name and press Return (Escape keeps the old one). Or change **Notebook Name** on its page in **Settings → Notebooks** and choose **Rename**. With only one notebook, the sidebar shows no row for it: use Settings.

The name is kept in the notebook's repository, so it renames it on every device that syncs it, your agents' copies included. Agents keep working: `--notebook` still finds a notebook by the name it had before.

Two notebooks with one name can't be told apart by agents, so Penmoss warns when you add or rename a notebook to a name another notebook on this Mac has, and offers a free one, such as "Personal (2)".

### The Primary Notebook

One notebook is your **Primary Notebook**. Today's note, This Week's note, the calendar, the Inbox and quick capture use it, and your app settings are kept in it. Choose it in **Settings → Notebooks**: open the notebook and choose **Make Primary Notebook**. Each Mac chooses its own. On Android the same setting is **Journal notebook**, in **Settings → Notebooks**.

## Folders

- **New folder:** **New Folder** (⌘⌥⇧N), or right-click a folder and choose **New Folder Here**. **New Note Here** makes a note inside it.
- **Rename:** right-click and choose **Rename**, or focus the folder in the sidebar and press F2.
- **Move:** drag it in the sidebar, or focus it and press ⌥↑ or ⌥↓.
- **Delete:** right-click and choose **Delete Folder…**, or press Delete. Its notes move up to the folder above it; no note is deleted. The folder itself goes to Trash.

### Sort order

Each folder sorts its notes in its own way: **Manual** (the default: drag to reorder), **A–Z**, or **Modified** (newest first). Choose it with the **Sort Order** button on the notebook's row in the sidebar (in its ⋯ menu when the sidebar is narrow), which sorts the current folder, or with the commands **Sort the Current Folder: Manual**, **A–Z** and **Last Modified**.

## Moving notes

- **Drag** a note to a folder in the sidebar.
- **Move to Folder…**, in the note's ⋯ menu, the File menu or the command palette, opens a picker: choose the folder and **Move here**.
- **Several at once:** Shift-click selects a range, ⌘-click adds or removes one. Then right-click (or Ctrl-click, or Shift+F10) for **Move N Notes…** or **Move N Notes to Trash**, with one Undo.

What a move or copy did, or why it could not be done, shows in a message at the bottom centre of the window, with a check when it worked and a warning sign when it did not. Up to three messages show at once, newest at the bottom. On Android the same messages show at the bottom of the screen.

## Tags

A tag is a word after `#` in the note, such as `#ideas`, or an entry in the note's tags. Tags nest with `/`: `#work/plans` is inside `#work`. Tags ignore case. `#2026` and `C#` are not tags: a tag needs a letter, and must follow a space or an opening bracket.

- **Add a tag to the note's tags:** **Add a Tag to This Note**, or the tag field in the note's Metadata tab (`tag or area/tag`).
- **See a tag's notes:** choose it in the sidebar's **Tags** section, choose a tag in the note's Metadata tab, or ⌘-click a #tag in the text. [Search](/docs/search/) opens with its **Tag** filter set and lists every note with that tag, or a tag inside it, newest first. Type to search those notes by their words. With several notebooks, Search starts on the tag's notebook.
- **Rename or merge a tag:** the pencil beside a tag in the Tags section (**Rename or Merge**) changes it in every note, nested tags and notes in Trash included. Renaming to a tag that already exists merges the two. The Tags page does this too, and deletes tags.

### The Tags page

The **Tags** page is where you describe and tidy your tags: a table with a row for each tag, its note count, and what it means. Open it with the button at the end of the sidebar's **Tags** title (**Open the Tags Page**, shown when you point at the title) or **Tags** in the command palette. With several notebooks it has a table for each, in the sidebar's order, and each change stays in its own notebook.

- **Find a tag:** type in the filter at the top. It narrows the tables to tags whose name or description has what you type. Escape clears it. Choose **Tag** or **Notes** at the top of a table to sort by it.
- **See a tag's notes:** choose its name, or **Show Notes** in its ⋯ menu. Search opens on its notes, in that tag's notebook, as choosing it in the Tags section does.
- **Describe a tag:** choose its description (or **Add a description**) and type. A row shows the first line of its description; while you edit it the box grows to show every line. It saves as you type: **Saving…**, then **Saved**. If it can't be saved, the row says **Not saved**; choose **Try Again**. Empty the box to remove the description.
- **Rename a tag:** **Rename…** in its ⋯ menu, or F2 on its row, turns the name into a box in its row. Press Return, or click away, and it is renamed in every note at once; Escape cancels. A tag with tags inside it offers to rename those too (**Also rename the tags inside it**, on unless you turn it off). Its description goes with it.
- **Rename to a name that exists:** the row asks whether to merge the two, with how many notes end up with the tag. **Merge Into #name** opens the Merge dialog with that tag chosen; **Pick Another Name** lets you type again.
- **Merge tags:** **Merge Into…** in a tag's ⋯ menu, or select tags with their checkboxes and choose **Merge…** at the top. For one tag, find and choose the tag to merge it into; for several, choose the one to keep or type a new name. The dialog says how many notes change, and which description is kept: the kept tag's, or, if it has none, the first merged tag's that has one. **Merge Tags** replaces the merged tags with the kept one in every note, and the tags inside them move along.
- **Delete tags:** **Delete…** in a tag's ⋯ menu, or select tags and choose **Delete…** at the top. After you confirm, the tags, and the tags inside them, are removed from every note that has them, notes in Trash included. The notes stay, and a tag in a note's text keeps its word without the #: `a #garden bed` becomes `a garden bed`. Its description goes too.
- **Undo:** after a rename, merge or delete, the message at the bottom of the window offers **Undo** for a few seconds (longer while you point at it). Undo puts back the tags in each note, and the descriptions, unless you have changed that text since.
- **With one tag selected,** **Rename…** joins **Merge…** and **Delete…** at the top. **Select All** at the top of the checkboxes selects every tag the filter shows.
- **Each tag has its own description.** A parent's description says what the parent means, not its nested tags.
- **Descriptions belong to the notebook.** They sync with it to your other devices, and agents read them with [`describe_tags`](/docs/reference/mcp/#what-tags-mean) to choose and understand tags.

Android shows tags as before and keeps their descriptions when it syncs; describe and tidy tags on your Mac.

## Quick Access

Quick Access holds up to 20 notes you want at hand. **Pin to Quick Access** in a note's ⋯ menu adds it, or drag a note onto the section. Right-click one for **Remove from Quick Access**. On the Mac the [menu bar icon](/docs/install/mac/#the-menu-bar-icon) lists them too.

## Recent Notes and the Inbox

- **Recent Notes** lists the notes opened on this device or changed anywhere, newest first: ten unless you change it in **Settings → Display**. **Switch to a Recent Note** (⌘E) steps through them.
- **Inbox** is the top-level folder that [quick capture](/docs/quick-capture/) files new notes in. Penmoss uses a folder called Inbox if you have one, and makes it otherwise.

## The sidebar

**Settings → Display** chooses which shortcuts the sidebar's top row shows (Search is always there), the order of its sections (Quick Access, Recent Notes, Notebooks, Calendar, Tags), and how many notes Recent Notes lists. ⌘\\ folds the sidebar to a rail of icons and back. On the rail, Send Feedback and Settings stay at its foot, Settings at the very bottom, and a note's top bar starts with Back and Forward.
