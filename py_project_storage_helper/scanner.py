"""Core scanner module for detecting code projects and disposable directories."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional

# Standalone indicators that strongly indicate a project root
PROJECT_ROOT_MARKERS = {
    ".git",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "setup.py",
    "setup.cfg",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "mix.exs",
    "pubspec.yaml",
    "CMakeLists.txt",
    "deno.json",
    "deno.jsonc",
    "bun.lockb",
}

# Disposable directory names that strongly indicate a project root
PROJECT_ROOT_DISPOSABLES = {
    "node_modules",
    ".venv",
    "venv",
    "env",
    "target",
    ".next",
    ".nuxt",
}

# Disposable directory names and their category
DISPOSABLE_CATEGORIES: dict[str, str] = {
    # Node
    "node_modules": "node",
    ".next": "build",
    ".nuxt": "build",
    ".turbo": "cache",
    ".parcel-cache": "cache",
    ".angular": "cache",
    ".svelte-kit": "build",
    # Python
    ".venv": "python",
    "venv": "python",
    "env": "python",
    ".env": "python",  # only if is_dir
    "__pycache__": "cache",
    ".pytest_cache": "cache",
    ".mypy_cache": "cache",
    ".ruff_cache": "cache",
    ".tox": "cache",
    ".nox": "cache",
    # Build & Dist
    "dist": "build",
    "build": "build",
    "out": "build",
    "target": "build",
    # General caches
    ".cache": "cache",
}

CATEGORY_LABELS: dict[str, str] = {
    "node": "Node.js (node_modules)",
    "python": "Python (.venv / venv)",
    "build": "Build & Dist",
    "cache": "Caches",
}


@dataclass
class DisposableFolder:
    """Represents a disposable folder inside a project."""
    path: str
    name: str
    category: str
    category_label: str
    size_bytes: int = 0
    size_human: str = "0 B"
    file_count: int = 0


@dataclass
class ProjectInfo:
    """Represents a detected code project."""
    path: str
    name: str
    relative_path: str
    disposable_folders: list[DisposableFolder] = field(default_factory=list)
    total_disposable_size: int = 0
    total_disposable_human: str = "0 B"

    def recalculate_totals(self) -> None:
        self.total_disposable_size = sum(f.size_bytes for f in self.disposable_folders)
        self.total_disposable_human = format_size(self.total_disposable_size)


def format_size(size_bytes: int) -> str:
    """Format bytes into human-readable string (KB, MB, GB)."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.2f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def get_dir_size_fast(path: str | Path, should_stop: Optional[Callable[[], bool]] = None) -> tuple[int, int]:
    """Calculate directory size in bytes and file count using os.scandir."""
    total_size = 0
    file_count = 0
    stack = [str(path)]

    while stack:
        if should_stop and should_stop():
            break
        curr_dir = stack.pop()
        try:
            with os.scandir(curr_dir) as it:
                for entry in it:
                    try:
                        # On Windows, follow_symlinks=False prevents jumping outside
                        if entry.is_file(follow_symlinks=False):
                            total_size += entry.stat(follow_symlinks=False).st_size
                            file_count += 1
                        elif entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                    except (PermissionError, FileNotFoundError, OSError):
                        continue
        except (PermissionError, FileNotFoundError, OSError):
            continue

    return total_size, file_count


def is_project_root(entries: Iterable[os.DirEntry]) -> bool:
    """Check if directory entries contain strong project markers or root disposables."""
    for entry in entries:
        try:
            name = entry.name
            if name in PROJECT_ROOT_MARKERS:
                return True
            if name in PROJECT_ROOT_DISPOSABLES and entry.is_dir(follow_symlinks=False):
                return True
        except (OSError, PermissionError):
            continue
    return False


def collect_project_disposables(
    project_path: Path,
    max_subdepth: int = 3,
    should_stop: Optional[Callable[[], bool]] = None,
) -> tuple[list[DisposableFolder], list[Path]]:
    """
    Search inside project for disposable folders and discover any nested subprojects.
    Returns (disposable_folders, nested_subprojects_paths).
    """
    disposables: list[DisposableFolder] = []
    nested_projects: list[Path] = []
    # Queue: (dir_path, current_subdepth)
    queue: list[tuple[Path, int]] = [(project_path, 0)]

    while queue:
        if should_stop and should_stop():
            break
        curr_dir, subdepth = queue.pop(0)

        try:
            entries = list(os.scandir(curr_dir))
        except (PermissionError, FileNotFoundError, OSError):
            continue

        # If this is a subdirectory (subdepth > 0) and has its own project markers,
        # treat it as a nested subproject (e.g. monorepo package) and do not absorb it.
        if subdepth > 0 and is_project_root(entries):
            nested_projects.append(curr_dir)
            continue

        for entry in entries:
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue

                name = entry.name
                if name == ".git":
                    continue

                if name in DISPOSABLE_CATEGORIES:
                    category = DISPOSABLE_CATEGORIES[name]
                    cat_label = CATEGORY_LABELS.get(category, category.capitalize())
                    size_bytes, file_count = get_dir_size_fast(entry.path, should_stop=should_stop)
                    rel_name = os.path.relpath(entry.path, project_path)
                    disposables.append(
                        DisposableFolder(
                            path=entry.path,
                            name=rel_name.replace("\\", "/"),
                            category=category,
                            category_label=cat_label,
                            size_bytes=size_bytes,
                            size_human=format_size(size_bytes),
                            file_count=file_count,
                        )
                    )
                elif subdepth < max_subdepth:
                    queue.append((Path(entry.path), subdepth + 1))
            except (OSError, PermissionError):
                continue

    return disposables, nested_projects


def find_projects_and_disposables(
    root_dir: str | Path,
    max_depth: int = 5,
    on_project_found: Optional[Callable[[ProjectInfo], None]] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
) -> list[ProjectInfo]:
    """
    Walk root directory up to max_depth and find all projects and their disposable folders.
    """
    root_path = Path(root_dir).resolve()
    if not root_path.exists() or not root_path.is_dir():
        return []

    projects: list[ProjectInfo] = []
    queue: list[tuple[Path, int]] = [(root_path, 0)]

    while queue:
        if should_stop and should_stop():
            break

        current_path, depth = queue.pop(0)

        if on_progress:
            on_progress(f"Scanne: {current_path.name or str(current_path)}")

        try:
            entries = list(os.scandir(current_path))
        except (PermissionError, FileNotFoundError, OSError):
            continue

        # Check if current_path is a project
        is_proj = is_project_root(entries)

        if is_proj:
            # Collect all disposables for this project
            disposables, nested_subprojects = collect_project_disposables(
                current_path,
                should_stop=should_stop,
            )

            rel_path = str(current_path.relative_to(root_path))
            if rel_path == ".":
                rel_path = current_path.name

            project = ProjectInfo(
                path=str(current_path),
                name=current_path.name,
                relative_path=rel_path,
                disposable_folders=disposables,
            )
            project.recalculate_totals()

            if project.disposable_folders:
                projects.append(project)
                if on_project_found:
                    on_project_found(project)

            # Enqueue nested subprojects if any
            for sub_proj in nested_subprojects:
                if depth + 1 <= max_depth:
                    queue.append((sub_proj, depth + 1))
        else:
            # Not a project root, continue descending down non-disposable children
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        name = entry.name
                        if name == ".git" or name in DISPOSABLE_CATEGORIES:
                            continue
                        if depth < max_depth:
                            queue.append((Path(entry.path), depth + 1))
                except (OSError, PermissionError):
                    continue

    return projects
