# Penmoss Mac app: agent test script

A thorough test pass of the Penmoss Mac app for an agent running on Ryan's Mac, such as Claude Code. Work through every section, record a result for every check, and finish with a written report. Ryan reads the report and passes it to the Penmoss build agent.

## Ground rules

These rules come first. If a step would break one, skip the step and mark it **Blocked**.

1. **Work only in your own test folder.** Create a top-level folder named `QA Mac <YYYY-MM-DD HHMM>` and create, edit, move, tag and trash notes only inside it. Never edit, move, rename, tag or trash anything outside it. In particular, never touch **Assistant Memory** or Ryan's other notes. You may open and read other notes, but don't type in them.
2. **Never delete anything for good** except notes and folders you created, and only through the app's Trash.
3. **Account and device actions belong to Ryan.** Don't sign out, don't revoke tokens or devices, don't use "Sign out every other device", and don't create a recovery code. Never answer a Touch ID or password prompt. List those checks under "For Ryan" in the report.
4. **Keep your network up.** You need it to run, so don't turn Wi-Fi off or block hosts. Offline checks are listed for Ryan.
5. **Put settings back.** Before changing any setting (theme, Display, shortcuts, full width, sidebar), note its value, and restore it in the Cleanup section.
6. **Don't change macOS settings.** That includes appearance, accessibility and login items. The one exception is granting your terminal Accessibility and Screen Recording access if Ryan agrees to it.
7. **No secrets in the report.** Leave out tokens, recovery codes and the contents of Ryan's own notes. Note titles outside your folder are fine only if you need them as evidence.

## How to drive the app

- **Screenshots:** `screencapture -x -o ~/Desktop/penmoss-qa/<step>.png`, or `-l <windowid>` for a single window. Take one for every failure and for each section's main screen. Look at every screenshot you take: what's on screen is the evidence.
- **Keys and clicks:** use `osascript` with System Events, for example `tell application "Penmoss" to activate`, then `tell application "System Events" to keystroke "k" using command down`. Menus can be listed and clicked through `menu bar 1 of process "Penmoss"`. If System Events is refused, ask Ryan to allow Accessibility for your terminal app, then carry on.
- **Typing:** type with `keystroke` in short chunks, or paste through `pbcopy` and ⌘V. Wait about half a second after each action, and take a screenshot before you judge the result.
- **Shortcuts:** don't assume them. Open the app's own list (Keyboard shortcuts, ⌘/) and test the bindings it shows. A shortcut that doesn't do what the list says is a failure.
- **The server's view:** if the `penmoss` MCP server is connected in your session, use it to check what the server holds: `search_notes`, `read_note`, `create_note`, `append_to_note`, `move_note`, `trash_note`, `restore_note`, `list_folder`, `create_folder` and so on (list the tools first). Your agent token's changes count as an **agent's**, which several checks depend on. If it isn't connected, mark those checks Blocked; don't use another way in.
- **Time:** after an action on one side, give sync up to 10 s before you call it a failure. Record how long it took.

## Report format

Write `~/Desktop/penmoss-qa/report.md` as you go, so a crash loses nothing:

```
# Penmoss Mac QA, <date>, build <CFBundleVersion>
## Summary
<pass/fail counts, the 5 worst problems, overall impression in 3 sentences>
## Results
| ID | Check | Result (Pass/Fail/Partial/Blocked) | Notes, timings, screenshot |
## Bugs
### B1 <title> (severity: blocker / major / minor / cosmetic)
Steps: … Expected: … Actual: … Screenshot: … Repeats: n of m
## UX feedback
<friction, confusing wording, inconsistent behaviour, slowness, things that felt good>
## For Ryan
<checks that need Touch ID, a password, going offline, or a decision>
```

Number bugs B1, B2 and so on. Count a check as **Partial** when it mostly works. Keep the result line short and put the detail in Bugs. UX feedback should be concrete: what you did, what you expected, what happened.

## 0. Setup and build

