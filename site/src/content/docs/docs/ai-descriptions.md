---
title: AI Descriptions
description: Have AI write a short description of each note into its frontmatter, so agents can tell what a note holds before they open it.
---

This page shows you how to have AI write a short description of each note, and what that sends where. Descriptions are for [agents](/docs/agents/): they see a note's description wherever the note is named, so they can choose which notes to read. It works on the Mac and on Android.

A description is one or two sentences in the note's frontmatter, as `description:`. You can always write or change one yourself. AI Descriptions only writes the ones you let it.

## Turn it on

The first run asks once, **Describe Notes for Agents?**, with **Not Now** picked. To turn it on later:

1. Open **Settings → AI Descriptions**.
2. Under **AI Provider**, pick who writes the descriptions (see [AI providers](#ai-providers)).
3. Set **Describe Notes** to **On**.

Until you pick a provider, nothing is sent and notes wait.

## Which notes are described

Each note, folder and notebook has its own setting, **Inherit**, **On** or **Off**. The closest one that isn't Inherit wins:

1. The note's own, in its **Metadata** tab under **AI Description**.
2. Its folder's, then each folder above it: right-click a folder in the sidebar on the Mac and pick under **AI Descriptions**.
3. The notebook's, on its page in **Settings → All Notebooks** on the Mac.
4. **Describe Notes**, in **Settings → AI Descriptions**, for everything else. It is Off until you turn it on.

The Metadata tab shows what a note comes to, such as **● On**, and where that comes from: a folder, the notebook, or **Everywhere** (Settings). Android follows the folder and notebook settings made on the Mac, and its Metadata tab sets the note's own.

## When a note is described

A note is described after you stop changing it, and only if its title, tags or text changed since its last description.

- **Describe a Note: After a Pause** (the default) waits for the pause you pick, 2 minutes unless you change it.
- **At Sync** waits until the notebook has synced.

**Describe Now**, in the Metadata tab, describes the note straight away. **Describe Notes Now…**, in a folder's menu or on a notebook's page, describes every note there that wants one. It tells you how many first, and **Stop** ends it.

Only one Penmoss window on a device describes notes at a time.

## Your own description

Type in the **Description** field of the Metadata tab to write one yourself. It is marked **Written by you**. While AI Descriptions is on for the note, Penmoss asks **Keep Your Description?**:

- **Keep Mine** turns AI Descriptions Off for the note, so yours stays.
- **Let Claude Update It** lets the next change rewrite it.

An agent that sets a description with `set_properties` counts as you, and Penmoss asks the same question. **Clear** removes a description.

To show a note's description under its title, check **Description** in **Settings → Note**.

## AI providers

The provider is set on each device, and doesn't sync.

- **Anthropic (API Key)** calls Anthropic's API with your key, billed to the key. Paste the key in **Settings → AI Descriptions** and choose **Save**: Penmoss checks it with Anthropic first. It stays on that device, encrypted (in the Mac's Keychain, or Android's keystore), and is never synced or shown again. **Test Key** checks it again; **Remove** deletes it.
- **Claude Code on This Mac** runs `claude -p` with Claude Code's own sign-in, so your Claude plan covers the calls. Penmoss never sees its credentials. It needs Claude Code installed and signed in; **Check Claude Code** says whether it is.

On Android, pick Anthropic with a key, or leave it **Not Set Up**: your Mac describes the phone's notes once they sync.

**Model** picks the model. The fastest, Claude Haiku, is picked for you.

## The prompt

**Prompt**, in Settings → AI Descriptions, is what is sent for each note. These tokens are replaced with the note's own:

| Token             | Replaced with                            |
| ----------------- | ---------------------------------------- |
| `{{title}}`       | The note's title                         |
| `{{tags}}`        | Its tags                                 |
| `{{folder}}`      | Its folder's path                        |
| `{{body}}`        | Its text, cut short for a very long note |
| `{{notebook}}`    | Its notebook's name                      |
| `{{description}}` | Its description now, if it has one       |
| `{{date}}`        | Today's date                             |

Click a token to insert it. A prompt without `{{body}}` gets a warning, since the model can't see the note. **Reset to Default** brings back Penmoss's prompt. The prompt syncs with your settings.

## What is sent

For each note described, the prompt, with the note's title, tags, folder path and text, goes to the provider you picked: to Anthropic directly, or to Claude Code on your Mac, which sends it to Anthropic. Nothing else is sent, and nothing at all is sent for a note whose setting comes to Off.

The description comes back and is written into the note, which syncs through your repository as any change does.

## For agents

Agents see descriptions through the [MCP tools](/docs/reference/mcp/) and the [CLI](/docs/reference/cli/):

- `search_notes`, `list_recent`, `list_folder` and `get_backlinks` give each note's `description`.
- `read_note` gives the note's own, and `links`: each note it links to, with its description.
- `set_properties` sets one, with `description`.
- `penmoss search` and `penmoss ls` print it under each title, and `--json` includes it.
