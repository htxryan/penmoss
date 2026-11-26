# The relay: Penmoss in claude.ai

The relay lets Claude on the web, desktop and mobile apps use [git notebooks](https://penmoss.app/docs/first-notebook/) (T55, D48). It is one Cloudflare Worker that serves the notebooks' MCP tools over HTTP and reads and writes each notebook's repository through GitHub's API. It stores no notes: each copy is a cache of its repository, rebuilt from GitHub whenever needed.

|               | Relay                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Where it runs | `https://mcp.penmoss.app/mcp`                                         |
| Notes         | Several git notebooks, each in a GitHub repository (A1695)            |
| Sign-in       | OAuth: GitHub, as the one allowed account                             |
| Tools         | The local MCP server's (A830), without the comment tools (D50, A1064) |
| Search        | By words (#192 adds search by meaning)                                |
| Code          | `apps/relay`; decisions A996–A1001, A1695, A1696                      |

## How it behaves

- **Several notebooks**: the tools are `penmoss mcp`'s for several notebooks (A1584). An id finds its notebook, searches and lists span them all, a new note names its `notebook`, and nothing moves between notebooks. Each notebook is named by its own `notebook.json`, with its repository added when two share a name (A1696).
- **Before a call** it pulls that notebook, when its last sync is 15 seconds old or more, so Claude sees what the Mac pushed (A998).
- **A write** is saved at once and pushed to GitHub 5 seconds after writes settle. `save_version` pushes right away. A failed push is tried again every minute.
- **Edits are an agent's**: the writer `claude.ai`, shown in History and agent activity, where they can be reverted.
- **Any repository**: public and private repositories sync alike; the relay asks GitHub nothing about privacy (D61, A1530).
- **One copy per notebook, one call at a time on each**: one Durable Object holds every notebook's copy, each with its own queue and sync, so one notebook failing leaves the others serving (A996, A1695).

## Set it up

You need the notebooks' repositories (each a GitHub repository holding a git notebook), a Cloudflare account with `penmoss.app`, and Wrangler (`pnpm --filter @penmoss/relay exec wrangler login`).

### 1. Create the GitHub App

In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Name**: for example `Penmoss relay (htxryan)`. **Homepage URL**: `https://mcp.penmoss.app`.
- **Callback URL**: `https://mcp.penmoss.app/callback`. Leave **Request user authorization during installation** off.
- **Webhook**: turn **Active** off.
- **Repository permissions**: **Contents: Read and write**. **Metadata** is read-only by default. Nothing else.
- **Where can this GitHub App be installed?** **Only on this account**.

Create it, then:

1. Note the **App ID** and the **Client ID**.
2. **Generate a new client secret** and keep it for step 3.
3. **Generate a private key**. GitHub downloads a `.pem` file.
4. **Install App** on your account, choose **Only select repositories**, and pick the notebooks' repositories. The relay finds the installation for each repository itself.

A notebook in a repository the App can't be installed on (an organisation's, say) uses a fine-grained personal access token of its own, limited to that repository, with **Contents: Read and write** (`NOTEBOOK_TOKENS` below). Sign-in still needs the GitHub App for its client id and secret.

### 2. Configure the Worker

```bash
cd apps/relay
pnpm exec wrangler kv namespace create OAUTH_KV
```

Put the namespace id into `wrangler.jsonc` (`kv_namespaces[0].id`), and fill in its `vars`: `NOTEBOOKS`, `GITHUB_APP_ID` and `GITHUB_CLIENT_ID`. `ALLOWED_GITHUB_LOGIN` is the one account that may sign in. `NOTEBOOKS` lists the notebooks as JSON, each with its repository and, when they aren't `main` and the top, its branch and folder:

```json
[
  { "repository": "htxryan/penmoss-notes" },
  { "repository": "quantaservices/ryan-henderson-scratch", "branch": "dev", "folder": "penmoss" }
]
```

### 3. Add the secrets

```bash
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/penmoss-relay.*.private-key.pem
```

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
```

For each notebook reached by a token of its own, `NOTEBOOK_TOKENS` holds the tokens as JSON, by repository: `{"quantaservices/ryan-henderson-scratch": "github_pat_…"}`.

```bash
pnpm exec wrangler secret put NOTEBOOK_TOKENS
```

### 4. Deploy

```bash
pnpm exec wrangler deploy
```

`https://mcp.penmoss.app` should say how to connect.

### 5. Connect claude.ai

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. **Name** `Penmoss`, **URL** `https://mcp.penmoss.app/mcp`, then **Add**.
3. Choose **Connect**. The relay shows what Claude is asking for. Choose **Continue with GitHub** and sign in as the allowed account.
4. Turn the connector on in a conversation (**+ → Connectors**). Connectors added on the web are also available in Claude's mobile apps.

## When something is wrong

- **“This relay is not yours”**: you signed in to GitHub as another account than `ALLOWED_GITHUB_LOGIN`.
- **“This app cannot connect”**: the connector's redirect is not on `ALLOWED_REDIRECT_HOSTS` (claude.ai and claude.com by default).
- **“The relay is not set up”** or a 503 from `/mcp`: a setting or secret is missing; the message names it.
- **The relay's GitHub App is not installed on owner/name**: install the App on that repository, or give the notebook a token in `NOTEBOOK_TOKENS`. A notebook that fails is left out of searches and lists (`skipped`, with the reason) while the others serve.
- **GitHub refused the App's installation token**: the key or App id is wrong.
- Logs: `pnpm exec wrangler tail` in `apps/relay`.
