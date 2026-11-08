# T40 P8b · Files and pictures from web addresses on Android

Evidence for the second part of T40's P8 ([issue #76](https://github.com/htxryan/penmoss/issues/76)), in the same branch and [PR #101](https://github.com/htxryan/penmoss/pull/101) as [P8a](p8a.md):

- files in notes through the app (ED12, and the slash menu's **File**, ED3): attached from the bar's **Attach a file** or the slash menu's **File** (Android's document picker), or dropped or pasted; stored on the phone first and uploaded by the pictures' queue; a chip with its type, name and size, and **Open** and **Save a copy** (_adapted_ from the web's Preview, Open and Download);
- pictures from `https:` web addresses (ED13), fetched by the app on the page's own origin, with the per-device **Load pictures from the web** (On · Wi-Fi only · Off) and **Tap to load** on mobile data.

No server half: the attachment routes already take any file (T13), with `?ext=` for a file that is not a picture or a PDF. Decisions A486–A489 are in [`decisions.md`](../../../decisions.md). No Room schema change: the attachments table already keys files by hash and extension.

## How it was run

- **No emulator session: blocked on KVM**, as in P8a. The Pixel checklist is in [`docs/android.md`](../../../android.md#test-files-and-web-pictures-on-the-pixel-t40-p8-part-two), and the tests below cover the flows.
- **What covers it instead:**
  - Page tests (`files.test.ts`, 11):
    - A pasted PDF and CSV are sent as `file` with the web's `filePath` names (the sniffed `.pdf`, and the name's lower-cased `.csv`), each followed by its bytes. Each goes into the note only on `fileStored ok`.
    - A refused file stays out of the note, with the message saying so.
    - A file over 50 MB is refused before it is read.
    - `insertFiles` puts in a chip, or a picture for a picture's path.
    - A chip asks `fileInfo` once, by the app's path even when the link is relative. It shows the size, and **Open** and **Save a copy** post `openFile`, with no iframe.
    - With no answer within 5 s, the chip shows no size.
    - The + sheet offers **File**, which opens the page's file picker for any type.
    - Web pictures:
      - They load from `/remote?u=` with `on`.
      - With `wait` they show **Tap to load**. A tap loads `now=1` and never writes to the note.
      - Off, no word from the app, `http:`, or another note's mode all show the alt text.
    - The new messages are parsed strictly.
  - Shared editor tests (`@penmoss/editor`):
    - `image.test.ts` (+5): without the hook the address loads (the web). With it:
      - the shell's URL shows, and `resolve` is not used;
      - null shows the alt text;
      - `'wait'` shows Tap to load, then that picture loads;
      - attachments still resolve.
    - `attachment.test.ts` (+2): with `openFile`, every chip shows Open and Save a copy and hands both to the shell, with no fetch, no iframe and no change to the note. An embed's file opens through the shell too.
  - The contract (`bridge-v1.json`):
    - to the page: `fileStored`, `insertFiles`, `fileInfo` (known and unknown) and `webPictures` (`on`, `wait`, `off`);
    - from the page: `file`, `fileInfo` and `openFile` (open and save);
    - 13 malformed examples.

    `contract.test.ts` and Kotlin's `BridgeProtocolTest` read them both ways.
  - Robolectric (`AttachmentFilesTest`, 9):
    - Files are named as core's `filePath` names them, with the types the server serves.
    - A picked CSV and PDF are stored and uploaded, the CSV with `ext=csv` and the PDF and pictures with none.
    - A file over 50 MB is refused, with the web's message.
    - The page's path must be the one the bytes and name give.
    - Size and type come from Room.
    - A file is read from the phone first and fetched only when missing, then kept.
    - A fetched file must match its hash and the type its extension names. Offline gives no file and no exception.
    - The space used is counted.
  - Robolectric (`NoteFilesTest`, 8):
    - `webPictures` is sent right before each `open`, following the network, and nothing is sent without the setting.
    - A pasted file's bytes are stored and answered `fileStored`. A picture's bytes after a file's message are still a picture's.
    - Wrong sizes, wrong paths and no storage are refused.
    - A chip's size and type are answered.
    - Open and Save a copy reach the screen, and another note's chip does not.
    - Picked files are stored, then inserted, with notices for refusals.
    - Files picked during a reload go in once the note shows.
  - Robolectric (`RemotePicturesTest`, 11):
    - A fetch carries no cookie or token and asks for `image/*`. The picture is kept and served again without asking, and Clear empties the cache.
    - SVG, oversized and 404 answers are refused.
    - By the real rules, no `http`, private, loopback, link-local, carrier-NAT, unique-local or mapped-private address, user info or overlong URL is reached.
    - A name that resolves to this machine is never reached (0 requests), and neither is an address in the URL.
    - A redirect to an address that is not allowed is not followed, and a redirect chain stops after 5.
    - The cache drops the least recently shown picture first.
    - Nothing throws.
    - The setting's modes: Off refuses even a tap.
    - The address rules cover IPv4, IPv6, mapped and NAT64 addresses.
  - Robolectric (`EditorWebViewTest`, +2): the File item's chooser opens the document picker and Image's the photo picker. `/remote?u=` is answered `no-store` with `tapped` only for `now=1`. A handler that throws gives 404, and every other shape gives 403.
  - Robolectric Compose (`FileToolsTest`, 8):
    - Shared copies get a safe name.
    - The view type is the server's.
    - Open hands a `FileProvider` content URI with read permission only, from the cache's shared folder.
    - Save a copy's intent carries the name and type, and the copy is written.
    - The unavailable message uses the web's words.
    - The bar's **Attach a file** works.
    - Sync and storage shows the storage and the Load pictures from the web choices.
    - Sizes are formatted as core formats them.
  - `HttpPenmossApiTest` (+1): an upload with `ext` sends `?ext=csv`, and a picture's names none.
  - Full `task check` and `task android:test`: see Tests below.

