# T56: Ryan's workspace into `htxryan/penmoss-notebook` (4 Nov 2026, 03:30 UTC)

Run by Claude at Ryan's request, with the CLI built from PR #197, signed in to
`https://api.penmoss.app` with the "Claude Code" agent token (read, write; every note) as
`PENMOSS_TOKEN`, and GitHub's token from `gh` as `PENMOSS_GIT_TOKEN` (the private check). Tokens
are not shown.

Before the export, `main` held one commit, `1576ca6 Penmoss: 0 notes`: an empty notebook added
from this Mac about ten minutes earlier. It is kept on the branch `backup-empty-notebook`, and
`main` was started again, since the import needs an empty target with the workspace's unsalted
ids (A1021).

## Dry run

```text
Dry run: nothing was written. Exporting would make the git notebook “Personal” in https://github.com/htxryan/penmoss-notebook.git with one commit:
  commit        “Penmoss: 51 notes [skip ci]”, 113 files, 1.4 MB
  files         36 markdown, 23 attachments, 54 Penmoss logs
  notes         51 (15 in Trash)
  folders       9, and 2 deleted folders kept for Restore
  settings      9 for this device, 0 the notebook’s own (time zone, templates); 9 symbols, 1 note in Quick Access
  attachments   23 files (1022 KB)
  writer        “Personal workspace import”, 260 client ids in its actor file
  Filed 11 notes the tree did not (in Trash: where each was deleted from; others at the top level).
```

No attachment is over 10 MB, and none is missing.

## Export

The first push was refused by GitHub (GH007: the commit would publish a private email). The
export ran again with the GitHub no-reply address as the author, and the notebook now commits
with it (`penmoss notebook set personal --author-email …@users.noreply.github.com`).

```text
Exported the personal workspace into the git notebook “Personal” (https://github.com/htxryan/penmoss-notebook.git), commit 34fc013:
  notes         51 (15 in Trash)
  folders       9, and 2 deleted folders kept for Restore
  settings      9 for this device, 0 the notebook’s own (time zone, templates); 9 symbols, 1 note in Quick Access
  attachments   23 files (1022 KB)
  writer        “Personal workspace import”, 260 client ids in its actor file
  Filed 11 notes the tree did not (in Trash: where each was deleted from; others at the top level).
Check it with: penmoss verify-personal personal
```

## Check

The first check found one difference:

```text
personal differs from the personal workspace in 1 place (51 notes checked):
  01M6W78V00Q1V3475BH4D5P5W3 markdown (- server, + notebook):
      - updated: 2026-10-24T19:52:26Z
      + updated: 2026-11-08T00:00:00Z
penmoss: 1 difference found.
```

That note is the daily note for 8 November, made on 24 October and in Trash. The file in the
repository had the server's `updated`. The notebook's read of a note (what local agents get, and
what the check compares) wrote `updated` from the list's sort time, which is never before
`created`. It now writes the note's last change, as the file and the server do (A1024). With that
fix:

```text
personal matches the personal workspace: 51 notes and 23 attachments checked, no differences.
```
