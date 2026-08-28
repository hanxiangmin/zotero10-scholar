#!/usr/bin/env python3
"""Build a public XPI without tables, or explicitly opt into a personal data build."""
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlparse
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "manifest.json", "bootstrap.js", "prefs.js", "prefs.xhtml", "prefs-pane.js",
    "preview.xhtml", "preview.js", "src/core.js", "src/plugin.js",
    "locale/en-US/zotero10-scholar.ftl", "locale/zh-CN/zotero10-scholar.ftl",
    "assets/icon.svg", "LICENSE", "NOTICE.md", "data/README.md"
]
DATA_FILES = ["data/ccf-2026.json", "data/jcr-2025.json", "data/cas-2025.json", "data/SOURCES.md"]


def validate_manifest(manifest):
    """Fail before packaging when Zotero's required extension metadata is absent."""
    if manifest.get("manifest_version") != 2 or not manifest.get("name") or not manifest.get("version"):
        raise ValueError("The Zotero manifest needs manifest_version=2, name and version")
    if not isinstance(manifest["version"], str) or not re.fullmatch(r"[0-9][0-9A-Za-z.+-]*", manifest["version"]):
        raise ValueError("Unsafe or unsupported version string")
    app = manifest.get("applications", {}).get("zotero", {})
    for field in ("id", "update_url", "strict_min_version", "strict_max_version"):
        if not isinstance(app.get(field), str) or not app[field]:
            raise ValueError("Zotero requires applications.zotero." + field)
    if app["id"] != "zotero10-scholar@local":
        raise ValueError("Refusing to package as a different/legacy add-on")
    update = urlparse(app["update_url"])
    if update.scheme != "https" or not update.hostname or update.username or update.password:
        raise ValueError("The update manifest URL must use HTTPS without credentials")
    if "*" in app["strict_min_version"]:
        raise ValueError("strict_min_version must not contain a wildcard")


def build(out_dir: Path, *, with_data: bool = False) -> dict:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    validate_manifest(manifest)
    files = FILES + (DATA_FILES if with_data else [])
    contents = {}
    for name in files:
        if not (ROOT / name).is_file():
            raise ValueError("Missing package file: " + name)
        contents[name] = (ROOT / name).read_bytes()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = "-personal" if with_data else ""
    path = out_dir / f"zotero10-scholar-{manifest['version']}{suffix}.xpi"
    temp = path.with_suffix(".tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            entry = zipfile.ZipInfo(name, date_time=(2026, 8, 28, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, contents[name])
    temp.replace(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    (out_dir / (path.name + ".sha256")).write_text(f"{digest}  {path.name}\n", encoding="ascii")
    with zipfile.ZipFile(path) as archive:
        assert sorted(archive.namelist()) == sorted(files)
        assert archive.testzip() is None
    return {"file": str(path), "bytes": path.stat().st_size, "sha256": digest, "files": len(files),
            "mode": "personal-with-data" if with_data else "public-without-data"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist")
    parser.add_argument("--with-data", action="store_true",
                        help="Include locally supplied third-party tables; do not publicly distribute without permission")
    args = parser.parse_args()
    try:
        result = build(args.out, with_data=args.with_data)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Build failed: {error}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