## Walk-through (by test, against the page and the Robolectric screens)

| Step                      | What happens                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attach                    | **Attach a file**, or the slash menu's **File** (whose file chooser the WebView routes to the document picker): `OpenMultipleDocuments`; each file is read (50 MB at most), stored with its `filePath` name and inserted with `insertFiles`.                     |
| Drop or paste             | The page hashes and sniffs the file and sends `file` and its bytes; the app checks the path and answers `fileStored`; the chip goes in on `ok`.                                                                                                                  |
| Upload                    | The pictures' queue uploads files too, oldest first, with `?ext=` for any file that is not a picture or a PDF; the sync icon and Sync and storage count them while they wait.                                                                                    |
| Chip                      | Badge, name and size (`fileInfo`, from Room); **Open** and **Save a copy**.                                                                                                                                                                                      |
| Open                      | The file from the phone, or fetched with the device token; a copy in `cache/shared/<sha>/<name>`; `ACTION_VIEW` with a read-only content URI; no app for it → a snackbar with Save a copy.                                                                       |
| Save a copy               | `ACTION_CREATE_DOCUMENT` with the name and type; the file copied there; "Saved a copy."                                                                                                                                                                          |
| Web pictures              | `![](https://…)` shows from `/remote?u=`; the app fetches it by A488's rules and caches it.                                                                                                                                                                      |
| Wi-Fi only on mobile data | The picture shows its alt text and **Tap to load**; a tap asks `now=1`, which the app allows; Off refuses even that.                                                                                                                                             |
| Storage                   | Sync and storage: the space files and pictures take, the web pictures kept (Clear), and Load pictures from the web.                                                                                                                                              |

**Not walked through on a device:**

- **Another app opening the file**: the intent and the content URI are tested on Robolectric; the Pixel checklist opens a PDF and a CSV.
- **The document picker and the save dialog themselves**: the contracts' intents are tested; the Pixel checklist runs them.
- **A real `https` fetch**: MockWebServer speaks plain http, so the fetching tests let http and loopback through, and the refusals run with the real rules; the Pixel checklist loads a picture from Wikimedia.

## Tests

