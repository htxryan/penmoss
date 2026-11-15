---
title: Notebooks, folders and tags
description: Organise notes in notebooks, folders and nested tags, and keep the ones you use most in Quick Access.
---

This page shows you how to organise your notes: several notebooks side by side, folders inside each, nested tags across them, and Quick Access and Recent Notes for the notes you use most.

## Notebooks

Each git notebook has its own section in the sidebar, with its folder tree, its sync state and its own Trash. Add more in **Settings → All Notebooks → Add Notebook…** (**Notebook Settings** in the command palette opens the page). Each notebook also has its own entry under **All Notebooks** in Settings, with its sync dot, which opens its page.

- **Search** covers every notebook, and labels each result with its notebook.
- **Links, embeds, tags, the graph and backlinks** stay inside one notebook.
- **New notes** go where you last clicked: a notebook's **Top level**, or a folder.
- **Move to Notebook…** and **Copy to Notebook…**, in a note's or folder's right-click menu, take it to another notebook.
- **Copy Tags**, at the bottom of Copy to Notebook's picker, chooses whether the copies keep the tags you added to their notes. Turn it on or off by default with **Copy Tags When Copying Notes**, under **Between Notebooks** in **Settings → All Notebooks**; it is on unless you change it. Tags typed in a note's text, like #idea, are part of the note and always go with it. Move to Notebook always keeps the tags.

### Rename a notebook

Point at a notebook's row in the sidebar, open its ⋯ menu (**More Notebook Actions**) and choose **Rename…**, or right-click the row and choose **Rename Notebook**. Type the new name and press Return (Escape keeps the old one). Or change **Name** on its page in Settings (choose the notebook under **All Notebooks**), and choose **Rename**.

The name is kept in the notebook's repository, so it renames it on every device that syncs it, your agents' copies included. Agents keep working: `--notebook` still finds a notebook by the name it had before.

Two notebooks with one name can't be told apart by agents, so Penmoss warns when you add or rename a notebook to a name another notebook on this Mac has, and offers a free one, such as "Personal (2)".

### Notebook badges

