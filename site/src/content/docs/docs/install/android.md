---
title: The Android app
description: "Sideload Penmoss on an Android phone, check its signing certificate and update it, then what is different on Android: the editor's formatting bar, notebooks, background sync, capture and the owner check."
---

This page shows you how to install Penmoss on an Android phone from GitHub and check that the app is the one we signed, then how Penmoss works on the phone: the editor, notebooks, syncing in the background, capture and the phone's own settings.

Penmoss runs on Android 17 or later. It is not in Google Play yet: you install the APK yourself (sideloading). The phone runs the same editor and the same notebook engine as the Mac, so notes look the same and merge the same way.

## Download and install

1. On the phone, download [Penmoss.apk](https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.apk) from the latest stable release on GitHub.
2. Open the downloaded file. The first time, Android asks you to allow your browser to install apps: allow it, then go back and open the file again.
3. Google Play Protect may warn that it does not know the developer. Choose **Install anyway**.
4. Open **Penmoss** from the app drawer.

The app opens on **Welcome to Penmoss**. **Get Started** walks you through three short steps: start a new notebook or open one, pick its repository (Penmoss can create a private one on GitHub for you), and name it. See [Add a notebook on Android](/docs/more-devices/#android).

You can also put the APK where the phone can reach it (a cloud drive, or an email to yourself) and open it there, or install it from a computer with `adb install Penmoss.apk`.

## Check the signing certificate

Every release of Penmoss for Android is signed with the same certificate. Android itself checks this when you update: it refuses an update signed with a different certificate, so once you have a genuine copy, later updates must come from us too.

To check a download before you install it, use `apksigner` from the Android SDK build tools on a computer:

```sh
apksigner verify --print-certs Penmoss.apk
```

It prints the certificate's SHA-256 digest. Compare it with the digest of a copy you already trust, for example one installed earlier, or one downloaded from a different network.

To check the file itself, every release lists the SHA-256 of each file in `SHA256SUMS.txt`:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

## Updates

The Android app does not update itself. To update, download `Penmoss.apk` from the latest release again and open it: it installs over the copy you have and keeps your notebooks.

If you have Penmoss from Google Play (its internal testing track, by invitation only), Google Play updates it, as it does your other apps. A `Penmoss.apk` doesn't install over a Play copy, nor the other way round: to switch, remove Penmoss first and add your notebooks again.

Builds from the Alpha channel use the same app and certificate, so an Alpha build installs over a stable one, and the next stable release installs over it again once its version is higher. See [Updates and the Alpha channel](/docs/help/updates/).

## Notebooks

The first screen lists your notebooks; each opens in a screen of its own, with its Home, folders and search. On a notebook's Home, **☰** (or a swipe from the left edge) opens the menu with the Mac sidebar's places as two rows of tiles: **Home**, **Search**, **Today**, **This Week**, **Journal**, **All Notes**, **Tags** and **Graph**; your **Notebooks**, to switch to another, and **All Notebooks**; then **Quick Capture**, **Trash**, **Settings** and **Send Feedback**. The **⋮** menu has **New Folder**, **Reorder Folders** and which of Home's sections show. The gear at the top opens **Settings**, which has a **Search Settings** field (a match opens its screen scrolled to the setting, marked for a moment) and five groups: **Look and Feel** (Appearance, Home, Symbols), **Writing** (Daily Notes, Quick Capture, Keyboard Shortcuts), **Notebooks**, **Agents** (Agent Activity) and **This Phone** (Storage, GitHub, What’s New).

Under **Notebooks**, each notebook has a row with its sync state; tap it for the notebook's page, which has three tabs:

- **Overview:** its sync state with **Sync Now**, **Open Notebook**, its **Badge** (its colour, and a letter, a number or an icon from **Choose Icon…**, as on the Mac; see [Notebook badges](/docs/organise/#notebook-badges)), **Make Primary**, how many **Notes** it has, **Copy Settings…** (with two notebooks or more), and **Remove from This Phone…**, which asks for your fingerprint, face or screen lock first.
- **Sync:** what the last sync said, **Wi-Fi Only**, how soon it pushes (**Push After**, 12 seconds by default) and how often it pulls (**Pull Every**, 1 minute by default).
- **Git:** the **Personal Access Token** (**Save Token**, **Forget Token**), **Sign Commits**, and a **Commit Name** and **Commit Email** for this notebook.

**All Notebooks** lists them all, with **+ Add Notebook** (the first run's steps, from **Create or Open Notebook**), and:

- **Between Notebooks:** **Primary Notebook** first (where Today, This Week and captures go on this phone, and where your app settings are kept), then **Keep Settings in Step** (each change to the Primary Notebook's settings goes to your other notebooks a moment later; this phone's choice), **Copy Tags When Copying Notes**, and **Copy Settings…**: pick **From** and **To** and choose **Copy Settings** to replace the other notebook's settings, once. Quick Access stays as it is. Keep Settings in Step and Copy Settings… show with two notebooks or more.
- **Commits From This Phone:** the name and email the phone commits as, and its signing key.
- **Background Sync:** the last background sync and the next.

The phone syncs over HTTPS with a token; SSH remotes are not supported.

## Signing commits

If your branch requires signed commits, turn on **Sign Commits** on the notebook's **Git** tab. **Signing Key** shows the phone's public key: **Copy** it and add it on GitHub as an SSH key with the key type **Signing Key**. The commit email must be a verified email of that GitHub account. **Make a New Key** and **Make an Ed25519 Key** replace the key.

## The editor

The formatting bar above the keyboard has **Insert a Block**, **Bold**, **Italic**, **Inline Code**, **Text Style** (headings, quote, code block, strikethrough, highlight), the three lists, **Link**, **Symbol**, indent and outdent, **Add a Picture**, **Attach a File**, Undo and Redo, and **Block Actions** (Move Up, Move Down, Duplicate Block, Delete Block). In a table it adds buttons for rows and columns.

Select text for **Comment**, **Copy as Markdown**, **Copy as rich text** and **Paste as plain text**. The note's ⋮ menu has the rest: **View Metadata**, **Comments**, **Version History**, **Local Graph**, **Markdown Source**, the copy commands, **Copy Agent Reference**, **Find in Note**, **Word Count**, **Pin to Quick Access**, **Move to Folder…** and **Move to Trash**.

With a hardware keyboard, the [shortcuts](/docs/shortcuts/) work with Ctrl for ⌘. **Settings → Keyboard Shortcuts** lists and changes them.

## Syncing in the background

While a notebook is open, the phone pulls when you open it and every minute, and pushes 12 seconds after you stop typing. When you leave the app with changes not pushed, it pushes soon after.

With the app closed, Android syncs your notebooks about every 15 minutes, the shortest interval Android allows. It may wait longer:

- not while the battery is low or battery saver is on;
- not on mobile data with Data Saver on;
- on mobile data, it skips notebooks set to **Wi-Fi only** and fetches less;
- in Doze, when the phone has been still for a while.

**Settings → All Notebooks → Background Sync** shows the last run and the next.

## Capture

Share text, links and pictures to Penmoss from any app, or add the **Capture** tile to Quick Settings or the **Capture** widget to your home screen. See [Quick capture](/docs/quick-capture/#on-android).

A long press on the app icon offers **Quick Capture**, **New Note**, **Today's Note**, **Search Notes** and your two most recent notes.

## The owner check

Removing a notebook, Delete for Good and restoring a version first ask for your fingerprint, face or screen lock ("Confirm it's you"). Android checks it on the phone; Penmoss never sees it. With no screen lock set, these changes are refused until you set one.

## Storage and pictures from the web

**Settings → Storage** shows the space **Files and Pictures in Notes** and **Pictures From the Web** take on the phone; **Clear…** empties the saved web pictures after asking. **Load Pictures From the Web** is **Always**, **On Wi-Fi** or **Never**: loading one lets its website see your phone's IP address. Files over 10 MB upload on Wi-Fi only.

## GitHub

**Settings → GitHub** shows the GitHub account the phone is signed in to, with **Sign Out**. **Sign In with GitHub** shows a code to enter at github.com/login/device; **Use a Token Instead…** takes a personal access token. The account is used for **Send Feedback**, and to list and create repositories when you add a notebook; a notebook added that way syncs with its token. A notebook's own token is on its **Git** tab.

## What's new

**Settings → What’s New** names the version you have and how it updates (by Google Play, or with a newer `Penmoss.apk`), with **Open Source Notices**, the licences of the open source software Penmoss includes, then shows what changed in it and, under **Earlier Versions**, in earlier ones, grouped as **New**, **Improved** and **Fixed**. Only changes that reach Android are listed. An Alpha build lists every change since the last stable release, each with its build. The phone fetches the notes from GitHub when you open the screen and after an update, at most once an hour, and keeps them for offline. Until it has them, the screen links to the [Releases page](https://github.com/htxryan/penmoss/releases).

After you install a newer version, a message at the foot of the screen says **Updated to …** once, with **What’s New**, if that version has notes for Android.

## What the phone does not have

Compared with the Mac: note windows, Keep on Top, the menu bar icon and hotkey, SSH remotes, semantic search, and the sidebar's Calendar and Tags sections. Agents connect on a Mac, not on the phone.

## Uninstall

Uninstall Penmoss as you would any app. Your notes stay in your repositories; the phone's copies, tokens and signing key go with the app.
