"""Tests for scanner and cleaner modules."""

import shutil
import tempfile
from pathlib import Path
import unittest

from py_project_storage_helper.scanner import (
    format_size,
    get_dir_size_fast,
    find_projects_and_disposables,
)
from py_project_storage_helper.cleaner import (
    is_safe_to_delete,
    delete_directory,
)


class TestScannerAndCleaner(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="test_storage_helper_")
        self.root = Path(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_format_size(self):
        self.assertEqual(format_size(500), "500 B")
        self.assertEqual(format_size(2048), "2.0 KB")
        self.assertEqual(format_size(1024 * 1024 * 3), "3.00 MB")
        self.assertEqual(format_size(1024 * 1024 * 1024 * 2), "2.00 GB")

    def test_get_dir_size_fast(self):
        sample_dir = self.root / "sample"
        sample_dir.mkdir()
        (sample_dir / "file1.txt").write_bytes(b"x" * 100)
        (sample_dir / "sub").mkdir()
        (sample_dir / "sub" / "file2.txt").write_bytes(b"y" * 250)

        size, count = get_dir_size_fast(sample_dir)
        self.assertEqual(size, 350)
        self.assertEqual(count, 2)

    def test_find_projects_and_disposables(self):
        # Create Project 1 (Python)
        p1 = self.root / "my_python_project"
        p1.mkdir()
        (p1 / "pyproject.toml").write_text("[project]\nname='test'", encoding="utf-8")
        venv = p1 / ".venv"
        venv.mkdir()
        (venv / "dummy.lib").write_bytes(b"0" * 1024)

        # Create Project 2 (Node)
        p2 = self.root / "subfolder" / "my_node_project"
        p2.mkdir(parents=True)
        (p2 / "package.json").write_text('{"name": "test"}', encoding="utf-8")
        nm = p2 / "node_modules"
        nm.mkdir()
        (nm / "pkg.js").write_bytes(b"1" * 2048)

        # Create .git inside p1 to ensure it's not traversed
        git = p1 / ".git"
        git.mkdir()
        (git / "config").write_text("git config", encoding="utf-8")

        found = find_projects_and_disposables(self.root)
        self.assertEqual(len(found), 2)

        p_names = {p.name for p in found}
        self.assertIn("my_python_project", p_names)
        self.assertIn("my_node_project", p_names)

        p1_info = next(p for p in found if p.name == "my_python_project")
        self.assertEqual(len(p1_info.disposable_folders), 1)
        self.assertEqual(p1_info.disposable_folders[0].name, ".venv")
        self.assertEqual(p1_info.disposable_folders[0].size_bytes, 1024)

        p2_info = next(p for p in found if p.name == "my_node_project")
        self.assertEqual(len(p2_info.disposable_folders), 1)
        self.assertEqual(p2_info.disposable_folders[0].name, "node_modules")
        self.assertEqual(p2_info.disposable_folders[0].size_bytes, 2048)

    def test_safety_rules(self):
        # .git must be blocked
        git_dir = self.root / ".git"
        git_dir.mkdir()
        safe, msg = is_safe_to_delete(git_dir)
        self.assertFalse(safe)
        self.assertIn(".git", msg)

        # Non-disposable folder must be blocked
        src_dir = self.root / "src"
        src_dir.mkdir()
        safe, msg = is_safe_to_delete(src_dir)
        self.assertFalse(safe)

        # Valid disposable folder must be accepted
        venv_dir = self.root / ".venv"
        venv_dir.mkdir()
        safe, _ = is_safe_to_delete(venv_dir)
        self.assertTrue(safe)

    def test_delete_directory_permanent(self):
        target = self.root / "node_modules"
        target.mkdir()
        (target / "sample.js").write_bytes(b"abc")

        res = delete_directory(target, use_trash=False)
        self.assertTrue(res.success)
        self.assertFalse(target.exists())
        self.assertEqual(res.freed_bytes, 3)


if __name__ == "__main__":
    unittest.main()
