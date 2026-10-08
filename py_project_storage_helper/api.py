"""API bridge between PyWebView and the Python backend."""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Optional

import webview

from py_project_storage_helper.cleaner import delete_directories_batch
from py_project_storage_helper.scanner import (
    ProjectInfo,
    find_projects_and_disposables,
    format_size,
)


class StorageHelperApi:
    """Methods exposed to JavaScript via pywebview.api."""

    def __init__(self) -> None:
        self.window: Optional[webview.Window] = None
        self._stop_scan_flag = threading.Event()
        self._scan_thread: Optional[threading.Thread] = None
        self._delete_thread: Optional[threading.Thread] = None

    def set_window(self, window: webview.Window) -> None:
        self.window = window

    def _eval_js(self, fn_name: str, payload: Any = None) -> None:
        """Safely invoke a JavaScript callback on the frontend."""
        if not self.window:
            return
        try:
            if payload is not None:
                arg = json.dumps(payload, ensure_ascii=False)
                js = f"window.{fn_name}({arg});"
            else:
                js = f"window.{fn_name}();"
            self.window.evaluate_js(js)
        except Exception as exc:
            print(f"[StorageHelperApi] JS eval error: {exc}")

    def select_folder(self) -> str:
        """Open native folder picker and return chosen path."""
        if not self.window:
            return ""
        try:
            # FileDialog.FOLDER in pywebview
            result = self.window.create_file_dialog(webview.FileDialog.FOLDER)
            if result and len(result) > 0:
                selected = str(result[0])
                return selected
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
        if not path.exists() or not path.is_dir():
            return {"status": "error", "message": "Der angegebene Ordner existiert nicht."}

        if self._scan_thread and self._scan_thread.is_alive():
            self._stop_scan_flag.set()
            self._scan_thread.join(timeout=1.0)

        self._stop_scan_flag.clear()

        def run_scan() -> None:
            total_projects_count = 0
            total_reclaimable_bytes = 0

            def on_project(p: ProjectInfo) -> None:
                nonlocal total_projects_count, total_reclaimable_bytes
                total_projects_count += 1
                total_reclaimable_bytes += p.total_disposable_size
                project_dict = {
                    "path": p.path,
                    "name": p.name,
                    "relative_path": p.relative_path,
                    "total_size": p.total_disposable_size,
                    "total_size_human": p.total_disposable_human,
                    "folders": [
                        {
                            "path": f.path,
                            "name": f.name,
                            "category": f.category,
                            "category_label": f.category_label,
                            "size_bytes": f.size_bytes,
                            "size_human": f.size_human,
                            "file_count": f.file_count,
                        }
                        for f in p.disposable_folders
                    ],
                }
                self._eval_js("onProjectDiscovered", project_dict)

            def on_progress(msg: str) -> None:
                self._eval_js("onScanProgress", {"message": msg})

            try:
                find_projects_and_disposables(
                    path,
                    on_project_found=on_project,
                    on_progress=on_progress,
                    should_stop=lambda: self._stop_scan_flag.is_set(),
                )
            except Exception as e:
                self._eval_js(
                    "onScanCompleted",
                    {
                        "stopped": False,
                        "error": str(e),
                        "total_projects": total_projects_count,
                        "total_bytes": total_reclaimable_bytes,
                        "total_human": format_size(total_reclaimable_bytes),
                    },
                )
                return

            self._eval_js(
                "onScanCompleted",
                {
                    "stopped": self._stop_scan_flag.is_set(),
                    "total_projects": total_projects_count,
                    "total_bytes": total_reclaimable_bytes,
                    "total_human": format_size(total_reclaimable_bytes),
                },
            )

        self._scan_thread = threading.Thread(target=run_scan, daemon=True)
        self._scan_thread.start()
        return {"status": "started"}

    def stop_scan(self) -> dict[str, Any]:
        """Signal scanning thread to stop."""
        self._stop_scan_flag.set()
        return {"status": "stopped"}

    def delete_items(self, paths: list[str], use_trash: bool = True) -> dict[str, Any]:
        """Delete list of folders in background thread with progress feedback."""
        if not paths:
            return {"status": "error", "message": "Keine Ordner zum Löschen ausgewählt."}

        def run_deletion() -> None:
            def on_item(result: Any, current_idx: int, total_cnt: int) -> None:
                self._eval_js(
                    "onDeleteProgress",
                    {
                        "current": current_idx,
                        "total": total_cnt,
                        "path": result.path,
                        "success": result.success,
                        "freed_bytes": result.freed_bytes,
                        "freed_human": format_size(result.freed_bytes),
                        "error": result.error,
                    },
                )

            results, total_freed = delete_directories_batch(
                paths,
                use_trash=use_trash,
                on_item_completed=on_item,
            )

            self._eval_js(
                "onDeleteCompleted",
                {
                    "total_count": len(paths),
                    "success_count": sum(1 for r in results if r.success),
                    "failed_count": sum(1 for r in results if not r.success),
                    "total_freed_bytes": total_freed,
                    "total_freed_human": format_size(total_freed),
                    "use_trash": use_trash,
                },
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
            # On Windows: os.startfile or explorer
            if os.name == "nt":
                os.startfile(str(path))
            else:
                subprocess.run(["xdg-open", str(path)], check=False)
            return True
        except Exception as exc:
            print(f"[StorageHelperApi] Explorer open error: {exc}")
            return False
