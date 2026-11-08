---
title: More devices
description: Open the same notebook on another Mac, an Android phone or the command line.
---

This page shows you how to open a notebook you already have on another device, so your notes are on all of them.

A notebook lives in its repository, so every device that can reach the repository can open it. Each device keeps its own copy, works offline, and syncs through the repository. Edits made on two devices at once, even offline, are merged: see [Sync, offline and merging](/docs/help/sync/).

## Another Mac

1. [Install Penmoss](/docs/install/mac/) and open it.
2. Choose **Open a notebook you already have**. (With a notebook open already: **Settings → Git Notebooks → Add a Git Notebook…**.)
3. Pick the repository, then the folder that holds the notebook (Penmoss shows its name), or choose **Type an Address** and paste the repository's address.
4. Choose **Open Notebook**.

The second Mac needs its own git sign-in for the repository, as the first did: see [Your first notebook](/docs/first-notebook/#before-you-start).

## Android

The phone syncs over HTTPS with a personal access token. SSH is not supported on Android.

1. Make a token for the notebook's repository. On GitHub: a fine-grained token for that repository only, with **Contents: Read and write** and **Metadata: Read**. Give it an expiry date you will remember.
2. [Install Penmoss](/docs/install/android/) and open it.
3. Under **Add a git notebook**, fill in:
   - **Repository**: its HTTPS address, such as `https://github.com/you/notes`.
   - **Branch**: the notebook's branch, `main` unless you chose another.
   - **Directory**: the folder that holds the notebook, if it is not at the top of the repository.
   - **Personal access token**: the token from step 1.
4. Tap **Add**.

The notebook is listed on the first screen; tap it to open it. To make a new notebook from the phone, point **Add** at an empty private repository: the app then asks for a **Notebook name**.

When the token expires, the notebook stops syncing and says why. Save a new one in **Settings → Git Notebooks** (**Save Token**).

## The command line

The `penmoss` command can open the same notebook in a terminal. On a Mac with the app, [install the command](/docs/reference/cli/#install) and the app's notebooks are already there. Elsewhere:

```sh
penmoss notebook add https://github.com/you/notes.git --name notes
```

See [The penmoss CLI](/docs/reference/cli/).

## Which settings follow you

- **The notebook's own settings** go with it to every device: its time zone and its daily and weekly templates.
- **Your app settings** (theme, sidebar, shortcuts and the rest) are kept in your **Primary Notebook** (on Android, the **Journal notebook**), so another device that opens the same notebook gets them too.
- **This device only:** which notebook is primary, the Mac's window settings (compact title bar, menu bar icon, the capture hotkey), and Auto-Update.