Each notebook has a badge: a small square in a colour, holding a letter, a number or an icon. It shows at the start of the notebook's row in the sidebar, at the start of each of its notes' [tabs](/docs/install/mac/#tabs), and in Settings (its entry under **All Notebooks**, its row in the list and its page's heading), so you can tell notebooks apart at a glance.

- **By default** a notebook's badge shows the first letter (or digit) of its name in one of ten colours, picked from the notebook itself, so it is the same on every Mac. Two notebooks can have the same badge: Personal and Penmoss are both **P** until you change one.
- **To change it**, open Settings, choose the notebook under **All Notebooks**, and use the **Badge** rows on its **Overview**, after its name: pick a colour (Moss, Teal, Blue, Indigo, Violet, Rose, Red, Orange, Ochre, Slate, or **Custom…** for any colour), then what it **Shows**: a **Letter**, a **Number** from 0 to 99, or one of 24 **Icons**. The preview shows it alone, then on the notebook's own row in the sidebar and on a tab of one of its notes, and the change applies at once.
- **Reset to Default** brings back the first letter and the colour it started with. A default letter follows the notebook's name when you rename it; one you chose stays.
- The badge belongs to the notebook and syncs with it to your other Macs. **Copy Settings…** and **Keep Settings in Step** leave each notebook's badge its own. Android doesn't show badges yet.

### The Primary Notebook

One notebook is your **Primary Notebook**. Today's note, This Week's note, the calendar, the Inbox and quick capture use it, and your app settings are kept in it. Choose it with **Primary Notebook** in **Settings → All Notebooks**. Each Mac chooses its own; the notebook's row and page show a **Primary** chip.

To give another notebook the same settings, choose **Copy Settings…** under **Between Notebooks**, pick **From** and **To**, and choose **Copy Settings**: it replaces the other notebook's settings, once (Quick Access stays as it is). **Keep Settings in Step** does it for every change from then on, on this Mac. Android has **Primary Notebook**, **Keep Settings in Step** and **Copy Settings…** in **Settings → All Notebooks** too, and Keep Settings in Step is each phone's own choice.

## Folders

- **New folder:** **New Folder** (⌘⌥⇧N), or right-click a folder and choose **New Folder Here**. **New Note Here** makes a note inside it.
- **Rename:** right-click and choose **Rename**, or focus the folder in the sidebar and press F2.
- **Move:** drag it in the sidebar, or focus it and press ⌥↑ or ⌥↓.
- **Delete:** right-click and choose **Delete Folder…**, or press Delete. Its notes move up to the folder above it; no note is deleted. The folder itself goes to Trash.

### Sort order

Each folder sorts its notes in its own way: **Manual** (the default: drag to reorder), **A–Z**, or **Modified** (newest first). Choose it with **Sort Order…** in the ⋯ menu on the notebook's row in the sidebar, which sorts the current folder, or with the commands **Sort the Current Folder: Manual**, **A–Z** and **Last Modified**.

## Moving notes

- **Drag** a note to a folder in the sidebar.
- **Move to Folder…**, in the note's ⋯ menu, the File menu or the command palette, opens a picker: choose the folder and **Move here**.
- **Several at once:** Shift-click selects a range; once several are selected, ⌘-click adds or removes one, and Space adds or removes the note you are on. On a single note, ⌘-click opens it in a [new tab](/docs/install/mac/#tabs) instead. Then right-click (or Ctrl-click, or Shift+F10) for **Move N Notes…** or **Move N Notes to Trash**, with one Undo.

What a move or copy did, or why it could not be done, shows in a message at the bottom centre of the window, with a check when it worked and a warning sign when it did not. Up to three messages show at once, newest at the bottom. On Android the same messages show at the bottom of the screen.

## Tags

A tag is a word after `#` in the note, such as `#ideas`, or an entry in the note's tags. Tags nest with `/`: `#work/plans` is inside `#work`. Tags ignore case. `#2026` and `C#` are not tags: a tag needs a letter, and must follow a space or an opening bracket.

- **Add a tag to the note's tags:** **Add a Tag to This Note**, or the tag field in the note's Metadata tab (`tag or area/tag`).
- **See a tag's notes:** choose it in the sidebar's **Tags** section, choose a tag in the note's Metadata tab, or ⌘-click a #tag in the text. [Search](/docs/search/) opens with its **Tag** filter set and lists every note with that tag, or a tag inside it, newest first. Type to search those notes by their words. With several notebooks, Search starts on the tag's notebook.
- **Rename or merge a tag:** the pencil beside a tag in the Tags section (**Rename or Merge**) changes it in every note, nested tags and notes in Trash included. Renaming to a tag that already exists merges the two. A tag's description goes with it, and the message at the bottom of the window offers **Undo**, as on the Tags page, which also deletes tags.

### The Tags page

The **Tags** page is where you describe and tidy your tags: a table with a row for each tag, its note count, and what it means. Open it with **Tags** in the sidebar's top row (the # button after Search), the button at the end of the sidebar's **Tags** title (**Open the Tags Page**, shown when you point at the title), or **Tags** in the command palette. With several notebooks it has a table for each, in the sidebar's order, and each change stays in its own notebook. Only the tables scroll: the title and filter stay at the top, and as you scroll through a notebook's table, its name, its **Merge…** and **Delete…** buttons and its column headings stay above its rows.

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

Quick Access holds up to 20 notes you want at hand. **Pin to Quick Access** in a note's ⋯ menu adds it, or drag a note onto the section. Right-click one for **Open in New Tab**, **Open in New Window** or **Remove from Quick Access**. A note's right-click menu in your notebooks' tree starts with the same two Open items. On the Mac the [menu bar icon](/docs/install/mac/#the-menu-bar-icon) lists them too.

Quick Access is not the same as a pinned [tab](/docs/install/mac/#tabs): Quick Access is one list for all your devices, and a pinned tab belongs to the window it is in. A tab's right-click menu has **Pin to Quick Access**, and dragging a tab onto Quick Access pins its note; neither pins the tab.

## Recent Notes and the Inbox

- **Recent Notes** lists the notes opened on this device or changed anywhere, newest first: ten unless you change it with **−** and **+** in **Settings → Sidebar** (1 to 50). **Switch to a Recent Note** (⌘E) steps through them.
- **Inbox** is the top-level folder that [quick capture](/docs/quick-capture/) files new notes in. Penmoss uses a folder called Inbox if you have one, and makes it otherwise.

## The sidebar

**Settings → Sidebar** (**Sidebar Settings** in the command palette) shows your sidebar itself, made small, beside its settings, and it changes as you change them:

- **Shortcuts**: which buttons the sidebar's top row shows. Search is always there; **Tags**, **Today**, **This Week**, **Graph** and **Commands** show unless you switch them off. A hidden shortcut still works from its keys and the command palette.
- **Sections**: **Quick Access** (with **Show Notebook Names**, which labels each pinned note with its notebook), **Recent Notes** (with how many notes it lists), **Notebooks**, **Calendar** and **Tags**, each with a switch to show or hide it. Drag a section by its handle to move it, or press Alt+↑ or Alt+↓ on its row. You can also drag a section by the handle on its title in the sidebar.

⌘\\ folds the sidebar to a rail of icons and back. On the rail, Send Feedback and Settings stay at its foot, Settings at the very bottom, and the tab strip starts with Back and Forward.

## The note in Settings

**Settings → Note** shows the note you opened last, made small, beside its settings, and under it **Fonts at Real Size**: a note's title, headings, text and code at the size Penmoss draws them, each with its font and size. The preview changes as you change these settings:

- **Layout**: **Note Width**, the theme's width or **Full Window**, and **Note Panel**, whether a note's panel starts **Closed** or **Open** (marked **This Mac**, as it is kept on each device). Each note then remembers its own.
- **Title Bar Buttons**: which of Full Width, Markdown Source, the two copies, Copy Agent Reference, Pin to Quick Access, Open in New Window, Move to Folder and Move to Trash have a button at the end of the tab strip (beside the title in a note window). Each is also in the note's ⋯ menu.
- **Under the Title** and **In the Status Bar**: click a detail to show or hide it there: notebook, folder, created, edited, tags, words, characters, reading time and token count. The status bar does not offer tags, which you edit under the title or in the Metadata tab.
