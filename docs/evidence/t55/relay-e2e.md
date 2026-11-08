# T55: the relay end to end (4 Nov 2026)

The relay at `https://mcp.penmoss.app` runs Worker version `7974d67d` (#196 with main merged, so it reads format 2). It serves `htxryan/penmoss-notebook`, which holds Ryan's personal workspace (T56, commit `34fc013`, 51 notes). The Mac runs Penmoss build 401 (from `build-401`).

## Sign-in

- claude.ai → Settings → Connectors → custom connector `https://mcp.penmoss.app/mcp`. The relay's consent page appears, then GitHub sign-in as htxryan. claude.ai gets a token, and the relay log shows `/register`, `/authorize`, `/callback`, `/token`, then `POST /mcp` calls.
- Reconnecting failed at first. When GitHub had already authorized the App it redirected straight back, so the consent form's redirect chain ended at claude.ai, and the page's `form-action` CSP blocked that last hop. Fixed in c383088 (the consent page's `form-action` allows the redirect hosts) and tested in `worker.test.ts`.

## Round trip

1. On the Mac: `penmoss new "Relay E2E from Mac" --text "… Code word: heron-42." --folder "Test Folder" --notebook personal` pushed commit `ebfdbfb`.
2. In claude.ai (Opus 5.5, Penmoss connector), Claude was asked to read that note, create "Relay E2E from claude.ai" (body with reply word `kestrel-17`), and run `list_recent`. Its answer gave the code word **heron-42**, confirmed it created the note, and said `list_recent` returned 20 notes (the default limit), led by the new note and then the Mac's.
3. The relay pushed commit `393d06b` within seconds, authored `claude.ai (Penmoss relay)`, with trailer `Penmoss-Writer: 01M6JE1M53N8VX8ZNKS0770C36 (agent "claude.ai")`.
4. On the Mac, `penmoss notebook sync personal` reported "1 note changed elsewhere", and `penmoss search kestrel --notebook personal` found "Relay E2E from claude.ai".

## The copy after the import

T56's import replaced the branch's history, so the relay's copy pointed at a commit the branch no longer had (`branch_gone`), and it kept serving the old empty copy. Fixed in 7bff662 (A998): on `branch_gone` or `other_notebook`, the copy is cleared and read again. After the deploy, the live log showed `The target holds the notebook "Personal" (01M6J9GY…), not "personal" (01M6J8VS…). Starting again from the repository.`

## Not yet done

- The connector on Ryan's phone.
- An edit, as opposed to a create, from claude.ai, seen in the Mac app's History under "claude.ai". The Mac app's window was not checked in this run; the CLI in the same app bundle was.
