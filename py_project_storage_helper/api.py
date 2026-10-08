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
from py_project_storage_helper.report_generator import generate_deletion_report_pdf
from py_project_storage_helper.scanner import ProjectInfo, find_projects_and_disposables


class StorageHelperApi:
    """Methods exposed to JavaScript via pywebview.api."""

    def __init__(self) -> None:
        # Underscore matters: pywebview walks every public attribute of the js_api object to
        # expose it to JavaScript. A public reference to the window makes it crawl the native
        # WinForms/.NET objects behind it, and the app freezes on start.
        self._window: Optional[webview.Window] = None
        self._stop_scan_immediate = threading.Event()
        self._stop_scan_after_project = threading.Event()
        self._scan_stop_level = 0
        # Backward-compatible reference for tests/external checks
        self._stop_scan_flag = self._stop_scan_immediate

        self._stop_delete_immediate = threading.Event()
        self._stop_delete_after_project = threading.Event()
        self._delete_stop_level = 0

        # Only folders reported by the latest scan may be deleted
        self._scanned_paths: set[str] = set()
        self._path_to_project: dict[str, str] = {}
        self._path_details: dict[str, dict[str, Any]] = {}
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

    def toggle_fullscreen(self) -> bool:
        """Toggle desktop window fullscreen mode."""
        if not self._window:
            return False
        try:
            self._window.toggle_fullscreen()
            return True
        except Exception as exc:
            print(f"[StorageHelperApi] Fullscreen toggle error: {exc}")
            return False

    def start_scan(self, folder_path: str) -> dict[str, Any]:
        """Start scanning in background thread."""
        path = Path(folder_path).resolve()
        if not path.is_dir():
            return {"status": "error", "message": "Ordner nicht gefunden. Prüfe den Pfad oder wähle ihn über „Ordner wählen“."}

        # Stop any running scan.
        self._stop_scan_immediate.set()
        stop_immediate = threading.Event()
        stop_after_project = threading.Event()
        self._stop_scan_immediate = stop_immediate
        self._stop_scan_after_project = stop_after_project
        self._stop_scan_flag = stop_immediate
        self._scan_stop_level = 0
        self._scanned_paths = set()
        self._path_to_project = {}
        self._path_details = {}

        def emit(fn_name: str, payload: Any) -> None:
            if self._stop_scan_immediate is stop_immediate:
                self._eval_js(fn_name, payload)

        def run_scan() -> None:
            total_projects = 0
            total_bytes = 0
            error = None

            last_progress = 0.0

            def on_progress(msg: str) -> None:
                nonlocal last_progress
                now = time.monotonic()
                if now - last_progress >= 0.1:
                    last_progress = now
                    emit("onScanProgress", {"message": msg, "total_projects": total_projects})

            def on_project(p: ProjectInfo) -> None:
                nonlocal total_projects, total_bytes
                total_projects += 1
                total_bytes += p.total_disposable_size
                if self._stop_scan_immediate is stop_immediate:
                    for f in p.disposable_folders:
                        self._scanned_paths.add(f.path)
                        self._path_to_project[f.path] = p.name
                        self._path_details[f.path] = {
                            "project_name": p.name,
                            "project_path": p.path,
                            "folder_name": f.name,
                            "category": f.category,
                            "size_bytes": f.size_bytes,
                            "file_count": f.file_count,
                            "ecosystem": p.ecosystem,
                        }
                emit("onProjectDiscovered", asdict(p))

            try:
                try:
                    find_projects_and_disposables(
                        path,
                        on_project_found=on_project,
                        on_progress=on_progress,
                        should_stop=stop_immediate.is_set,
                        should_stop_after_project=stop_after_project.is_set,
                    )
                except TypeError:
                    find_projects_and_disposables(
                        path,
                        on_project_found=on_project,
                        on_progress=on_progress,
                        should_stop=stop_immediate.is_set,
                    )
            except Exception as e:
                error = str(e)

            was_stopped = error is None and (stop_immediate.is_set() or stop_after_project.is_set())
            emit(
                "onScanCompleted",
                {
                    "stopped": was_stopped,
                    "error": error,
                    "total_projects": total_projects,
                    "total_bytes": total_bytes,
                },
            )

        threading.Thread(target=run_scan, daemon=True).start()
        return {"status": "started"}

    def stop_scan(self) -> dict[str, Any]:
        """Signal scanning thread to stop (1st click: after current project, 2nd click: immediate)."""
        if self._scan_stop_level == 0:
            self._scan_stop_level = 1
            self._stop_scan_after_project.set()
            return {"level": 1, "message": "Scan hält nach dem aktuellen Projekt an..."}
        else:
            self._scan_stop_level = 2
            self._stop_scan_immediate.set()
            return {"level": 2, "message": "Scan wird sofort abgebrochen..."}

    def stop_delete(self) -> dict[str, Any]:
        """Signal deletion thread to stop (1st click: after current project, 2nd click: immediate)."""
        if self._delete_stop_level == 0:
            self._delete_stop_level = 1
            self._stop_delete_after_project.set()
            return {"level": 1, "message": "Löschen hält nach dem aktuellen Projekt an..."}
        else:
            self._delete_stop_level = 2
            self._stop_delete_immediate.set()
            return {"level": 2, "message": "Löschen wird sofort abgebrochen..."}

    def delete_items(self, paths: list[str], use_trash: bool = True) -> dict[str, Any]:
        """Delete list of folders in background thread with dual progress feedback and 2-stage stop."""
        if not paths:
            return {"status": "error", "message": "Markiere zuerst mindestens einen Ordner."}
        if self._delete_thread and self._delete_thread.is_alive():
            return {"status": "error", "message": "Es werden gerade schon Ordner entfernt. Warte, bis das fertig ist."}

        self._stop_delete_immediate.clear()
        self._stop_delete_after_project.clear()
        self._delete_stop_level = 0

        def run_deletion() -> None:
            # Group paths by project to manage project-level stopping and progress
            project_items: dict[str, list[str]] = {}
            for path in paths:
                proj = self._path_to_project.get(path, Path(path).parent.name)
                project_items.setdefault(proj, []).append(path)

            success_count = 0
            overall_idx = 0
            total_items = len(paths)
            total_projects = len(project_items)
            deleted_records: list[dict[str, Any]] = []
            stopped_early = False

            for proj_idx, (proj_name, proj_paths) in enumerate(project_items.items(), 1):
                # Check soft stop before beginning a new project
                if self._stop_delete_after_project.is_set() and proj_idx > 1:
                    stopped_early = True
                    break

                for in_proj_idx, path in enumerate(proj_paths, 1):
                    # Check immediate hard stop
                    if self._stop_delete_immediate.is_set():
                        stopped_early = True
                        break

                    overall_idx += 1
                    if path in self._scanned_paths:
                        res = delete_directory(path, use_trash=use_trash)
                    else:
                        res = DeleteResult(path=path, success=False, error="Ordner stammt nicht aus dem letzten Scan.")

                    if res.success:
                        self._scanned_paths.discard(path)
                        success_count += 1

                    details = self._path_details.get(path, {})
                    record = {
                        "path": path,
                        "project_name": proj_name,
                        "folder_name": details.get("folder_name", Path(path).name),
                        "category": details.get("category", "cache"),
                        "size_bytes": details.get("size_bytes", 0),
                        "file_count": details.get("file_count", 0),
                        "success": res.success,
                        "error": res.error,
                    }
                    deleted_records.append(record)

                    self._eval_js(
                        "onDeleteProgress",
                        {
                            "current": overall_idx,
                            "total": total_items,
                            "path": path,
                            "project_name": proj_name,
                            "project_index": proj_idx,
                            "total_projects": total_projects,
                            "project_current": in_proj_idx,
                            "project_total": len(proj_paths),
                            "success": res.success,
                            "error": res.error,
                        },
                    )

                if stopped_early or self._stop_delete_immediate.is_set():
                    stopped_early = True
                    break

            self._eval_js(
                "onDeleteCompleted",
                {
                    "success_count": success_count,
                    "total_requested": total_items,
                    "use_trash": use_trash,
                    "stopped": stopped_early,
                    "deleted_records": deleted_records,
                },
            )

        self._delete_thread = threading.Thread(target=run_deletion, daemon=True)
        self._delete_thread.start()
        return {"status": "started"}

    def export_pdf_report(self, report_data: dict[str, Any]) -> dict[str, Any]:
        """Open native save dialog and generate PDF deletion report."""
        if not self._window:
            return {"status": "error", "message": "Fenster nicht verfügbar."}
        try:
            result = self._window.create_file_dialog(
                webview.FileDialog.SAVE,
                save_filename="Speicher-Bereinigung-Protokoll.pdf",
                file_types=("PDF Dateien (*.pdf)", "Alle Dateien (*.*)"),
            )
            if not result:
                return {"status": "cancelled"}

            target_path = str(result if isinstance(result, (str, Path)) else result[0])
            if not target_path.lower().endswith(".pdf"):
                target_path += ".pdf"

            generate_deletion_report_pdf(target_path, report_data)
            return {"status": "ok", "path": target_path}
        except Exception as exc:
            print(f"[StorageHelperApi] PDF export error: {exc}")
            return {"status": "error", "message": str(exc)}

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
