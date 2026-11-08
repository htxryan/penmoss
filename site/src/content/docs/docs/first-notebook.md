---
title: Your first notebook
description: Make a private git repository, and keep your notes in it with Penmoss on the Mac.
---

This page shows you how to make your first notebook on the Mac: a private git repository that holds your notes, synced by the Mac's own git.

A **git notebook** is a git repository, or a folder in one, that Penmoss keeps notes in. Your notes are markdown files there, readable without Penmoss. There is no Penmoss account: Penmoss signs in to your git host the way `git` on your Mac already does.

## Before you start

- **A git host.** GitHub works best: Penmoss can list your repositories and make a new one for you. Any host that `git push` on your Mac can reach works too, such as GitLab, Bitbucket or your own server.
- **git on your Mac, signed in to that host.** If `git push` works in Terminal for a repository of yours, Penmoss can sync it. That means an SSH key, or a credential helper such as the macOS Keychain or GitHub Desktop's. With no git sign-in for GitHub, Penmoss can sign you in itself (below).

:::caution[Keep it private]
Penmoss does not check who can read your repository. Make it **private** to keep your notes private.
:::

## Make the notebook

1. Open Penmoss. It shows **Welcome to Penmoss** with two choices.
2. Choose **Start a new notebook**.
3. Pick the repository:
   - **With GitHub:** Penmoss lists your repositories, most recently pushed first, with empty ones at the top. Pick an empty private one, or fill in **Create a private repository on GitHub**: a **Notebook name** (shown in the sidebar), a **Repository name** and an **Owner** (you or one of your organisations).
   - **Another host, or to type it:** choose **Type an Address**. Make an empty private repository with no README on your host, copy its address (SSH, such as `git@github.com:you/notes.git`, or HTTPS) and paste it in **Repository address**.
4. Name the notebook and choose **Make Notebook**. Penmoss sets it up in the repository at its first sync.

Penmoss opens the new notebook on a note called **Welcome to Penmoss**, a short guide you can delete.

### More options

Under **More Options** you can set:

- **Branch:** `main` unless you say otherwise. A branch that does not exist yet is made by the first push.
- **Directory:** a folder of the repository to keep the notebook in, such as `docs/notes` in a code repository. Penmoss then writes only inside that folder.

## Sign in with GitHub

If git on your Mac is not signed in to GitHub, Penmoss says so and offers **Sign In with GitHub**:

1. Choose **Sign In with GitHub**. Penmoss shows a code and opens github.com in your browser.
2. Enter the code there (**Copy Code** copies it) and approve Penmoss.
3. Back in Penmoss, pick or create the repository as above.

Penmoss keeps the sign-in in the Mac's Keychain. It uses it to list your repositories, to sync notebooks it added from github.com over HTTPS, and to [send feedback](/docs/help/feedback/). **Settings → Status → GitHub Token** shows whose it is, and **Sign Out** forgets it.

If you prefer git's own sign-in, install the GitHub CLI and run `gh auth login`, then `gh auth setup-git`.

## A personal access token

For an HTTPS host that needs a token, open **Settings → Git Notebooks**, choose the notebook and save the token under **Access** (**Save Token**). Penmoss keeps it in the Keychain, hands it to git only when it syncs, and never shows it again. **Forget Token** removes it.

On GitHub, a fine-grained token for that one repository needs **Contents: Read and write** (GitHub adds **Metadata: Read** itself).

## Open a notebook you already have

To open a notebook Penmoss made before, on this Mac or another device, choose **Open a notebook you already have** instead, then pick the repository and the folder that holds it (or type its address). See [More devices](/docs/more-devices/).

## Commits and your email

Penmoss commits as git's `user.name` and `user.email`. If GitHub keeps your email private and blocks pushes that show it, a push is refused with the error GH007. Give the notebook its own **Commit email** in **Settings → Git Notebooks** (under **Commits**): your GitHub no-reply address, `…@users.noreply.github.com`, from GitHub's Settings → Emails.

## Next

- [The editor](/docs/editor/): write your first notes.
- [More devices](/docs/more-devices/): add the notebook on your phone or another Mac.
- [How agents work](/docs/agents/): give an agent the notebook.
