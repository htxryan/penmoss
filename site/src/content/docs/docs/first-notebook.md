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

Penmoss asks one thing per screen, in three steps. **Back** at the bottom left goes to the screen before.

1. Open Penmoss. It shows **Welcome to Penmoss**. Choose **Get Started**.
2. **Create or Open Notebook:** choose **Start a New Notebook**, then **Continue**.
3. **Pick Repository:** choose one, then **Continue**.
   - **Create New Repo** (recommended): Penmoss makes a private, empty repository on GitHub for you. Give the **Notebook name** (shown in the sidebar); the repository's name follows it until you change it. The repository goes under your own account; **Change** picks one of your organisations instead. Choose **Make Notebook**. If the name is taken, Penmoss says so and offers another.
   - **Use Existing Repo:** Penmoss lists your GitHub repositories, empty ones first, each with the notebooks in it beneath. Choose an empty repository you made. One that holds other files, such as code, asks which folder the notebook goes in (**Pick Folder**): its **Root**, a folder, or a new one (**Add Folder**).
   - **Paste a URL:** for another host, or a repository GitHub doesn't list. Make an empty private repository with no README on your host, copy its address (SSH, such as `git@github.com:you/notes.git`, or HTTPS), paste it in **Repository URL** and choose **Continue**.
4. **Name Your Notebook:** Penmoss offers the repository's name. Change it if you like (you can rename it any time) and choose **Make Notebook**.

Penmoss then sets the notebook up and runs its first sync, showing each step. When it is done, Penmoss opens the new notebook on a note called **Welcome to Penmoss**, a short guide you can delete.

If the first sync fails, Penmoss says why. The notebook is on your Mac already, and nothing is lost: **Retry** tries again, and **Open Anyway** opens it, and the note's bottom bar shows how the sync stands until one works.

If the repository you pick already holds a notebook, Penmoss offers to open it instead of making a second one.

### More options

When you use an empty repository or paste a URL, **More Options** lets you set:

- **Branch:** `main` unless you say otherwise. A branch that does not exist yet is made by the first push.
- **Folder:** a folder of the repository to keep the notebook in, such as `docs/notes` in a code repository. Penmoss then writes only inside that folder.

## Sign in with GitHub

Penmoss first tries git's own GitHub sign-in on your Mac (GitHub Desktop's, the GitHub CLI's or the Keychain's). If there is none, **Sign In to GitHub** offers Penmoss's own:

1. Choose **Sign In with GitHub**. Penmoss shows a code and opens github.com in your browser.
2. Enter the code there (**Copy Code** copies it) and approve Penmoss.
3. Back in Penmoss, choose **Continue**, then create or pick the repository as above.

**Paste a URL Instead** skips GitHub altogether.

Penmoss keeps the sign-in in the Mac's Keychain. It uses it to list your repositories, to sync notebooks it added from github.com over HTTPS, and to [send feedback](/docs/help/feedback/). **Settings → Status → GitHub Token** shows whose it is, and **Sign Out** forgets it.

If you prefer git's own sign-in, install the GitHub CLI and run `gh auth login`, then `gh auth setup-git`, then **Try Again** in Penmoss.

If GitHub refuses the sign-in (it ran out, or the repositories are in an organisation that uses single sign-on and hasn't authorised Penmoss), Penmoss says so and offers to sign in again. If git itself is missing, Penmoss asks you to install the Mac's command-line tools: run `xcode-select --install` in Terminal.

## A personal access token

For an HTTPS host that needs a token, open **Settings → Notebooks**, choose the notebook and save the token under **Access** (**Save Token**). Penmoss keeps it in the Keychain, hands it to git only when it syncs, and never shows it again. **Forget Token** removes it.

On GitHub, a fine-grained token for that one repository needs **Contents: Read and write** (GitHub adds **Metadata: Read** itself).

## Open a notebook you already have

To open a notebook Penmoss made before, on this Mac or another device, choose **Open an Existing Notebook** instead of Start a New Notebook. Penmoss lists your GitHub repositories with the notebooks in each beneath it: choose **Open** beside the one you want, or **Paste a URL Instead** for a repository on another host. The most recently pushed repositories are looked into at once; the arrow beside another shows what it holds, and the filter box finds a repository or notebook by name. A repository that holds several notebooks asks which one (**Pick Notebook**). See [More devices](/docs/more-devices/).

## Commits and your email

Penmoss commits as git's `user.name` and `user.email`. If GitHub keeps your email private and blocks pushes that show it, a push is refused with the error GH007. Give the notebook its own **Commit email** in **Settings → Notebooks** (under **Commits**): your GitHub no-reply address, `…@users.noreply.github.com`, from GitHub's Settings → Emails.

## Next

- [The editor](/docs/editor/): write your first notes.
- [More devices](/docs/more-devices/): add the notebook on your phone or another Mac.
- [How agents work](/docs/agents/): give an agent the notebook.
