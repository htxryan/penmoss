---
title: The Mac app
description: 'Install Penmoss on the Mac and keep it up to date, then what the Mac app adds: note windows, keep on top, the compact title bar, the panes, the menus and the menu bar icon.'
---

This page shows you how to download Penmoss for the Mac, install it and check the download, then what the Mac app adds to the notes themselves: windows of their own, keeping a window on top, the layout of the window, the menus and the menu bar icon.

Penmoss runs on macOS 12 or later, on Apple Silicon and Intel Macs. It is signed with a Developer ID and notarised by Apple.

## Download and install

1. Download [Penmoss.dmg](https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.dmg) from the latest stable release on GitHub.
2. Open the downloaded file and drag **Penmoss** to **Applications**. If asked, replace the older copy.
3. Open Penmoss from Applications or Spotlight.

The first time it opens, Penmoss may ask to use the keychain item "Penmoss Safe Storage". That is where it keeps the key that protects your git tokens: choose **Always Allow**.

Penmoss then opens on **Welcome to Penmoss**. Go on to [Your first notebook](/docs/first-notebook/).

## Check the download

Every release lists the SHA-256 of each file in `SHA256SUMS.txt`. To check the dmg, download that file to the same folder and run:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

It prints `Penmoss.dmg: OK` when the file matches.

## Updates

Penmoss can check for a newer release and offer it; you choose when to install it. Turn this on in **Settings → Updates → Auto-Update**, or press **Check Now** there at any time. See [Updates and the Alpha channel](/docs/help/updates/).

## The window

The main window has three panes: the sidebar, the note, and the note panel. Drag the edge between two panes to resize them; Penmoss remembers the widths on this Mac.

- **The sidebar** holds the shortcuts row (New Note, Search, Today, This Week, Graph, Commands), then Quick Access, Recent Notes, your notebooks, the calendar and tags. Its bottom row has Settings and Send Feedback, and above them the notice of a new version. ⌘\\ folds it to a rail of icons and back: Settings and Send Feedback stay at the rail's foot, and a note's top bar then starts with Back, Forward and the Keep on Top pin. The buttons in the sidebar's top row always fit, however narrow you drag it. **Settings → Display** chooses what it shows.
- **The note** has its title, the editor and, at the foot, the **status bar**: whether the note is saved and in git, and its words, characters and reading time (for the selection while text is selected). **Settings → Display** chooses what the status bar and the line under the title show, and which buttons the note's top bar has.
- **The note panel**, on the right, has four tabs: **Metadata** (folder, dates, tags, frontmatter and [backlinks](/docs/links/#backlinks)), **Comments**, **History** and **Local Graph**. The **Note Panel** button in the note's top bar shows or hides it. **Settings → Appearance → Note Panel** chooses whether it starts open.

The note's other actions are in the ⋯ at the end of its top bar.

## Note windows

Open a note in a window of its own with **Open in New Window** (⌘⌥O), from the note's ⋯ menu, from a note's right-click menu in the sidebar, or by ⌥-clicking a link, a backlink or a note in the sidebar.

A note window has the note, its ⋯ menu, the note panel and the status bar, but no sidebar. Links open in the same window; its ← and → buttons, ⌘[ and ⌘], go back and forward. Several windows can show the same note, and typing in one shows in the others at once, offline too. Settings, Trash and the graph open in the main window.

Closing the main window leaves note windows open; the Dock icon or **Window → Penmoss** brings it back. Note windows are not reopened after you quit.

## Minimised windows

When no Penmoss window is on screen, clicking Penmoss in the Dock brings back the window you minimised last, even if the main window is closed. Any other minimised windows stay minimised: right-click the Dock icon, or use the **Window** menu, to pick one. To have windows minimise into the Penmoss icon instead of the right-hand end of the Dock, turn on **System Settings → Desktop & Dock → Minimise windows into application icon**. It is a macOS setting, so it applies to every app.

## Keep on top

**Keep on Top** pins a window above other apps' windows, on every Space, so a note stays in view while you work elsewhere. It never floats over a full-screen app. Turn it on or off with:

- the pin in the sidebar's header (in the note's top bar while the sidebar is a rail), or in a note window's top bar;
- **View → Keep on Top**;
- **Keep on Top** in the command palette.

The main window stays pinned after a relaunch; note windows start unpinned. Keep on Top has no shortcut until you [give it one](/docs/shortcuts/#change-a-shortcut).

## The compact title bar

With **Settings → Appearance → Compact Title Bar** on (the default), the window's red, yellow and green buttons sit in Penmoss's own top row, and notes start higher. That row drags the window, and double-clicking an empty part of it zooms or minimises it, as **System Settings → Desktop & Dock** says. Before you have a notebook, the strip across the top of the welcome screen does the same. In full screen the buttons hide.

Turn it off to use macOS's own title bar: Penmoss asks, then reopens its windows where they were. The setting is for this Mac only.

## The menus

Every command is in the menus, with its current shortcut:

- **Penmoss:** About Penmoss, Settings (⌘,) and **Check for Updates…**.
- **File:** new notes and folders, quick capture, moving, history, note windows, Move to Trash, sort order, and the git notebook's actions (Sync This Git Notebook Now, its token, commit name and email, Remove This Git Notebook from This Mac…).
- **Edit:** undo, the clipboard, Copy Note as Markdown or Rich Text, Copy Agent Reference, and Search Notes….
- **Format:** text formatting, headings, lists, blocks and line symbols.
- **Insert:** every block from the slash menu.
- **View:** the command palette, Keep on Top, the sidebar, the note panel's tabs, full width, tags and themes.
- **Go:** Quick Open, recent notes, the graph, Trash, Back and Forward, and the daily and weekly notes.
- **Window** and **Help:** the open windows; keyboard shortcuts and **Send Feedback**.

## The menu bar icon

**Settings → Display → Show Penmoss in the Menu Bar** (on by default, this Mac only) puts the Penmoss mark in the menu bar. Its menu has **Quick Capture**, **Open Today's Journal**, your [Quick Access](/docs/organise/#quick-access) notes and **Open Penmoss**.

## Quick capture

**⌃⌥⌘N** in any app opens a small capture window over it. See [Quick capture](/docs/quick-capture/#on-the-mac).

## Links into Penmoss

A `penmoss://note/<id>` link opens that note in Penmoss, from any app, with its 26-character id or its short id (such as `penmoss://note/K7QD-9HTF2CXA`); `penmoss://capture` opens the capture window. `penmoss open <note> --print` gives a note's link. Web links in notes open in your browser.

## The owner check

Some changes ask macOS to check that it is you first, with **Touch ID or your Mac's password**: removing a notebook from this Mac, Delete for Good, restoring or reverting a version, and connecting an agent. Cancel it and nothing changes. No page, script or agent can skip it.

## Quitting

When you quit, or close a window, Penmoss saves what you typed and pushes the changes waiting, for up to 10 seconds; the notebook says **Pushing…** meanwhile. A push that cannot finish in time goes first at the next launch.

## Where it keeps things

- **Your notebooks, settings and tokens:** `~/Library/Application Support/Penmoss`. Tokens are encrypted with a key in the Keychain ("Penmoss Safe Storage").
- **Agents' copies of your notebooks and the search model:** `~/.penmoss`, shared with the [`penmoss` command](/docs/reference/cli/).

## Uninstall

Quit Penmoss and move it from Applications to the Trash. Your notes stay in your repositories. To remove this Mac's copies too, delete `~/Library/Application Support/Penmoss` and, if you used the CLI or agents, `~/.penmoss`.
