"""Tests for the bridge between the GUI and the backend (StorageHelperApi)."""

import json
import re
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from py_project_storage_helper import api as api_module
from py_project_storage_helper.api import StorageHelperApi
from py_project_storage_helper.scanner import DisposableFolder, ProjectInfo


class FakeWindow:
    """Records the JavaScript callbacks the API would run in the GUI."""

    def __init__(self):
        self.calls: list[tuple[str, object]] = []
        self.lock = threading.Lock()

    def evaluate_js(self, js: str) -> None:
        m = re.fullmatch(r"window\.(\w+)\((.*)\);", js, re.S)
        with self.lock:
            self.calls.append((m.group(1), json.loads(m.group(2))))

    def names(self) -> list[str]:
        with self.lock:
            return [name for name, _ in self.calls]

    def payloads(self, name: str) -> list:
        with self.lock:
            return [p for n, p in self.calls if n == name]

    def wait_for(self, name: str, count: int = 1, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while len(self.payloads(name)) < count:
            if time.monotonic() > deadline:
                raise AssertionError(f"{name} was not called {count}x; calls: {self.names()}")
            time.sleep(0.01)


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="test_storage_helper_api_"))
        self.window = FakeWindow()
        self.api = StorageHelperApi()
        self.api.set_window(self.window)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def make_node_project(self, name: str) -> Path:
        p = self.root / name
        (p / "node_modules").mkdir(parents=True)
        (p / "package.json").write_text("{}", encoding="utf-8")
        (p / "node_modules" / "a.js").write_bytes(b"x" * 100)
        return p / "node_modules"

    def scan(self) -> dict:
        self.assertEqual(self.api.start_scan(str(self.root)), {"status": "started"})
        self.window.wait_for("onScanCompleted")
        return self.window.payloads("onScanCompleted")[-1]


class TestExposure(unittest.TestCase):
    def test_only_methods_are_public(self):
        # pywebview exposes every public attribute of the js_api object to JavaScript and walks
        # into non-callables. Public data (e.g. the window) makes the app hang on start.
        api = StorageHelperApi()
        api.set_window(FakeWindow())
        public_data = [n for n in dir(api) if not n.startswith("_") and not callable(getattr(api, n))]
        self.assertEqual(public_data, [])


class TestScan(ApiTest):
    def test_missing_folder_is_reported(self):
        res = self.api.start_scan(str(self.root / "missing"))
        self.assertEqual(res["status"], "error")
        self.assertIn("nicht gefunden", res["message"])

    def test_projects_are_sent_with_the_fields_the_gui_reads(self):
        self.make_node_project("web")
        summary = self.scan()

        self.assertEqual(summary, {"stopped": False, "error": None, "total_projects": 1, "total_bytes": 100})
        (project,) = self.window.payloads("onProjectDiscovered")
        self.assertEqual(
            set(project), {"path", "name", "relative_path", "disposable_folders", "total_disposable_size"}
        )
        self.assertEqual(
            set(project["disposable_folders"][0]), {"path", "name", "category", "size_bytes", "file_count"}
        )

    def test_scanner_error_is_reported_in_summary(self):
        with mock.patch.object(api_module, "find_projects_and_disposables", side_effect=RuntimeError("kaputt")):
            summary = self.scan()
        self.assertEqual(summary["error"], "kaputt")
        self.assertFalse(summary["stopped"])

    def test_results_of_a_replaced_scan_are_dropped(self):
        release_old = threading.Event()
        calls = 0

        def fake_scan(root, on_project_found, on_progress, should_stop):
            nonlocal calls
            calls += 1
            name = "alt" if calls == 1 else "neu"
            if name == "alt":
                release_old.wait(5)
            on_project_found(ProjectInfo(path=f"C:/{name}", name=name, relative_path=name,
                                         disposable_folders=[DisposableFolder(f"C:/{name}/dist", "dist", "build", 1)],
                                         total_disposable_size=1))
            return []

        with mock.patch.object(api_module, "find_projects_and_disposables", side_effect=fake_scan):
            self.api.start_scan(str(self.root))   # old scan, blocked
            self.api.start_scan(str(self.root))   # new scan replaces it
            self.window.wait_for("onScanCompleted")
            release_old.set()
            time.sleep(0.2)

        self.assertEqual([p["name"] for p in self.window.payloads("onProjectDiscovered")], ["neu"])
        self.assertEqual(len(self.window.payloads("onScanCompleted")), 1)
        self.assertEqual(self.api._scanned_paths, {"C:/neu/dist"})


class TestDelete(ApiTest):
    def delete(self, paths: list[str]) -> dict:
        self.assertEqual(self.api.delete_items(paths, False), {"status": "started"})
        self.window.wait_for("onDeleteCompleted")
        return self.window.payloads("onDeleteCompleted")[-1]

    def test_empty_selection_is_rejected(self):
        self.assertEqual(self.api.delete_items([], True)["status"], "error")

    def test_scanned_folder_is_deleted_and_reported_with_original_path(self):
        nm = self.make_node_project("web")
        self.scan()
        scanned_path = self.window.payloads("onProjectDiscovered")[0]["disposable_folders"][0]["path"]

        summary = self.delete([scanned_path])

        self.assertFalse(nm.exists())
        self.assertEqual(summary, {"success_count": 1, "use_trash": False})
        (progress,) = self.window.payloads("onDeleteProgress")
        self.assertEqual(progress["path"], scanned_path)
        self.assertTrue(progress["success"])

    def test_folder_not_from_last_scan_is_refused(self):
        nm = self.make_node_project("web")   # exists, but was never scanned
        summary = self.delete([str(nm)])

        self.assertTrue(nm.exists())
        self.assertEqual(summary["success_count"], 0)
        self.assertIn("letzten Scan", self.window.payloads("onDeleteProgress")[0]["error"])

    def test_failure_of_one_folder_does_not_stop_the_rest(self):
        self.make_node_project("a")
        self.make_node_project("b")
        self.scan()
        paths = sorted(f["path"] for p in self.window.payloads("onProjectDiscovered") for f in p["disposable_folders"])
        shutil.rmtree(paths[0])   # vanished between scan and delete

        summary = self.delete(paths)

        self.assertEqual(summary["success_count"], 1)
        self.assertEqual([p["success"] for p in self.window.payloads("onDeleteProgress")], [False, True])


if __name__ == "__main__":
    unittest.main()
