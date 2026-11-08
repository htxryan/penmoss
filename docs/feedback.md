# In-app feedback (T49): for contributors

**How to send feedback, and what a report holds, is in the user docs: [Send feedback](https://penmoss.app/docs/help/feedback/).** This page keeps how the pipeline works.

**Send feedback**, in every client, files a bug report or a feature request as an issue in
`htxryan/penmoss`, labelled `in-app feedback`, and the issue lands on the
[Penmoss board](https://github.com/users/htxryan/projects/8) in **Triage** (D41). The form attaches
where you are in the app and the metadata of what's on screen, never a note's content. Decisions
A790–A804 in [`decisions.md`](decisions.md) hold the details.

Since T57 (D48, A1010–A1012) the **Mac app and Android file it themselves with your own GitHub
token**: see [Your GitHub token](#your-github-token-t57). Since T59 (D49, A1036) there is no
Worker and no browser client: the web app runs only inside the Mac app, so feedback never
reaches a Penmoss server.

## Where it is

| Client  | Entry points                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac     | **Send feedback** in the sidebar's footer and in the note's ⋯ menu; the palette's **Send feedback** (`app.sendFeedback`, no keys); **Help → Send feedback** |
| Android | **Send feedback** in Home's and the note's ⋮ menu, **Settings → About**, a Search action and the keyboard command                                           |

The command has no default shortcut; bind one in Settings → Keyboard shortcuts.

## Your GitHub token (T57)

- **Where:** on the Mac, **Settings → Status → GitHub Token**; on Android, **Settings → About → GitHub
  Token**. The token is kept in the Mac's Keychain (sealed with safeStorage in
  `github-token.json`) or with the Android Keystore, and is never shown again. The Mac's pages
  never see it: the main process files the issue.
- **Which token:** on the Mac, the token Sign In with GitHub keeps (D63); a classic token with the
  `public_repo` scope (`repo` while the repository is private); or, for a collaborator, a
  fine-grained token for `htxryan/penmoss` with **Issues** and **Contents** (read and write;
  Contents is what the screenshot upload needs, and what updates read the Releases with, A1015).
  A fine-grained token cannot open issues in a repository its account is not a member of, so
  people outside the project use a classic token.
- **From outside the project (T80.3, A1184):** on the public repository anyone signed in can open
  an issue, so the token check refuses an account without push or triage only while the
  repository is private. GitHub drops, without an error, the labels of an account that cannot
  triage, so such an issue arrives unlabelled; the retry lookup lists recent issues without a
  label filter and finds the submission by its footer. Whether such an account can upload
  screenshots is untested until a second account tries it on the public repository.
- **Checked when saved:** `GET /user` and `GET /repos/htxryan/penmoss`. A token GitHub does not
  accept, or one that cannot see or write the repository, is refused in plain words and not kept;
  a good one shows the account it belongs to.
- **Without one** a report waits in the outbox ("Add your GitHub token in Settings → Status →
  GitHub Token to send it.") and is filed as soon as a token is saved.
- **Refused at Send:** a 401, or a 403 or 404 that is not a rate limit, is final
  (`token_cannot_file`: "This GitHub token cannot open issues in htxryan/penmoss…"), kept for Edit,
  Retry or Discard, and Settings says it until a report is filed.
- **Once per submission:** each device keeps a ledger of what it filed or tried. A retry first looks
  the issue up by its footer and adopts it; after a create that may have landed it waits 60 s
  (A1010). Screenshots go to GitHub's issue attachments from the device (A1011).
- **Tests:** `packages/core/test/feedback-github.test.ts`, `apps/desktop/test/unit/github-token.test.ts`
  and `apps/desktop/test/e2e/send-feedback.spec.ts` run against the fake GitHub
  (`packages/core/test/support/fake-github-feedback.ts`; the Mac takes it from
  `PENMOSS_TEST_GITHUB_API`, unpackaged builds only).

## The form

- **Type** (Bug report or Feature request) and **Priority** (P1 Highest, P2 High, P3 Normal,
  P4 Lowest) are required and have no default.
- **Title**: one line, up to 256 characters.
- **Description**: bold, italic, bulleted and numbered lists (nested), links, inline code, code
  blocks and quotes, sent as GitHub markdown. The Mac uses the Penmoss editor with a reduced
  schema and the notes' markdown serialiser (A790). Android, which may hold only one editor
  WebView (A418), uses a native field with a toolbar that inserts markdown, and a preview.
- **Screenshots**: up to 6 PNG, JPEG, WebP or GIF images, 10 MB each before compression, by
  paste, drag and drop, or the file or photo picker, with remove and reorder. **Capture this
  window**: the Mac app's `capturePage()` and Android's `PixelCopy` take the window behind the
  form as it opens, offered unticked. Images are scaled down to 2560 px on the long side
  and encoded again (PNG stays PNG, the rest become JPEG at 0.85).
- **Captured context**: shows exactly the markdown the issue will hold, with a checkbox per group
  to leave that group out.
- **Drafts**: an unsent form is kept on the device (title, description, choices, screenshots)
  until it's sent or discarded.

## What the context holds (A791)

Metadata only, in five groups. Never a note's body text, excerpts, search queries or the text of
other notes; a test note with a marker string in its body proves it on every client.

1. **App**: client, version and build, OS, browser or WebView, window kind, viewport and pixel
   ratio, theme and appearance mode, locale and time zone; on the Mac the title bar and keep on
   top.
2. **Where you are**: the route (ids kept, no query string), the screen, the open panel or
   dialog, how the form was opened, the sidebar's state and the selected folder's path.
3. **Sync**: online or not, the git notebook's sync state, the last time sync finished, unsynced
   notes and the feedback outbox.
4. **This note** (when one is open): id, title, folder path, tags, created and updated times,
   word, character and attachment counts, size in bytes, engine and epoch, unsynced and Trash
   state, backlink and outgoing-link counts, and how many windows show it.
5. **Recent errors**: the last 10 errors and unhandled rejections from an in-memory ring buffer,
   message and a stack trimmed to the app's frames, redacted like Android's error reports (A427):
   tokens, emails, URL queries, quotations and note or folder names removed. An error that quotes
   the open note's text is dropped.

## The issue (A794)

- **Title**: the form's title.
- **Labels**: `in-app feedback`, `bug` or `feature request`, and `P1`–`P4`.
- **Body**: the description, then the screenshots as `![screenshot-1.png](…)`, then the context
  inside `<details><summary>Captured context</summary>…</details>` (a table per group, then a
  fenced JSON copy for agents), then `Sent from Penmoss <client> <version> · submission <id>`.

Screenshots are native issue attachments (A793), uploaded as `gh issue create --attach` does:
`POST https://uploads.github.com/user-attachments/assets?repository_id=1450019106&name=<file>` with
the image's own `Content-Type` (it must match the name's extension; `application/octet-stream`
gets a 422). Each answers `{ url: "https://github.com/user-attachments/assets/<uuid>" }`. The
assets are private: only people with access to the repository see them.

## The board (A795)

Penmoss never calls the Projects API. A fine-grained token cannot reach a user's project
(`addProjectV2ItemById` answers FORBIDDEN, checked on 27 Oct 2026), so the board's built-in
workflows do it: **Auto-add to project** (`label:"in-app feedback"`) and **Item added to project →
Status: Triage**, both enabled by Ryan. An issue shows in Triage within about 20 seconds.

## Offline (A796)

A submission made offline, or one that fails for a reason that may pass (no network, a 5xx, a
429), waits in an outbox on the device (IndexedDB on the Mac, Room on Android) and is
sent when the device is back online. The form says **Queued, will send when you're online**,
Settings → Status lists what waits, and a toast with the issue's link shows once it's sent. A
refusal that won't change by itself (another 4xx) stays in the outbox with its error, with
**Edit**, **Retry** and **Discard**. Edit puts the report back in the form as it was sent, with
its screenshots and the context it was captured with (not the screen it is edited from), to be
changed and sent again; the form's draft is written before the entry goes; until then the outbox entry keeps the form, so a
report is never lost before it is filed or discarded. The form checks the lengths GitHub
would refuse for good (the description, and the issue as a whole) before it queues anything.
Discard waits while the report is being sent, so a send that then fails cannot bring it back.
