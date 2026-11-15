---
title: Search
description: Find notes by their words, and on the Mac by their meaning, with filters for notebook, folder, tag and date.
---

This page shows you how to search your notes: by the words in them, by what they are about on the Mac, and with filters.

Open search with **Search Notes…** (⌘⇧F), or **Search** in the sidebar. To jump to a note by its title instead, use **Quick Open Note…** (⌘P).

Search runs on your device, over every notebook you have open, offline too. The status line says how many results it found.

Press Enter on a result, or click it, to open it in the tab you are in; in the Mac app, a note open in another tab already switches to that tab. There, ⌘↩ (or ⌘-click) opens it in a [new tab](/docs/install/mac/#tabs) behind that one, and ⇧⌘↩ in a new tab in front; Quick Open and the command palette do the same.

## Search by words

Type words to find the notes that have all of them. The last word matches the start of a word as you type, and a word can match inside a longer one: `moss` finds Penmoss.

| You type        | It finds                                                             |
| --------------- | -------------------------------------------------------------------- |
| `garden plan`   | Notes with both words                                                |
| `"garden plan"` | Notes with that phrase                                               |
| `gard*`         | Words that start with `gard` (2 letters or more)                     |
| `-draft`        | Leaves out notes with `draft`; `-"old plan"` leaves out a phrase     |
| `title:garden`  | Notes with `garden` in the title; `title:"garden plan"` for a phrase |

## Filters

Under the search box you can narrow the results by **Notebook** (with more than one), **Folder**, **Tag**, and when the note was **Updated**: Any Time, Past Day, Past Week, Past Month or Past Year.

With the search box empty, a **Folder**, **Tag** or **Updated** filter lists every note it matches, newest first. Choosing a tag elsewhere in Penmoss (the sidebar's **Tags** section, a note's tags, the Tags page) opens Search this way, with **Tag** set.

With more than one notebook and Notebook on **All Notebooks**, Folder lists every notebook's folders under the notebook's name, and picking one switches Notebook to that folder's notebook; Tag lists the tags of every notebook.

With one notebook chosen, Folder lists that notebook's folders after two choices: **All Folders (This Notebook)** searches every folder of the chosen notebook, and **All Folders (All Notebooks)** puts Notebook back to All Notebooks and searches every folder of every notebook.

## Semantic search

On the Mac, search also finds notes by what they are about, not only the words they use: a search for `holiday plans` can find a note about a trip to Lisbon.

- The results for your words show at once. Half a second after you stop typing, or when you press Enter, they are replaced by results for your words and their meaning together.
- A note found by its meaning alone is marked **≈**, and opens at the section that matched.
- While Penmoss is still reading your notes, the results say how many notes meaning covers so far.
- When meaning cannot answer, a **Words only** label says why, such as the model still downloading.

It uses EmbeddingGemma, a small language model that runs on your Mac. Penmoss downloads it once, about 219 MB from Hugging Face, the first time it starts. Your notes never leave the Mac: the model and its index of your notes stay in `~/.penmoss`. The Gemma Terms of Use apply to the model.

**Settings → Semantic Search** (once called Search by Meaning) has the switch, **Semantic Search**, then what it is doing (Not downloaded, Downloading, Indexing, Ready) with a progress bar and how many notes of your open notebooks it has read, then the model, its size and its licence. A notebook you remove from the Mac leaves that count. Turning it off stops it at once, and search goes back to words only; the model stays on the Mac, so turning it on again needs no download. **Delete Model…**, in the model's row, frees the space: it asks first, naming the size, then deletes the model and its index from the Mac and turns Semantic Search off. Turning it on again downloads the model again. The same setting applies to agents' `penmoss` on this Mac: see [MCP tools](/docs/reference/mcp/#search_notes).

One program at a time reads your notes for meaning, normally the Mac app, which reads every notebook it has open. While the app is closed, an agent's `penmoss mcp` reads its own notebook instead, and the app takes over again when it opens. If another copy of Penmoss on the Mac is doing it, Settings → Semantic Search says how many notes wait, since Semantic Search can miss them until then.

The Android app searches by words only.
