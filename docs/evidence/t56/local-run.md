# T56: export and check against a local server (3 Nov 2026)

The built CLI (`task cli:build`, `node packages/cli/dist/penmoss.js`) against the Worker under
`wrangler dev --local` (state in a scratch directory, `e2e.env`), signed in with DEV_AUTH's session
token as `PENMOSS_TOKEN`. The workspace was seeded through the REST API: folders `Work/Plans`, a
tagged note with a comment thread, a note linking to it with a picture and an 11 MB PDF, a note in
Trash, today's daily note, and settings (time zone, a symbol, two notes in Quick Access). The
repository is a bare one on this machine (`file://…/personal.git`); the privacy confirmation was
typed at a terminal (`script`). Paths are shortened to `…`. This is not Ryan's workspace.

```text
$ penmoss export-personal file://…/personal.git --dry-run
penmoss: Reading the folder tree…
Dry run: nothing was written. Exporting would make the git notebook “Personal” in file://…/personal.git with one commit:
  commit        “Penmoss: 4 notes [skip ci]”, 11 files, 0.0 MB
  files         3 markdown, 1 attachments, 7 Penmoss logs
  notes         4 (1 in Trash)
  folders       5
  settings      2 for this device, 1 the notebook’s own (time zone, templates); 1 symbol, 2 notes in Quick Access
  attachments   1 (0.0 MB)
  writer        “Personal workspace import”, 8 client ids in its actor file
  Filed 1 note the tree did not (in Trash: where each was deleted from; others at the top level).
  1 attachment over the 10 MB a git notebook takes, NOT in the notebook (download them from the server before it goes):
    c69a292fa3958db53e448b517fbb09d60a56a0d8ee28c63058843fbcce06a771.pdf (10.5 MB), in 01M6J7AN595AMTKF1PZS2TKYAX
(exit 0)

$ git -C personal.git branch --list
(no branch: nothing written)
$ penmoss export-personal file://…/personal.git --name personal --confirm-private
penmoss: Reading the folder tree…
penmoss: Only a person can confirm that a repository is private, typed at this machine's terminal, and penmoss has none here (an agent, a script or a pipe). Nothing was changed.
(exit 7)

$ penmoss export-personal file://…/personal.git --name personal --confirm-private
penmoss: Reading the folder tree…
Penmoss cannot check whether a repository on this machine is private.
Every repository holding notes must be private. Is file://…/personal.git private? Type "private" to confirm: private
penmoss: Penmoss cannot check whether a repository on this machine is private.
Exported the personal workspace into the git notebook “Personal” (file://…/personal.git), commit e169f23:
  notes         4 (1 in Trash)
  folders       5
  settings      2 for this device, 1 the notebook’s own (time zone, templates); 1 symbol, 2 notes in Quick Access
  attachments   1 (0.0 MB)
  writer        “Personal workspace import”, 8 client ids in its actor file
  Filed 1 note the tree did not (in Trash: where each was deleted from; others at the top level).
  1 attachment over the 10 MB a git notebook takes, NOT in the notebook (download them from the server before it goes):
    c69a292fa3958db53e448b517fbb09d60a56a0d8ee28c63058843fbcce06a771.pdf (10.5 MB), in 01M6J7AN595AMTKF1PZS2TKYAX
Check it with: penmoss verify-personal personal

$ git log --oneline main
e169f23 Penmoss: 4 notes [skip ci]
$ git ls-tree -r --name-only main
.penmoss/actors/01M6J7D00WN4G9C07A9P4R433Z.json
.penmoss/notebook.json
.penmoss/notes/01M6FB9800JPVW5Z560JDTVGWA/01M6J7D00WN4G9C07A9P4R433Z.yjs
.penmoss/notes/01M6J7AMT5XQAB45QPCC6YZNR0/01M6J7D00WN4G9C07A9P4R433Z.yjs
.penmoss/notes/01M6J7AN595AMTKF1PZS2TKYAX/01M6J7D00WN4G9C07A9P4R433Z.yjs
.penmoss/notes/01M6J7AN6QTQ2W9E3E98QTHC6M/01M6J7D00WN4G9C07A9P4R433Z.yjs
.penmoss/workspace/01M6J7D00WN4G9C07A9P4R433Z.yjs
Index.md
Journal/2026/11/2026-11-03.md
Work/Plans/Garden.md
attachments/c9880aff1980992d9f1969638642174d0cfb59db28ea2336eda8648b0b07d6e9.png
$ git show main:.penmoss/notebook.json
{
  "id": "01M6J7CZX7994T530DZENF7N9Y",
  "name": "Personal",
  "format": 2,
  "renderVersion": 3,
  "salt": ""
}
$ git show main:Work/Plans/Garden.md
---
id: 01M6J7AMT5XQAB45QPCC6YZNR0
title: Garden
created: 2026-11-03T20:48:34-06:00
updated: 2026-11-03T20:48:34-06:00
tags: [home/garden]
---

Tomatoes and beans.

- [ ] Order seeds

$ penmoss verify-personal personal
penmoss: Reading the folder tree…
personal matches the personal workspace: 4 notes and 2 attachments checked, no differences.
  Not in the notebook, over 10 MB (as the export listed): c69a292fa3958db53e448b517fbb09d60a56a0d8ee28c63058843fbcce06a771.pdf
(exit 0)

$ penmoss append 01M6J7AMT5XQAB45QPCC6YZNR0 --text 'Changed in the notebook.' --notebook personal
Appended to 01M6J7AMT5XQAB45QPCC6YZNR0 · Appended · +1 −0 line · version 4
(exit 0)
$ penmoss verify-personal personal
penmoss: Reading the folder tree…
personal differs from the personal workspace in 2 places (4 notes checked):
  01M6J7AMT5XQAB45QPCC6YZNR0 markdown (- server, + notebook):
      - updated: 2026-11-03T20:48:34-06:00
      + updated: 2026-11-03T20:50:50-06:00
      + 
      + Changed in the notebook.
  01M6J7AMT5XQAB45QPCC6YZNR0 body (- server, + notebook):
      + 
      + Changed in the notebook.
  Not in the notebook, over 10 MB (as the export listed): c69a292fa3958db53e448b517fbb09d60a56a0d8ee28c63058843fbcce06a771.pdf
penmoss: 2 differences found.
(exit 1)
```
