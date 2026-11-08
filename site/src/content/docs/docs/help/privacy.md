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
- **The search model** is downloaded once from Hugging Face on the Mac. Search by meaning then runs on your Mac; your notes are not sent anywhere.
- **Pictures from the web** in a note are downloaded from their websites, which see your IP address. On Android you can turn this off in **Settings → Sync and Storage**.
- **Updates**: the Mac app asks for the newest build when it checks.

Penmoss sends no analytics, crash reports or usage data.

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
