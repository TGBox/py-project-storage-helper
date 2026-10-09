"""Main entry point for Project Storage Helper."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import webview

from py_project_storage_helper.api import StorageHelperApi
from py_project_storage_helper.scanner import find_projects_and_disposables, format_size


def get_base_dir() -> Path:
    """Get the base directory, supporting PyInstaller bundled executables."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def run_gui() -> None:
    """Launch the PyWebView desktop application."""
    api = StorageHelperApi()
    base_dir = get_base_dir()
    html_file = base_dir / "py_project_storage_helper" / "gui" / "index.html"
    if not html_file.exists():
        alt_html = base_dir / "gui" / "index.html"
        if alt_html.exists():
            html_file = alt_html

    window = webview.create_window(
        title="Project Storage Helper",
        url=str(html_file),
        js_api=api,
        width=1120,
        height=820,
        min_size=(800, 600),
    )
    api.set_window(window)
    webview.start(debug=False)


def run_cli_scan(path: str) -> None:
    """Quick CLI inspection mode."""
    target = Path(path).resolve()
    print(f"Scanning {target}...")
    projects = find_projects_and_disposables(
        target,
        on_project_found=lambda p: print(f"  [+] Found: {p.relative_path} ({format_size(p.total_disposable_size)})"),
    )
    total_bytes = sum(p.total_disposable_size for p in projects)
    print(f"\nDone. Found {len(projects)} projects with disposable folders.")
    print(f"Total reclaimable space: {format_size(total_bytes)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean disposable build and environment folders to reclaim disk space.")
    parser.add_argument("--scan", type=str, help="Scan a directory via CLI without opening the GUI")
    args = parser.parse_args()

    if args.scan:
        run_cli_scan(args.scan)
    else:
        run_gui()


if __name__ == "__main__":
    main()
