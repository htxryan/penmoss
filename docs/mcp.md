# Penmoss MCP: for contributors

**How to connect an agent and what each tool does is in the user docs: [How agents work](https://penmoss.app/docs/agents/) and [MCP tools](https://penmoss.app/docs/reference/mcp/).** This page keeps how the two servers fit together.

Penmoss serves its notes to AI agents through the [Model Context Protocol](https://modelcontextprotocol.io) in two ways. Both work on git notebooks, with no Penmoss account (D48):

|               | Local server                                             | The relay                                                  |
| ------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| Where it runs | On your Mac: `penmoss mcp --notebook <name>`, over stdio | `https://mcp.penmoss.app/mcp`, a Cloudflare Worker (T55)   |
| For           | Claude Code, Codex and other agents on the same machine  | Claude on the web, desktop and mobile (a custom connector) |
| Notes         | One git notebook, through its own clone                  | Ryan's one notebook repository, through GitHub's API       |
| Sign-in       | None: the notebook's own git access                      | GitHub, as the one allowed account                         |

- **Code.** The tools' names, descriptions and schemas are `packages/core/src/mcp/tools.ts`; the local server is `packages/git-notebook/src/local/mcp.ts` (`LocalMcpServer`), which replaces some descriptions for git notebooks (`DESCRIPTIONS`). The CLI's side is [`cli.md`](cli.md); the relay's is [`relay.md`](relay.md).
- **The same tools.** Both serve the same tools on the git-notebook engine, but for comments. The local server also searches by meaning when the model is on the Mac: `search_notes` in `hybrid` (the default) finds notes by their words and by what they are about, and `semantic` by meaning alone. It embeds in a worker thread; whichever process holds the indexing lease (normally the app) embeds notes in the background, and results say how many notes meaning covers until it is done (A1156, A1157). The relay searches by words only (A1161, #236). Every edit an agent makes is committed under its own writer, so the note's History names it and can revert it.
- **Comments.** Only the local server has the five comment tools (`list_comment_threads`, `read_comment_thread`, `create_comment_thread`, `reply_to_comment_thread`, `resolve_comment_thread`), with the names and arguments the server's had (D50, A1064). They read and write the threads in the notes of the agent's clone, as its writer; `sentToMe: true` lists the threads sent to this agent, reading one marks it seen, and a reply marks it replied (A1061). The relay leaves them out (`RELAY_ABSENT_TOOLS`): a call there says so.
- **Channel.** `penmoss mcp --notebook <name> --channel` also makes the local server a Claude Code channel, so a comment sent from **Send to…** in the Mac app arrives in the session by itself, through the notebook's repository (A1063).
- **Changing a tool.** A tool's name, arguments or behaviour changing is a user-facing change: update [the MCP tools page](../site/src/content/docs/docs/reference/mcp.md) in the same pull request.

The Penmoss server's remote MCP at `api.penmoss.app/mcp`, with its agent tokens and folder-scoped tokens, was removed with the server (D49, T59).
