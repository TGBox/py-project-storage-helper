"""API bridge between PyWebView and the Python backend."""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

import webview

from py_project_storage_helper.cleaner import DeleteResult, delete_directory
from py_project_storage_helper.scanner import ProjectInfo, find_projects_and_disposables


class StorageHelperApi:
    """Methods exposed to JavaScript via pywebview.api."""

    def __init__(self) -> None:
        # Underscore matters: pywebview walks every public attribute of the js_api object to
        # expose it to JavaScript. A public reference to the window makes it crawl the native
        # WinForms/.NET objects behind it, and the app freezes on start.
        self._window: Optional[webview.Window] = None
        self._stop_scan_flag = threading.Event()
        # Only folders reported by the latest scan may be deleted
        self._scanned_paths: set[str] = set()
        self._delete_thread: Optional[threading.Thread] = None

    def set_window(self, window: webview.Window) -> None:
        self._window = window

    def _eval_js(self, fn_name: str, payload: Any) -> None:
        """Safely invoke a JavaScript callback on the frontend."""
        if not self._window:
            return
        try:
            self._window.evaluate_js(f"window.{fn_name}({json.dumps(payload, ensure_ascii=False)});")
        except Exception as exc:
            print(f"[StorageHelperApi] JS eval error: {exc}")

    def select_folder(self) -> str:
        """Open native folder picker and return chosen path."""
        if not self._window:
            return ""
        try:
            result = self._window.create_file_dialog(webview.FileDialog.FOLDER)
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
            return {"status": "error", "message": "Ordner nicht gefunden. Prüfe den Pfad oder wähle ihn über „Ordner wählen“."}

        # Stop any running scan. Each scan gets its own event, so an old thread that is still
        # winding down can neither be restarted by mistake nor push results into the new scan.
        self._stop_scan_flag.set()
        stop = threading.Event()
        self._stop_scan_flag = stop
        self._scanned_paths = set()

        def emit(fn_name: str, payload: Any) -> None:
            if self._stop_scan_flag is stop:
                self._eval_js(fn_name, payload)

        def run_scan() -> None:
            total_projects = 0
            total_bytes = 0
            error = None

            last_progress = 0.0

            def on_progress(msg: str) -> None:
                # The scanner reports every directory; the GUI only needs a few updates per second
                nonlocal last_progress
                now = time.monotonic()
                if now - last_progress >= 0.1:
                    last_progress = now
                    emit("onScanProgress", {"message": msg})

            def on_project(p: ProjectInfo) -> None:
                nonlocal total_projects, total_bytes
                total_projects += 1
                total_bytes += p.total_disposable_size
                if self._stop_scan_flag is stop:
                    self._scanned_paths.update(f.path for f in p.disposable_folders)
                emit("onProjectDiscovered", asdict(p))

            try:
                find_projects_and_disposables(
                    path,
                    on_project_found=on_project,
                    on_progress=on_progress,
                    should_stop=stop.is_set,
                )
            except Exception as e:
                error = str(e)

            emit(
                "onScanCompleted",
                {
                    "stopped": error is None and stop.is_set(),
                    "error": error,
                    "total_projects": total_projects,
                    "total_bytes": total_bytes,
                },
            )

        threading.Thread(target=run_scan, daemon=True).start()
        return {"status": "started"}

    def stop_scan(self) -> None:
        """Signal scanning thread to stop."""
        self._stop_scan_flag.set()

    def delete_items(self, paths: list[str], use_trash: bool = True) -> dict[str, Any]:
        """Delete list of folders in background thread with progress feedback."""
        if not paths:
            return {"status": "error", "message": "Markiere zuerst mindestens einen Ordner."}
        if self._delete_thread and self._delete_thread.is_alive():
            return {"status": "error", "message": "Es werden gerade schon Ordner entfernt. Warte, bis das fertig ist."}

        def run_deletion() -> None:
            success_count = 0
            for idx, path in enumerate(paths, 1):
                if path in self._scanned_paths:
                    res = delete_directory(path, use_trash=use_trash)
                else:
                    res = DeleteResult(path=path, success=False, error="Ordner stammt nicht aus dem letzten Scan.")
                if res.success:
                    self._scanned_paths.discard(path)
                success_count += res.success
                self._eval_js(
                    "onDeleteProgress",
                    {"current": idx, "total": len(paths), "path": path, "success": res.success, "error": res.error},
                )

            self._eval_js(
                "onDeleteCompleted",
                {"success_count": success_count, "use_trash": use_trash},
            )

        self._delete_thread = threading.Thread(target=run_deletion, daemon=True)
        self._delete_thread.start()
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
