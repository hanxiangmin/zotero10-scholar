#!/usr/bin/env python3
"""Convert the user-supplied ShowJCR CCF 2026 CSV to the plugin catalog.

Usage:
    python scripts/update-ccf.py --zip ShowJCR-master.zip

This script uses the Python standard library and does not fetch or scrape CCF.
It locates CCF2026-UTF8.csv by basename inside the ZIP without extracting it.
The source is a user-provided compilation, not a direct official download.
Keep the archive for reproducibility; hashes of both input files are recorded.

CCF's official announcement confirms edition 7 (2026-03-31) and notes an
erratum on 2026-04-09. This does NOT establish that the input includes that
erratum. TPAMI, CVPR and ICML were checked against the official AI page on
2026-08-28; the full CSV has not been checked against the official PDF.

Only international A/B/C records are accepted. Chinese T1/T2/T3 catalogs are
not imported. Exact duplicate records are removed; entries from different
fields or with conflicting ranks are preserved, never silently combined.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile


CSV_BASENAME = "CCF2026-UTF8.csv"
OFFICIAL_REFERENCE = "https://www.ccf.org.cn/Academic_Evaluation/By_category/"
SAMPLE_REFERENCE = "https://www.ccf.org.cn/Academic_Evaluation/AI/"
TYPE_COLUMN = "CCF推荐类别（国际学术刊物/会议）"
RANK_COLUMN = "CCF推荐类型"
REQUIRED_COLUMNS = {"刊物名称", "Journal", "年份", "领域", TYPE_COLUMN, RANK_COLUMN}
TYPE_MAP = {"推荐国际学术刊物": "journal", "推荐国际学术会议": "conference"}
RANK_MAP = {"A类": "A", "B类": "B", "C类": "C"}
REFERENCE_SAMPLES = {
    "TPAMI": ("journal", "IEEE Transactions on Pattern Analysis and Machine Intelligence", "A"),
    "CVPR": ("conference", "IEEE/CVF Computer Vision and Pattern Recognition Conference", "A"),
    "ICML": ("conference", "International Conference on Machine Learning", "A"),
}


def clean(value: str | None) -> str:
    """Collapse CSV formatting whitespace without rewriting venue names."""
    return re.sub(r"\s+", " ", value or "").strip()


def read_archive(archive: Path) -> tuple[bytes, dict]:
    """Read only the uniquely named CSV, preventing ambiguous ZIP selection."""
    archive_bytes = archive.read_bytes()
    with ZipFile(io.BytesIO(archive_bytes)) as bundle:
        candidates = [
            info for info in bundle.infolist()
            if not info.is_dir()
            and PurePosixPath(info.filename.replace("\\", "/")).name == CSV_BASENAME
        ]
        if len(candidates) != 1:
            raise ValueError(
                f"Expected one {CSV_BASENAME} in the ZIP; found {len(candidates)}"
            )
        member = candidates[0]
        if member.file_size > 10 * 1024 * 1024:
            raise ValueError("CCF CSV exceeds the 10 MiB safety limit")
        payload = bundle.read(member)
    provenance = {
        "kind": "user-provided-compilation",
        "archive": archive.name,
        "archiveSha256": hashlib.sha256(archive_bytes).hexdigest(),
        "member": member.filename,
        "memberSha256": hashlib.sha256(payload).hexdigest(),
        "officialReference": OFFICIAL_REFERENCE,
        "officialReleaseDate": "2026-03-31",
        "officialErratumNoticeDate": "2026-04-09",
        "officialPdfFullyVerified": False,
        "verificationNote": (
            "全表来自用户提供的 ShowJCR 数据文件，未逐条与官方 PDF 比对；"
            "官网所述 4 月 9 日勘误是否已纳入本 CSV 尚未核实。"
        ),
        "sampleReference": SAMPLE_REFERENCE,
        "sampleReferenceCheckedAt": "2026-08-28",
        "checkedSamples": list(REFERENCE_SAMPLES),
    }
    return payload, provenance


def parse_csv(payload: bytes) -> tuple[list[dict], dict]:
    reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig"), newline=""))
    if not reader.fieldnames or not REQUIRED_COLUMNS.issubset(reader.fieldnames):
        missing = REQUIRED_COLUMNS.difference(reader.fieldnames or [])
        raise ValueError(f"Missing CCF CSV columns: {', '.join(sorted(missing))}")
    records = []
    seen = set()
    duplicate_count = 0
    title_fallbacks = []
    for row in reader:
        if None in row:
            raise ValueError(f"CSV line {reader.line_num}: unexpected extra cells")
        if not any(clean(value) for value in row.values()):
            continue
        if clean(row["年份"]) != "2026":
            raise ValueError(f"CSV line {reader.line_num}: expected year 2026")
        venue_type = TYPE_MAP.get(clean(row[TYPE_COLUMN]))
        rank = RANK_MAP.get(clean(row[RANK_COLUMN]))
        if venue_type is None or rank is None:
            raise ValueError(
                f"CSV line {reader.line_num}: only international journal/conference A/B/C is supported"
            )
        title, category = clean(row["Journal"]), clean(row["领域"])
        abbreviation = clean(row["刊物名称"])
        if not title and abbreviation:
            # ShowJCR's HotSec row has an empty Journal cell. Use only the
            # supplied abbreviation, with an explicit warning; do not invent a title.
            title = abbreviation
            title_fallbacks.append({"csvLine": reader.line_num, "abbreviation": abbreviation})
        if not title or not category:
            raise ValueError(f"CSV line {reader.line_num}: missing title or category")
        record = {
            "type": venue_type,
            "title": title,
            "abbreviation": abbreviation,
            "rank": rank,
            "aliases": [],
            "category": category,
        }
        # Category and rank are part of the key: neither is discarded on a clash.
        key = tuple(record[field] for field in ("type", "title", "abbreviation", "rank", "category"))
        if key in seen:
            duplicate_count += 1
            continue
        seen.add(key)
        records.append(record)
    if not records:
        raise ValueError("No CCF records found")

    for abbreviation, expected in REFERENCE_SAMPLES.items():
        matches = [record for record in records if record["abbreviation"] == abbreviation]
        if not matches or any(
            (record["type"], record["title"], record["rank"]) != expected for record in matches
        ):
            raise ValueError(f"Reference sample does not match: {abbreviation}")

    ranks_by_title = defaultdict(set)
    categories_by_title = defaultdict(set)
    for record in records:
        key = (record["type"], record["title"].casefold())
        ranks_by_title[key].add(record["rank"])
        categories_by_title[key].add(record["category"])
    validation = {
        "recordCount": len(records),
        "byType": dict(sorted(Counter(record["type"] for record in records).items())),
        "byRank": dict(sorted(Counter(record["rank"] for record in records).items())),
        "categoryCount": len({record["category"] for record in records}),
        "exactDuplicatesRemoved": duplicate_count,
        "emptyTitlesUsingAbbreviation": title_fallbacks,
        "multiCategoryTitles": sum(len(categories) > 1 for categories in categories_by_title.values()),
        "conflictingRanks": [
            {"type": key[0], "title": key[1], "ranks": sorted(ranks)}
            for key, ranks in sorted(ranks_by_title.items()) if len(ranks) > 1
        ],
    }
    return records, validation


def normalized_timestamp(value: str | None) -> str:
    if value is None:
        stamp = datetime.now(timezone.utc)
    else:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("--retrieved-at must include a timezone, e.g. 2026-08-28T00:00:00Z")
    return stamp.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zip", type=Path, required=True, help="User-supplied ShowJCR ZIP archive")
    parser.add_argument("--output", type=Path, default=root / "data" / "ccf-2026.json")
    parser.add_argument("--retrieved-at", help="ISO 8601 time with timezone; set to reproduce identical JSON")
    args = parser.parse_args()
    try:
        payload, provenance = read_archive(args.zip)
        records, validation = parse_csv(payload)
        catalog = {
            "schemaVersion": 1,
            "kind": "ccf",
            "edition": "2026-第七版",
            "source": (
                f"用户提供 {provenance['archive']} / {CSV_BASENAME}; "
                f"CSV SHA-256: {provenance['memberSha256']}; 官方参考: {OFFICIAL_REFERENCE}"
            ),
            "retrievedAt": normalized_timestamp(args.retrieved_at),
            "provenance": provenance,
            "validation": validation,
            "records": records,
        }
        # Complete validation before replacing the previous catalog.
        encoded = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8", newline="\n")
        print(json.dumps({"output": str(args.output.resolve()), **validation}, ensure_ascii=True))
        return 0
    except (OSError, BadZipFile, UnicodeError, ValueError, csv.Error) as error:
        print(f"CCF import failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
