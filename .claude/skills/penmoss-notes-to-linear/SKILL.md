---
name: penmoss-notes-to-linear
description: Turn one or more Penmoss notes (feedback, roadmap or idea notes, given as links, reference text or note ids) into Linear issues in the Penmoss team's Triage, one issue per item, with screenshots uploaded, then write each issue's PEN id back into the note as a link at the start of its bullet. Use when Ryan pastes a Penmoss note reference ("Read it with ... read_note {"id":...}") and asks to capture, file, triage or add its items to Linear or the roadmap.
---

# Penmoss notes to Linear issues

Takes notes Ryan wrote in Penmoss (feedback lists, roadmap ideas) and files each item as a PEN issue in Triage. Issue shape, labels and statuses follow the `penmoss-roadmap` skill ("Add to the roadmap"); read it first.

## 1. Read the notes

- Each note arrives as a reference: a title, a notebook and `read_note {"id":"<id>"}`. Call `read_note` with that id on whichever Penmoss MCP is connected (the local `penmoss mcp --notebook "<name>"`, or the relay notebook).
- If the note isn't found, the MCP is looking at the wrong or a stale notebook. Search by title with `search_notes` before giving up. If the local MCP failed to connect (for example `api.penmoss.app` didn't resolve), say so.
- Last resort, read-only: the Mac app keeps each note as a Yjs document in `~/.penmoss/git/<localId>/state/notes/<noteId>.yjs`. Decode it in the scratchpad with `yjs` (`Y.applyUpdate`, then `doc.getXmlFragment('prosemirror').toString()`); never run `strings` on it, which scrambles the order. Never write to these files: the running app owns them.
- One top-level list item is one issue. Nested bullets stay inside their parent's issue. Skip empty items and a title line.

## 2. Make the issues

1. Check for duplicates with `list_issues` (`team: "PEN"`, `query`, `includeArchived: true`). If one exists, show it and ask whether to comment on it instead.
2. Create one issue per item with `save_issue`: `team: "PEN"`, `state: "Triage"`, a kind label (`Bug`, `Feature`, `Improvement` or `Chore`), a title that names the outcome, and the description shape from `penmoss-roadmap`. Start the description with "From Ryan's note "<title>" (<date>), item <n>. In Triage." Keep Ryan's wording and add nothing he didn't ask for. Put real doubts under "Questions for triage".
3. Several items are several calls; send them in parallel.

## 3. Upload the screenshots

An image in an item belongs on that item's issue, not just a mention of it.

1. Find the file named in the note (`attachments/<sha256>.png`). Look in the notebook's `attachments/` folder under `~/.penmoss/git/<localId>/`, then in its GitHub repo (`gh api repos/<owner>/<notebook>/contents/attachments/<file>`). A note edited minutes ago may not be pushed yet; say so rather than guessing.
2. One file at a time: `prepare_file_upload` (filename, contentType, exact size), `curl -X PUT --data-binary @file` with every returned header, within 60 seconds. Then put the returned `markdown` in the issue description with `save_issue` and a `patch`, or use `prepare_attachment_upload` plus `create_attachment_from_upload` to list it under Resources.
3. If a file can't be found, tell Ryan which issue lacks which image. Don't claim it was uploaded.

## 4. Link the issues back in the notes

Start each item's bullet with the id as a link: `[PEN-123](https://linear.app/redhale/issue/PEN-123/<slug>) The text of the item...`, using the `url` from `save_issue`. Edit with `replace_text` or `update_section` and the `baseVersion` from `read_note`; on a conflict, read again and redo it. If the connected MCP can't write the note, give Ryan the exact link prefix per bullet instead of editing a file by hand.

## 5. Report

List each new issue as a link with its kind, grouped by note. Name anything not done: images not uploaded, notes not updated, duplicates found.
