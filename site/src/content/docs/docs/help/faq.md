---
title: FAQ
description: Short answers to common questions about Penmoss, git, agents, devices and costs.
---

This page answers the questions people ask most about Penmoss.

## Is Penmoss free?

Yes. It is open source under the MIT licence, with no account and no subscription. Your git host may charge for its own plans; GitHub's free plan includes private repositories.

## Do I need GitHub?

No. On the Mac, any host that `git push` on your Mac can reach works: GitLab, Bitbucket, your own server. GitHub adds a few conveniences: Penmoss can list your repositories, make a private one, and sign you in. On Android, the host must accept HTTPS with a personal access token.

## Do I need to know git?

No. Penmoss commits and syncs for you. You need git on your Mac signed in to your host, or [Sign in with GitHub](/docs/first-notebook/#sign-in-with-github).

## Can I read my notes without Penmoss?

Yes. Each note is a markdown file in your repository, readable on your host's website, in any editor, or in another markdown app. See [Notebooks on disk](/docs/reference/notebook-format/).

## Can I edit the markdown files directly?

Not usefully: Penmoss writes the files from its own history, and the next sync puts a hand-edited file back. Edit in Penmoss, with the [CLI](/docs/reference/cli/), or through an agent.

## Can I keep notes in a code repository?

Yes. Give the notebook a **Directory**, such as `docs/notes`, and Penmoss writes only there. Its commits say `[skip ci]`.

## What happens if I edit the same note on two devices?

Both edits are kept, with no conflict copies. See [Merging](/docs/help/sync/#merging).

## Is there an iPhone app, or Windows or Linux?

Not yet. Penmoss is for Mac and Android. The `penmoss` CLI can be built from source for other systems.

## Which agents work with Penmoss?

Any agent on your Mac that can run a local MCP server, or run shell commands: Claude Code, Codex, OpenCode and others. See [Connect an agent](/docs/agents/connect/).

## Can an agent delete my notes?

An agent can move a note to Trash, which you can undo. Only you can delete a note for good, in the app. Every agent edit is in History, where you can revert it.

## Are my notes encrypted?

They are not end-to-end encrypted: your git host can read the files in your repository, as it can any file there. Keep the repository private. See [Privacy and security](/docs/help/privacy/).

## Why does search by meaning download a model?

The model runs on your Mac so that your notes never leave it. It is downloaded once, about 219 MB. You can turn it off in **Settings → Search by Meaning**.

## My daily note has the wrong date

Set the notebook's time zone in **Settings → Daily Notes**. A new notebook starts on America/Chicago.

## How do I report a bug or ask for a feature?

**Help → Send Feedback** in the app. See [Send feedback](/docs/help/feedback/).
