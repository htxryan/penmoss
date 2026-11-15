---
title: Daily and weekly notes
description: Keep a journal with a note for each day and each week, made from your own templates.
---

This page shows you how to keep a journal in Penmoss: a note for each day and each week, made from templates you choose, in the time zone you choose.

Daily and weekly notes go in your [Primary Notebook](/docs/organise/#the-primary-notebook).

## Today and this week

- **Today's Note:** ⌘D, **Today** in the sidebar, or a day in the calendar.
- **This Week's Note:** ⌘⇧W, or **This Week** in the sidebar. Weeks start on Monday and are numbered as ISO weeks.

If the note does not exist yet, Penmoss makes it from the template. So does any other device, or an agent, that asks for the same day: every device makes the same note, and they merge into one.

Above a daily note are the previous and next day, the date, and a **Week** button for its week. Above a weekly note are the previous and next week and its seven days. Choosing a day that has no note makes it. Under a weekly note's title, **What changed this week** opens the [Time Machine](/docs/time-machine/#what-changed) on that week. The commands **Previous Day or Week**, **Next Day or Week** and **The Week of This Daily Note** do the same from the keyboard.

## The calendar

The sidebar's **Calendar** shows the month, with the days that have a note marked and a **Wk** column for weekly notes. **Previous Month** and **Next Month** move it. **Show the Calendar** opens it from the command palette.

## Where they are kept

Daily notes are `Journal/2026/11/2026-11-07.md` and weekly notes `Journal/2026/Weekly/2026-W45.md`, inside the notebook. Each note's title is its date or week.

## Time zone

"Today" is the day in the notebook's time zone, so a note made on a trip, or by an agent on a server, still lands on the right day. Set it in **Settings → Daily Notes → Time zone**.

:::caution
A new notebook starts on the America/Chicago time zone. Set your own in **Settings → Daily Notes** before you start your journal.
:::

## Templates

**Settings → Daily Notes** has a **Daily template** and a **Weekly template**: the markdown a new note starts with. **Save** keeps a change and **Use the Default** goes back to the default (`## Plan` and `## Notes` for a day, `## Goals` and `## Review` for a week). A change applies to the notes made after it.

Templates can use these placeholders:

| Placeholder    | Becomes                     |
| -------------- | --------------------------- |
| `{{date}}`     | The date, `2026-11-07`      |
| `{{longDate}}` | The date in words           |
| `{{weekday}}`  | The day of the week         |
| `{{week}}`     | The ISO week, such as `W45` |
| `{{year}}`     | The year                    |
| `{{month}}`    | The month                   |

A placeholder Penmoss does not know is left as you typed it.

The time zone and the templates belong to the notebook, so every device and agent that opens it uses the same ones.
