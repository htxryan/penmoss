# Security policy

## Reporting a vulnerability

Please report security issues privately, through GitHub's [private vulnerability reporting](https://github.com/htxryan/penmoss/security/advisories/new) (the repository's **Security** tab, then **Report a vulnerability**). Do not open a public issue or pull request for a vulnerability.

Include what you found, how to reproduce it, and which app and version it affects (Settings → About on the Mac, or the app's info on Android). You will get an answer within a week. Once a fix ships, the advisory is published with credit to you, unless you would rather stay anonymous.

## Supported versions

Fixes go into the next stable release. Only the newest stable release, and the Alpha channel's newest build, get security fixes.

## Scope

Penmoss runs on your own devices and keeps notes in a git repository you choose. Of particular interest:

- anything that lets a note, a pasted page, an embedded file or a git repository run code or read data it should not;
- the local MCP server and the `penmoss` CLI, which give AI agents access to your notes;
- the relay (`apps/relay`), the one hosted service, which lets claude.ai reach a notebook over remote MCP;
- how tokens are stored (the macOS Keychain and Android's Keystore) and where they are sent;
- the update feeds and the signatures on release files.

Your GitHub account, your git host and the AI agents you connect are outside this project's control.