Totals for the whole PR (both parts, with the re-review's fixes), on the branch rebased onto `main` (#100):

- **`task check`:** lint, typecheck and every package's unit tests pass. They include the page (`@penmoss/android-editor`, 145: `files.test.ts` 11, `parity.test.ts` 35) and the shared editor (`@penmoss/editor`, 479).
- **`task android:test`:** `engine-bridge` 107 and `app` 717 pass, none skipped. `app` includes `AttachmentFilesTest` 13, `NoteFilesTest` 10, `RemotePicturesTest` 12, `FileToolsTest` 9 and `EditorWebViewTest` 11.
- **Mutation checks**, each run against the suite and caught:

  | Change made to the code | What failed |
  | --- | --- |
  | Every name that resolves passes the DNS filter | `aNameThatResolvesToTheHomeNetworkIsNeverReached` |
  | An address in the URL skips the address rules | `anAddressInTheUrlIsCheckedThoughItSkipsDns`, `checksEveryRedirectAgain` |
  | Redirects followed without checking again | `checksEveryRedirectAgain` |
  | The page's path trusted as given | `thePageIsNotTrustedToNameAFile` |
  | No `ext` on a file's upload | `storesAPickedFileAndUploadsItWithItsExtension` |
  | A file's bytes not checked against its `file` message | `refusesBytesThatAreNotWhatTheFilesMessageSaid`, `storesAPastedFileAndItsBytesBeforeThePageInsertsIt` |
  | `webPictures` not sent before `open` | `tellsThePageHowWebPicturesShowRightBeforeEachOpen`, `answersAChipsSizeAndTypeFromThePhone` |
  | `/remote` ignoring `now=1` | `answersAWebPictureOnlyAtItsOwnPathAndNeverThrows` |
  | A fetched file's type not checked | `aFetchedFileMustBeWhatItsPathNames` |
  | The File item's chooser opening the photo picker | `theFileItemsPickerOpensTheDocumentPickerAndImagesThePhotoPicker` |
  | The page ignoring Wi-Fi only | `holds one back for a tap on mobile data with Wi-Fi only` |
  | The page inserting a file without waiting for `fileStored` | `hands a pasted file to the app with its bytes…`, `leaves a file out of the note when the phone could not store it` |
  | The page allowing `http:` pictures | `shows the alt text when they are off, when the app has not said, and for http` |
  | Web pictures on when the app has not said | the same test |
  | The page not giving the editor its file services | `hands a pasted file…`, `leaves a file out…`, `refuses a file over 50 MB before reading it` |
  | The shared image view ignoring the shell's `web` hook | `shows the shell's URL, never the address`, `shows the alt text when web pictures are off`, `waits for a tap, then loads that picture only` |
  | The shared chip ignoring the shell's `openFile` | `offer Open and Save a copy for every file, with no preview, and hand both to the shell` |
  | No 50 MB check on the page | `refuses a file over 50 MB before reading it` |

## Re-review fixes

The review of part two (at 3cf0aad) found one blocker and four should-fix items. Each fix was proved by putting the old behaviour back and watching the named test fail.

| Finding | Fix |
| --- | --- |
| PB1 (blocker): a short-form IPv4 host (`127.1`, `2130706433`, `10.1`, `3232235777`) got past both address checks, since OkHttp connects to any digits-and-dots host without the vetted DNS | `RemotePictures.hostKind`: a host OkHttp takes as an address, or whose every label is a number (`0x7f.1`), is an address only as a plain dotted quad or IPv6, and every other numeric form is refused. Local-use NAT64 is refused and 6to4 judged by its IPv4; the client uses no proxy |
| PS1: every picked file was read into memory before any was stored | Picked files are opened one at a time and streamed through their hash to disk with the 50 MB cap (`Attachments.addFile(InputStream, …)`); a file that cannot be read says so by name |
| PS2: uploads read whole files, and a timed-out 50 MB upload was retried for ever over mobile data | Uploads stream from the file; a failure once the bytes were going out (`UploadInterrupted`) counts as an attempt, while no connection is still offline; files over 10 MB upload on Wi-Fi only, which Sync and storage says |
| PS3: a file attached on another device showed no size | `info` asks the server's `HEAD` once per file, as the web's chips do (`PenmossApi.attachmentSize`) |
| PS4: Save a copy forgot the file if the activity was recreated while its picker was open, leaving an empty document | The chip's path and name are kept with `rememberSaveable` and the file is found again; if it cannot be written, the empty document is deleted and the snackbar says why |

**Putting the old behaviour back:**

| Old behaviour put back | What failed |
| --- | --- |
| PB1: only a four-part dotted quad checked as an address | `anAddressInAShortOctalHexOrIpv6FormIsRefusedToo`, and `anAddressInTheUrlIsCheckedThoughItSkipsDns` (the old code fetched `http://127.1:<port>/` from the test server) |
| PS1: every picked file opened before any is stored | `readsPickedFilesOneAtATimeEachStoredBeforeTheNextIsOpened`, `saysWhichPickedFileCouldNotBeRead` |
| PS2: a cut-short upload postponed, not counted | `anUploadCutShortCountsAsAnAttemptWhereOfflineDoesNot` |
| PS2: a large file sent over mobile data | `aLargeFileUploadsOnWiFiOnly` |
| PS2: the API not telling a cut-short upload from offline | `anUploadCutShortAfterItsBytesWentOutIsInterruptedNotOffline` |
| PS3: no server size | `asksTheServerOnceForTheSizeOfAFileAddedElsewhere` |
| PS3: `GET` instead of `HEAD` | `asksTheSizeOfAStoredFileWithoutItsBytes` |
| PS4: the request kept with `remember`, not `rememberSaveable` | `saveACopyWritesTheFileThoughTheActivityWasRecreatedWhileItsPickerWasOpen` |

A probe of the old `checked` with the real rules let through `127.1`, `2130706433`, `10.1`, `3232235777`, `192.168.1`, `0x7f.1`, `0x7f000001`, `0177.0.0.1`, `127.0.0.1.`, `1572395042`, `[64:ff9b:1::a00:1]` and `[2002:c0a8:101::1]`. It already refused `127.0.0.01`, `[::1]`, `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]` and `[fd00::1]`, which stay in the test as guards.

**Not proved by a failing test:** that uploads and picks stream rather than read whole. Putting `readBytes` back gives the same bytes and passes; `aPickedFileIsStreamedThroughItsHashToDiskLeavingNoPartFile` checks that a 50 MB pick is read in 64 KB pieces and leaves no partial file, and `streamsAnUploadFromItsFileWithItsLength` checks the body and its length. The empty-document deletion after a failed write needs a real documents provider; the Pixel checklist (part two, step 6) covers recreation during Save a copy.

## Deploy

None: no server half and no schema change in this part. The PR's schema is 13 (part one's `folds` table).
