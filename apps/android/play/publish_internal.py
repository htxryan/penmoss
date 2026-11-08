# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "google-api-python-client==2.201.0",
#   "google-auth==2.62.0",
# ]
# ///
"""Upload the release App Bundle to Google Play's internal testing track (A692).

Run it as `task android:publish-internal` (or `-- --dry-run`), after `task android:release`.
It talks to the Google Play Developer API (androidpublisher v3) as the service account whose
JSON key is at ~/.config/penmoss/play-service-account.json: one edit, the bundle uploaded into
it, the internal track set to that version code with status `completed`, then the edit
committed. With --dry-run it validates the edit instead and deletes it, so nothing is
published. Setting up the service account: docs/android.md, "Publish from the worker".

It never prints anything read from the key file. Only the standard library is needed until
the API is called, so the unit tests (test_publish_internal.py) run on any Python 3.9+.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional, Sequence, TextIO

PACKAGE = "app.penmoss"
# Fixed on purpose: this command never releases to a wider track.
TRACK = "internal"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
DEFAULT_KEY = Path("~/.config/penmoss/play-service-account.json")
REPO = Path(__file__).resolve().parents[3]
DEFAULT_BUNDLE = REPO / "apps/android/app/build/outputs/bundle/release/app-release.aab"
SETUP = 'docs/android.md, "Publish from the worker"'
# Where a bundle built with ndk.debugSymbolLevel keeps the symbols it carries itself.
SYMBOLS_IN_BUNDLE = "BUNDLE-METADATA/com.android.tools.build.debugsymbols/"


class Refused(Exception):
    """A reason to stop before or during publishing, said in one line, with an exit code."""

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="task android:publish-internal --",
        description=f"Upload the release App Bundle to Google Play's {TRACK} testing track.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="upload into an edit and validate it, then delete the edit: nothing is published",
    )
    parser.add_argument(
        "--aab",
        type=Path,
        default=DEFAULT_BUNDLE,
        help="the App Bundle (default: the one task android:release builds)",
    )
    parser.add_argument(
        "--key",
        type=Path,
        default=None,
        help="the service account's JSON key (default: $PENMOSS_PLAY_KEY, else "
        f"{DEFAULT_KEY})",
    )
    parser.add_argument("--notes", default=None, help="release notes for testers (en-US)")
    return parser.parse_args(list(argv))


def key_path(args: argparse.Namespace, env: "os._Environ[str] | dict[str, str]") -> Path:
    chosen = args.key or (Path(env["PENMOSS_PLAY_KEY"]) if env.get("PENMOSS_PLAY_KEY") else DEFAULT_KEY)
    return chosen.expanduser()


def check_files(key: Path, bundle: Path) -> None:
    """Both files exist, before anything is imported or asked of Google."""
    if not key.is_file():
        raise Refused(
            f"No Play service-account key at {key}. Make the service account and its JSON key "
            f"first ({SETUP}), then copy the key there (mode 600).",
            code=2,
        )
    if not bundle.is_file():
        raise Refused(f"No App Bundle at {bundle}. Build it first: task android:release.", code=2)


def native_libraries(bundle: Path) -> tuple[list[str], bool]:
    """The bundle's native libraries, and whether it carries their symbols itself."""
    with zipfile.ZipFile(bundle) as archive:
        names = archive.namelist()
    libraries = [n for n in names if n.endswith(".so") and "/lib/" in n and not n.startswith("BUNDLE-METADATA/")]
    return libraries, any(n.startswith(SYMBOLS_IN_BUNDLE) for n in names)


def symbols_zip(bundle: Path, libraries: Sequence[str], folder: Path) -> Path:
    """
    Play's native symbols file for libraries shipped already stripped (A691): `<abi>/<name>.so`,
    each library itself, whose dynamic symbol table is all the symbols it has.
    """
    out = folder / "native-debug-symbols.zip"
    with zipfile.ZipFile(bundle) as archive, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as symbols:
        for name in libraries:
            abi, file = name.split("/lib/", 1)[1].split("/", 1)
            symbols.writestr(f"{abi}/{file}", archive.read(name))
    return out


def load_service(key: Path) -> Any:
    """The androidpublisher v3 client, signed in as the key's service account."""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError as error:
        raise Refused(
            f"The Google API client is missing ({error.name}). Run this through "
            "`task android:publish-internal`, which installs it with uv."
        ) from None
    try:
        credentials = service_account.Credentials.from_service_account_file(str(key), scopes=[SCOPE])
    except Exception as error:  # noqa: BLE001 — any unreadable key is the same answer
        # The exception's own text can quote the file, so only its type is said.
        raise Refused(
            f"The file at {key} is not a usable service-account key ({type(error).__name__}). "
            f"Download a new JSON key ({SETUP})."
        ) from None
    return build("androidpublisher", "v3", credentials=credentials, cache_discovery=False)


