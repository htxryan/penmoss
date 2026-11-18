---
title: More devices
description: Open the same notebook on another Mac, an Android phone or the command line.
---

This page shows you how to open a notebook you already have on another device, so your notes are on all of them.

A notebook lives in its repository, so every device that can reach the repository can open it. Each device keeps its own copy, works offline, and syncs through the repository. Edits made on two devices at once, even offline, are merged: see [Sync, offline and merging](/docs/help/sync/).

## Another Mac

1. [Install Penmoss](/docs/install/mac/) and open it.
2. Choose **Get Started**, then **Open an Existing Notebook** and **Continue**.
3. Penmoss lists your GitHub repositories with the notebooks in each beneath it. Choose **Open** beside the notebook. To use a repository on another host, choose **Paste a URL Instead** and paste its address.

With a notebook open already, use **Settings → All Notebooks → Add Notebook…** instead. It shows the same steps, from **Create or Open Notebook** (see [More notebooks on this Mac](/docs/first-notebook/#more-notebooks-on-this-mac)).

The second Mac needs its own git sign-in for the repository, as the first did: see [Your first notebook](/docs/first-notebook/#before-you-start).

## Android

The phone syncs over HTTPS; SSH is not supported on Android.

1. [Install Penmoss](/docs/install/android/) and open it.
2. Tap **Get Started**, choose **Open an Existing Notebook** and tap **Continue**.
3. Sign in to GitHub: **Sign In with GitHub** shows a short code to enter at github.com/login/device, or **Use a Token Instead** takes a personal access token (a classic token with the **repo** scope lists every repository; a fine-grained one, only those it names, with **Contents: Read and write**).
4. Pick the notebook under its repository and tap **Open**. Penmoss clones it and stays on **Opening …** until the first sync, then opens the notebook.

For a repository on another host, choose **Paste a URL** instead: its HTTPS address, a token for it, and under **More Options** the **Branch** and **Folder**.

To make a new notebook from the phone, choose **Start a New Notebook**: **Create New Repo** makes a private repository on GitHub for it. Later, **+ Add Notebook** on the first screen or in **Settings → All Notebooks** shows the same steps. To add a notebook from another GitHub account, such as a work one, tap the account at the top of the list of repositories and choose another, or **Add Another Account**; each notebook syncs as the account you added it with. See [GitHub on Android](/docs/install/android/#github).

When the token expires, the notebook stops syncing and says why. Save a new one on the notebook's **Git** tab in Settings (**Save Token**).

## The command line

The `penmoss` command can open the same notebook in a terminal. On a Mac with the app, [install the command](/docs/reference/cli/#install) and the app's notebooks are already there. Elsewhere:

```sh
penmoss notebook add https://github.com/you/notes.git --name notes
```

See [The penmoss CLI](/docs/reference/cli/).

## Which settings follow you

- **The notebook's own settings** go with it to every device: its time zone and its daily and weekly templates.
- **Your app settings** are kept in your **Primary Notebook**, so another device that opens the same notebook gets them too.
- **Your Macs and your phones each have their own** appearance (mode, theme, fonts, text size), sidebar or Home layout and keyboard shortcuts: a change on a Mac reaches your other Macs, and a change on a phone your other phones. Until you change one on a platform, it shows what you had before ([Settings](/docs/reference/settings/#kept-apart-for-your-macs-and-your-phones)).
- **This device only:** which notebook is primary, the Mac's window settings (compact title bar, menu bar icon, the capture hotkey), and everything under **This Mac** in Settings: Semantic Search, the GitHub sign-in and Updates.
