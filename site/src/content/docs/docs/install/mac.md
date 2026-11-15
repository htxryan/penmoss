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

Penmoss can check for a newer release and offer it; you choose when to install it. Turn this on in **Settings → Updates → Update Automatically**, or press **Check Now** there at any time. See [Updates and the Alpha channel](/docs/help/updates/).

## The window

The main window has three panes: the sidebar, the note, and the note panel. Drag the edge between two panes to resize them; Penmoss remembers the widths on this Mac.

- **The sidebar** holds the shortcuts row (New Note, Search, Tags, Today, This Week, Graph, Commands), then Quick Access, Recent Notes, your notebooks (each with its [badge](/docs/organise/#notebook-badges)), the calendar and tags. Its bottom row has Settings and Send Feedback, and above them the notice of a new version. ⌘\\ folds it to a rail of icons and back: Send Feedback and Settings stay at the rail's foot, Settings at the very bottom, and the tab strip then starts with Back, Forward and the Keep on Top pin. The buttons in the sidebar's top row always fit, however narrow you drag it. A notebook's row has **New Note**, **New Folder** and a ⋯ menu (**More Notebook Actions**) with **Rename…**, **Sort Order…**, **Time Machine** and **Trash**, so its name stays readable; when the notebook's sync stops, its row turns red. **Settings → Sidebar** chooses what it shows.
- **The note** sits under the [tab strip](#tabs). It has its title, the editor and, at the foot, the **status bar**: where the note is (click it to reveal the note in the sidebar), whether it is saved and in git (**Sync Stopped** in red at the bar's left edge when its notebook cannot sync; click it to see why), and its words, characters and reading time (for the selection while text is selected). **Settings → Note** chooses what the status bar and the line under the title show, and which buttons sit at the end of the tab strip.
- **The note panel**, on the right, has four tabs: **Metadata** (folder, dates, tags, frontmatter and [backlinks](/docs/links/#backlinks)), **Comments**, **History** and **Local Graph**. The **Note Panel** button at the end of the tab strip shows or hides it. **Settings → Note → Note Panel** chooses whether it starts open.

The note's other actions are in the ⋯ at the end of the tab strip. There is no title row above the note: its tab shows its notebook's badge and its title.

## Tabs

The main window opens several notes at once, as tabs in the strip above the note. Each tab has its own Back and Forward (their tooltips name the page they go to in this tab), keeps its place in the note and its note panel, and Penmoss reopens your tabs, in order, when you relaunch.

- **Open a note in the tab you are in:** click it, as before. A pinned tab keeps its note, so a click there opens a new tab.
- **A note that is open in a tab already:** click it in the sidebar to switch to its tab; the tab you were in keeps its note. ⌘-clicking it opens no second tab, and its tab blinks. Links in a note, Search and the palette still open it where you ask, so you can have a note in two tabs.
- **Open a note in a new tab:** ⌘-click it (or middle-click) anywhere in the sidebar (your notebooks' tree, Quick Access, Recent Notes, Today and This Week), in a tag's notes, Backlinks, the graph or a link, press ⌘↩ on a result in [Search](/docs/search/) or the palette, or choose **Open in New Tab** from a note's right-click menu in the sidebar. The tab opens behind the one you are in, which stays just as it was; ⇧⌘-click or ⇧⌘↩ opens it in front. While you have [several notes selected](/docs/organise/#moving-notes) in the tree, ⌘-click adds or removes one instead. You can also drag a note from the sidebar onto the strip.
- **New Tab** (⌘T, or + after the last tab) opens Home with Search open and the cursor in it; Escape leaves Home.
- **Today's Note** (⌘D), **This Week's Note**, the menu bar icon's **Open Today's Journal**, its Quick Access notes and `penmoss://` links never replace the page you are on: they switch to the tab already showing that note, or open it in a new tab.
- **Close a tab:** its ×, a middle click on it, or ⌘W. Closing the last tab leaves no tab, only +, over a dad joke (a new one each time, none twice until you have seen them all) and where to start: New Note, or the Command Palette. A window that opens with no note looks the same. **Reopen Closed Tab** (⇧⌘T) brings back the last 20 you closed, each where it was.
- **Switch tabs:** click one, ⌃Tab and ⇧⌃Tab for the next and previous, ⌘1 to ⌘8 for the first eight and ⌘9 for the last.
- **Reorder:** drag a tab along the strip, or press ⌥← or ⌥→ with it focused. Dragging a tab onto Quick Access pins its note there.
- **Right-click a tab** for Close Tab, Close Other Tabs, Close Tabs to the Right, **Pin Tab**, Duplicate Tab, Move to New Window, Pin to Quick Access and Reveal in Sidebar. A pinned tab moves to the strip's start, starts with a pin and has no ×, and ⌘W leaves it open.

Each note's tab starts with its notebook's badge. When two tabs have the same title and their notebooks' badges look alike, each also names its notebook; a tab's tooltip shows its notebook, its folders and its ⌘ number. A note moved to Trash closes its tabs, wherever it was moved from, and a message offers **Restore**. When the tabs no longer fit, they scroll sideways and **All Tabs**, with the count, lists them all, pinned tabs first with their pin.

In a window 700 points wide or narrower the strip hides, and the **Tabs** button in the top bar, with the count, lists your tabs (pinned ones first, marked Pinned) and has **New Tab**. Settings opens over the whole window, and closing it brings back your tabs as they were.

As in other Mac apps, Penmoss's own words (buttons, labels, headings, the sidebar) can't be selected, and the pointer stays an arrow over them. What you might copy can: your notes, every field, code and paths, comments, History, release notes, a notebook's details in Settings, and error messages.

## Note windows

Open a note in a window of its own with **Open in New Window** (⌘⌥O), from the note's ⋯ menu, from a note's right-click menu in the sidebar, or by ⌥-clicking a link, a backlink or a note in the sidebar.

A note window has the note, its title row and ⋯ menu, the note panel and the status bar, but no sidebar and no tabs. ⌘T there opens a new tab in the main window, and **Move to New Window** in a tab's menu moves that tab's note into a window of its own. Links open in the same window; its ← and → buttons, ⌘[ and ⌘], go back and forward. Several windows can show the same note, and typing in one shows in the others at once, offline too. Settings, Trash and the graph open in the main window.

Closing the main window leaves note windows open; the Dock icon or **Window → Penmoss** brings it back. Note windows are not reopened after you quit.

## Minimised windows

When no Penmoss window is on screen, clicking Penmoss in the Dock brings back the window you minimised last, even if the main window is closed. Any other minimised windows stay minimised: right-click the Dock icon, or use the **Window** menu, to pick one. To have windows minimise into the Penmoss icon instead of the right-hand end of the Dock, turn on **System Settings → Desktop & Dock → Minimise windows into application icon**. It is a macOS setting, so it applies to every app.

## Keep on top

**Keep on Top** pins a window above other apps' windows, on every Space, so a note stays in view while you work elsewhere. It never floats over a full-screen app. Turn it on or off with:

- the pin in the sidebar's header (at the start of the tab strip while the sidebar is a rail), or in a note window's top bar;
- **View → Keep on Top**;
- **Keep on Top** in the command palette.

The main window stays pinned after a relaunch; note windows start unpinned. Keep on Top has no shortcut until you [give it one](/docs/shortcuts/#change-a-shortcut).

## The compact title bar

With **Settings → Appearance → Window → Compact Title Bar** on (the default), the window's red, yellow and green buttons sit in Penmoss's own top row, beside the tab strip, and notes start higher. That row, and the strip's empty part, drags the window, and double-clicking an empty part of it zooms or minimises it, as **System Settings → Desktop & Dock** says. On Home, so does its empty space, and on the Tags page, the empty space around its title and filter; before you have a notebook, the strip across the top of the welcome screen does. In full screen the buttons hide.

Turn it off to use macOS's own title bar: Penmoss asks, then reopens its windows where they were. The setting is for this Mac only.

## The menus

Every command is in the menus, with its current shortcut:

- **Penmoss:** About Penmoss, Settings (⌘,) and **Check for Updates…**.
- **File:** New Note, then New Tab (⌘T), new folders, quick capture, moving, history, Open in New Window, then Reopen Closed Tab (⇧⌘T), Move to Trash, sort order, the git notebook's actions (Sync This Git Notebook Now, its token, commit name and email, Remove This Git Notebook from This Mac…), and last Close Tab (⌘W), Close Other Tabs and Close Window (⇧⌘W; in a note window, ⌘W).
- **Edit:** undo, the clipboard, Copy Note as Markdown or Rich Text, Copy Agent Reference, and Search Notes….
- **Format:** text formatting, headings, lists, blocks and line symbols.
- **Insert:** every block from the slash menu.
- **View:** the command palette, Keep on Top, the sidebar, the note panel's tabs, full width, tags and themes.
- **Go:** Quick Open, recent notes, the graph, Trash, Back and Forward, and the daily and weekly notes.
- **Window:** Show Next Tab (⌃Tab) and Show Previous Tab (⇧⌃Tab), Pin or Unpin Tab, Duplicate Tab, Move Tab to New Window, Show All Tabs, and the open windows.
- **Help:** keyboard shortcuts and **Send Feedback**.

## The menu bar icon

**Settings → Quick Capture → Show in the Menu Bar** (on by default, this Mac only) puts the Penmoss mark in the menu bar. Its menu has **Quick Capture**, **Open Today's Journal**, your [Quick Access](/docs/organise/#quick-access) notes and **Open Penmoss**.

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
