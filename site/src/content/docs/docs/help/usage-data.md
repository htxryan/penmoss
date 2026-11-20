---
title: Usage data
description: What Penmoss records about how you use it, where it is kept, what is sent if you agree, and how to see, limit, stop or delete it.
---

This page explains the record Penmoss keeps of how you use it: what it holds, where it is kept, what is sent if you agree, and how to change any of it. In short, it is kept on your device always, sent only if you choose **Share Usage Data**, and never holds anything you write or name.

## What is recorded

The Mac app, the `penmoss` CLI, the MCP server agents use, and the Android app record each thing you do, by name:

| Kind     | Example                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command  | `note.new`, from a shortcut (`Mod+Alt+N`), the palette, a button or menu                                                                                                                             |
| Screen   | `settings.privacy`, `note`, `firstrun.github`                                                                                                                                                        |
| Dialog   | `palette` opened, then closed after 2–5 s                                                                                                                                                            |
| Click    | `sidebar.quick-access.pin`; every button, link, menu, switch, list and slider by its own name, and a list or slider only says it was changed, never to what                                          |
| Menu     | `copy` from the menu bar                                                                                                                                                                             |
| Setting  | `theme.mode` set to `dark`; a text setting only says it changed                                                                                                                                      |
| CLI      | `search`, with the names of the options used (never their values)                                                                                                                                    |
| MCP tool | `read_note`, by which agent (`claude-code`), and whether it worked                                                                                                                                   |
| App      | started, quit, came to the front, went to the back; the window's size each time it opens, resizes or goes full screen, and its layout: sidebar, note panel, Full Width, light or dark, how many tabs |
| Scroll   | `note` at 0.42 of the way down; the sidebar, its folder tree, Recent Notes and Tags; Settings and its list of pages                                                                                  |

Each event also says whether a person, an agent or a script did it, the app's version and channel, your system and its version (such as macOS 15.1), the window's size class (its size and layout are their own events), and a random analytics ID. Counts are rounded into ranges ("10–49 notes") and window sizes to the nearest 10 pixels, and times into durations ("2–5 s"). Nothing about where a window is or which screen it is on is recorded.

A scroll is recorded once the area has stopped moving for a moment, at most once a second for each area, as how far down it is: from 0 at the top to 1 at the bottom, rounded to hundredths. It says nothing about what is there: no note, heading or length. Scrolling adds events, about one every few seconds while you read a long note; with **Don't Share** that means the record on your device covers fewer days, and **Keep at Most** (5,000 by default) can be raised under [Limits](#limits).

### Never recorded

Anything you write or name: note titles, text or excerpts; file, folder, tag, attachment, notebook and repository names, paths, branches and links; search text; your GitHub account, email address and tokens; the values you pass to the CLI; what agents ask for or read. A Penmoss event has no place for text: each name comes from a fixed list in the app, and Penmoss's server drops any event that doesn't match it.

## Where it is kept

On your device, from the first launch, whatever you answer:

- **Mac:** `~/.penmoss/analytics/events.db`, shared by the app, the CLI and the MCP server. Your answer and the analytics ID are in `~/.penmoss/analytics.json`.
- **Android:** in the app's private storage, kept out of Android's backups and device transfer.

It is kept for 7 days, at most 5,000 events, unless you change that (below). It is never put in your notebooks or synced.

## Seeing it

**Settings → Privacy → View Analytics Data** shows every event, newest first, 100 at a time, with its state:

- **Waiting for Your Answer**: recorded before you answered. Sent if your answer is **Share Usage Data**.
- **Not Shared**: recorded while sharing was off. Never sent, even if you turn sharing on later.
- **Waiting to Send**, then **Sent** or **Refused**: recorded while sharing was on.

On the Mac you can filter by app, CLI or MCP and by state, and **Copy as JSON** copies exactly what was last sent. In a terminal, `penmoss analytics show` prints the same, and `penmoss analytics show --json` as JSON.

## Sharing it

At the end of setting up, or once after the update that added it, Penmoss asks **Share How You Use Penmoss?**:

