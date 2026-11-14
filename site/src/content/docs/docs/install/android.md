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

The app opens on a screen that says Penmoss keeps your notes in git notebooks, with a form to add one. See [Add a notebook on Android](/docs/more-devices/#android).

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

Builds from the Alpha channel use the same app and certificate, so an Alpha build installs over a stable one, and the next stable release installs over it again once its version is higher. See [Updates and the Alpha channel](/docs/help/updates/).

## Notebooks

The first screen lists your notebooks; each opens in a screen of its own, with its Home, folders and search. **Settings → Notebooks** adds, configures and removes them:

- **Sync Now**, **Wi-Fi only**, **Sign commits**, how soon it pushes (**Push after**, 12 seconds by default) and how often it pulls (**Pull every**, 1 minute by default).
- **Personal access token** (**Save Token**, **Forget Token**), and a **Commit name** and **Commit email** for this notebook.
- **Remove from This Phone**, which asks for your fingerprint, face or screen lock first.
- **Commits from this phone:** the name and email the phone commits as.
- **Journal notebook:** where Today, This week and captures go on this phone.

The phone syncs over HTTPS with a token; SSH remotes are not supported.

## Signing commits

If your branch requires signed commits, turn on **Sign commits**. **Signing key** shows the phone's public key: **Copy** it and add it on GitHub as an SSH key with the key type **Signing Key**. The commit email must be a verified email of that GitHub account. **Make a New Key** and **Make an Ed25519 Key** replace the key.

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

**Settings → Notebooks → In the background** shows the last run and the next.

## Capture

Share text, links and pictures to Penmoss from any app, or add the **Capture** tile to Quick Settings or the **Capture** widget to your home screen. See [Quick capture](/docs/quick-capture/#on-android).

A long press on the app icon offers **Quick Capture**, **New Note**, **Today's Note**, **Search Notes** and your two most recent notes.

## The owner check

Removing a notebook, Delete for Good and restoring a version first ask for your fingerprint, face or screen lock ("Confirm it's you"). Android checks it on the phone; Penmoss never sees it. With no screen lock set, these changes are refused until you set one.

## Pictures from the web

**Settings → Sync and Storage** chooses whether notes load pictures from web addresses, which lets those websites see your phone's IP address, and shows the space files and pictures take on the phone. Files over 10 MB upload on Wi-Fi only.

## What's new

**Settings → What’s New** shows what changed in the version you have, and in earlier versions, grouped as **New**, **Improved** and **Fixed**. Only changes that reach Android are listed. An Alpha build lists every change since the last stable release, each with its build. The phone fetches the notes from GitHub when you open the screen and after an update, at most once an hour, and keeps them for offline. Until it has them, the screen links to the [Releases page](https://github.com/htxryan/penmoss/releases).

After you install a newer version, a message at the foot of the screen says **Updated to …** once, with **What’s New**, if that version has notes for Android.

## What the phone does not have

Compared with the Mac: note windows, Keep on Top, the menu bar icon and hotkey, Sign in with GitHub and the repository picker, SSH remotes, search by meaning, and the sidebar's Calendar and Tags sections. Agents connect on a Mac, not on the phone.

## Uninstall

Uninstall Penmoss as you would any app. Your notes stay in your repositories; the phone's copies, tokens and signing key go with the app.
