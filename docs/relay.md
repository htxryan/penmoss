# The relay: Penmoss in claude.ai

The relay lets Claude on the web, desktop and mobile apps use a [git notebook](https://penmoss.app/docs/first-notebook/) (T55, D48). It is one Cloudflare Worker that serves the notebook's MCP tools over HTTP and reads and writes the notes repository through GitHub's API. It stores no notes: its copy is a cache of the repository, rebuilt from GitHub whenever needed.

|               | Relay                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Where it runs | `https://mcp.penmoss.app/mcp`                                         |
| Notes         | One git notebook in a private GitHub repository                       |
| Sign-in       | OAuth: GitHub, as the one allowed account                             |
| Tools         | The local MCP server's (A830), without the comment tools (D50, A1064) |
| Search        | By words (#192 adds search by meaning)                                |
| Code          | `apps/relay`; decisions A996–A1001                                    |

## How it behaves

- **Before a call** it pulls, when its last sync is 15 seconds old or more, so Claude sees what the Mac pushed (A998).
- **A write** is saved at once and pushed to GitHub 5 seconds after writes settle. `save_version` pushes right away. A failed push is tried again every minute.
- **Edits are an agent's**: the writer `claude.ai`, shown in History and agent activity, where they can be reverted.
- **The repository must be private** (A841). The relay checks with GitHub, trusts “private” for an hour, and refuses every call while the repository is public.
- **One copy, one call at a time**: a Durable Object holds the copy, as the clone lock does on a Mac (A996).

## Set it up

You need the notes repository (a private GitHub repository holding a git notebook), a Cloudflare account with `penmoss.app`, and Wrangler (`pnpm --filter @penmoss/relay exec wrangler login`).

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
4. **Install App** on your account, choose **Only select repositories**, and pick the notes repository. The installation's URL ends in its id (`…/installations/<id>`).

A fine-grained personal access token limited to the notes repository, with **Contents: Read and write**, can stand in for the App's key (`GITHUB_TOKEN` below). Sign-in still needs a GitHub App or OAuth App for its client id and secret.

### 2. Configure the Worker

```bash
cd apps/relay
pnpm exec wrangler kv namespace create OAUTH_KV
```

Put the namespace id into `wrangler.jsonc` (`kv_namespaces[0].id`), and fill in its `vars`: `NOTES_REPOSITORY` (`owner/name`), `NOTES_BRANCH`, `NOTES_DIR` (the notebook's directory, empty for the top), `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_CLIENT_ID`. `ALLOWED_GITHUB_LOGIN` is the one account that may sign in.

### 3. Add the secrets

```bash
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/penmoss-relay.*.private-key.pem
```

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
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
- **“… is public”**: make the notes repository private on GitHub. The relay never syncs a public repository.
- **“The relay is not set up”** or a 503 from `/mcp`: a setting or secret is missing; the message names it.
- **GitHub refused the App's installation token**: the App is not installed on the notes repository, or the key, App id or installation id is wrong.
- Logs: `pnpm exec wrangler tail` in `apps/relay`.
