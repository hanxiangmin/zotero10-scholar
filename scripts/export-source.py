#!/usr/bin/env python3
"""Export a clean, data-free source tree and a reproducible source ZIP.

Only the fixed list below is exported. The working repository and any existing
nonempty destination are never cleaned or overwritten. Journal data, Git history,
legacy code, local reports, and binary packages do not belong in this export.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
FILES = (
    ".gitignore",
    ".gitattributes",
    ".github/workflows/ci.yml",
    "LICENSE",
    "NOTICE.md",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "manifest.json",
    "package.json",
    "bootstrap.js",
    "prefs.js",
    "prefs.xhtml",
    "prefs-pane.js",
    "assets/icon.svg",
    "locale/en-US/zotero10-scholar.ftl",
    "locale/zh-CN/zotero10-scholar.ftl",
    "src/core.js",
    "src/metadata.js",
    "src/plugin.js",
    "data/README.md",
    "docs/INSTALL.md",
    "docs/DEVELOPMENT.md",
    "docs/PUBLISHING.md",
    "docs/DATA_FORMAT.md",
    "docs/TESTING.md",
    "docs/images/scholar-rank-display.png",
    "docs/images/scholar-rank-settings.png",
    "scripts/build.py",
    "scripts/export-source.py",
    "scripts/import-showjcr.py",
    "scripts/update-ccf.py",
    "scripts/prepare-smoke.py",
    "tests/core.test.cjs",
    "tests/metadata.test.cjs",
    "tests/plugin.test.cjs",
    "tests/test_export_source.py",
    "tests/test_build.py",
    "tests/runtime-smoke/bootstrap.js",
    "tests/runtime-smoke/manifest.json",
)
ZIP_TIMESTAMP = (2026, 8, 28, 0, 0, 0)


def _no_links(path):
    """Reject symlinks and Windows junctions before traversing their contents."""
    absolute = Path(os.path.abspath(path))
    for current in reversed((absolute, *absolute.parents)):
        try:
            info = current.lstat()
        except FileNotFoundError:
            break
        attributes = getattr(info, "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(info.st_mode) or attributes & reparse_flag:
            raise ValueError(f"Symbolic links and reparse points are not allowed: {current}")


def _relative_name(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError(f"Unsafe source path: {name!r}")
    relative = PurePosixPath(name)
    if (relative.is_absolute() or relative.as_posix() != name
            or any(part in (".", "..", "") for part in name.split("/"))):
        raise ValueError(f"Unsafe source path: {name!r}")
    return relative


def _snapshot_sources(root):
    """Read every required file before creating any export or archive."""
    names = [(name, _relative_name(name)) for name in FILES]
    if len({name.casefold() for name, _ in names}) != len(names):
        raise ValueError("Duplicate source paths are not allowed")
    snapshot = {}
    for name, relative in names:
        path = root.joinpath(*relative.parts)
        _no_links(path)
        if not path.resolve(strict=True).is_relative_to(root):
            raise ValueError(f"Source path escapes the project: {name}")
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError(f"Source must be a regular file: {name}")
        snapshot[name] = path.read_bytes()
    return snapshot


def _empty_destination(path):
    _no_links(path)
    if path.exists():
        if not path.is_dir():
            raise FileExistsError(f"Source destination is not a directory: {path}")
        if next(path.iterdir(), None) is not None:
            raise FileExistsError(f"Refusing to overwrite a nonempty source destination: {path}")


def _archive_destination(path):
    _no_links(path)
    if path.exists() and not stat.S_ISREG(path.lstat().st_mode):
        raise FileExistsError(f"Archive destination is not a regular file: {path}")


def export_source(out=None):
    root = Path(os.path.abspath(ROOT))
    _no_links(root)
    root = root.resolve(strict=True)
    snapshot = _snapshot_sources(root)
    manifest = json.loads(snapshot["manifest.json"].decode("utf-8"))
    version = manifest.get("version") if isinstance(manifest, dict) else None
    if not isinstance(version, str) or not re.fullmatch(
        r"[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?", version
    ):
        raise ValueError("manifest.json must contain a safe numeric release version")

    target = Path(os.path.abspath(out if out is not None else root / "publish" / "zotero10-scholar"))
    _empty_destination(target)
    target = target.resolve(strict=False)
    dist = root / "dist"
    _no_links(dist)
    if root.is_relative_to(target) or dist.is_relative_to(target):
        raise ValueError("The source destination must not replace the project or contain its dist directory")
    archive_path = dist / f"zotero10-scholar-{version}-source.zip"
    checksum_path = archive_path.with_name(archive_path.name + ".sha256")
    _archive_destination(archive_path)
    _archive_destination(checksum_path)

    target.parent.mkdir(parents=True, exist_ok=True)
    dist.mkdir(parents=True, exist_ok=True)
    # Each temporary directory is created by this operation, in its destination
    # parent. Only these new staging files are removed on a failed operation.
    with tempfile.TemporaryDirectory(prefix=".scholar-source-", dir=target.parent) as source_temp:
        staging = Path(source_temp)
        for name, payload in snapshot.items():
            destination = staging.joinpath(*PurePosixPath(name).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)

        with tempfile.TemporaryDirectory(prefix=".scholar-source-", dir=dist) as archive_temp:
            staged_zip = Path(archive_temp) / archive_path.name
            staged_checksum = Path(archive_temp) / checksum_path.name
            with zipfile.ZipFile(staged_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                for name in sorted(snapshot):
                    entry = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFREG | 0o644) << 16
                    archive.writestr(entry, snapshot[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
            with zipfile.ZipFile(staged_zip) as archive:
                if archive.namelist() != sorted(snapshot) or archive.testzip() is not None:
                    raise ValueError("Source ZIP failed its integrity check")
            digest = hashlib.sha256(staged_zip.read_bytes()).hexdigest()
            staged_checksum.write_text(f"{digest}  {archive_path.name}\n", encoding="ascii")

            # Recheck before promotion. An empty user-created destination is
            # supported; rmdir cannot remove it if any file appeared meanwhile.
            _empty_destination(target)
            _archive_destination(archive_path)
            _archive_destination(checksum_path)
            if staging.resolve().parent != target.parent.resolve():
                raise ValueError("Unexpected source staging location")
            if target.exists():
                target.rmdir()
            staging.replace(target)
            staged_zip.replace(archive_path)
            staged_checksum.replace(checksum_path)

    return {
        "directory": str(target),
        "source_zip": str(archive_path),
        "sha256_file": str(checksum_path),
        "sha256": digest,
        "files": len(snapshot),
        "bytes": archive_path.stat().st_size,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="New or empty source directory (default: publish/zotero10-scholar)")
    args = parser.parse_args()
    try:
        result = export_source(args.out)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Source export failed: {error}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
