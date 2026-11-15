---
name: penmoss-notes-to-linear
description: Turn one or more Penmoss notes (feedback, roadmap or idea notes, given as links, reference text or note ids) into Linear issues in the Penmoss team's Triage, one issue per item, with screenshots uploaded, then write each issue's PEN id back into the note as a link at the start of its bullet. Use when Ryan pastes a Penmoss note reference ("Reference note via Penmoss MCP ... read_note {"id":...}") and asks to capture, file, triage or add its items to Linear or the roadmap.
---

# Penmoss notes to Linear issues

Takes notes Ryan wrote in Penmoss (feedback lists, roadmap ideas) and files each item as a PEN issue in Triage. Issue shape, labels and statuses follow the `penmoss-roadmap` skill ("Add to the roadmap"); read it first.

## 1. Read the notes

- Each note arrives as a reference: `Reference note via Penmoss MCP (penmoss mcp --notebook "<name>") tool read_note {"id":"<id>"}`, where the id is a short id such as `K7QD-9HTF2CXA` (PEN-69) or, in older references, a 26-character id after a title and a notebook. Both work with `read_note`. Use the **local** Penmoss MCP (`penmoss-local`), not the hosted `penmoss` one at `api.penmoss.app`, which may not resolve.
- If `penmoss-local` isn't registered, register it for the clone that holds the note, then start a new session to load it: `claude mcp add --scope user penmoss-local -- /Applications/Penmoss.app/Contents/MacOS/Penmoss --penmoss-cli mcp --notebook <clone>`. The `<clone>` is the clone's own name from `Penmoss --penmoss-cli notebook ls` (for example `personal-agent`). A notebook's display name such as "Personal" can match several clones and is refused as ambiguous.
- Until the MCP loads, use the same CLI from Bash: `Penmoss --penmoss-cli cat <id> --notebook <clone> --body` (add `--json` for the `baseVersion`). Call it through a shell function, since zsh won't split a command held in a variable. A note id missing from one clone may be in another: try each clone.
- Never read or edit the Yjs files under `~/.penmoss/git/`, and never run `strings` on them. They go stale, and the running app owns them.
- One top-level list item is one issue. Nested bullets stay inside their parent's issue. Skip empty items and a title line.

## 2. Make the issues

1. Check for duplicates with `list_issues` (`team: "PEN"`, `query`, `includeArchived: true`). If one exists, show it and ask whether to comment on it instead.
2. Create one issue per item with `save_issue`: `team: "PEN"`, `state: "Triage"`, a kind label (`Bug`, `Feature`, `Improvement` or `Chore`), a title that names the outcome, and the description shape from `penmoss-roadmap`. Start the description with "From Ryan's note "<title>" (<date>), item <n>. In Triage." Keep Ryan's wording and add nothing he didn't ask for. Put real doubts under "Questions for triage".
3. Several items are several calls; send them in parallel.

## 3. Upload the screenshots

An image in an item belongs on that item's issue, not just a mention of it.

1. Find the file named in the note (`attachments/<sha256>.png`). It isn't in the app's local folders; fetch it from the notebook's GitHub repo, the clone's remote in `~/.penmoss/notebooks.json`: `gh api -H "Accept: application/vnd.github.raw" repos/<owner>/<repo>/contents/attachments/<file> > file.png`. Check with `file` that you got a PNG and not a JSON error. If it's missing, the note may not be pushed yet; say so rather than guessing.
2. One file at a time: `prepare_file_upload` (filename, contentType, exact size), `curl -X PUT --data-binary @file` with every returned header, within 60 seconds. Then put the returned `markdown` in the issue description with `save_issue` and a `patch`, or use `prepare_attachment_upload` plus `create_attachment_from_upload` to list it under Resources.
3. If a file can't be found, tell Ryan which issue lacks which image. Don't claim it was uploaded.

## 4. Link the issues back in the notes

Start each item's bullet with the id as a link: `[PEN-123](https://linear.app/redhale/issue/PEN-123/<slug>) The text of the item...`, using the `url` from `save_issue`. Edit with `replace_text` (MCP) or `Penmoss --penmoss-cli edit <id> --notebook <clone> --replace <start of bullet> --with "[PEN-n](url) <start of bullet>"`, once per bullet; a conflict (exit 5) means read again and redo it. Check the result with `cat --body`. If nothing can write the note, give Ryan the exact link prefix per bullet.

## 5. Report

List each new issue as a link with its kind, grouped by note. Name anything not done: images not uploaded, notes not updated, duplicates found.
