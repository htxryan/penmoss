# T40 P2a · Devices, tokens and admin on Android

Evidence for the first half of T40's P2 ([issue #76](https://github.com/htxryan/penmoss/issues/76)): admin for Android sign-ins approved in the browser, the phone's own check before every admin change, Settings → Devices and tokens (AC2–AC4), Approve a sign-in (AC10) and This phone (AC1). Decisions A420–A425 in [`decisions.md`](../../../decisions.md). P2b (AC5–AC8, PL10) follows.

## How it was run

- The `penmoss36` emulator (API 36, 1080×2400) on the agent worker, a local Worker (`wrangler dev --local`) with this branch's server, and the web app on Vite, as in P1. The phone signed in through the real flow. Screenshots are scaled to 1080 px tall.
- Two sessions under the shared lock, of 2 and 10 minutes. The first found that the app did not ask for `USE_BIOMETRIC`: the system refused `canAuthenticate`, and the screen showed the system's message. Nothing was sent. The fix is in this PR, with `BiometricPermissionTest`, and a check that throws now refuses (A421).
- The phone started with no screen lock. A PIN was set with `locksettings set-pin`, then a fingerprint was enrolled in Settings with `adb -e emu finger touch 1`, which also answered the prompts.
- BiometricPrompt and the PIN screen are secure windows, so a screenshot of them is black. What they showed was read from the window with `uiautomator dump` instead, and is quoted below.
- The CLI's side of a sign-in code was played with `curl` (`POST /api/auth/device`, then `/api/auth/device/token`), since `penmoss login` takes a pasted token (A160).

## Walk-through

