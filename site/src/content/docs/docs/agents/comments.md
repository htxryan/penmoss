---
title: Comments to agents
description: Send a comment thread from a note to an agent's session, and get its reply in the thread.
---

This page shows you how to ask an agent to work on a passage of a note by commenting on it, and how the agent answers.

You comment on a passage, send the thread to an agent's session, and the agent reads it, edits the note if you asked, and replies in the thread. It all goes through your notebook's repository: no server and no token.

## Set it up

Any connected agent can find and answer comments with its comment tools. For the comment to arrive in a running session by itself, use Claude Code with its channel: see [Receive comments from your notes](/docs/agents/claude-code/#receive-comments-from-your-notes).

While such a session runs, it appears in Penmoss's **Send to** menus. Each session is named after the agent and the folder it runs in, so starting Claude Code again in the same folder is the same session. A session is offered for seven days after it was last seen.

## Send a thread

1. Select a passage and choose **Comment** (⌘⌥⇧M), and write what you want, such as "Make this shorter".
2. In the thread, open **Send to** and choose the session. Sessions are grouped as **Running** and **Not running**.
3. The thread shows where it is: **Sending to …**, **Sent to …**, **Seen**, then **Replied**.

The comment arrives with the quoted passage and the note's title. The agent reads the thread, makes the change and replies in it. Expect 5 to 15 seconds each way.

To stop, choose **Stop sending** in the thread's **Send to** menu. If the session has gone, the thread says **Not sent: the session is gone**, with **Send to again**.

## Without a channel

An agent without a channel still has the tools. Ask it to look: `list_comment_threads` with `sentToMe: true` lists the threads sent to it, and it can answer them with `reply_to_comment_thread`. See [MCP tools](/docs/reference/mcp/#comments).

## On Android

You can comment on Android too, and threads sent from the Mac show their state there. Sending a thread to an agent is on the Mac.
