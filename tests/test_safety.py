"""Tests for the rules that decide what may be offered for deletion and what may be deleted."""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from py_project_storage_helper.cleaner import delete_directory, is_safe_to_delete
from py_project_storage_helper.scanner import find_projects_and_disposables, get_dir_size_fast


def make_venv(path: Path) -> Path:
    path.mkdir(parents=True)
    (path / "pyvenv.cfg").write_text("home = x", encoding="utf-8")
    return path


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="test_storage_helper_"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def project(self, name: str, marker: str = "pyproject.toml") -> Path:
        p = self.root / name
        p.mkdir(parents=True)
        (p / marker).write_text("x", encoding="utf-8")
        return p

    def folder_names(self, project_name: str) -> set[str]:
        found = find_projects_and_disposables(self.root)
        project = next((p for p in found if p.name == project_name), None)
        return {f.name for f in project.disposable_folders} if project else set()


class TestScannerOffers(TempDirTest):
    def test_env_folder_without_pyvenv_cfg_is_not_offered(self):
        p = self.project("app")
        (p / "env").mkdir()
        (p / "env" / "prod.yaml").write_text("secret: 1", encoding="utf-8")
        self.assertEqual(self.folder_names("app"), set())

    def test_real_venv_named_env_is_offered(self):
        p = self.project("app")
        make_venv(p / "env")
        self.assertEqual(self.folder_names("app"), {"env"})

    def test_dot_env_folder_is_never_offered(self):
        p = self.project("app")
        make_venv(p / ".env")
        self.assertEqual(self.folder_names("app"), set())

    def test_nested_monorepo_package_is_its_own_project(self):
        root = self.project("mono", "package.json")
        (root / "node_modules").mkdir()
        pkg = root / "packages" / "ui"
        pkg.mkdir(parents=True)
        (pkg / "package.json").write_text("{}", encoding="utf-8")
        (pkg / "node_modules").mkdir()

        found = {p.relative_path.replace("\\", "/"): p for p in find_projects_and_disposables(self.root)}
        self.assertEqual(set(found), {"mono", "mono/packages/ui"})
        self.assertEqual([f.name for f in found["mono"].disposable_folders], ["node_modules"])

    def test_should_stop_ends_scan_early(self):
        for i in range(3):
            (self.project(f"p{i}", "package.json") / "node_modules").mkdir()
        self.assertEqual(find_projects_and_disposables(self.root, should_stop=lambda: True), [])

    def test_missing_root_returns_nothing(self):
        self.assertEqual(find_projects_and_disposables(self.root / "missing"), [])

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks not supported")
    def test_size_does_not_follow_links(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "big.bin").write_bytes(b"x" * 5000)
        nm = self.root / "node_modules"
        nm.mkdir()
        (nm / "a.js").write_bytes(b"x" * 10)
        try:
            os.symlink(outside, nm / "link", target_is_directory=True)
        except OSError:
            self.skipTest("creating symlinks needs extra rights on this system")
        self.assertEqual(get_dir_size_fast(nm), (10, 1))


class TestDeleteRules(TempDirTest):
    def test_inside_git_is_refused(self):
        target = self.root / ".git" / "node_modules"
        target.mkdir(parents=True)
        safe, msg = is_safe_to_delete(target)
        self.assertFalse(safe)
        self.assertIn(".git", msg)

    def test_drive_root_is_refused(self):
        safe, _ = is_safe_to_delete(Path(self.root.anchor))
        self.assertFalse(safe)

    def test_file_is_refused(self):
        f = self.root / "node_modules"
        f.write_text("not a dir", encoding="utf-8")
        self.assertFalse(is_safe_to_delete(f)[0])

    def test_missing_folder_is_refused(self):
        self.assertFalse(is_safe_to_delete(self.root / "node_modules")[0])

    def test_env_without_pyvenv_cfg_is_refused(self):
        (self.root / "env").mkdir()
        safe, msg = is_safe_to_delete(self.root / "env")
        self.assertFalse(safe)
        self.assertIn("pyvenv.cfg", msg)

    def test_egg_info_is_allowed(self):
        (self.root / "pkg.egg-info").mkdir()
        self.assertTrue(is_safe_to_delete(self.root / "pkg.egg-info")[0])

    def test_refused_folder_is_left_untouched(self):
        src = self.root / "src"
        src.mkdir()
        res = delete_directory(src, use_trash=False)
        self.assertFalse(res.success)
        self.assertTrue(src.exists())

    def test_trash_mode_uses_send2trash(self):
        target = self.root / "node_modules"
        target.mkdir()
        with mock.patch("py_project_storage_helper.cleaner.send2trash.send2trash") as trash:
            res = delete_directory(target, use_trash=True)
        self.assertTrue(res.success)
        trash.assert_called_once_with(str(target.resolve()))

    def test_errors_are_reported_not_raised(self):
        target = self.root / "node_modules"
        target.mkdir()
        with mock.patch("py_project_storage_helper.cleaner.shutil.rmtree", side_effect=PermissionError("gesperrt")):
            res = delete_directory(target, use_trash=False)
        self.assertFalse(res.success)
        self.assertIn("gesperrt", res.error)


if __name__ == "__main__":
    unittest.main()