def describe_http(error: Exception) -> Optional[str]:
    """One line for an API error (googleapiclient's HttpError), or None for anything else."""
    status = getattr(getattr(error, "resp", None), "status", None)
    if status is None:
        return None
    reason = getattr(error, "reason", None) or str(error)
    line = f"Google Play answered {status}: {reason}"
    lowered = str(reason).lower()
    if "draft app" in lowered:
        line += " Play keeps the app in draft until a first release is rolled out in Play Console."
    elif int(status) in (401, 403):
        line += (
            " Is the service account invited in Play Console (Users and permissions) with "
            f"'Release apps to testing tracks' for Penmoss? ({SETUP})"
        )
    elif int(status) == 404:
        line += f" Is the Google Play Android Developer API enabled for the key's project? ({SETUP})"
    return line


def media(path: Path) -> Any:
    from googleapiclient.http import MediaFileUpload

    return MediaFileUpload(str(path), mimetype="application/octet-stream", resumable=True)


def publish(
    service: Any,
    bundle: Path,
    *,
    dry_run: bool,
    notes: Optional[str],
    out: TextIO,
    upload: Optional[Callable[[Path], Any]] = None,
) -> int:
    """One edit: the bundle, its native symbols if it lacks its own, the track, then commit (or
    validate and delete). Any failure deletes the edit. Returns the version code."""
    upload = upload or media
    edits = service.edits()
    edit_id = edits.insert(packageName=PACKAGE, body={}).execute()["id"]
    finished = False
    try:
        print(f"Uploading {bundle.name} to Play ({PACKAGE})…", file=out)
        uploaded = edits.bundles().upload(packageName=PACKAGE, editId=edit_id, media_body=upload(bundle)).execute()
        version_code = int(uploaded["versionCode"])
        print(f"Version code {version_code}, track {TRACK}", file=out)

        libraries, carried = native_libraries(bundle)
        if libraries and not carried:
            with tempfile.TemporaryDirectory() as folder:
                symbols = symbols_zip(bundle, libraries, Path(folder))
                edits.deobfuscationfiles().upload(
                    packageName=PACKAGE,
                    editId=edit_id,
                    apkVersionCode=version_code,
                    deobfuscationFileType="nativeCode",
                    media_body=upload(symbols),
                ).execute()
            print(f"Native symbols: {len(libraries)} libraries' own symbol tables", file=out)

        release: dict[str, Any] = {"versionCodes": [str(version_code)], "status": "completed"}
        if notes:
            release["releaseNotes"] = [{"language": "en-US", "text": notes}]
        edits.tracks().update(
            packageName=PACKAGE, editId=edit_id, track=TRACK, body={"track": TRACK, "releases": [release]}
        ).execute()

        if dry_run:
            edits.validate(packageName=PACKAGE, editId=edit_id).execute()
            print("Dry run: the edit is valid. Deleting it; nothing was published.", file=out)
            edits.delete(packageName=PACKAGE, editId=edit_id).execute()
        else:
            edits.commit(packageName=PACKAGE, editId=edit_id).execute()
            print(f"Released {version_code} to the {TRACK} track (completed).", file=out)
        finished = True
        return version_code
    finally:
        if not finished:
            try:
                edits.delete(packageName=PACKAGE, editId=edit_id).execute()
            except Exception:  # noqa: BLE001 — an edit left behind expires on its own
                pass


def main(
    argv: Sequence[str],
    *,
    env: "os._Environ[str] | dict[str, str]" = os.environ,
    out: TextIO = sys.stdout,
    err: TextIO = sys.stderr,
    service_for: Callable[[Path], Any] = load_service,
    upload: Optional[Callable[[Path], Any]] = None,
) -> int:
    args = parse_args(argv)
    key = key_path(args, env)
    bundle = args.aab.expanduser()
    try:
        check_files(key, bundle)
        publish(service_for(key), bundle, dry_run=args.dry_run, notes=args.notes, out=out, upload=upload)
        return 0
    except Refused as refused:
        print(f"publish-internal: {refused}", file=err)
        return refused.code
    except Exception as error:  # noqa: BLE001 — the API's errors are said in a line
        line = describe_http(error)
        if line is None:
            raise
        print(f"publish-internal: {line}", file=err)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
