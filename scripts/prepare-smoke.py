#!/usr/bin/env python3
"""Prepare, but never start, a separate Zotero runtime smoke test.

Run this after rebuilding the product XPI. Every invocation creates a new
work/smoke-<UTC timestamp>-<random suffix>/ directory. No existing Zotero
profile, library, profiles.ini, application setting or process is touched.

The test add-on is packaged separately. A matching random marker, canonical
profile path and canonical data path are all required before it can write.
It runs once per prepared profile; create a fresh profile to repeat a test.
The script prints a PowerShell launch command for a human/the root agent to
execute separately. It does not change signature checks or install policies.
Both complete personal XPIs and public XPIs without metric data are supported.
With --auto-close, only the newly prepared instance will request a normal quit
after its guarded test report is saved; no Zotero process is started here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
PRODUCT_ID = "zotero10-scholar@local"
TEST_ID = "zotero10-scholar-runtime-smoke@local"
MARKER_NAME = "SCHOLAR_SMOKE_TEST_ONLY.json"
REPORT_NAME = "runtime-report.json"
MARKER_KIND = "zotero10-scholar-isolated-smoke-v1"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def powershell_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def prepare(product: Path, executable: Path, *, auto_close: bool = False) -> dict:
    product = product.resolve(strict=True)
    executable = executable.resolve(strict=True)
    test_source = ROOT / "tests" / "runtime-smoke"
    test_manifest = json.loads((test_source / "manifest.json").read_text(encoding="utf-8"))
    if test_manifest["applications"]["zotero"]["id"] != TEST_ID:
        raise ValueError("Unexpected smoke-test add-on ID")
    test_bootstrap = (test_source / "bootstrap.js").read_bytes()
    with ZipFile(product) as archive:
        names = set(archive.namelist())
        if not {"manifest.json", "bootstrap.js", "src/core.js", "src/plugin.js"}.issubset(names):
            raise ValueError("Rebuild the product XPI before preparing a smoke test")
        dataset_files = {"data/ccf-2026.json", "data/jcr-2025.json", "data/cas-2025.json"}
        included_datasets = names & dataset_files
        if included_datasets and included_datasets != dataset_files:
            raise ValueError("A smoke-test product must contain all three datasets or none; partial data bundles are refused")
        with_data = bool(included_datasets)
        if any(name.startswith(("tests/", "scripts/", "work/")) or "runtime-smoke" in name for name in names):
            raise ValueError("The product XPI must not include test hooks or development scripts")
        product_manifest = json.loads(archive.read("manifest.json"))
        if product_manifest["applications"]["zotero"]["id"] != PRODUCT_ID:
            raise ValueError("This harness only tests zotero10-scholar@local")
        for name in names:
            if name.endswith((".js", ".json")) and TEST_ID.encode() in archive.read(name):
                raise ValueError("A smoke-test hook was found in the product XPI")
        if archive.testzip() is not None:
            raise ValueError("Product XPI integrity check failed")

    work = ROOT / "work"
    work.mkdir(exist_ok=True)
    if work.resolve() != work or work.is_symlink():
        raise ValueError("Refusing a redirected/symlinked project work directory")
    timestamp = datetime.now(timezone.utc)
    session = work / ("smoke-" + timestamp.strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(6))
    session.mkdir(exist_ok=False)  # Never reuse or clean an existing directory.
    if session.resolve().parent != work:
        raise ValueError("Smoke session must be an immediate child of the project work directory")
    profile, data = session / "profile", session / "data"
    profile.mkdir()
    data.mkdir()
    extensions = profile / "extensions"
    extensions.mkdir()

    config = {
        "schemaVersion": 1,
        "markerKind": MARKER_KIND,
        "token": secrets.token_hex(32),
        "projectDir": str(ROOT),
        "sessionDir": str(session),
        "profileDir": str(profile),
        "dataDir": str(data),
        "markerName": MARKER_NAME,
        "reportName": REPORT_NAME,
        "preparedAt": timestamp.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "productID": PRODUCT_ID,
        "testID": TEST_ID,
        "productVersion": product_manifest["version"],
        "productSha256": sha256(product),
        "withData": with_data,
        "autoClose": bool(auto_close),
        "expectedJournal": "A|20.4|Q1|1区TOP" if with_data else "C|2.5|Q2|3区",
        "expectedConference": "A" if with_data else "B",
        "singleRun": True,
    }
    write_json(data / MARKER_NAME, config)
    write_json(session / "smoke-config.json", config)

    preferences = {
        "extensions.zotero.dataDir": str(data),
        "extensions.zotero.useDataDir": True,
        "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.httpServer.enabled": False,
        "extensions.zotero.httpServer.localAPI.enabled": False,
        "extensions.zotero.firstRun2": False,
        "extensions.zotero.firstRunGuidance": False,
        "extensions.zoteroWinWordIntegration.skipInstallation": True,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        "extensions.zotero.undoHistory.steps": 100,
        "extensions.zotero10scholar.autoNew": False,
        "extensions.zotero10scholar.quartilePolicy": "best",
        # Profile-only development sideload discovery. No signing bypasses.
        "extensions.startupScanScopes": 1,
        "extensions.autoDisableScopes": 0,
        "extensions.logging.enabled": True,
    }
    user_js = "// Isolated Scholar Rank smoke test only. Never copy to a regular profile.\n"
    user_js += "\n".join(
        f"user_pref({json.dumps(name)}, {json.dumps(value, ensure_ascii=True)});"
        for name, value in preferences.items()
    ) + "\n"
    (profile / "user.js").write_text(user_js, encoding="utf-8", newline="\n")

    staged_product = extensions / (PRODUCT_ID + ".xpi")
    shutil.copy2(product, staged_product)
    if sha256(staged_product) != config["productSha256"]:
        raise ValueError("Staged product differs from the requested XPI")
    staged_test = extensions / (TEST_ID + ".xpi")
    with ZipFile(staged_test, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(test_manifest, ensure_ascii=False, indent=2) + "\n")
        archive.writestr("bootstrap.js", test_bootstrap)
        archive.writestr("smoke-config.json", json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    with ZipFile(staged_test) as archive:
        if set(archive.namelist()) != {"manifest.json", "bootstrap.js", "smoke-config.json"} or archive.testzip():
            raise ValueError("Smoke-test add-on integrity check failed")

    arguments = ["-no-remote", "-profile", str(profile), "-ZoteroDebugText"]
    launch = {
        "status": "prepared-not-started",
        "sessionDir": str(session),
        "profileDir": str(profile),
        "dataDir": str(data),
        "reportPath": str(data / REPORT_NAME),
        "executable": str(executable),
        "arguments": arguments,
        "powershellCommand": (
            "Start-Process -FilePath " + powershell_string(str(executable))
            + " -ArgumentList " + powershell_string(subprocess.list2cmdline(arguments))
            + " -WindowStyle Hidden -PassThru"
        ),
        "productXpi": str(staged_product),
        "productSha256": config["productSha256"],
        "testXpi": str(staged_test),
        "testSha256": sha256(staged_test),
        "withData": with_data,
        "autoClose": bool(auto_close),
        "note": (
            "Not launched. After saving its report, only this new isolated instance will request a normal quit. "
            if auto_close else "Not launched. Runtime tests leave their final preview open for inspection. "
        ) + "Synthetic items are retained; prepare a new directory to rerun.",
    }
    write_json(session / "launch.json", launch)
    return launch


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    parser.add_argument("--product", type=Path, default=ROOT / "dist" / f"zotero10-scholar-{version}-personal.xpi")
    parser.add_argument("--zotero", type=Path, default=Path("C:/Program Files/Zotero/zotero.exe"))
    parser.add_argument("--auto-close", action="store_true",
                        help="After saving the guarded native-test report, request a normal quit of only the newly prepared instance")
    args = parser.parse_args()
    try:
        result = prepare(args.product, args.zotero, auto_close=args.auto_close)
    except (OSError, KeyError, ValueError) as error:
        parser.exit(1, f"Smoke preparation failed: {error}\n")
    # ASCII escaping keeps redirected Windows console output parseable as JSON.
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
