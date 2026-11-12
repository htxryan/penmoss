---
title: The Mac app
description: 'What the Mac app adds: note windows, keep on top, the compact title bar, the panes, the menus and the menu bar icon.'
---

This page shows you what the Mac app adds to the notes themselves: windows of their own, keeping a window on top, the layout of the window, the menus and the menu bar icon.

## The window

The main window has three panes: the sidebar, the note, and the note panel. Drag the edge between two panes to resize them; Penmoss remembers the widths on this Mac.

- **The sidebar** holds the shortcuts row (New Note, Search, Today, This Week, Graph, Commands), then Quick Access, Recent Notes, your notebooks, the calendar and tags. ⌘\\ folds it to a rail of icons and back. **Settings → Display** chooses what it shows.
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

- the pin in the sidebar's header, or in a note window's top bar;
- **View → Keep on Top**;
- **Keep on Top** in the command palette.

The main window stays pinned after a relaunch; note windows start unpinned. Keep on Top has no shortcut until you [give it one](/docs/shortcuts/#change-a-shortcut).

## The compact title bar

With **Settings → Appearance → Compact Title Bar** on (the default), the window's red, yellow and green buttons sit in Penmoss's own top row, and notes start higher. That row drags the window, and double-clicking an empty part of it zooms or minimises it, as **System Settings → Desktop & Dock** says. In full screen the buttons hide.

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

A `penmoss://note/<id>` link opens that note in Penmoss, from any app; `penmoss://capture` opens the capture window. **Copy Agent Reference** and `penmoss open <note> --print` give a note's link. Web links in notes open in your browser.

## The owner check

Some changes ask macOS to check that it is you first, with **Touch ID or your Mac's password**: removing a notebook from this Mac, Delete for Good, restoring or reverting a version, and connecting an agent. Cancel it and nothing changes. No page, script or agent can skip it.

## Quitting

When you quit, or close a window, Penmoss saves what you typed and pushes the changes waiting, for up to 10 seconds; the notebook says **Pushing…** meanwhile. A push that cannot finish in time goes first at the next launch.

## Where it keeps things

- **Your notebooks, settings and tokens:** `~/Library/Application Support/Penmoss`. Tokens are encrypted with a key in the Keychain ("Penmoss Safe Storage").
- **Agents' copies of your notebooks and the search model:** `~/.penmoss`, shared with the [`penmoss` command](/docs/reference/cli/).