| ID  | Check                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Record the build number: `defaults read /Applications/Penmoss.app/Contents/Info.plist CFBundleVersion`. It should be **252 or later**. If it's lower, stop and tell Ryan to install the latest dmg from the [Releases page](https://github.com/htxryan/penmoss/releases/latest). |
| S2  | `codesign --verify --deep --strict /Applications/Penmoss.app` passes, and `spctl -a -vv /Applications/Penmoss.app` says `accepted` and `source=Notarized Developer ID`.                                                                                                          |
| S3  | Quit Penmoss if it's running, then time a launch to the first usable window. Take a screenshot.                                                                                                                                                                                  |
| S4  | The sync pill under the logo reads **Synced** within about 15 s. If it says **Sync stopped**, click it, screenshot what it says, and record whether it recovers on its own within a minute (#115).                                                                               |
| S5  | The folder tree shows **Assistant Memory**, and its note count roughly matches what `list_folder` and `search_notes` report for it. Read only; don't open notes to edit.                                                                                                         |
| S6  | Create the QA folder from rule 1, and record each setting you will change, with its current value, under "Settings before".                                                                                                                                                      |

## 1. Notes and sync

| ID  | Check                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | New note (use the shortcut from the list) inside the QA folder. Give it a title and three paragraphs. The status bar shows the word count and ends on "Saved · synced".                       |
| N2  | Within 10 s, `read_note` on the server returns exactly that text.                                                                                                                             |
| N3  | `create_note` from MCP into the QA folder. It appears in the app's tree within 10 s. Open it: the text matches.                                                                               |
| N4  | With the note open in the app, `append_to_note` from MCP. The new line appears live in the editor, the cursor isn't moved and nothing is lost.                                                |
| N5  | Type in the app and append from MCP to the same note within the same second. Both edits survive and neither is doubled.                                                                       |
| N6  | Rename a note through its title. The tree, the window title and the server (`read_note`) all update.                                                                                          |
| N7  | Quit with ⌘Q straight after typing a sentence, then relaunch. The sentence is there and reaches the server.                                                                                   |
| N8  | Open 3 notes one after another quickly. The recent-notes switcher (⌘E, or whatever the list shows) cycles them.                                                                               |
| N9  | Version history: open it, read the explainer, and check that versions are listed and "Save a version now" works. Restore an older version of a QA note; the restore appears as a new version. |
| N10 | Info panel: word count and dates. **Kind** shows only for daily or weekly notes ("Daily note"), not for an ordinary note.                                                                     |
| N11 | Full-width toggle and sidebar collapse (from the list) work, and both survive a relaunch.                                                                                                     |

## 2. Editor

Do all of this in one QA note called "Editor torture".

| ID  | Check                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Markdown shortcuts: `#`, `##`, `###`, `-`, `1.`, `[ ]`, `>`, `---`, and ``` for a code block. Each turns into the right block as you type.                           |
| E2  | Inline: bold, italic, strikethrough and inline code, by shortcut and by markdown (`**x**`, `_x_`, `~~x~~`, `` `x` ``).                                               |
| E3  | Slash menu: type `/` and insert each item it offers (table, callout, checklist, mermaid, math, image, and so on). Each one inserts and can be edited.                |
| E4  | Table: add and delete rows and columns, Tab between cells, paste a block of 3×3 tab-separated text into it.                                                          |
| E5  | Checklist: tick and untick by click and by keyboard. Ticks survive a reload of the note.                                                                             |
| E6  | Code block: pick a language. Highlighting appears, Tab indents, and it copies cleanly.                                                                               |
| E7  | A Mermaid diagram (`graph TD; A-->B`) and a math block (`e^{i\pi}+1=0`) both render. A deliberate error in each shows a readable error, not a blank.                 |
| E8  | Drag handle: reorder three paragraphs by dragging; the order sticks.                                                                                                 |
| E9  | Toggle Markdown source (shortcut from the list). The source is sensible markdown, and editing it changes the rich view.                                              |
| E10 | Undo and redo across 10 mixed edits; nothing is lost or duplicated.                                                                                                  |
| E11 | Paste rich text from Safari or Mail. Paste a 30 KB plain-text block (`pbcopy`), then type at the end: typing still feels instant. Record anything that feels laggy.  |
| E12 | Copy note as rich text, then paste into TextEdit (rich) and check the formatting. Copy as Markdown, then check `pbpaste` gives clean markdown.                       |
| E13 | Images: paste a screenshot from the clipboard. It uploads, shows, and reaches the server, then shows on reopen. Drag a PDF in from Finder: it attaches and opens.    |
| E14 | A picture by web address, `![x](https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg)`, loads.                                                            |
| E15 | Wikilinks: type `[[` and link another QA note. Clicking the link opens that note, whose Info panel lists the backlink. Embed a note with `![[…]]`; it renders.       |
| E16 | Tags: add `#qa-mac` in the text and through Add tag. Add tag suggests existing tags as you type, by keyboard too. The tag filter in the sidebar then shows the note. |
| E17 | Spelling, emoji (⌃⌘Space), accented characters (⌥e e) and dictation (Fn Fn, if available) all insert correctly.                                                      |

## 3. Folders, the sidebar and Trash

| ID  | Check                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Inside the QA folder, make subfolders A and B, with A2 inside A. Rename A2 with F2.                                                                                                                                                                                       |
| F2  | Drag a note into B and drag A2 into B. Drag B into A2's subtree: the app refuses (a loop), the message is clear, and it doesn't cover or block the next drag.                                                                                                             |
| F3  | Reorder rows with the keyboard (the move-up and move-down keys in the list) and with the mouse. Switch sorting: Manual, A–Z, Last modified.                                                                                                                               |
| F4  | ⌘-click two notes, then Ctrl-click (or two-finger click) one of them. Penmoss's own menu opens, naming the notes it acts on: "Move 2 notes…" and "Move 2 notes to Trash". Move both into A, then Trash both, then **Undo**: both come back to A.                          |
| F5  | ⌘-click a note, then open a different note. The menu no longer counts the old selection; it never acts on notes you can't see.                                                                                                                                            |
| F6  | Ctrl-click a folder: Rename and Delete folder…. Delete B, which holds notes. The dialog says what goes to Trash and that it can be restored for 30 days.                                                                                                                  |
| F7  | Trash: B is listed as a deleted folder. Restore it with its notes and subfolders, back where they were.                                                                                                                                                                   |
| F8  | Trash a QA note through MCP (`trash_note`). In the app's Trash it shows **"by <agent name> ✦"**, and History offers **no Revert** on its "Moved to Trash" version. Restore it from the app.                                                                               |
| F9  | Agent activity (Settings, or the command palette): move a QA note with MCP (`move_note`). The move is listed under the agent with **Undo**. Undo puts the note back. Then move it by hand, run the agent's Undo on another move, and check it refuses safely, saying why. |
| F10 | Delete for good a QA note from Trash. Expect a confirmation, then a Touch ID prompt. **Cancel** at Touch ID and check nothing was deleted. Leave the real confirmation for Ryan.                                                                                          |

## 4. Search, navigation and views

| ID  | Check                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Search (shortcut from the list) for a word in your Editor torture note: it's found, with the word highlighted. There's **no type picker**, because search is always hybrid.                                                                              |
| Q2  | Search for a meaning, not the words (e.g. "diagram of steps" should find the Mermaid note). Record whether the right note comes first.                                                                                                                   |
| Q3  | Search for nonsense (`zqxv qa`): **"No notes match"**. Record any obviously unrelated hits.                                                                                                                                                              |
| Q4  | Search for 5 real topics Ryan writes about (read titles in the tree to pick them). Record whether the results look right; this checks the 0.45 similarity floor on real notes. Don't open the notes to edit them.                                        |
| Q5  | Command palette (⌘K): run 10 commands from it, including Settings, Graph, Today's note, This week, Toggle dark mode (toggle back afterwards) and Trash. Each does what it says.                                                                          |
| Q6  | Quick open (⌘P): type part of a title; it opens the note.                                                                                                                                                                                                |
| Q7  | Today's note and This week's note open or create the right periodic note. The calendar moves between days. Don't type in Ryan's real daily notes; just open and close them.                                                                              |
| Q8  | Graph: it opens, nodes can be dragged, the filter works and clicking a node opens the note. The local graph of a QA note shows its links.                                                                                                                |
| Q9  | Keyboard shortcuts list (⌘/): open it, then try every shortcut in it once in a sensible place. List any that do nothing or the wrong thing.                                                                                                              |
| Q10 | Rebind New note to another free combination in Settings → Keyboard shortcuts, use it, then reset it to the default. The default works again, and the change reached the server: check through `read_note` or the web if you can, otherwise mark Partial. |

## 5. Settings

| ID  | Check                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | The order reads **Appearance, Display, Daily notes, Keyboard shortcuts, Sync, Git mirror, Status, Devices and agent tokens**.         |
| T2  | Appearance: switch themes, then light and dark. Every screen stays readable; screenshot any with poor contrast. Restore the original. |
| T3  | Display: hide Today, This week, Graph and Commands. They leave the sidebar and its rail, while Search always stays. Restore them.     |
| T4  | Sync: the state is clear, and "Sync stopped" (if you see it) leads to what fixes it. Don't turn sync off.                             |
| T5  | Git mirror and Status (backups and errors): read them only. Record any errors listed in Status, with times.                           |
| T6  | Devices and agent tokens: this Mac is first and labelled. Look only (rule 3).                                                         |

## 6. Mac integration

| ID  | Check                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Menu bar: list every menu item with its shortcut (System Events), and check none is greyed out without a reason. ⌘, opens Settings.                                                                                                                                                                                                                                                |
| M2  | Quick capture: from Finder, press the global capture shortcut (shown in the list; ⌃⌥⌘N by default), type a line and press ⌘Enter. The line lands in the capture destination. Check where that is in Settings first; if it's today's daily note, check the line is there and record it so Ryan can remove it. Type, switch apps, press the shortcut again: the text is still there. |
| M3  | Deep link: `open "penmoss://note/<id of a QA note>"` opens that note.                                                                                                                                                                                                                                                                                                              |
| M4  | Window: resize to the smallest size and to full screen. The layout holds. Use ⌘W, ⌘M and ⌘H, click the Dock icon, then ⌘Q and relaunch: the last note reopens.                                                                                                                                                                                                                     |
| M5  | Change the macOS appearance only if rule 6 allows it; otherwise skip. Theme "System" follows it.                                                                                                                                                                                                                                                                                   |
| M6  | Memory and CPU: with 5 notes opened, record `ps -o rss,%cpu -p $(pgrep -f Penmoss.app                                                                                                                                                                                                                                                                                              | head -1)` at idle and while typing. |
| M7  | Logs: look in `~/Library/Logs/Penmoss` and the app's Status for errors made during your run, and list them.                                                                                                                                                                                                                                                                        |
| M8  | Keyboard only: reach the sidebar, a note, the toolbar and Settings with Tab and arrows. Focus is always visible. Record any trap.                                                                                                                                                                                                                                                  |
| M9  | VoiceOver, optional and only if Ryan says yes: rows, buttons and the editor are read with sensible names.                                                                                                                                                                                                                                                                          |

## 7. Cleanup

1. Restore every setting from "Settings before", and check each one.
2. Trash the QA folder (rule 2), then Delete it for good from Trash only if Ryan says so. Otherwise leave it in Trash; it expires in 30 days.
3. Remove anything you put in a daily note (M2), or list it for Ryan.
4. Fill in the Summary and give Ryan the report's path. Keep the screenshots in `~/Desktop/penmoss-qa/`.

## For Ryan (manual, not for the agent)

- **Touch ID:** Delete for good, a recovery code, and Sign out every other device. Each asks for Touch ID, and Cancel refuses (docs/desktop.md §5 steps 6, 7 and 12).
- **Offline:** turn Wi-Fi off, edit and create notes and folders, quit, relaunch, edit again, then turn Wi-Fi on. Everything syncs, and nothing is lost or doubled.
- **Sign out and sign in again:** Devices on the web still lists one entry for this Mac.
- **Auto-update:** when the next build is published, quit the app. It updates, and the build number goes up.
