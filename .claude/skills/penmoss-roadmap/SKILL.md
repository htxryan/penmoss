---
name: penmoss-roadmap
description: Review and add to the Penmoss roadmap, which lives in Linear's Penmoss team (PEN) and is reached through the Linear MCP, with each plan in a Claude artifact. Use when Ryan asks what's on the roadmap or what's next, wants the roadmap reviewed or tidied, or wants an idea, feature, bug or chore added to the roadmap, backlog or Triage, even if he never says "roadmap" or "Linear".
---

# The Penmoss roadmap

The roadmap is the set of open issues in Linear's **Penmoss** team (key `PEN`, Redhale workspace), reached through the Linear MCP (tools such as `list_issues`, `get_issue`, `save_issue`, `list_comments`, `save_comment`, `list_projects`). Every plan is a Claude artifact, linked from its parent issue or project. Nothing else holds the roadmap. The repository has no plan, task list or roadmap file, and `scripts/no-plan-files.sh` fails `task lint` if one appears (W13, W14 and D66 in `docs/decisions.md`). The working rules are in `docs/development.md` (Planning).

## Where things live

| What                                                 | Where                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open work, ideas, bugs                               | Issues in the PEN team.                                                                                                                                                                                                                  |
| Work across several pull requests                    | A Linear project in PEN: Software factory, Public release, Search by meaning. Its description links the plan.                                                                                                                            |
| A plan (spec, decisions, diagrams, prototype, tasks) | A Claude artifact. The parent issue or project links to it, each task is a sub-issue, and each sub-issue links to its task's anchor (`…/artifact/<id>#t3`) as a link attachment.                                                         |
| Public intake                                        | GitHub issues on `htxryan/penmoss`, from people outside and from Send feedback (label `in-app feedback`). Linear's GitHub sync copies each one into PEN Triage. Don't file roadmap items on GitHub.                                      |
| Evidence                                             | In the pull request, or as a comment on the issue.                                                                                                                                                                                       |
| Old history                                          | Closed GitHub issues and pull requests in `htxryan/penmoss-private`. PEN-9 to PEN-60 were GitHub `htxryan/penmoss` #1–#52 (PEN-(n+8)), labelled `Migrated`. A bare `#n` in an older decision or doc means penmoss-private's issue or PR. |

## Statuses and labels

| Status      | Meaning                                                     | Who moves an issue here                       |
| ----------- | ----------------------------------------------------------- | --------------------------------------------- |
| Triage      | An idea or report, not yet weighed.                         | Agents file new items here; the GitHub sync.  |
| Backlog     | Accepted, to do one day, not started.                       | Ryan, or an agent when he asks.               |
| Todo        | Next up.                                                    | Ryan only.                                    |
| In Progress | Being built on a branch.                                    | The session building it.                      |
| In Review   | The pull request is open.                                   | The session building it, or Linear's PR link. |
| Done        | Merged. A merged pull request with `Fixes PEN-<n>` does it. | Automatic.                                    |
| Canceled    | Dropped.                                                    | Ryan, or an agent when he asks.               |
| Duplicate   | Same as another issue.                                      | Ryan, or an agent when he asks.               |

- **Kind** (workspace labels): `Feature`, `Bug`, `Improvement`, `Chore`.
- **`Blocked`:** waiting on Ryan or on something outside the issue, with a comment saying what. Only Ryan removes it.
- **`in-app feedback`:** filed from Send feedback. **`Migrated`:** came over from GitHub.
- **Priority** is Linear's own field (Urgent, High, Medium, Low; none means not set). **Estimates** are points: 2 small, 3 medium, 5 large.
- The importer's old labels (`feature request`, `size-*`, `phase-*`, `factory`, `checkpoint`) are retired. Don't use them.

## Rules

