---
title: Send feedback
description: Report a bug or ask for a feature from inside Penmoss, with screenshots, and see what the report holds.
---

This page shows you how to send a bug report or a feature request from Penmoss, and what it sends.

**Send Feedback** files your report as an issue on [Penmoss's GitHub repository](https://github.com/htxryan/penmoss/issues), using your own GitHub account. It never includes the text of your notes.

## Where it is

- **On the Mac:** **Help → Send Feedback**, the sidebar's feedback button, the note's ⋯ menu, or the command palette.
- **On Android:** the ⋮ menu on Home or in a note, or **Settings → About → Send Feedback**.

## Your GitHub token

Feedback is filed with a GitHub token of yours:

- **On the Mac:** **Settings → Status → GitHub Token**. If you used [Sign in with GitHub](/docs/first-notebook/#sign-in-with-github), it is already there.
- **On Android:** **Settings → About → GitHub Token**.

A classic token with the `public_repo` scope works. Penmoss checks the token when you save it, and keeps it encrypted on the device. Without a token, a report waits until you save one.

## The form

- **Type:** Bug report or Feature request.
- **Priority:** P1 Highest, P2 High, P3 Normal or P4 Lowest.
- **Title** and **Description**: the description takes bold, italic, lists, links and code.
- **Screenshots:** up to six pictures, by paste, drag and drop, or the picker. On the Mac, **This window.png** is a picture of the window you were in, offered unticked: tick it to send it.
- **Captured context:** shows exactly what else the issue will hold, with a checkbox for each group to leave it out.

An unsent form is kept as a draft until you send or discard it.

## What the context holds

Facts about the app, never your notes' text:

1. **App:** which app, its version, the system, the window and the theme.
2. **Where you are:** the screen, the open panel and the sidebar's state.
3. **Sync:** online or not, and the notebook's sync state.
4. **This note**, when one is open: its id, title, folder, tags, dates and counts (words, links, attachments), but not its text.
5. **Recent errors:** the app's last errors, with tokens, emails, names and quoted text removed.

## Offline

A report sent offline waits in an outbox and goes when the device is back online; the form says **Queued, will send when you're online**. A report GitHub refuses stays in the outbox with the reason, with **Edit**, **Retry** and **Discard**. On the Mac the outbox is in **Settings → Status**; on Android, in **Settings → About**.

## Without the app

You can also [open an issue on GitHub](https://github.com/htxryan/penmoss/issues/new/choose) yourself.
