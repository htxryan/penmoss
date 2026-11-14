---
title: Updates and the Alpha channel
description: How Penmoss updates on the Mac and Android, and how to try the Alpha builds made from every change.
---

This page shows you how to keep Penmoss up to date, and how to try Alpha builds before a release.

## Stable and Alpha

- **Stable** releases have a version number, such as 0.2.0, and are what penmoss.app's Download buttons give you. These docs describe them.
- **Alpha** builds are made from every change merged into Penmoss. They have the newest features and may break. The newest one is always on the [alpha release](https://github.com/htxryan/penmoss/releases/tag/alpha), and each is also a prerelease on the [Releases page](https://github.com/htxryan/penmoss/releases).

## On the Mac

Penmoss can check for a newer build and offer it. It never installs one until you say so.

- **Settings → Updates → Auto-Update** (off until you turn it on) checks when Penmoss starts and every hour after.
- **Check Now** in the same place, or **Penmoss → Check for Updates…**, checks at any time, with Auto-Update on or off.
- **Update Channel** chooses what it offers: **Stable** (the default) or **Alpha**. Changing it checks at once, and Penmoss still only offers the update.
- When a newer build is found, Settings and a notice at the bottom of the sidebar, above Settings and Send Feedback, offer it. **Install and Restart** downloads it and restarts Penmoss into it. With the sidebar folded to a rail, the notice is an icon with a dot at the rail's foot, which opens Settings → Updates; in a narrow window it shows at the foot of the window.
- Penmoss always updates to the newest build, never one step at a time. Install and Restart checks again first, so a build published since the offer is the one you get, however many came out since your last update. If a newer build appears after one has downloaded, Penmoss downloads it in its place.

**About Penmoss** shows the version you have.

### What's new

**Settings → Updates** also shows what changed, below its buttons:

- **What's new in …**, while a newer build is offered: what it brings, since the version you have.
- **In this version**: what your version brought. On Alpha, that's everything since the last stable release, each change with its build.
- **Earlier versions**, folded away: each stable release's changes, newest first.

After Penmoss restarts into a newer version, a notice at the bottom of the sidebar says **Updated to …** once, if that version has notes. **What's New** opens them in Settings → Updates; it and ✕ put the notice away for good. On the rail the notice is an icon with a dot, which opens What's New.

Changes are grouped as **New**, **Improved** and **Fixed**, and only the Mac's are shown. Penmoss fetches the notes from GitHub when it checks for updates and when you open Settings, at most once an hour, and keeps them, so they read offline. Until it has reached GitHub once, the page links to the [Releases page](https://github.com/htxryan/penmoss/releases) instead. Each release on that page carries the same notes, and so does [Release notes](/docs/releases/) here.

You can also update by hand at any time: download the newest [Penmoss.dmg](https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.dmg) and replace the app, as in [The Mac app](/docs/install/mac/#download-and-install). Your notebooks stay as they are.

## On Android

The Android app does not update itself. After you install a newer version, it says so once, and **Settings → What’s New** shows what changed ([The Android app](/docs/install/android/#whats-new)). Download the newest [Penmoss.apk](https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.apk) and open it: it installs over the app you have, and keeps your notebooks. See [The Android app](/docs/install/android/#updates).

## Trying Alpha

On the Mac, set **Settings → Updates → Update Channel** to **Alpha**. Penmoss checks at once and offers the newest Alpha build; it uses the same notebooks.

On Android, download `Penmoss.apk` from the [alpha release](https://github.com/htxryan/penmoss/releases/tag/alpha) and install it as you would a stable release. It installs over the stable app and uses the same notebooks.

To go back to Stable on the Mac, set Update Channel to **Stable**. Penmoss never installs an older version, so it stays on its Alpha build until a stable release is newer, and Settings says so. On Android, a stable release installs over an Alpha build once its version is higher; until then, wait for the next stable release.

If something breaks in an Alpha build, please [tell us](/docs/help/feedback/).