- **Share Usage Data** sends the record, this setup included, to Penmoss's own server at t.penmoss.app, on Cloudflare. It keeps the events for 13 months and never your IP address, and only Penmoss's developer reads them, through a private dashboard, to see which features are used and where people get stuck.
- **Don't Share** keeps everything on your device. Nothing is ever sent.

Events go in small batches about once a minute, in the background. Offline, they wait and are sent later; nothing you do waits for them.

This is what one batch looks like:

```json
{
  "v": 1,
  "install": "5c0e8f6a2b9d4e71a3f0c4d2e8b17a96",
  "events": [
    {
      "session": "a91f03c7d2e54b68",
      "seq": 41,
      "at": 1795100000000,
      "client": "mac",
      "actor": "person",
      "version": "0.15.0",
      "channel": "stable",
      "os": "macos",
      "osVersion": "15.1",
      "sizeClass": "expanded",
      "kind": "command",
      "name": "note.new",
      "props": { "source": "key", "keys": "Mod+Alt+N", "custom": false, "ran": true }
    },
    {
      "session": "a91f03c7d2e54b68",
      "seq": 42,
      "at": 1795100004000,
      "client": "mac",
      "actor": "person",
      "version": "0.15.0",
      "channel": "stable",
      "os": "macos",
      "osVersion": "15.1",
      "sizeClass": "expanded",
      "kind": "app",
      "name": "window",
      "props": {
        "window": "main",
        "width": 1440,
        "height": 900,
        "fullScreen": false,
        "maximised": false
      }
    }
  ]
}
```

## Changing your mind

In **Settings → Privacy** on the Mac and Android:

- **Share Usage Data** turns sharing on or off. On sends from then on; off keeps anything not yet sent on your device.
- **Reset My Analytics ID** gives this device a new random ID. Events not yet sent stay on the device.
- **Delete My Shared Data** asks Penmoss's server to delete everything this device shared, then gives it a new ID. It asks first; the record on your device stays.

With the CLI:

| Command                        | What it does                                      |
| ------------------------------ | ------------------------------------------------- |
| `penmoss analytics status`     | Your answer, the ID, the counts and the limits    |
| `penmoss analytics on` / `off` | Turns sharing on or off, as the switch does       |
| `penmoss analytics reset`      | A new analytics ID                                |
| `penmoss analytics forget`     | Deletes your shared data, then a new ID           |
| `penmoss analytics show`       | The record, newest first                          |
| `penmoss analytics limits`     | The limits below; `limits set` and `limits reset` |

The CLI and the MCP server follow the app's answer, never ask, and never send anything themselves; the app sends their events. `DO_NOT_TRACK=1` or `PENMOSS_ANALYTICS=off` in their environment keeps their events on your device.

## Limits

**Settings → Privacy → Advanced**, or `penmoss analytics limits set <key> <value>`:

| Setting                   | Key            | Default  | Range         |
| ------------------------- | -------------- | -------- | ------------- |
| Keep Events For           | `events.days`  | 7 days   | 1–360 days    |
| Keep at Most              | `events.max`   | 5,000    | 500–800,000   |
| Log File Size             | `logs.fileKb`  | 1,024 KB | 256–81,920 KB |
| Log Files Kept            | `logs.files`   | 2        | 1–5           |
| Keep Log Lines For        | `logs.days`    | 7 days   | 1–360 days    |
| Attach Logs from the Last | `report.hours` | 24 hours | 1–168 hours   |
| At Most (lines)           | `report.lines` | 300      | 50–2,000      |
| At Most (KB)              | `report.kb`    | 16 KB    | 4–40 KB       |

Lowering a limit that would delete events or logs asks first and says how much; **Cancel** keeps the old value. Raising a limit never brings back what was deleted. **Reset to Defaults** puts every limit back.

## Logs

The apps also keep a log on the device, with names, paths, IDs and secrets replaced as each line is written. It leaves only when you attach it to a bug report ([Send feedback](/docs/help/feedback/#anonymised-logs)), or on Android when you share it with **Settings → Privacy → Share Log File**. On the Mac, **Show Log File** shows it in Finder.
