---
title: MCP tools
description: The 35 tools Penmoss's local MCP server gives an agent, with their arguments, and how search, edits and conflicts work.
---

This page lists every tool the MCP server gives an agent, what each one does and the arguments it takes. To connect an agent, see [How agents work](/docs/agents/).

`penmoss mcp --notebook <name>` is an MCP server over stdio for one notebook. It has 35 tools, no resources and no prompts. It works on the notebook's clone on your Mac, as that clone's writer. Required arguments are marked \*.

## Search and read

### search_notes

Searches the notebook. Arguments: `query`\*, `mode` (`hybrid`, `full-text` or `semantic`), `folderId`, `tag`, `updatedAfter`, `updatedBefore`, `limit` (1 to 50, 10 by default).

- **`hybrid`** (the default) finds notes by their words and by their meaning. Each result says how it was found (`foundBy`) and, when found by meaning, the heading of the passage that matched. While Penmoss is still reading the notes, results say how many notes meaning covers.
- **`full-text`** finds notes by their words.
- **`semantic`** finds notes by meaning alone.

Meaning needs the model on this Mac, and **Settings → Search by Meaning** on when the server starts (or `penmoss models fetch`). Without it, `hybrid` searches words only and says so, and `semantic` is refused with `semantic_unavailable`.

### Note ids

A tool's `id` is a note's 26-character id or its short id, such as `K7QD-9HTF2CXA`, in any case (see [Point an agent at a note](/docs/agents/#point-an-agent-at-a-note)). `search_notes`, `list_recent` and `list_folder` give each note's `shortId` beside its `id`. A short id from another notebook is refused, with the `penmoss mcp --notebook` command that reads it when your Mac has that notebook.

### Reading

| Tool             | What it does                                                                      | Arguments                                  |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `read_note`      | The note's title, tags, headings, body and `baseVersion`, in parts of about 60 KB | `id`\*, `heading`, `offset`                |
| `list_folder`    | A folder's folders and notes, in the app's order                                  | `folderId` or `path`                       |
| `list_tags`      | Every tag with its count and description, or the notes with one tag               | `tag`                                      |
| `describe_tags`  | What tags mean: each tag's description, count and its parents' descriptions       | `tags` (a parent includes its nested tags) |
| `get_backlinks`  | The notes that link to this one, and those that mention it                        | `id`\*                                     |
| `list_recent`    | Notes, newest first, with daily and weekly notes marked                           | `limit` (1 to 100)                         |
| `get_daily_note` | Today's note (or a date's, or the week's), made from the template if needed       | `date`, `period` (`daily` or `weekly`)     |

### What tags mean

Each tag can have a description you write on the [Tags page](/docs/organise/#describe-your-tags). `describe_tags` gives each tag with its `description` (`null` when it has none), how many `notes` have it or a tag nested under it, and the descriptions of the tags above it (`ancestors`, outermost first), so an agent reading `#project/penmoss` also learns what `#project` means. With no `tags`, it gives every tag; with `tags`, those and the tags nested under each. Agents read descriptions but can't change them.

## Write

| Tool             | What it does                                                        | Arguments                                                                                     |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `create_note`    | Makes a note. The same call within 10 minutes returns the same note | `title`, `markdown`, `tags`, `folderId`, `idempotencyKey`                                     |
| `append_to_note` | Adds markdown at the end, or at the end of a section                | `id`\*, `markdown`\*, `heading`, `baseVersion`                                                |
| `update_section` | Replaces, or adds to, the section under a heading                   | `id`\*, `heading`\*, `markdown`\*, `baseVersion`\*, `mode` (`replace`, `prepend` or `append`) |
| `replace_text`   | Finds and replaces text                                             | `id`\*, `find`\*, `replace`\*, `baseVersion`\*, `all`, `scope` (`text` or `markdown`)         |
| `set_properties` | Changes the title or the tags                                       | `id`\*, `title`, `tags`, `baseVersion`                                                        |
| `tag_note`       | Adds and removes tags                                               | `id`\*, `add`, `remove`, `baseVersion`                                                        |
| `rename_tag`     | Renames a tag in every note, or merges it into another              | `from`\*, `to`\*, `merge`                                                                     |
| `move_note`      | Moves a note to a folder, or the top level (`null`)                 | `id`\*, `folderId`\*                                                                          |
| `trash_note`     | Moves a note to Trash                                               | `id`\*                                                                                        |
| `restore_note`   | Takes a note out of Trash                                           | `id`\*                                                                                        |
| `attach_file`    | Adds a file of at most 10 MB, sent as base64                        | `id`\*, `name`\*, `data`\*, `alt`, `heading`                                                  |

### Edits and conflicts

`read_note` returns a `baseVersion`. Pass it to an edit, and the edit goes ahead only if that part of the note is still as it was read. If it changed, nothing changes, and the result says so with the text as it was and as it is now. Read the note again and redo the edit on the new text; never resend the old edit. The server remembers the last 8 versions of each note it read.

## Folders

| Tool              | What it does                                             | Arguments                                                       |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `create_folder`   | Makes a folder                                           | `name`\*, `parentId`, `parentPath`                              |
| `rename_folder`   | Renames a folder                                         | `folderId`\*, `name`\*, `expectedName`                          |
| `move_folder`     | Moves a folder, or reorders it                           | `folderId`\*, `parentId`, `expectedParentId`, `before`, `after` |
| `set_folder_sort` | Sets a folder's sort order                               | `folderId`\*, `sortMode`\* (`manual`, `alpha` or `modified`)    |
| `delete_folder`   | Moves a folder to Trash; its notes move up to its parent | `folderId`\*                                                    |

## History

| Tool              | What it does                                                            | Arguments                    |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `get_history`     | The note's versions, or one version's markdown and the lines it changed | `id`\*, `versionId`, `limit` |
| `save_version`    | Saves a version now: a commit, pushed with the next sync                | `id`\*                       |
| `restore_version` | Brings back a version's content as a new change                         | `id`\*, `versionId`\*        |
| `revert_edit`     | Undoes what one version changed, keeping later edits                    | `id`\*, `versionId`\*        |

## Settings

| Tool           | What it does                                                      | Arguments       |
| -------------- | ----------------------------------------------------------------- | --------------- |
| `get_settings` | The notebook's `timeZone`, `template.daily` and `template.weekly` |                 |
| `set_settings` | Changes them                                                      | `set`\*, `base` |

## Comments

| Tool                      | What it does                                                              | Arguments                                                |
| ------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `list_comment_threads`    | A note's threads, or with `sentToMe: true` the threads sent to this agent | `id`, `status` (`open`, `resolved` or `all`), `sentToMe` |
| `read_comment_thread`     | One thread; a thread sent to this agent is marked seen                    | `id`\*, `threadId`\*                                     |
| `create_comment_thread`   | Starts a thread on a quoted passage, or the whole note                    | `id`\*, `body`\*, `quote`, `occurrence`                  |
| `reply_to_comment_thread` | Replies; a thread sent to this agent is marked replied                    | `id`\*, `threadId`\*, `body`\*                           |
| `resolve_comment_thread`  | Resolves a thread                                                         | `id`\*, `threadId`\*                                     |

With `--channel`, the server is also a Claude Code channel: a thread you send to the session arrives in it as a message with the quoted passage, the note's title and the thread's ids. See [Comments to agents](/docs/agents/comments/).

## Syncing

The server syncs when it starts, commits and pushes a minute after edits settle, and pulls every two minutes. With `--channel` it checks the repository every 10 seconds and pushes its own writes at once. When it stops with edits not pushed, it pushes them in the background. Nothing it does deletes a note for good.
