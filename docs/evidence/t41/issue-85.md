# #85 · Mac app: admin requests in the main process

Evidence for [issue #85](https://github.com/htxryan/penmoss/issues/85), a follow-up from the review of T41 (#84), and for the fixes from the security review of PR #100. Decisions A540–A543 are in [`decisions.md`](../../decisions.md).

## Before and after

|  | Before (T41) | After (#85) |
| --- | --- | --- |
| The page's token | The Mac's device token: read, write and admin | A second device token for the same Mac, read and write, one per Mac (A540) |
| The admin token | In the page's memory (the preload handed the session over) | In the main process only, encrypted in `session.json` |
| An admin request | Sent by the page with its token, after `penmoss:admin:confirm` said yes | Named by the page (`penmoss:admin:request`, main window only); main checks the parameters, asks Touch ID or the password in words for that change, and sends it (A541) |
| Approving another app's sign-in | In the page, with its admin token | Only in the browser: its code would sign an app in for the page (A541) |
| Code running in the page | Could send any admin request itself | Gets 403 from every admin route and gets no admin-capable credential; it can name a change, which runs only after the owner check. The residual is in A542 and A543 |

## What was built

- **Server:** `POST /api/auth/page-token`. Only a `mac` device's admin device token may call it. The token it issues for the same device is read and write, and issuing one signs out the device's earlier read-write device tokens in the same batch (one per Mac). The page's token gets 403 from every admin route. Settings → Devices signs both tokens out with the Mac.
- **Core:** `ADMIN_REQUESTS` (`packages/core/src/admin-requests.ts`) gives each admin route a name, its parameter shapes (aligned with the server's), its owner check, and whether the Mac's page may ask for it (`pageMayAsk`: all but `approveAppSignIn`). `ownerCheckWords` words each change on its own, from checked parameters only. `adminRequestOf` is the page's side and `adminHttpRequest` is main's.
- **Mac app:**
  - `PageSessions` (`page-session.ts`) makes the page token once and keeps it with the session. It replaces the token when the server refuses it, answers `pending` while it cannot make one, and signs both tokens out on Sign out or a new sign-in. The checks the page asks for run at most every 10 s.
  - `AdminRequests` (`admin-requests.ts`) checks the name and parameters and refuses an app's sign-in approval. It runs the owner check (A504) with that change's words, sends the request with the admin token, and returns the status and body, unless the body holds a device, session or agent token. A new agent token is the only one returned.
  - `penmoss:session:get` hands the page only `pageSession`, never a token that has admin.
  - The capture window's bridge has no `admin`, and main checks the sender (`isMainWindowFrame`).
  - Main's own requests use `net.fetch`.
  - The `storedSession` and `forgetPageToken` test hooks exist only in unpackaged builds.
- **Web app:** in the Mac app, `SessionManager.api` hands every call to an admin route to `native.admin` and never sends one itself. `canAdminister` reads `adminInApp`. A `pending` session starts offline, not signed out, and the sync pill says offline. A refused token waits for the app's answer, so the page does not flash "signed out". `/native-sign-in` in the Mac app says to approve it in the browser. The browser is unchanged: it uses its own admin session (A2, A503).
- **Android:** unchanged. Its page never held a token, and core's `ADMIN_ACTIONS` and `ADMIN_ROUTES` (the Android contract) are unchanged.

## Review of PR #100: each finding

| Finding | Resolution | Proof |
| --- | --- | --- |
| **B1** The page could get an admin token through `approveAppSignIn` | Main never sends it for the page (`pageMayAsk`); the Mac's `/native-sign-in` sends Ryan to the browser. No answer holding a device or session token goes back to the page. Each owner prompt has its own words; approving a CLI names its code (“approve the sign-in ABCD-EFGH”) | Electron: the page runs the whole chain (its own PKCE pair, `approveAppSignIn` through main, then `native/token` with its page token as `previousToken`). **Before the fix:** main answered 201 with `{code}` and the page redeemed it for `["read","write","admin"]`. **After:** refused, no code, no prompt. Desktop unit tests for the refusal, the credential hold-back and the prompt words. Core: each checked name has distinct words, and only `approveAppSignIn` is not allowed for the page. The T41 admin test checks “approve the sign-in <code>” |
| **S1** Page tokens piled up and kept a signed-out Mac alive | `issuePageToken` signs out the device's other read-write device tokens in the same batch | Server: “replaces the Mac's earlier page tokens, so signing out signs the Mac out” failed before the fix (the first page token still answered 200) and passes now. Electron S2 test: the page token it replaced answers 401 |
| **S2** With no page token, offline, the page started signed out | Main answers `pending`; the page starts offline (no banner, the pill says offline); main asks again and tells the page | Electron: “opens offline, still signed in, before it has a page token”. **Before the fix:** the sync pill said `signed-out`. Main's requests now use `net.fetch`, so the test's network block reaches them too. Web and desktop unit tests for `startOffline` and `pending` |
| **S3** No test that the capture window cannot administer | The capture preload has no `admin`, and main checks the sender with `isMainWindowFrame` | Electron: “the capture window cannot make admin requests” failed before the fix (`admin` was an object) and passes now. Unit test for `isMainWindowFrame` |
| **S4** A542 overstated; what the page may trigger was not decided | A543 makes the decision: everything but app sign-in approval, each change after the owner check. Only a new agent token and a new recovery code come back, for Ryan to see once. A542 lists the accepted residual | Electron: an agent token made through main is `pma_`, read only, and never admin. Desktop unit tests for the hold-back |
| **N1** Validation narrower than the server; a misleading message | A CLI's code is what remains after dropping white space and hyphens, as the server does. Labels may be any length up to 10,000 characters. A bad parameter says “Not done: that request was not valid.” | Core and desktop unit tests; the Electron refusal list |
| **N2** `storedSession` shipped in packaged builds | Both test hooks are gated on `!app.isPackaged` | Code review only: CI cannot run a packaged build here |
| **N3** A contradictory comment in `auth.test.ts` | Reworded | n/a |
| **N4** A “signed out” flash after Sign out everywhere else | In the Mac app, a 401 waits for main's check, then reads the session again | Web unit test (failed before the fix). Electron: a `MutationObserver` sees no banner during Sign out everywhere else |
| **N5** The page could start token checks at will | `reconcileForPage`: one check at a time, at most every 10 s; later asks wait for the next slot | Desktop unit test |
| **N6** Non-canonical paths | Left as is (the page's own token gets 403) | Core “leaves alone” test lines for `/api/devices/` and `//api/devices` |

Failing-first was checked as follows:

- **Server:** the S1 test.
- **Electron:** the B1 chain, S2, S3 and the CLI prompt words.
- **Desktop unit:** 8 tests.
- **Web unit:** 3 tests.
- **Core:** 4 tests.

For Electron and the server, the new tests were run against the code as it was before the fixes. For core and the web, the fixed sources were stashed instead.

## Re-review of PR #100: each item

| Item | Resolution | Proof |
| --- | --- | --- |
| **R1** A revoked admin token with no page token stayed offline for ever | When a page token cannot be made, main asks whether the server refuses its admin token (401). If it does, and the session is still the same one, main signs out and tells the page | Electron: “signs out, not offline, when its admin token was revoked before it had a page token”. **Before the fix:** no sign-in banner (the page stayed offline). Desktop unit test (failed before the fix) |
| **R2** Sign-out left a page token whose answer was lost | Sign out, and a new sign-in replacing a session, sign the Mac's own device out with the admin token (`DELETE /api/devices/<id>`); with no admin, or if that fails, both known tokens are revoked as before. Client only, no deploy | Desktop unit tests for `revokeOwnDevice` and `signOutDevice` (both failed before the fix). Server: a page token whose answer was lost answers 401 once the Mac's admin token signs its device out |
| **N-a** Token requests could follow a redirect | `redirect: 'error'` on making the page token, revoking it, checking it and signing the device out | Desktop unit test (failed before the fix) |
| **N-b** Sign-in used Node's `fetch` | The sign-in uses main's `net.fetch` too | Electron sign-in tests still pass |
| **N-c** No test that the sign-in callback stays in main | `penmoss://auth/callback?…` is in the deep-link list that never reaches the page | Shell unit test (passed before: the guard already held) |
| **N-d** Error reports were withheld whole when one quoted a token | Token-shaped text in error reports is blanked (“[token removed]”), and the list is handed over | Desktop unit test (failed before the fix) |
| **Guard** A new route that answers with a secret would reach the page | `ADMIN_REQUESTS` marks the requests that return a secret (`returns: 'secret'`). Main keeps back any answer from another request that holds a token, or a field such as `code`, `token`, `secret` or `deviceCode` | Core: the marked list is exactly `createToken`, `recoveryCode` and `approveAppSignIn` (failed before). Desktop unit test with a `code` and a nested `secret` (failed before) |
| **A543** The recovery code's display was not recorded as a risk | A543 records it: the page controls how the code is shown, so hostile code there could show a made-up one. A dialog in main is the follow-up | n/a |

Failing-first: 6 desktop unit tests, 1 core test and the R1 Electron test were run against `baf6e1c`'s code and failed.

## How it was run (worker VM 108, Linux, xvfb; no macOS)

All runs were under the shared lock.

- `task check`: lint, typecheck, every unit suite (web 338, desktop 85, core and the others) and the server suite in workerd (649), and releases. All green.
- `task desktop:test`: 85 desktop unit tests and 27 Electron tests. All green.
- Web Playwright `auth`, `folder-scope` and `history` specs (8): the browser's admin flows still work.

## On Ryan's Mac

See step 11 of [`docs/desktop.md`](../../desktop.md#5-manual-check-on-the-mac). Deploy the server first.