- **New items go to Triage.** When Ryan says "add it to the backlog" or "put it on the roadmap", he means Triage, unless he names the Backlog status itself.
- **Never set Todo, In Progress, In Review or Done** on an issue you aren't building yourself, and never remove `Blocked`.
- **Ask before** canceling, closing or marking an issue a duplicate, and before rewriting an issue someone else wrote. Read the issue's current description before you edit it, and prefer `patch` edits over replacing the whole description.
- **A new item gets enough detail to understand it, and no more.** Write the idea, why it fits Penmoss and the open questions. Leave out the plan: no task breakdown, no acceptance criteria, no design. Planning happens later, in an artifact.
- **Plans go only in artifacts.** Don't write planning files into the repository, not even in a scratch folder inside it. Draft long descriptions in the session's scratchpad.
- **No secrets, tokens or note content** in an issue. Issues that came from GitHub may be public there too.

## Review the roadmap

1. **List the open issues** in a few `list_issues` calls with `team: "PEN"` and `fields: ["id", "title", "status", "labels", "priority", "estimate", "project", "parentId", "updatedAt"]`, one call per state: `In Review`, `In Progress`, `Todo`, `Backlog`, `Triage` (limit 250). Then `list_projects` with `team: "PEN"` for the projects and their state.
2. **Read what Ryan asked about:** `get_issue` (with `includeRelations: true` for blockers), `list_comments` for the latest. To see a plan, read its artifact with the Artifact tool (`action: "read"`), never by fetching the page.
3. **Report briefly.** Lead with what's moving (In Review, In Progress, Todo, Blocked and why). Then what's queued (Backlog by priority, grouped by project), then what's waiting in Triage, newest first, with any new GitHub intake called out. Then the loose ends, for example:
   - possible duplicates;
   - Backlog items with no priority or estimate;
   - sub-issues not attached to their parent, or not in their parent's project;
   - a parent or project whose sub-issues are all Done but which is still open;
   - In Progress with nothing updated in two weeks;
   - Triage items older than two weeks.
4. **Recommend a next step** if he asked what's next: the order you'd pick and why, based on dependencies (blocked-by relations), priority, and what unblocks the most.
5. **Fix nothing on your own.** List the changes you'd make, such as moving issues, re-labelling, attaching sub-issues or closing finished parents, and make them only once Ryan says yes.

## Add to the roadmap

1. **Check for a duplicate:** `list_issues` with `team: "PEN"`, `query: "<keywords>"` and `includeArchived: true`. If one exists, show it and ask whether to add to it (a comment) instead.
2. **Pick the shape:**
   - **An idea or a feature** gets the label `Feature` (or `Improvement` for a change to something that exists). Its description starts with a line saying where it came from and that it's in Triage, then has:
     - `## The idea`: what changes for the user;
     - `## Why it fits Penmoss`: the code, decisions or issues it builds on;
     - `## Questions for triage`.

     Use `relatedTo` for related issues. A placeholder can be only a few lines.

   - **A bug** gets the label `Bug` and the headings what happened, steps to reproduce, where, the version and the system.
   - **A chore or an internal fix** gets the label `Chore`.
   - **Work that is ready to build** uses the team's **Task** template (`template: "Task"`): goal, acceptance criteria, automated and manual checks, evidence. Use it only when Ryan says the item is ready and agreed. It still goes to Triage unless he names another status.

3. **Create it** with `save_issue`: `team: "PEN"`, `title`, `description` (Markdown), `labels`, `state: "Triage"`, and `project` or `parentId` if Ryan says where it belongs. A title names the outcome, as in "Searchable images: find notes by the text inside their pictures".
4. **Report** each new issue as a link (`PEN-<n>`), with its status and labels. Several items Ryan asks for together are one issue each, unless he asks for them combined.

## Plan an item

Planning isn't this skill's job. When Ryan wants to plan an item, plan it with him as an artifact (the `workflow-define-and-plan` skill's flow), then:

- the parent issue, or a new PEN project for multi-PR work, links the artifact as a link attachment and in a `**Plan:** [<title>](<artifact url>)` line near the top of its description;
- each task becomes a sub-issue in PEN with the Task template, linking its task's anchor.

`workflow-*` skills that still say "GitHub issues" mean PEN issues here (W14). When the plan changes, update the artifact first: re-read the live version, merge, and republish to the same URL.