| Step | What happened | Screenshot |
| --- | --- | --- |
| Approval page | The browser's approval page said the Android app "will be able to read and edit your notes, and to manage devices and agent tokens and delete notes for good, each after the phone's fingerprint, face or screen lock" (A420). | [p2a-approval-page](p2a-approval-page.png) |
| Settings | Settings' home lists Devices and tokens, "Signed-in devices, agent tokens, recovery code", before This phone. | [p2a-settings-home](p2a-settings-home.png) |
| Devices | This phone first and marked, then the other devices by last seen, each with Sign out; Sign out every other device; Agent tokens, "No agent tokens."; Recovery; Approve a sign-in (A422). | [p2a-devices](p2a-devices.png) |
| No screen lock | Create recovery code with no screen lock: "Not done: this phone has no screen lock. Set a PIN, pattern or password in Android's Settings → Security, then try again." No prompt and no request (A421). | [p2a-no-screen-lock](p2a-no-screen-lock.png) |
| Create a token | The sheet: name "Laptop agent", Read, Folder "All notes". Create asked the check: the PIN screen, titled "Confirm it's you", with "Penmoss is trying to create an agent token." (core's words). | [p2a-create-token](p2a-create-token.png) |
| The secret | After the PIN: "Token for Laptop agent", the `pma_` token, "Copy it now; Penmoss will not show it again.", Copy and Done. The screenshot is black: `FLAG_SECURE` (A423). Done went back to the list, which now had "Laptop agent · Read only", "All notes · last used never". | [p2a-secret-flag-secure](p2a-secret-flag-secure.png) |
| Cancel | Revoke asked "Revoke Laptop agent?"; Revoke, then Back on the prompt: "Not done: this phone did not confirm it was you." The token stayed. | [p2a-revoke-confirm](p2a-revoke-confirm.png), [p2a-not-confirmed](p2a-not-confirmed.png) |
| Fingerprint | Revoke again: the prompt showed the fingerprint sensor, "Penmoss is trying to revoke an agent token.", and Use PIN. A touch on the sensor: "Revoked Laptop agent.", and "No agent tokens." | [p2a-revoked](p2a-revoked.png) |
| Recovery code | Create recovery code, a fingerprint, then the code shown once; Done: "Created a new recovery code.", and the button became Replace recovery code. | — |
| Approve a sign-in | A code from `POST /api/auth/device` ("Penmoss CLI on mbp"), typed, then Look up (no check): "Allow Penmoss CLI on mbp to read and edit your notes?", "Requested 25 Oct, 1:26 AM from Houston, US · ::1". Approve asked the check ("Penmoss is trying to approve a sign-in."); after a fingerprint, "Approved Penmoss CLI on mbp. It can sign in now." The CLI's exchange got a token with scopes `read` and `write`, never `admin` (A420, A424). | [p2a-approve-lookup](p2a-approve-lookup.png), [p2a-approved](p2a-approved.png) |
| Sign out a device | The first session's Android device: "Sign out Android app (sdk_gphone64_x86_64)?", Sign out, a fingerprint: "Signed out Android app (sdk_gphone64_x86_64)." | [p2a-sign-out-confirm](p2a-sign-out-confirm.png), [p2a-signed-out](p2a-signed-out.png) |
| This phone | Device name "Android app (sdk_gphone64_x86_64)", and "Version 0.1.0-debug (build 1)" (a local build's version code is 1) (A425). | [p2a-this-phone](p2a-this-phone.png) |
| A token from before P2a | With `admin` removed from the app's saved account, as an install from before P2a has it: Settings' home said "Sign in again to manage devices", and so did the screen, with no buttons. Sign in again showed a code, the approval page, Approve: the list came back, the phone was still one device ("· this phone", the same device), and the saved account had `admin` (A420). | [p2a-sign-in-again](p2a-sign-in-again.png), [p2a-sign-in-code](p2a-sign-in-code.png), [p2a-admin-again](p2a-admin-again.png) |

Typing the sign-in code fast through `adb` lost a character, because the field rewrote the text (uppercase, filtered) as it was typed. The field now keeps what is typed and the code is tidied on Look up (A424), with a test.

## Tests

- **Server** (`apps/server/test/auth-hardening.test.ts`, workerd):
  - the Android app signed in through the approval page gets `read`, `write` and `admin`, can read `/api/devices`, and loses it when signed out;
  - an Android token from before P2a stays read-write: 403 on `/api/devices` and on a recovery code;
  - a CLI token approved at `/link` is read-write and gets 403.
- **Web** (`apps/web/test/e2e/auth.spec.ts`): the Android approval page's words and the token's scopes.
- **Contracts:** `admin-actions-v1.json` (new), written from core's `ADMIN_ACTIONS` and `adminActionOf` by the page's vitest, and checked by `AdminActionsContractTest`.
- **Kotlin and Robolectric:**
  - `OwnerCheckGateTest`: a confirmed change is sent; a refused check sends none of the six changes; reads and a denial are not checked; a client without a check refuses; a 403 comes through.
  - `PhoneOwnerCheckTest`: both answers of the prompt, no screen lock (no prompt), unavailable, a check that throws, one at a time, and the authenticators.
  - `BiometricPermissionTest`: the manifest asks for `USE_BIOMETRIC`.
  - `DevicesModelTest`, through the real client against MockWebServer: the list's order and filters; a refused check sends nothing; sign out, revoke every other, a token (scope and folder sent, the secret shown once), a recovery code; a 403 asks to sign in again; offline; approving after the check, and Deny without one.
  - `DevicesScreensTest`: the Sign in again card; dialogs before each change; the recovery code's Replace; messages; `FLAG_SECURE` set and cleared; the clip marked sensitive; the create sheet; Approve a sign-in; the code tidied; This phone.
  - `SessionManagerTest`: `admin` and the device name kept across a restart and turned off by a 403; signing in again for admin uses the old token as proof and stays the same device.
  - `SettingsScreensTest`: the home's Devices and tokens row and its summary without admin.
- **Mutation checks:**
  - With `checkOwner` taken out of `HttpPenmossApi.call()`, 3 of `OwnerCheckGateTest`'s 5 tests and 4 of `DevicesModelTest`'s 11 fail.
  - With `USE_BIOMETRIC` taken out of the manifest, `BiometricPermissionTest` fails.

## After the review of #92

No blockers. Five should-fix items and eight nits, each with a regression test:

| Item | Fix | Tests |
| --- | --- | --- |
| 1. Approve could act on a code other than the one shown | The lookup keeps its code, shown under the request; Approve and Deny send that code; changing the field forgets it; a lookup answered after a change is dropped (A424) | `approveSendsTheCodeThatWasLookedUpAndAChangedFieldForgetsIt`, `aLookupThatAnswersAfterTheFieldChangedIsDropped`, `approvingASignInLooksUpTheCodeThenApprovesOrDenies` |
| 2. Selecting the secret copied it without the sensitive flag | The value is no longer selectable: Copy is the only way (A423) | `theSecretCannotBeSelectedSoOnlyCopyMarksItSensitive` (a long press offers no copy; with the selection put back it fails) |
| 3. A device kind could use the other app's callback | `android` only with `penmoss://auth/callback`, `mac` only with a loopback port; the App Link callback (A292) now guards an admin token (A420) | server "ties each device kind to its own app's callback" (both ways); `auth-hardening.test.ts`'s Mac sign-in uses the loopback |
| 4. Signing in again while signed in could race sync and sign the phone out | Sync in flight finishes first (`quiesce`); a 401 carries `tokenTag` of the token it was sent with, and one for a replaced token signs nothing out (A420) | `aTokenFromBeforeP2aIsNotAdminAndSigningInAgainKeepsTheSameDevice` (quiesce, then the old token's 401 ignored, the new one's not), `aRefusedTokenIsNamedByItsTagNeverItself` |
| 5. The screen was live while loading | Every change is off until the list is read (A422) | `nothingCanBeChangedWhileTheListLoads` |
| Nit: a second Approve | Ignored while one is out | `aSecondApproveWhileTheFirstIsOutSendsNothing` |
| Nit: any 403 turned admin off | Only `insufficient_scope` does | `onlyInsufficientScopeTurnsAdminOff` |
| Nit: Sign out and Revoke for TalkBack | "Sign out Mac", "Revoke Claude Code" | `signOutAndRevokeSayWhichDeviceOrToken` |
| Nit: the CLI's name | "Allow a CLI calling itself “…”" | `approvingASignInLooksUpTheCodeThenApprovesOrDenies` |
| Nit: the gate read every body | It reads a body only for the approve route (A421) | `onlyTheApproveRoutesBodyIsRead` |
| Nit: the contract's requests were hand-picked | Core exports `ADMIN_ROUTES`; the contract carries them, the Kotlin table must equal them, and the vitest fails for a route with no request (A421) | `theRoutesAreCoresPatternForPattern`, "has a request for every admin route core knows" |
| Nit: `ResumedActivity` | `@Volatile` | — |
| Nit: the plan still named Custom Tab admin | The plan updated | — |

The walk-through above was recorded before these fixes: Approve a sign-in now also shows the code it will send, and asks about "a CLI calling itself “Penmoss CLI on mbp”".
