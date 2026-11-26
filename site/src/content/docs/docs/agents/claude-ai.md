---
title: Use Penmoss in Claude
description: Let Claude on the web, the desktop app and your phone read and edit your Penmoss notebooks, through a relay you deploy to your own Cloudflare account in a few clicks.
---

This page shows you how to let Claude reach your notebooks from anywhere: claude.ai on the web, the Claude desktop app, and Claude on your phone. Claude can't run anything on your Mac from there, so it connects to a **relay**: a small server you deploy to your own Cloudflare account. The relay reads and writes your notebooks through their GitHub repositories, the same way your devices sync. Penmoss never sees your notes, and nothing runs on your Mac.

For agents on your Mac, such as Claude Code, use [Connect an agent](/docs/agents/connect/) instead.

You need:

- Notebooks that sync through GitHub ([More devices](/docs/more-devices/)).
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- A Claude plan that allows custom connectors.

## Deploy your relay

1. Open [htxryan/penmoss-relay](https://github.com/htxryan/penmoss-relay) and press **Deploy to Cloudflare**.
2. Sign in to Cloudflare and connect your GitHub account when it asks. Cloudflare copies the relay into a repository of your own and deploys it from there.
3. Under the settings, type your GitHub login as **OWNER_GITHUB_LOGIN**, such as `octocat`. Only that account can set the relay up, sign in to it and connect Claude. Leave the other settings as they are.
4. Press **Deploy**. When it finishes, open the relay's address, which ends in `workers.dev`.

## Set it up

The relay's first page is **Set Up This Relay**.

1. Choose **Create GitHub App…**. GitHub opens with an App filled in for your relay. It asks to read and write your repositories' contents, and nothing else. Choose **Create GitHub App**, and you come back to the relay. An App made by any account other than the owner's is refused.
2. Choose **Install on GitHub…**, and pick the repositories that hold your notebooks.
3. Choose **Sign In with GitHub**, as the owner.

## Add your notebooks

On the relay's **Notebooks** page, choose **Add Notebook…** for each notebook Claude may use.

1. Pick a repository the App can reach, or type one as `owner/name`. Then choose **GitHub App** or **Token**, and **Continue**.
2. Pick the branch, and type the folder if the notebook isn't at the top of the repository. Choose **Add Notebook**.

The relay checks that a Penmoss notebook is there before adding it. Each notebook shows its name, where it is, and when it last synced, or what went wrong.

A repository in an organisation that won't allow your App can use a token of its own. On GitHub, make a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for that one repository, with **Contents: Read and write**. Choose **Token** when you add the notebook, and paste it. The page shows only its last four characters, and **Replace Token…** gives it a new one.

**Remove…** stops Claude reaching a notebook. Its notes stay in the repository, and edits not yet pushed are pushed first.

## Connect Claude

1. On the **Notebooks** page, choose **Copy** beside **Connector Address**.
2. In Claude, open **Settings → Connectors → Add custom connector**. Name it Penmoss, paste the address as its URL, and choose **Add**.
3. Choose **Connect**. The relay shows what Claude is asking for: choose **Continue with GitHub**, and sign in as the owner. You come back to Claude.
4. In a conversation, turn the connector on under **+ → Connectors**.

The connector works in every Claude app you're signed in to. Ask, for example: "Search my Penmoss notes for the garden plan and add today's watering to it."

Claude's edits are committed to your notebook's repository, named **claude.ai** in History. They reach your devices the next time they sync.

## What Claude can do through the relay

Claude can search your notes by their words, read them, make and edit notes and folders, tag them, and use your daily journal, in every notebook you added. Each result names its notebook. It can't use comments, and search by meaning works only on your Mac.

## Update your relay

Every page of the relay shows its version on the last line, such as **Penmoss Relay c8ab2a16 (26 Nov 2026)**. [htxryan/penmoss-relay](https://github.com/htxryan/penmoss-relay) shows the newest version in its README.

Your copy doesn't follow it by itself. To update:

1. Download [`index.js`](https://github.com/htxryan/penmoss-relay/raw/main/index.js) from htxryan/penmoss-relay.
2. In your copy on GitHub, choose **Add file → Upload files**, drop `index.js` in, and choose **Commit changes**.

Cloudflare deploys the new version in a minute or two. Your App, notebooks and connector stay as they are.

## Your notes and keys

The relay runs on your Cloudflare account and talks only to GitHub and Claude. It keeps your App's key and any notebook tokens in its own storage on Cloudflare, encrypted at rest, and never shows them on a page. Only the owner can sign in, and it sends sign-ins only to claude.ai and claude.com.

To stop it, delete the Worker in Cloudflare's dashboard, and the App under your GitHub account's **Settings → Developer settings → GitHub Apps**.

## If something goes wrong

- **"This Relay Isn't Yours":** you signed in to GitHub as another account. Sign out of GitHub, then sign in as the owner you typed when you deployed.
- **"This Relay Isn't Set Up":** setup didn't finish. Open the relay's address and start again from **Create GitHub App…**.
- **A notebook says it can't reach its repository:** install the App on that repository, or give the notebook a token with **Replace Token…**.
- **Claude says the connector failed:** remove the connector in Claude and add it again with the address from the **Notebooks** page.
