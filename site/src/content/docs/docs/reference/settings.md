---
title: Settings
description: Every section of Settings in the Mac and Android apps, what each setting does, and where it is kept.
---

This page lists every setting, page by page, so you can find one and see what it does.

Open Settings with ⌘, on the Mac, or from the gear on the first screen on Android. Most settings are kept in your [Primary Notebook](/docs/organise/#the-primary-notebook) and so reach your other devices; the ones marked **this Mac** or **this device** stay where they are set. Settings that belong to a notebook itself (its time zone and templates) are the same on every device and agent that opens it.

## On the Mac

Settings lists its pages in five groups: **Look and Feel**, **Writing**, **Notebooks**, **Agents** and **This Mac**. Nothing under This Mac is synced; the heading says so once, so its pages don't repeat it.

### Search Settings

The field over the list finds a setting by its name, its help, or another word for it ("typeface" or "text size" for the fonts). While it has words in it, the matches take the page's place, each with the page and group it's on. Click one, or press Return for the first, to open its page with the setting marked; press Esc to clear the field. ↓ and ↑ move between the field and the matches.

Old links still work: Settings → Display opens Sidebar, and Settings → Status opens GitHub.

## Look and Feel

### Appearance

| Setting                   | What it does                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                      | Light, Dark, or System (the default), which follows macOS                                                                                                         |
| Theme                     | The theme; **Customize…** copies one to make your own ([Themes and fonts](/docs/themes/))                                                                         |
| Interface Font, Note Font | The fonts over the theme's own                                                                                                                                    |
| Note Font Size            | 12 to 28 px                                                                                                                                                       |
| Show Tooltips After       | How long the pointer rests on a control before its tooltip shows: 0.5, 1 (the default), 1.5 or 2 seconds, or Never. Keyboard focus always shows a tooltip at once |
| Compact Title Bar         | The window's buttons in Penmoss's own top row; on by default (this Mac)                                                                                           |

### Sidebar

| Setting                             | What it does                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Shortcuts                           | Which of Tags, Today, This Week, Graph and Commands the sidebar's top row shows (Search always shows); all are on by default |
| Sections                            | The order of Quick Access, Recent Notes, Notebooks, Calendar and Tags                                                        |
| Notes in Recent Notes               | 1 to 50, 10 by default                                                                                                       |
| Show Notebook Names in Quick Access | Labels each pinned note with its notebook                                                                                    |

### Note

| Setting           | What it does                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Note Width        | The theme's width, or Full Window                                                                                                           |
| Note Panel        | Whether the note panel starts Closed or Open (this Mac)                                                                                     |
| Title Bar Buttons | Which actions have a button at the end of the tab strip (beside the title in a note window): Full Width and Copy Agent Reference by default |
| Under the Title   | Which of notebook, folder, dates, tags, words, characters, reading time and token count show there                                          |
| In the Status Bar | The same for the status bar; words, characters and reading time by default                                                                  |

### Symbols

The [line symbols](/docs/editor/#line-symbols): each one's key, glyph (from the symbol picker: symbols and emoji, searched by name) and colour, their order (drag a row, or Alt+↑ and Alt+↓, which changes its key), **Add a Symbol** (up to nine) and **Restore Defaults**.

## Writing

### Daily Notes

| Setting                         | What it does                                                                |
| ------------------------------- | --------------------------------------------------------------------------- |
| Time Zone                       | The day "today" is, for this notebook (America/Chicago until you change it) |
| Daily Template, Weekly Template | What a new daily or weekly note starts with; **Use the Default** goes back  |

See [Daily and weekly notes](/docs/journal/).

### Quick Capture

| Setting               | What it does                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- |
| Saves To              | Where a capture goes by default: Today's Note or New Note in Inbox                  |
| Shortcut From Any App | The capture hotkey (this Mac)                                                       |
| Show in the Menu Bar  | The [menu bar icon](/docs/install/mac/#the-menu-bar-icon); on by default (this Mac) |

See [Quick capture](/docs/quick-capture/).

### Keyboard Shortcuts

Every command's shortcut, to change, remove or reset ([Keyboard shortcuts](/docs/shortcuts/#change-a-shortcut)).

## Notebooks

**All Notebooks** lists every notebook with **Add Notebook…**, then each notebook has an entry of its own in the list, with its [badge](/docs/organise/#notebook-badges) and a dot for how its sync is going. A notebook's page, in its **Overview**, **Sync** and **Git** tabs:

| Setting                              | What it does                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sync Now                             | Syncs at once                                                                                                                                                                                                      |
| Notebook Name, Rename                | Renames it on every device that syncs it ([Rename a notebook](/docs/organise/#rename-a-notebook))                                                                                                                  |
| Badge                                | On **Overview**, after its name: its colour (ten presets or **Custom…**), what it shows (a letter, a number from 0 to 99 or an icon) and **Reset to Default** ([Notebook badges](/docs/organise/#notebook-badges)) |
| Push after (seconds)                 | How long after your edits settle it pushes: 12 by default                                                                                                                                                          |
| Pull every (minutes)                 | How often it pulls while Penmoss is open: 1 by default                                                                                                                                                             |
| Sign commits as git is configured to | Untick to never sign this notebook's commits                                                                                                                                                                       |
| Commit name, Commit email            | This notebook's own commit identity, over git's (a GitHub no-reply address keeps yours private)                                                                                                                    |
| Access                               | **Save Token** and **Forget Token**, for an HTTPS host that needs a token                                                                                                                                          |
| Remove from This Mac                 | Removes this Mac's copy, after Touch ID; the repository keeps everything pushed                                                                                                                                    |

On All Notebooks:

| Setting                                          | What it does                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Primary Notebook                                 | The notebook that holds your journal, Inbox and these settings (this Mac)                                     |
| Keep Settings in Step, Copy Settings…            | Copies your app settings to your other notebooks, once or every time they change                              |
| Copy Tags When Copying Notes to Another Notebook | Whether **Copy Tags** starts ticked in [Copy to Notebook…](/docs/organise/#notebooks)'s picker; on by default |

## Agents

### Agents

For each notebook, the agents connected to it, **Connect an Agent** and **Disconnect**, and the commands to give each agent ([How agents work](/docs/agents/)). **The penmoss Command** installs the CLI ([Install](/docs/reference/cli/#install)).

### Agent Activity

What agents changed, in every notebook, with Undo ([Agent activity](/docs/agents/activity/)).

## This Mac

### Search by Meaning

**Find Notes by Meaning**, on by default; then what it's doing, with a progress bar while the model downloads or your notes are indexed, and the model with its size and licence. Turning it off asks first, as it removes the model and its index. See [Search](/docs/search/#search-by-meaning).

### GitHub

The GitHub account Penmoss uses, kept in this Mac's Keychain: **Sign In with GitHub**, or **Use a Token Instead…** to paste a token, and **Sign Out**. Under **Used For**: adding notebooks from your repositories, and **Send Feedback**, with how many reports are waiting and **Open**. See [Send feedback](/docs/help/feedback/).

### Updates

A card with the version you're running, whether it's up to date, the channel and when Penmoss last checked, and **Check Now** (or **Install and Restart**). Then **Update Automatically** (off by default) and **Update Channel** (Stable or Alpha), and **What's New**: what an offered update brings, what this version brought, and earlier versions. See [Updates](/docs/help/updates/#whats-new).

## On Android

Open Settings from the gear on the first screen. The same five groups as the Mac, with **This Phone** in place of This Mac, and a **Search Settings** field at the top that opens the screen a setting is on, scrolled to the setting and marked for a moment. On **All Notebooks**, **Between Notebooks** has **Keep Settings in Step** and **Copy Settings…** as on the Mac (with two notebooks or more), and Keep Settings in Step is this phone's own choice.

| Group         | Screen             | What it holds                                                                                                                      |
| ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Look and Feel | Appearance         | A live preview, then mode, theme and **Customize Penmoss…**, fonts, and note width                                                 |
| Look and Feel | Home               | Shortcuts on Home, the order of the sections, Notes in Recent Notes, Show Notebook Names in Quick Access                           |
| Look and Feel | Symbols            | The line symbols, and their keys on a hardware keyboard                                                                            |
| Writing       | Daily Notes        | Time zone, and the daily and weekly templates beside a preview of today's note                                                     |
| Writing       | Quick Capture      | Where a capture goes by default, and which notebook                                                                                |
| Writing       | Keyboard Shortcuts | Shortcuts for a hardware keyboard                                                                                                  |
| Notebooks     | Each notebook      | Its page: **Overview** (its notes, **Copy Settings…**), **Sync** and **Git** ([The Android app](/docs/install/android/#notebooks)) |
| Notebooks     | All Notebooks      | **Add Notebook**, **Primary Notebook**, Between Notebooks, **Commits From This Phone**, the signing key and background sync        |
| Agents        | Agent Activity     | What agents changed, in every notebook, with **Undo**                                                                              |
| This Phone    | Storage            | Files and pictures in notes, pictures from the web and **Clear…**, and whether to load pictures from the web                       |
| This Phone    | GitHub             | **Sign In with GitHub** (or a token), and what the account is used for, such as **Send Feedback**                                  |
| This Phone    | What’s New         | The version, what changed in it, and in earlier ones ([The Android app](/docs/install/android/#whats-new))                         |

## For a notebook, from the CLI or an agent

`penmoss settings` and the `get_settings` and `set_settings` tools read and change a notebook's own settings: `timeZone`, `template.daily` and `template.weekly`. They cannot change the apps' settings.
