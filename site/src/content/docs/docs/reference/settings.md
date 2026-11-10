---
title: Settings
description: Every section of Settings in the Mac and Android apps, what each setting does, and where it is kept.
---

This page lists every setting, section by section, so you can find one and see what it does.

Open Settings with ⌘, on the Mac, or from a notebook's menu on Android. Most settings are kept in your [Primary Notebook](/docs/organise/#the-primary-notebook) and so reach your other devices; the ones marked **this device** stay where they are set. Settings that belong to a notebook itself (its time zone and templates) are the same on every device and agent that opens it.

## On the Mac

### Appearance

| Setting           | What it does                                                                      |
| ----------------- | --------------------------------------------------------------------------------- |
| Mode              | Light, Dark, or System (the default), which follows macOS                         |
| Theme             | The theme; **Duplicate** one to make your own ([Themes and fonts](/docs/themes/)) |
| Note width        | The theme's width, or Full Window Width                                           |
| Note Panel        | Whether the note panel starts Closed or Open (this device)                        |
| Fonts             | Interface Font, Note Font and Note Font Size                                      |
| Compact Title Bar | The window's buttons in Penmoss's own top row; on by default (this device)        |

### Display

| Setting                             | What it does                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show in the sidebar                 | Which of Today, This Week, Graph and Commands the sidebar's top row shows (Search always shows)                                                                   |
| Sections                            | The order of Quick Access, Recent Notes, Notebooks, Calendar and Tags                                                                                             |
| Notes in Recent Notes               | 1 to 50, 10 by default                                                                                                                                            |
| Show Notebook Names in Quick Access | Shows each pinned note's notebook under its title                                                                                                                 |
| Buttons in the note's title bar     | Which actions have a button beside the note's title: Full Width and Copy Agent Reference by default                                                               |
| Show Tooltips After                 | How long the pointer rests on a control before its tooltip shows: 0.5, 1 (the default), 1.5 or 2 seconds, or Never. Keyboard focus always shows a tooltip at once |
| Note Metadata Under the Title       | Which of notebook, folder, dates, tags, words, characters, reading time and token count show under the title                                                      |
| Note Metadata in the Status Bar     | The same for the status bar; words, characters and reading time by default                                                                                        |
| Show Penmoss in the Menu Bar        | The [menu bar icon](/docs/mac/#the-menu-bar-icon); on by default (this device)                                                                                    |

### Symbols

The [line symbols](/docs/editor/#line-symbols): each one's glyph and colour, their order, **Add a Symbol** (up to nine) and **Restore Defaults**.

### Git Notebooks

**Add a Git Notebook…**, then for each notebook:

| Setting                              | What it does                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Sync Now                             | Syncs at once                                                                                   |
| Push after (seconds)                 | How long after your edits settle it pushes: 12 by default                                       |
| Pull every (minutes)                 | How often it pulls while Penmoss is open: 1 by default                                          |
| Sign commits as git is configured to | Untick to never sign this notebook's commits                                                    |
| Commit name, Commit email            | This notebook's own commit identity, over git's (a GitHub no-reply address keeps yours private) |
| Access                               | **Save Token** and **Forget Token**, for an HTTPS host that needs a token                       |
| Agent Activity                       | What agents changed, with Undo ([Agent activity](/docs/agents/activity/))                       |
| Primary Notebook                     | **Make Primary Notebook** (this device)                                                         |
| Copy Settings to Other Notebooks     | Copies your app settings to your other notebooks; you can keep them in step on this Mac         |
| Remove from This Mac                 | Removes this Mac's copy, after Touch ID; the repository keeps everything pushed                 |

### Agents

For each notebook, the agents connected to it, **Connect an Agent** and **Disconnect**, and the commands to give each agent ([How agents work](/docs/agents/)). **The penmoss Command** installs the CLI ([Install](/docs/reference/cli/#install)).

### Daily Notes

| Setting                         | What it does                                                                |
| ------------------------------- | --------------------------------------------------------------------------- |
| Time zone                       | The day "today" is, for this notebook (America/Chicago until you change it) |
| Daily template, Weekly template | What a new daily or weekly note starts with; **Use the Default** goes back  |
| Quick Capture                   | Where a capture goes by default: Today's Note or New Note in Inbox          |

See [Daily and weekly notes](/docs/journal/).

### Keyboard Shortcuts

Every command's shortcut, to change, remove or reset ([Keyboard shortcuts](/docs/shortcuts/#change-a-shortcut)), and **Quick capture from any app**, the capture hotkey (this device).

### Search by Meaning

What search by meaning is doing, and the switch: on by default. Off removes the model and its index (this device). See [Search](/docs/search/#search-by-meaning).

### Updates

**Auto-Update** (off by default, this device), **Update Channel** (Stable or Alpha, this Mac), **Check Now** and **Install and Restart**. See [Updates](/docs/help/updates/).

### Status

**GitHub Token**, for sending feedback (**Save**, **Sign Out**), and the **Feedback outbox**: reports waiting to send, with **Edit**, **Retry** and **Discard**. See [Send feedback](/docs/help/feedback/).

## On Android

| Section            | What it holds                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance         | Mode, theme, note width, fonts and the theme editor                                                                                                                                                                                                                             |
| Display            | Shortcuts on Home, the order of the sections, Notes in Recent Notes, Show Notebook Names in Quick Access                                                                                                                                                                        |
| Symbols            | The line symbols, and their keys on a hardware keyboard                                                                                                                                                                                                                         |
| Git Notebooks      | Each notebook's sync, Wi-Fi only, signing, push and pull timing, token, commit identity and **Remove from This Phone**; then **Commits from this phone**, the **Signing key**, the **Journal notebook** and **In the background** ([The Android app](/docs/android/#notebooks)) |
| Daily Notes        | Time zone and templates                                                                                                                                                                                                                                                         |
| Quick Capture      | Where a capture goes by default                                                                                                                                                                                                                                                 |
| Keyboard Shortcuts | Shortcuts for a hardware keyboard                                                                                                                                                                                                                                               |
| Sync and Storage   | Storage on this phone, and whether to load pictures from the web                                                                                                                                                                                                                |
| About              | The version, **Send Feedback**, **GitHub Token** and the feedback outbox                                                                                                                                                                                                        |

## For a notebook, from the CLI or an agent

`penmoss settings` and the `get_settings` and `set_settings` tools read and change a notebook's own settings: `timeZone`, `template.daily` and `template.weekly`. They cannot change the apps' settings.
