# The default notebook's paths are unchanged (T43, A751)

`apps/server/test/mirror-default-paths.test.ts` builds one vault with no notebooks (duplicate
titles, a hand-made `README.md`, a Windows device name, a leading dot, a title and a folder name
too long for a Windows clone, case-only sibling folders, links to an ambiguous title) and mirrors
it to a fake GitHub.

1. **The fixture is today's paths.** The scenario was run on `origin/main` at `9d941ab5` (before
   T43) on 28 Oct 2026, and the paths it assigned were recorded as `pathsBefore` in the test.
   The same file run there: `assigns the paths it assigned before notebooks` passes.
2. **The branch assigns the same paths.** On `codex/t43-notebooks` both tests pass: the same
   paths and links, and after a notebook named `QDK` (with a `Work` folder and notes titled
   `Meeting` and `Plan`, names the default notebook already uses) is made and filled, the
   default notebook's repository is byte for byte the same, with no new commit.
3. **The second test has teeth.** Run on `origin/main`, `changes nothing in its repository when
   a notebook is made…` fails: without notebooks the "notebook" is an ordinary folder, and its
   notes are published to the default repository.

```text
origin/main 9d941ab5:
 ❯ test/mirror-default-paths.test.ts (2 tests | 1 failed)
     × changes nothing in its repository when a notebook is made, filled and mirrored beside it
 Tests  1 failed | 1 passed (2)

codex/t43-notebooks:
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

Every mirror test from before T43 (`mirror.test.ts`, `mirror-recovery.test.ts`,
`mirror-paths.test.ts`, `mirror-tree.test.ts`) passes unchanged on the branch.
