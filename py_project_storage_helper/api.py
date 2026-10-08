"""API bridge between PyWebView and the Python backend."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

import webview

from py_project_storage_helper.cleaner import delete_directory
from py_project_storage_helper.scanner import ProjectInfo, find_projects_and_disposables


class StorageHelperApi:
    """Methods exposed to JavaScript via pywebview.api."""

    def __init__(self) -> None:
        self.window: Optional[webview.Window] = None
        self._stop_scan_flag = threading.Event()
        self._scan_thread: Optional[threading.Thread] = None

    def set_window(self, window: webview.Window) -> None:
        self.window = window

    def _eval_js(self, fn_name: str, payload: Any) -> None:
        """Safely invoke a JavaScript callback on the frontend."""
        if not self.window:
            return
        try:
            self.window.evaluate_js(f"window.{fn_name}({json.dumps(payload, ensure_ascii=False)});")
        except Exception as exc:
            print(f"[StorageHelperApi] JS eval error: {exc}")

    def select_folder(self) -> str:
        """Open native folder picker and return chosen path."""
        if not self.window:
            return ""
        try:
            result = self.window.create_file_dialog(webview.FileDialog.FOLDER)
            return str(result[0]) if result else ""
        except Exception as exc:
            print(f"[StorageHelperApi] Folder picker error: {exc}")
            return ""

    def get_initial_folder(self) -> str:
        """Return a sensible initial folder for convenience."""
        current = Path.cwd().resolve()
        # If running from inside a subfolder, parent folder often contains other projects
        if (current / "pyproject.toml").exists() and current.parent.exists():
            return str(current.parent)
        return str(current)

    def start_scan(self, folder_path: str) -> dict[str, Any]:
        """Start scanning in background thread."""
        path = Path(folder_path).resolve()
        if not path.is_dir():
            return {"status": "error", "message": "Der angegebene Ordner existiert nicht."}

        if self._scan_thread and self._scan_thread.is_alive():
            self._stop_scan_flag.set()
            self._scan_thread.join(timeout=1.0)

        self._stop_scan_flag.clear()

        def run_scan() -> None:
            total_projects = 0
            total_bytes = 0
            error = None

            def on_project(p: ProjectInfo) -> None:
                nonlocal total_projects, total_bytes
                total_projects += 1
                total_bytes += p.total_disposable_size
                self._eval_js("onProjectDiscovered", asdict(p))

            try:
                find_projects_and_disposables(
                    path,
                    on_project_found=on_project,
                    on_progress=lambda msg: self._eval_js("onScanProgress", {"message": msg}),
                    should_stop=self._stop_scan_flag.is_set,
                )
            except Exception as e:
                error = str(e)

            self._eval_js(
                "onScanCompleted",
                {
                    "stopped": error is None and self._stop_scan_flag.is_set(),
                    "error": error,
                    "total_projects": total_projects,
                    "total_bytes": total_bytes,
                },
            )

        self._scan_thread = threading.Thread(target=run_scan, daemon=True)
        self._scan_thread.start()
        return {"status": "started"}

    def stop_scan(self) -> None:
        """Signal scanning thread to stop."""
        self._stop_scan_flag.set()

    def delete_items(self, paths: list[str], use_trash: bool = True) -> dict[str, Any]:
        """Delete list of folders in background thread with progress feedback."""
        if not paths:
            return {"status": "error", "message": "Keine Ordner zum Löschen ausgewählt."}

        def run_deletion() -> None:
            success_count = 0
            freed_bytes = 0
            for idx, path in enumerate(paths, 1):
                res = delete_directory(path, use_trash=use_trash)
                success_count += res.success
                freed_bytes += res.freed_bytes
                self._eval_js(
                    "onDeleteProgress",
                    {"current": idx, "total": len(paths), "path": res.path, "success": res.success, "error": res.error},
                )

            self._eval_js(
                "onDeleteCompleted",
                {"success_count": success_count, "total_freed_bytes": freed_bytes, "use_trash": use_trash},
            )

        threading.Thread(target=run_deletion, daemon=True).start()
        return {"status": "started"}

    def open_in_explorer(self, folder_path: str) -> bool:
        """Open folder in Windows Explorer."""
        try:
            path = Path(folder_path).resolve()
            if not path.exists():
                return False
            os.startfile(str(path))
            return True
        except Exception as exc:
            print(f"[StorageHelperApi] Explorer open error: {exc}")
            return False
