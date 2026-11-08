---
title: Links and the graph
description: Link notes with wikilinks, see what links to a note, and explore your notes as a graph.
---

This page shows you how to link notes to each other, find what links to a note, and see your notes and their links as a graph.

## Link to a note

Type `[[` and start typing a note's title. Pick it from the list, or choose **Create "…"** to make a new note with that title. Type `#` after the title to link to a heading in it.

| You type                 | You get                                           |
| ------------------------ | ------------------------------------------------- |
| `[[Garden plan]]`        | A link to the note                                |
| `[[Garden plan#Spring]]` | A link to its Spring heading                      |
| `[[Garden plan\|plans]]` | A link that reads "plans"                         |
| `![[Garden plan]]`       | The note [embedded](/docs/editor/#embedded-notes) |

Click a link, or move into it and press Enter, to open the note. On the Mac, ⌥-click opens it in a [window of its own](/docs/mac/#note-windows). A link to a note that does not exist yet is shown as such, and clicking it makes the note.

Links stay inside one notebook.

### Renaming

Penmoss keeps track of the note a link points to, not just its title. When you rename a note, every link to it shows the new title, and the markdown of the notes that link to it is rewritten on the next sync.

## Backlinks

The note panel's **Metadata** tab (⌘⌥⇧I) lists the notes that link to this one:

- **Linked mentions:** notes with a link or an embed of this note; embeds are marked **Embeds**.
- **Unlinked mentions:** notes that mention its title without a link.

## The local graph

The note panel's **Local Graph** tab shows this note, the notes it links to and the notes that link to it. **Depth** goes from 1 to 3 steps. Click a note to open it, or **Open Full Graph** for the whole notebook.

## The graph

**Graph** (⌘⇧G, or **Graph** in the sidebar) shows every note as a dot and every link as a line. You can show **All Notes** or only the notes around the open one, limit it by **Depth**, **Folder** or **Tag**, show **Tags as Nodes**, and show or hide **Unlinked Notes**. Click a note to open it.
