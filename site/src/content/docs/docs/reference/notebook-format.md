---
title: Notebooks on disk
description: What Penmoss writes in your repository, how notes are stored as markdown, and what it does with files it did not write.
---

This page shows you what a notebook looks like in your repository: the markdown files you can read anywhere, the files Penmoss keeps beside them, and what happens to files you add or edit yourself.

## What is in the repository

A notebook lives at the top of its branch, or in the folder you gave as its **Directory**. Penmoss writes only inside that folder.

```
notes/                       the notebook's folder (or the top of the repository)
├── Garden plan.md           a note
├── Projects/
│   └── Release checklist.md a note in a folder
├── Journal/
│   └── 2026/
│       ├── 11/2026-11-07.md a daily note
│       └── Weekly/2026-W45.md a weekly note
├── attachments/
│   └── 3f2a…c9.png          pictures and files
└── .penmoss/
    ├── notebook.json        the notebook's id, name and format
    ├── actors/              one file per device or agent that writes
    ├── workspace/           the folder tree, Trash, tag descriptions and settings
    └── notes/               each note's edit history
```

## Notes are markdown

Each note is a `.md` file named after its title, in the folder it is filed in. A note with no title is `Untitled.md`. Two notes whose titles would give the same file name get the end of their id added, such as `Meeting (7KQ2MXH).md`. A file keeps its name until the note is renamed.

The file starts with frontmatter that Penmoss writes:

```yaml
---
id: 01JC4Z8Q6V3M2N7K5T1R9XWB4D
title: Garden plan
created: 2026-11-07T09:14:03-06:00
updated: 2026-11-07T10:02:41-06:00
tags: [garden, home/outside]
---
```

`tags` lists the tags set on the note; tags written in the text, such as `#ideas`, stay in the text. Daily and weekly notes also have `type: daily` or `type: weekly`.

Links between notes are written by file name, as `[[Garden plan]]`, or `[[File name|Title]]` when the file name differs from the title, so other markdown tools can follow them. Comments are not in the markdown: see below.

### Attachments

Pictures and files go in `attachments/`, named by the SHA-256 of their content, so the same picture added twice is stored once. Notes link to them by a relative path, such as `![Seedlings](../attachments/3f2a…c9.png)`. A [drawing](/docs/editor/#drawings) is two of them, its Excalidraw scene and an SVG picture of it, written as the picture linked to the scene: `[![Drawing](../attachments/9c1e…b2.svg)](../attachments/41d7…0a.excalidraw)`.

## The `.penmoss` folder

The markdown files are what you read; the `.penmoss` folder is what Penmoss syncs. Each device and agent keeps a log of its own edits there, which is how edits made offline on two devices merge with no git conflict: each writer only adds to its own files. Penmoss then writes the markdown from the merged result.

- `notebook.json` holds the notebook's id, name and format version.
- `actors/` names each writer: a device such as your Mac, or an agent such as Claude Code.
- `workspace/` holds the folder tree, sort orders, Trash, what each tag means, the notebook's settings (time zone and templates), your app settings and agents' sessions.
- `notes/<id>/` holds each note's history of edits and its comment threads.

Leave the `.penmoss` folder as it is: it is the notebook.

## Files you did not write

- **Editing a note's `.md` file by hand does not change the note.** Penmoss writes the markdown from its own history, so the next sync puts the file back as it was and says so. Edit notes in Penmoss, with the CLI, or through an agent.
- **A copy of a note's file** (the same `id` in its frontmatter, somewhere else) is left alone and reported.
- **Other files** in the folder, such as a README or your own markdown, are never touched or deleted. Penmoss does not show them as notes.
- **Outside the notebook's folder**, in a code repository for example, Penmoss writes nothing.

## Commits

Each sync makes one commit, such as `Penmoss: 2 notes [skip ci]`, with your git identity (or the notebook's own commit name and email) and a trailer that names the writer:

```
Penmoss-Writer: 01JC4Z… (device "Penmoss for Mac")
```

An agent's commits say `(agent "Claude Code")`. `[skip ci]` keeps CI from running on a code repository for note changes. Commits are signed when your git configuration signs commits.

## Notes in Trash

A note in Trash has no `.md` file. Its history stays in `.penmoss`, so you can restore it. **Delete for Good** removes the note from the notebook; the repository's git history still has it, as it has every version.
