# The relay: Penmoss in claude.ai

The relay lets Claude on the web, desktop and mobile apps use [git notebooks](https://penmoss.app/docs/first-notebook/) (T55, D48). It is one Cloudflare Worker that serves the notebooks' MCP tools over HTTP and reads and writes each notebook's repository through GitHub's API. It stores no notes: each copy is a cache of its repository, rebuilt from GitHub whenever needed.

|               | Relay                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Where it runs | `https://mcp.penmoss.app/mcp`                                         |
| Notes         | Several git notebooks, each in a GitHub repository (A1695)            |
| Sign-in       | OAuth: GitHub, as the owner, through the relay's own App (A1697)      |
| Tools         | The local MCP server's (A830), without the comment tools (D50, A1064) |
| Search        | By words (#192 adds search by meaning)                                |
| Code          | `apps/relay`; decisions A996–A1001, A1695–A1700                       |

## How it behaves

- **Several notebooks**: the tools are `penmoss mcp`'s for several notebooks (A1584). An id finds its notebook, searches and lists span them all, a new note names its `notebook`, and nothing moves between notebooks. Each notebook is named by its own `notebook.json`, with its repository added when two share a name (A1696).
- **Before a call** it pulls that notebook, when its last sync is 15 seconds old or more, so Claude sees what the Mac pushed (A998).
- **A write** is saved at once and pushed to GitHub 5 seconds after writes settle. `save_version` pushes right away. A failed push is tried again every minute.
- **Edits are an agent's**: the writer `claude.ai`, shown in History and agent activity, where they can be reverted.
- **Any repository**: public and private repositories sync alike; the relay asks GitHub nothing about privacy (D61, A1530).
- **One copy per notebook, one call at a time on each**: one Durable Object holds every notebook's copy, each with its own queue and sync, so one notebook failing leaves the others serving (A996, A1695).

## Set it up

Anyone runs a relay of their own from the template, with the **Deploy to Cloudflare** button on [htxryan/penmoss-relay](https://github.com/htxryan/penmoss-relay). The user docs walk through it: [Use Penmoss in Claude](https://penmoss.app/docs/agents/claude-ai/). Ryan's relay at `mcp.penmoss.app` is deployed from this repository instead, as below. Steps 2 to 4 are the same for both.

### 1. Deploy the Worker

`apps/relay/wrangler.jsonc`'s top level is the generic relay the template is built from: no KV id, no route, no owner (A1700). Ryan's relay is its `penmoss` environment, which keeps the Worker's name (`penmoss-relay`, and so its Durable Object), the `mcp.penmoss.app` custom domain, its KV namespace and `OWNER_GITHUB_LOGIN`. With Wrangler signed in (`pnpm --filter @penmoss/relay exec wrangler login`):

```bash
task relay:deploy
```

It runs `wrangler deploy --env penmoss` with the relay's version built in: the source commit and its date, and `+ changes` when the relay or a package it bundles has uncommitted edits. Every page shows it on its last line. A plain `wrangler deploy` in `apps/relay` deploys the generic config as another Worker, `penmoss-relay-dev`, never Ryan's.

### 2. Make the relay's GitHub App

Open the relay's `/setup` (`https://mcp.penmoss.app/setup` for Ryan's), signed in to GitHub as the owner, and choose **Create GitHub App…**. GitHub opens with the App filled in: read and write access to contents, metadata read, no webhook, only on your account. Create it there; GitHub sends you back, and the relay keeps the App's id, key and secrets in its own storage (A1697). An App made by any other account is refused and nothing is kept. A relay makes its App once.

Then choose **Install on GitHub…**, pick **Only select repositories**, and choose the notebooks' repositories. The relay finds the installation for each repository itself.

### 3. Add the notebooks

**Sign In with GitHub** on the setup page, or open `https://mcp.penmoss.app/notebooks`, signed in as the owner (A1698). The Notebooks page lists what the relay serves, when each notebook last synced, and the connector's address (A1699).

- **Add Notebook…**: the repository (those the App is installed on are offered), and **GitHub App** or **Token**; then its branch (the default first) and its folder, empty for the top. The relay adds it only when it can read the notebook's `.penmoss/notebook.json` there.
- A notebook in a repository the App can't be installed on (an organisation's, say) uses **Token**: a fine-grained personal access token limited to that repository, with **Contents: Read and write**. The page shows only its last four characters; **Replace Token…** changes it.
- **Remove…** asks first. The notes stay in the repository; the relay pushes Claude's unpushed edits, then deletes its copy.

### 4. Connect claude.ai

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. **Name** `Penmoss`, **URL** `https://mcp.penmoss.app/mcp`, then **Add**.
3. Choose **Connect**. The relay shows what Claude is asking for. Choose **Continue with GitHub** and sign in as the owner.
4. Turn the connector on in a conversation (**+ → Connectors**). Connectors added on the web are also available in Claude's mobile apps.

## When something is wrong

- **“This Relay Isn’t Yours”**: you signed in to GitHub as another account than `OWNER_GITHUB_LOGIN`.
- **“This App Isn’t the Owner’s”** on setup: the App was made while GitHub was signed in as another account. Delete that App on GitHub, sign in as the owner and start again.
- **“This Relay Isn’t Set Up”**: it has no GitHub App yet; open `/setup`.
- **“This App Can’t Connect”**: the connector's redirect is not on `ALLOWED_REDIRECT_HOSTS` (claude.ai and claude.com by default).
- A 503 from `/mcp`: `OWNER_GITHUB_LOGIN` is missing or wrong; the message says so.
- **The relay's GitHub App is not installed on owner/name**, beside a notebook on the Notebooks page: install the App on that repository, or remove the notebook and add it again with a token. A notebook that fails is left out of searches and lists (`skipped`, with the reason) while the others serve.
- Logs: `pnpm exec wrangler tail` in `apps/relay`.

## The template

The Deploy to Cloudflare button builds one public folder by itself, and the relay bundles `packages/core`, `git-notebook`, `model` and `ui` from this monorepo. So the button points at [htxryan/penmoss-relay](https://github.com/htxryan/penmoss-relay), which holds a self-contained build (A1700):

- `index.js`: the bundled Worker, with its version in it (`no_bundle` in its config).
- `wrangler.jsonc`: the top level of `apps/relay/wrangler.jsonc`, named `penmoss-relay`. Its KV namespace has no id, so Cloudflare makes one on the first deploy.
- `package.json`: Wrangler, and `cloudflare.bindings`, the deploy form's words for each setting.
- `.dev.vars.example`: `OWNER_GITHUB_LOGIN`, a secret there so the form asks for it.
- `README.md` with the button, `LICENSE` and `.gitignore`.

`task relay:template -- <dir>` builds it into a folder, then runs `wrangler deploy --dry-run` on a copy in an empty folder, as the button would. CI's Check job runs that on every pull request. On main, the **Relay template** workflow (`.github/workflows/relay-template.yml`) builds it again whenever the relay or a package it bundles changes, and commits it to htxryan/penmoss-relay, naming the source commit and the build. Nothing is pushed when the template is unchanged.

The workflow pushes with a deploy key: `RELAY_TEMPLATE_DEPLOY_KEY`, an SSH private key in the `relay-template` environment (limited to main), whose public half is a deploy key with write access on htxryan/penmoss-relay alone.

Someone's copy of the template is a repository of their own and doesn't follow this one. They update by uploading the new `index.js` to it; Workers Builds deploys it. A change to the template's `wrangler.jsonc` (a new binding, a Durable Object migration) needs them to edit theirs too, so the user docs and the template's README must say so when it happens.
