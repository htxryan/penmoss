---
title: Privacy and security
description: Where your notes are, what leaves your device, how tokens are kept, and what protects your notes from mistakes and agents.
---

This page explains where your notes are kept, what Penmoss sends anywhere, and what protects your notes. The full policy is the [privacy policy](/privacy).

## Where your notes are

- **On your devices**, in each app's own storage, so they open offline.
- **In your repository**, on the git host you chose, under its terms. Your notes are files there that your host can read: Penmoss does not encrypt them.

There is no Penmoss server and no account. We never receive your notes.

:::caution
Penmoss does not check who can read your repository. Keep it **private** to keep your notes private.
:::

## What leaves your device

- **Sync**, to the repositories you added, over HTTPS or SSH.
- **Send feedback**, only when you send it: an issue on Penmoss's GitHub repository, with what you wrote, the screenshots you chose and a description of the screen, never a note's text. See [Send feedback](/docs/help/feedback/).
- **Agents you connect** read and change the notebook you gave them. Their providers handle what they read under their own terms. Penmoss never sends your notes to an AI service by itself.
- **The search model** is downloaded once from Hugging Face on the Mac. Semantic search then runs on your Mac; your notes are not sent anywhere.
- **Pictures from the web** in a note are downloaded from their websites, which see your IP address. On Android, **Settings → Storage → Load Pictures from the Web** sets it to **Always**, **On Wi-Fi** or **Never**.
- **Updates**: the Mac app asks for the newest build when it checks.

- **Usage data**, only if you choose **Share Usage Data**: the names of the commands, shortcuts, buttons, screens and settings you use, sent to Penmoss's own server. See [Usage data](#usage-data) below.
- **Logs**, only when you attach them to a bug report (or, on Android, share them with **Share Log File**), after names, paths, IDs and secrets are replaced.

The apps send no crash reports by themselves. This website, penmoss.app, counts page views with Cloudflare Web Analytics, which sets no cookies; that is separate from the apps' usage data. See the [privacy policy](/privacy).

## Usage data

**On your device, always.** From the first launch, the Mac app, the `penmoss` CLI, the MCP server agents use, and the Android app keep a record of what you do in Penmoss, by name: `command note.new from a shortcut`, `screen settings.privacy`, `click sidebar.quick-access.pin`. It stays on your device for 7 days (at most 5,000 events) unless you change that, and you can read all of it in **Settings → Privacy → View Analytics Data**, or with `penmoss analytics show`.

**Sent only if you agree.** At the end of setting up (or once after an update), Penmoss asks **Share How You Use Penmoss?**. **Share Usage Data** sends the record, setup included, to Penmoss's own server at t.penmoss.app, on Cloudflare, which keeps it for 13 months and which only Penmoss's developer reads, through a private dashboard. **Don't Share** keeps it on your device, and nothing is ever sent. Turning sharing on later sends only what is recorded from then on.

**Never recorded, so never sent:** anything you write or name. No note titles, text or excerpts; no file, folder, tag, attachment, notebook or repository names, paths or links; no search text; no GitHub account, email address or token; no CLI argument or what an agent asked for or read. Counts are rounded into ranges ("10–49 notes"), and each event carries only the app's version, your system's version, the window's size class, whether a person, an agent or a script did it, and a random analytics ID. The apps also record the window's size and layout: its size to the nearest 10 pixels as it opens, resizes or goes full screen, and how it is laid out (sidebar, note panel, Full Width, light or dark, how many tabs), but never where it is or which screen it is on, and how far you scroll the note, the sidebar and Settings, from top to bottom in hundredths, never what is there.

**Your choices**, in **Settings → Privacy** on the Mac and Android, or with `penmoss analytics`:

- **Share Usage Data** turns sharing on or off. Off, anything waiting to be sent stays on your device.
- **Reset My Analytics ID** gives this device a new random ID.
- **Delete My Shared Data** asks Penmoss's server to delete everything this device shared, then gives it a new ID.
- **Advanced** sets how long the record and the logs are kept and how much a bug report attaches.
- The CLI and the MCP server follow the app's answer, never ask, and send nothing themselves. `DO_NOT_TRACK=1` or `PENMOSS_ANALYTICS=off` in their environment keeps their events on your device.

More detail, with an example of what is sent: [Usage data](/docs/help/usage-data/).

## Tokens and sign-ins

- **On the Mac**, tokens for git and GitHub are encrypted with a key kept in the Keychain, and never shown again once saved. Penmoss hands a token to git only while it syncs.
- **On Android**, tokens and the commit signing key are encrypted with a key in the Android Keystore, and stay out of Android's backups.
- **The CLI** keeps tokens in the system keychain, or in `~/.penmoss/credentials.json` readable only by you.

Use a token that can reach only the notebook's repository, such as a fine-grained GitHub token for that one repository.

## What protects your notes

- **History.** Every change is a commit, named after the device or agent that made it, and can be restored or reverted. See [History and Trash](/docs/history/).
- **The owner check.** Removing a notebook, Delete for Good and restoring a version ask for Touch ID or your password on the Mac, or your fingerprint, face or screen lock on Android. The check runs on the device; Penmoss never sees it.
- **Only you delete for good.** No agent, script or command can delete a note for good.
- **Agents' edits are checked** against what they read, and each agent writes as itself. See [Safe edits](/docs/agents/#safe-edits).

## Reporting a security problem

Please report security problems privately, as the [security policy](https://github.com/htxryan/penmoss/blob/main/SECURITY.md) explains, not in a public issue.
