"""Unit tests for publish_internal.py (A692): arguments, refusals and the order of API calls,
against a fake androidpublisher client. Nothing here reaches Google. Standard library only:
`task android:publish:test`."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import types
import unittest
import unittest.mock
import zipfile
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import publish_internal as publish  # noqa: E402

SECRET = "-----BEGIN PRIVATE KEY-----\nNOT-A-REAL-KEY-sentinel-6d1f\n-----END PRIVATE KEY-----\n"


class Call:
    """One request the fake client was asked to make; `execute()` records it and answers."""

    def __init__(self, service: "FakeService", name: str, kwargs: dict[str, Any]) -> None:
        self.service, self.name, self.kwargs = service, name, kwargs

    def execute(self) -> Any:
        self.service.calls.append((self.name, self.kwargs))
        failure = self.service.fail.get(self.name)
        if failure is not None:
            raise failure
        return self.service.answers.get(self.name, {})


class Resource:
    def __init__(self, service: "FakeService", prefix: str) -> None:
        self.service, self.prefix = service, prefix

    def __getattr__(self, method: str) -> Any:
        name = f"{self.prefix}.{method}"
        if method in ("bundles", "tracks", "deobfuscationfiles"):
            return lambda: Resource(self.service, name)
        return lambda **kwargs: Call(self.service, name, kwargs)


class FakeService:
    def __init__(self, version_code: int = 431083) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: dict[str, Exception] = {}
        self.answers: dict[str, Any] = {
            "edits.insert": {"id": "edit-1"},
            "edits.bundles.upload": {"versionCode": version_code},
        }

    def edits(self) -> Resource:
        return Resource(self, "edits")

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


class FakeHttpError(Exception):
    """The parts of googleapiclient's HttpError that publish_internal reads."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.resp = type("Response", (), {"status": status})()
        self.reason = reason


def bundle(folder: Path, *, libraries: bool = True, symbols: bool = False) -> Path:
    path = folder / "app-release.aab"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("base/manifest/AndroidManifest.xml", b"manifest")
        archive.writestr("base/dex/classes.dex", b"dex")
        if libraries:
            archive.writestr("base/lib/arm64-v8a/libandroidx.graphics.path.so", b"\x7fELF-arm64")
            archive.writestr("base/lib/x86_64/libandroidx.graphics.path.so", b"\x7fELF-x86_64")
        if symbols:
            archive.writestr(
                publish.SYMBOLS_IN_BUNDLE + "arm64-v8a/libandroidx.graphics.path.so.sym", b"symbols"
            )
    return path


def key(folder: Path) -> Path:
    path = folder / "play-service-account.json"
    path.write_text(json.dumps({"type": "service_account", "private_key": SECRET}))
    return path


class Run:
    """main() with captured output and a fake client, which records the key it was given."""

    def __init__(self, argv: list[str], *, env: Optional[dict[str, str]] = None, service: Any = None) -> None:
        self.out, self.err = io.StringIO(), io.StringIO()
        self.service = service or FakeService()
        self.keys: list[Path] = []

        def service_for(path: Path) -> Any:
            self.keys.append(path)
            return self.service

        self.code = publish.main(
            argv,
            env=env or {},
            out=self.out,
            err=self.err,
            service_for=service_for,
            upload=lambda path: f"media:{path.name}",
        )

    @property
    def output(self) -> str:
        return self.out.getvalue() + self.err.getvalue()


class ArgumentsTest(unittest.TestCase):
    def test_defaults(self) -> None:
        args = publish.parse_args([])
        self.assertFalse(args.dry_run)
        self.assertEqual(args.aab, publish.DEFAULT_BUNDLE)
        self.assertTrue(str(args.aab).endswith("apps/android/app/build/outputs/bundle/release/app-release.aab"))
        self.assertIsNone(args.notes)
        self.assertEqual(publish.key_path(args, {}), publish.DEFAULT_KEY.expanduser())

    def test_flags(self) -> None:
        args = publish.parse_args(["--dry-run", "--aab", "/tmp/x.aab", "--key", "/tmp/k.json", "--notes", "Hi"])
        self.assertTrue(args.dry_run)
        self.assertEqual(args.aab, Path("/tmp/x.aab"))
        self.assertEqual(publish.key_path(args, {"PENMOSS_PLAY_KEY": "/elsewhere.json"}), Path("/tmp/k.json"))
        self.assertEqual(args.notes, "Hi")

    def test_the_environment_names_the_key_when_no_flag_does(self) -> None:
        args = publish.parse_args([])
        self.assertEqual(publish.key_path(args, {"PENMOSS_PLAY_KEY": "/elsewhere.json"}), Path("/elsewhere.json"))

    def test_there_is_no_way_to_name_another_track(self) -> None:
        with self.assertRaises(SystemExit), unittest.mock.patch("sys.stderr", io.StringIO()):
            publish.parse_args(["--track", "production"])
        self.assertEqual(publish.TRACK, "internal")

    def test_unknown_flags_are_refused(self) -> None:
        with self.assertRaises(SystemExit) as raised, unittest.mock.patch("sys.stderr", io.StringIO()):
            publish.parse_args(["--commit-anyway"])
        self.assertEqual(raised.exception.code, 2)


class RefusalsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())

    def test_a_missing_key_stops_before_google_is_asked_and_says_where_to_set_it_up(self) -> None:
        run = Run(["--aab", str(bundle(self.folder)), "--key", str(self.folder / "absent.json")])
        self.assertEqual(run.code, 2)
        self.assertEqual(run.keys, [])
        self.assertEqual(run.service.calls, [])
        self.assertIn(f"No Play service-account key at {self.folder / 'absent.json'}", run.err.getvalue())
        self.assertIn("docs/android.md", run.err.getvalue())

    def test_the_default_key_path_is_named_when_it_is_missing(self) -> None:
        home = self.folder / "home"
        home.mkdir()
        with unittest.mock.patch.dict("os.environ", {"HOME": str(home)}):
            run = Run(["--aab", str(bundle(self.folder))])
        self.assertEqual(run.code, 2)
        self.assertIn(str(home / ".config/penmoss/play-service-account.json"), run.err.getvalue())

    def test_a_missing_bundle_says_to_build_it(self) -> None:
        run = Run(["--aab", str(self.folder / "none.aab"), "--key", str(key(self.folder))])
        self.assertEqual(run.code, 2)
        self.assertEqual(run.service.calls, [])
        self.assertIn("task android:release", run.err.getvalue())

    def google_modules(self, loader: Any) -> dict[str, Any]:
        """Stand-ins for the Google client's modules, whose key loader is `loader`."""
        service_account = types.SimpleNamespace(
            Credentials=types.SimpleNamespace(from_service_account_file=loader)
        )
        discovery = types.SimpleNamespace(build=lambda *args, **kwargs: "client")
        return {
            "google": types.SimpleNamespace(oauth2=types.SimpleNamespace(service_account=service_account)),
            "google.oauth2": types.SimpleNamespace(service_account=service_account),
            "google.oauth2.service_account": service_account,
            "googleapiclient": types.SimpleNamespace(discovery=discovery),
            "googleapiclient.discovery": discovery,
        }

    def test_an_unreadable_key_is_named_by_its_errors_type_never_by_what_it_holds(self) -> None:
        path = key(self.folder)

        def loader(name: str, scopes: list[str]) -> Any:
            # As a JSON or PEM parser might: quoting what it could not read.
            raise ValueError(f"Could not deserialize key data: {Path(name).read_text()}")

        with unittest.mock.patch.dict(sys.modules, self.google_modules(loader)):
            with self.assertRaises(publish.Refused) as refused:
                publish.load_service(path)
        message = str(refused.exception)
        self.assertIn(f"The file at {path} is not a usable service-account key (ValueError)", message)
        self.assertNotIn("sentinel", message)
        # Not chained either, so a traceback would not show it.
        self.assertIsNone(refused.exception.__cause__)
        self.assertTrue(refused.exception.__suppress_context__)

    def test_a_usable_key_signs_in_with_the_publisher_scope_only(self) -> None:
        asked: list[tuple[str, list[str]]] = []
        modules = self.google_modules(lambda name, scopes: asked.append((name, scopes)) or "credentials")
        with unittest.mock.patch.dict(sys.modules, modules):
            self.assertEqual(publish.load_service(key(self.folder)), "client")
        self.assertEqual(asked, [(str(self.folder / "play-service-account.json"), [publish.SCOPE])])
        self.assertEqual(publish.SCOPE, "https://www.googleapis.com/auth/androidpublisher")

    def test_without_the_google_client_it_says_to_run_through_the_task(self) -> None:
        missing = {name: None for name in ("google", "google.oauth2", "google.oauth2.service_account")}
        with unittest.mock.patch.dict(sys.modules, missing):
            with self.assertRaises(publish.Refused) as refused:
                publish.load_service(key(self.folder))
        self.assertIn("task android:publish-internal", str(refused.exception))

    def test_an_api_refusal_is_one_line_with_a_hint_and_the_edit_is_deleted(self) -> None:
        service = FakeService()
        service.fail["edits.tracks.update"] = FakeHttpError(403, "The caller does not have permission")
        run = Run(["--aab", str(bundle(self.folder)), "--key", str(key(self.folder))], service=service)
        self.assertEqual(run.code, 1)
        self.assertIn("Google Play answered 403: The caller does not have permission", run.err.getvalue())
        self.assertIn("Release apps to testing tracks", run.err.getvalue())
        self.assertNotIn("edits.commit", service.names())
        self.assertEqual(service.names()[-1], "edits.delete")
        self.assertEqual(service.calls[-1][1], {"packageName": "app.penmoss", "editId": "edit-1"})

    def test_a_draft_app_is_explained(self) -> None:
        service = FakeService()
        service.fail["edits.commit"] = FakeHttpError(400, "Only releases with status draft may be created on draft app.")
        run = Run(["--aab", str(bundle(self.folder)), "--key", str(key(self.folder))], service=service)
        self.assertEqual(run.code, 1)
        self.assertIn("first release is rolled out in Play Console", run.err.getvalue())
        self.assertEqual(service.names()[-1], "edits.delete")

    def test_an_error_that_is_not_the_apis_is_raised_and_the_edit_still_deleted(self) -> None:
        service = FakeService()
        service.fail["edits.validate"] = RuntimeError("socket closed")
        with self.assertRaises(RuntimeError):
            Run(["--dry-run", "--aab", str(bundle(self.folder)), "--key", str(key(self.folder))], service=service)
        self.assertEqual(service.names()[-1], "edits.delete")

    def test_nothing_printed_ever_holds_the_key(self) -> None:
        run = Run(["--aab", str(bundle(self.folder)), "--key", str(key(self.folder))])
        self.assertEqual(run.code, 0)
        self.assertNotIn("sentinel", run.output)
        self.assertNotIn("PRIVATE KEY", run.output)


