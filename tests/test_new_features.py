"""Tests for new features: ecosystem detection, 2-stage stop, PDF generation, and fullscreen."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from py_project_storage_helper.api import StorageHelperApi
from py_project_storage_helper.report_generator import generate_deletion_report_pdf
from py_project_storage_helper.scanner import (
    DisposableFolder,
    detect_ecosystem,
    find_projects_and_disposables,
    get_dominant_category,
)


class TestNewFeatures(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="test_features_")
        self.root = Path(self.temp_dir)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_ecosystem_detection(self):
        # Rust project
        rust_proj = self.root / "rust_app"
        rust_proj.mkdir()
        (rust_proj / "Cargo.toml").write_text("[package]\nname='app'", encoding="utf-8")
        target_dir = rust_proj / "target"
        target_dir.mkdir()
        (target_dir / "bin.exe").write_bytes(b"x" * 100)

        projects = find_projects_and_disposables(self.root)
        self.assertEqual(len(projects), 1)
        p = projects[0]
        self.assertEqual(p.ecosystem, "Rust")
        self.assertEqual(p.dominant_category, "build")
        self.assertEqual(p.total_file_count, 1)

    def test_dominant_category(self):
        folders = [
            DisposableFolder(path="p1", name="node_modules", category="node", size_bytes=1000, file_count=10),
            DisposableFolder(path="p2", name=".cache", category="cache", size_bytes=5000, file_count=5),
        ]
        dom = get_dominant_category(folders)
        self.assertEqual(dom, "cache")

    def test_two_stage_stop_scan(self):
        api = StorageHelperApi()
        # Initial stop
        res1 = api.stop_scan()
        self.assertEqual(res1["level"], 1)
        self.assertTrue(api._stop_scan_after_project.is_set())

        # Second stop
        res2 = api.stop_scan()
        self.assertEqual(res2["level"], 2)
        self.assertTrue(api._stop_scan_immediate.is_set())

    def test_two_stage_stop_delete(self):
        api = StorageHelperApi()
        res1 = api.stop_delete()
        self.assertEqual(res1["level"], 1)
        self.assertTrue(api._stop_delete_after_project.is_set())

        res2 = api.stop_delete()
        self.assertEqual(res2["level"], 2)
        self.assertTrue(api._stop_delete_immediate.is_set())

    def test_toggle_fullscreen(self):
        api = StorageHelperApi()
        fake_win = mock.MagicMock()
        api.set_window(fake_win)
        self.assertTrue(api.toggle_fullscreen())
        fake_win.toggle_fullscreen.assert_called_once()

    def test_pdf_report_generation(self):
        out_pdf = self.root / "report.pdf"
        report_data = {
            "timestamp": "08.10.2026, 20:00",
            "total_freed_bytes": 1048576 * 15,
            "total_files_deleted": 120,
            "total_folders_deleted": 3,
            "use_trash": True,
            "stopped_early": False,
            "categories": {
                "node": {"label": "Node-Pakete", "bytes": 1048576 * 10, "folders": 1, "files": 90, "percentage": 66.7},
                "cache": {"label": "Caches", "bytes": 1048576 * 5, "folders": 2, "files": 30, "percentage": 33.3},
            },
            "projects": [
                {
                    "name": "my-web-project",
                    "path": str(self.root / "my-web-project"),
                    "ecosystem": "Node.js",
                    "freed_bytes": 1048576 * 10,
                    "files_deleted": 90,
                    "folders": [
                        {"name": "node_modules", "category": "Node-Pakete", "bytes": 1048576 * 10, "files": 90, "success": True}
                    ],
                }
            ],
        }

        path_generated = generate_deletion_report_pdf(out_pdf, report_data)
        self.assertTrue(os.path.exists(path_generated))
        self.assertGreater(os.path.getsize(path_generated), 1000)


if __name__ == "__main__":
    unittest.main()
