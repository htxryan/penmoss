# Public release audit (T80.1, 7 Nov 2026)

Before Penmoss goes public (D64, #237), everything that would become public was checked for secrets and personal data. No secret value and no personal address is repeated here.

## What was scanned

| What                                   | How                                                                                                                                          | Result                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 536 commits on every branch and tag    | gitleaks 8.30.1, default rules, all of `git log --remotes --tags`                                                                            | 43 findings, all false positives (below); no live secret           |
| 422 more commits held only by PR refs  | the same, over `refs/pull/*/head` (GitHub keeps these for every pull request, deleted branches included)                                     | 15 findings, the same false positives                              |
| The tree                               | `task audit:secrets`                                                                                                                         | clean with `.gitleaks.toml`                                        |
| Files ever committed                   | names matching keys, keystores, certificates, `.env` and `.dev.vars`                                                                         | none; only `.dev.vars.example` and test env files with fake values |
| 1,352 screenshots (tree, history, PRs) | on-device text recognition (macOS Vision), then a search for distinctive words from the titles and text of the notes in Ryan's real notebook | none found: the screenshots show test notebooks and fixtures       |
| Text in every commit, PR ref and issue | the same words, Ryan's personal email addresses, private repository names, hostnames and IP addresses                                        | see Findings                                                       |
| 172 issues, their comments and images  | the same search; each of the 3 uploaded images opened and looked at                                                                          | one personal photo (Findings 1)                                    |

## gitleaks findings: all false positives

Each is allowed in `.gitleaks.toml` by its shape, never by file, so a real secret in the same files still fails:

- ULIDs (note, comment and submission ids) in tests and the Android bridge contract;
- two fake 12-byte comment-anchor keys (`0123…`, `89ab…`) in the bridge contract and its tests;
- keyboard shortcut strings (`Alt+Shift+…`) in the E2E key helpers and the editor's drag handle;
- the repository's own name passed as an argument in a feedback test;
- the relay's PEM parser, which matches the text of a private key header (no key is in the file).

In history only: a Cloudflare Access application audience tag in the removed `apps/server/wrangler.jsonc`. It identifies the Access application and is not a credential.

## Findings and what was done

| #   | Finding                                                                                                                                  | Decision (Ryan, 7 Nov 2026)                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | An in-app feedback test issue had a personal photo attached as a screenshot                                                              | Issue deleted                                                               |
| 2   | Ryan's two personal email addresses in 3 files of the tree, about 20 files of history and 3 issues                                       | Replaced in the tree in this change; history does not go public (finding 4) |
| 3   | Names of Ryan's private repositories, his partner's first name, his city and his Mac's hostname, in history, fixtures and one screenshot | Accepted in the tree; history does not go public                            |
| 4   | History itself: the items above, and GitHub keeps every pull request's commits, so rewriting `main` here would not hide them             | **A fresh public history in a new repository** (D65): see below             |

## The new repository (D65)

This repository becomes `htxryan/penmoss-private`, private, with its history, issues and pull requests. A new public `htxryan/penmoss` starts from one commit of the audited tree. The open issues are transferred to it; closed issues and pull requests stay in the private one.

## Keeping it clean

`task audit:secrets` runs in `task check`, and so in CI. `task audit:test` checks that the scan fails on a planted token or private key and passes the reviewed false positives. gitleaks is pinned and its download checked against its release's SHA-256 (`scripts/gitleaks.sh`).