class PublishTest(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())
        self.key = key(self.folder)

    def test_uploads_sets_the_internal_track_completed_and_commits(self) -> None:
        run = Run(["--aab", str(bundle(self.folder)), "--key", str(self.key), "--notes", "Fixes"])
        self.assertEqual(run.code, 0, run.output)
        self.assertEqual(run.keys, [self.key])
        service = run.service
        self.assertEqual(
            service.names(),
            [
                "edits.insert",
                "edits.bundles.upload",
                "edits.deobfuscationfiles.upload",
                "edits.tracks.update",
                "edits.commit",
            ],
        )
        calls = dict(service.calls)
        self.assertEqual(calls["edits.insert"], {"packageName": "app.penmoss", "body": {}})
        self.assertEqual(calls["edits.bundles.upload"]["media_body"], "media:app-release.aab")
        self.assertEqual(
            calls["edits.tracks.update"],
            {
                "packageName": "app.penmoss",
                "editId": "edit-1",
                "track": "internal",
                "body": {
                    "track": "internal",
                    "releases": [
                        {
                            "versionCodes": ["431083"],
                            "status": "completed",
                            "releaseNotes": [{"language": "en-US", "text": "Fixes"}],
                        }
                    ],
                },
            },
        )
        self.assertIn("Version code 431083, track internal", run.out.getvalue())
        self.assertIn("Released 431083 to the internal track (completed).", run.out.getvalue())

    def test_dry_run_validates_then_deletes_the_edit_and_never_commits(self) -> None:
        run = Run(["--dry-run", "--aab", str(bundle(self.folder)), "--key", str(self.key)])
        self.assertEqual(run.code, 0, run.output)
        names = run.service.names()
        self.assertEqual(names[-2:], ["edits.validate", "edits.delete"])
        self.assertNotIn("edits.commit", names)
        self.assertEqual(names.count("edits.delete"), 1)
        self.assertIn("Version code 431083, track internal", run.out.getvalue())
        self.assertIn("nothing was published", run.out.getvalue())

    def test_no_release_notes_unless_given(self) -> None:
        run = Run(["--aab", str(bundle(self.folder)), "--key", str(self.key)])
        release = dict(run.service.calls)["edits.tracks.update"]["body"]["releases"][0]
        self.assertEqual(release, {"versionCodes": ["431083"], "status": "completed"})

    def test_stripped_native_libraries_go_up_as_the_versions_native_symbols(self) -> None:
        uploads: list[tuple[str, list[str], dict[str, bytes]]] = []

        def upload(path: Path) -> str:
            if path.suffix == ".zip":
                with zipfile.ZipFile(path) as archive:
                    uploads.append((path.name, archive.namelist(), {n: archive.read(n) for n in archive.namelist()}))
            return f"media:{path.name}"

        service = FakeService()
        publish.publish(service, bundle(self.folder), dry_run=False, notes=None, out=io.StringIO(), upload=upload)
        symbols = dict(service.calls)["edits.deobfuscationfiles.upload"]
        self.assertEqual(symbols["apkVersionCode"], 431083)
        self.assertEqual(symbols["deobfuscationFileType"], "nativeCode")
        self.assertEqual(symbols["media_body"], "media:native-debug-symbols.zip")
        name, entries, contents = uploads[0]
        self.assertEqual(sorted(entries), ["arm64-v8a/libandroidx.graphics.path.so", "x86_64/libandroidx.graphics.path.so"])
        self.assertEqual(contents["arm64-v8a/libandroidx.graphics.path.so"], b"\x7fELF-arm64")

    def test_a_bundle_that_carries_its_own_symbols_or_no_native_code_sends_none(self) -> None:
        for folder, made in (
            ("own", lambda f: bundle(f, symbols=True)),
            ("none", lambda f: bundle(f, libraries=False)),
        ):
            path = self.folder / folder
            path.mkdir()
            run = Run(["--aab", str(made(path)), "--key", str(self.key)])
            self.assertEqual(run.code, 0, run.output)
            self.assertNotIn("edits.deobfuscationfiles.upload", run.service.names())


if __name__ == "__main__":
    unittest.main()
