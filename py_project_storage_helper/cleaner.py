"""Cleaner module for deleting disposable directories safely."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import send2trash

from py_project_storage_helper.scanner import DISPOSABLE_CATEGORIES, get_dir_size_fast


@dataclass
class DeleteResult:
    """Result of deleting a single item."""
    path: str
    success: bool
    freed_bytes: int = 0
    error: Optional[str] = None


def is_safe_to_delete(dir_path: str | Path) -> tuple[bool, str]:
    """
    Validate that the directory is safe to delete.
    Ensures that we never delete .git, system roots, or arbitrary directories.
    """
    path = Path(dir_path).resolve()

    if not path.exists():
        return False, "Ordner existiert nicht mehr."

    if not path.is_dir():
        return False, "Pfad ist kein Verzeichnis."

    # Deny deleting root or drive roots like C:\ or /
    if path == path.parent:
        return False, "Laufwerks-Wurzelverzeichnis darf nicht gelöscht werden!"

    # Deny .git or anything inside it
    if ".git" in [p.lower() for p in path.parts]:
        return False, ".git-Verzeichnisse dürfen niemals gelöscht werden!"

    # Must be in known disposable categories or egg-info
    name = path.name.lower()
    if name not in DISPOSABLE_CATEGORIES and not name.endswith(".egg-info"):
        return False, f"'{name}' ist kein bekannter Einweg-/Cache-Ordner."

    return True, ""


def delete_directory(
    dir_path: str | Path,
    use_trash: bool = True,
) -> DeleteResult:
    """
    Delete a single directory, either sending to trash or removing permanently.
    """
    path = Path(dir_path).resolve()
    safe, reason = is_safe_to_delete(path)
    if not safe:
        return DeleteResult(path=str(path), success=False, error=reason)

    try:
        # Pre-measure size to report freed space
        size_bytes, _ = get_dir_size_fast(path)

        if use_trash:
            # send2trash on Windows moves directory into Recycle Bin
            send2trash.send2trash(str(path))
        else:
            shutil.rmtree(path)

        return DeleteResult(path=str(path), success=True, freed_bytes=size_bytes)
    except Exception as exc:
        return DeleteResult(path=str(path), success=False, error=str(exc))
