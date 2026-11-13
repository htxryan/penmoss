---
title: Notebooks, folders and tags
description: Organise notes in notebooks, folders and nested tags, and keep the ones you use most in Quick Access.
---

This page shows you how to organise your notes: several notebooks side by side, folders inside each, nested tags across them, and Quick Access and Recent Notes for the notes you use most.

## Notebooks

Each git notebook has its own section in the sidebar, with its folder tree, its sync state and its own Trash. Add more in **Settings → Git Notebooks → Add a Git Notebook…**.

- **Search** covers every notebook, and labels each result with its notebook.
- **Links, embeds, tags, the graph and backlinks** stay inside one notebook.
- **New notes** go where you last clicked: a notebook's **Top level**, or a folder.
- **Move to Notebook…** and **Copy to Notebook…**, in a note's or folder's right-click menu, take it to another notebook.
- **Copy Tags**, at the bottom of Copy to Notebook's picker, chooses whether the copies keep the tags you added to their notes. Turn it on or off by default in **Settings → Git Notebooks → Copy to Notebook**; it is on unless you change it. Tags typed in a note's text, like #idea, are part of the note and always go with it. Move to Notebook always keeps the tags.

### The Primary Notebook

One notebook is your **Primary Notebook**. Today's note, This Week's note, the calendar, the Inbox and quick capture use it, and your app settings are kept in it. Choose it in **Settings → Git Notebooks**: open the notebook and choose **Make Primary Notebook**. Each Mac chooses its own. On Android the same setting is **Journal notebook**, in **Settings → Git Notebooks**.

## Folders

- **New folder:** **New Folder** (⌘⌥⇧N), or right-click a folder and choose **New Folder Here**. **New Note Here** makes a note inside it.
- **Rename:** right-click and choose **Rename**, or focus the folder in the sidebar and press F2.
- **Move:** drag it in the sidebar, or focus it and press ⌥↑ or ⌥↓.
- **Delete:** right-click and choose **Delete Folder…**, or press Delete. Its notes move up to the folder above it; no note is deleted. The folder itself goes to Trash.

### Sort order

Each folder sorts its notes in its own way: **Manual** (the default: drag to reorder), **A–Z**, or **Modified** (newest first). Choose it with the **Sort Order** button on the notebook's row in the sidebar, which sorts the current folder, or with the commands **Sort the Current Folder: Manual**, **A–Z** and **Last Modified**.

## Moving notes

- **Drag** a note to a folder in the sidebar.
- **Move to Folder…**, in the note's ⋯ menu, the File menu or the command palette, opens a picker: choose the folder and **Move here**.
- **Several at once:** Shift-click selects a range, ⌘-click adds or removes one. Then right-click (or Ctrl-click, or Shift+F10) for **Move N Notes…** or **Move N Notes to Trash**, with one Undo.

What a move or copy did, or why it could not be done, shows in a message at the bottom centre of the window, with a check when it worked and a warning sign when it did not. Up to three messages show at once, newest at the bottom. On Android the same messages show at the bottom of the screen.

## Tags

A tag is a word after `#` in the note, such as `#ideas`, or an entry in the note's tags. Tags nest with `/`: `#work/plans` is inside `#work`. Tags ignore case. `#2026` and `C#` are not tags: a tag needs a letter, and must follow a space or an opening bracket.

- **Add a tag to the note's tags:** **Add a Tag to This Note**, or the tag field in the note's Metadata tab (`tag or area/tag`).
- **Filter by a tag:** choose it in the sidebar's **Tags** section. The sidebar then shows only the notes with that tag, or a tag inside it. **All Notes** clears the filter.
- **Rename or merge a tag:** the pencil beside a tag in the Tags section (**Rename or Merge**) changes it in every note, nested tags and notes in Trash included. Renaming to a tag that already exists merges the two.

## Quick Access

Quick Access holds up to 20 notes you want at hand. **Pin to Quick Access** in a note's ⋯ menu adds it, or drag a note onto the section. Right-click one for **Remove from Quick Access**. On the Mac the [menu bar icon](/docs/install/mac/#the-menu-bar-icon) lists them too.

## Recent Notes and the Inbox

- **Recent Notes** lists the notes opened on this device or changed anywhere, newest first: ten unless you change it in **Settings → Display**. **Switch to a Recent Note** (⌘E) steps through them.
- **Inbox** is the top-level folder that [quick capture](/docs/quick-capture/) files new notes in. Penmoss uses a folder called Inbox if you have one, and makes it otherwise.

## The sidebar

**Settings → Display** chooses which shortcuts the sidebar's top row shows (Search is always there), the order of its sections (Quick Access, Recent Notes, Notebooks, Calendar, Tags), and how many notes Recent Notes lists. ⌘\\ folds the sidebar to a rail of icons and back.
