#!/usr/bin/env python3
"""Convert the user's two ShowJCR CSV tables without extracting/executing the ZIP.

Python 3.10+, standard library only. Run from the project root:
    python scripts/import-showjcr.py ShowJCR-master.zip
    python scripts/import-showjcr.py ShowJCR-master.zip --check

This deliberately accepts only CAS 2025 and JCR's 2025 metric-year tables.
XR/new-ranking tables and executable files in the archive are never imported.
"""

from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import sys
import unicodedata
import zipfile


ROOT = Path(__file__).resolve().parents[1]
CAS_FILE = "FQBJCR2025-UTF8.csv"
JCR_FILE = "JCR2025-UTF8.csv"
SOURCE = "https://github.com/hitfyd/ShowJCR"
MAX_CSV_BYTES = 32 * 1024 * 1024
MISSING = {"", "N/A", "NA", "NULL", "NONE", "-", "—", "****-****"}
ISSN_RE = re.compile(r"[0-9]{4}-[0-9]{3}[0-9X]")


class ImportFailure(ValueError):
    """The archive does not satisfy the supported source-data contract."""


def read_table(archive: zipfile.ZipFile, basename: str) -> tuple[bytes, list[dict]]:
    matches = [
        info for info in archive.infolist()
        if not info.is_dir() and PurePosixPath(info.filename).name == basename
    ]
    if len(matches) != 1:
        raise ImportFailure(f"Expected exactly one {basename}; found {len(matches)}")
    member = matches[0]
    if member.file_size > MAX_CSV_BYTES:
        raise ImportFailure(f"{basename} exceeds the 32 MiB safety limit")
    if member.flag_bits & 1:
        raise ImportFailure(f"Encrypted source is not supported: {basename}")
    # No extract/extractall: even a malicious member path cannot write to disk.
    blob = archive.read(member)
    reader = csv.DictReader(io.StringIO(blob.decode("utf-8-sig"), newline=""))
    if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
        raise ImportFailure(f"Missing or duplicate CSV columns: {basename}")
    rows = []
    for row_number, row in enumerate(reader, start=2):
        if None in row or any(value is None for value in row.values()):
            raise ImportFailure(f"Malformed CSV row: {basename}:{row_number}")
        if not row.get("Journal", "").strip():
            raise ImportFailure(f"Missing journal title: {basename}:{row_number}")
        rows.append(row)
    if not rows:
        raise ImportFailure(f"Empty table: {basename}")
    return blob, rows


def require_columns(rows: list[dict], required: set[str], name: str) -> None:
    missing = required.difference(rows[0])
    if missing:
        raise ImportFailure(f"{name} missing columns: {', '.join(sorted(missing))}")


def issn_checksum_valid(issn: str) -> bool:
    digits = issn.replace("-", "")
    total = sum(int(value) * (8 - index) for index, value in enumerate(digits[:7]))
    total += 10 if digits[-1] == "X" else int(digits[-1])
    return total % 11 == 0


def parse_issns(values: list[str], title: str, audit: dict) -> list[str]:
    result = []
    for raw in values:
        text = raw.strip().upper()
        if text in MISSING:
            continue
        for token in re.split(r"[/;,\s]+", text):
            if token in MISSING:
                continue
            if not ISSN_RE.fullmatch(token):
                raise ImportFailure(f"Unexpected ISSN format for {title!r}: {token!r}")
            if not issn_checksum_valid(token):
                audit["excludedIssns"].append({"title": title, "issn": token})
                continue
            if token not in result:
                result.append(token)
    return result


def parse_top(raw: str) -> bool | None:
    value = raw.strip()
    if value.upper() in MISSING:
        return None
    if value == "是":
        return True
    if value == "否":
        return False
    raise ImportFailure(f"Unrecognized CAS Top value: {raw!r}")


def parse_division(raw: str) -> int | None:
    value = raw.strip()
    if value.upper() in MISSING:
        return None
    match = re.fullmatch(r"([1-4])(?:\s*\[\s*\d+\s*/\s*\d+\s*\])?", value)
    if not match:
        raise ImportFailure(f"Unrecognized CAS major division: {raw!r}")
    return int(match.group(1))


def parse_jif(raw: str) -> tuple[float | None, str | None]:
    value = raw.strip()
    if value.upper() in MISSING:
        return None, None
    if value == "<0.1":
        # A bound is not an exact value; do not coerce it to 0 or 0.1.
        return None, value
    if not re.fullmatch(r"\d+(?:\.\d+)?", value):
        raise ImportFailure(f"Unrecognized JIF value: {raw!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ImportFailure(f"Non-finite JIF value: {raw!r}")
    return number, None


def base_table(kind: str, edition: int, basename: str, blob: bytes) -> dict:
    return {
        "schemaVersion": 1,
        "kind": kind,
        "edition": edition,
        "source": SOURCE,
        "sourceFile": basename,
        "sourceSha256": hashlib.sha256(blob).hexdigest(),
    }


def import_cas(blob: bytes, rows: list[dict], audit: dict) -> dict:
    require_columns(rows, {"Journal", "年份", "ISSN/EISSN", "大类分区", "Top"}, CAS_FILE)
    table = base_table("cas", 2025, CAS_FILE, blob)
    table.update({"system": "CAS", "categoryLevel": "major"})
    records = []
    for row in rows:
        if row["年份"].strip() != "2025":
            raise ImportFailure(f"CAS table contains a non-2025 row: {row['Journal']!r}")
        title = row["Journal"].strip()
        records.append({
            "title": title,
            "issns": parse_issns([row["ISSN/EISSN"]], title, audit),
            "aliases": [],
            "division": parse_division(row["大类分区"]),
            "top": parse_top(row["Top"]),
        })
    table["records"] = records
    return table


def import_jcr(blob: bytes, rows: list[dict], audit: dict) -> dict:
    required = {"Journal", "ISSN", "EISSN", "IF(2025)"}
    for index in range(1, 7):
        required.update({f"Category_{index}", f"IF Quartile(2025)_{index}"})
    require_columns(rows, required, JCR_FILE)
    # IF(2025) is the metric year. Clarivate's matching release is JCR 2026.
    table = base_table("jcr", 2026, JCR_FILE, blob)
    table["metricYear"] = 2025
    records = []
    for row in rows:
        title = row["Journal"].strip()
        value, display = parse_jif(row["IF(2025)"])
        quartiles = []
        for index in range(1, 7):
            quartile = row[f"IF Quartile(2025)_{index}"].strip().upper()
            if quartile in MISSING:
                continue
            category = row[f"Category_{index}"].strip()
            if not re.fullmatch(r"Q[1-4]", quartile) or not category:
                raise ImportFailure(f"Invalid category/quartile pair for {title!r}")
            quartiles.append({"category": category, "quartile": quartile})
        record = {
            "title": title,
            "issns": parse_issns([row["ISSN"], row["EISSN"]], title, audit),
            "aliases": [],
            "jif": value,
            "quartiles": quartiles,
        }
        if display is not None:
            record["jifDisplay"] = display
        records.append(record)
    table["records"] = records
    return table


def normalized_title(title: str) -> str:
    text = unicodedata.normalize("NFKD", title).casefold().replace("&", "and")
    return "".join(char for char in text if char.isalnum())


def collisions(records: list[dict], field: str) -> list[dict]:
    index: dict[str, list[str]] = collections.defaultdict(list)
    for record in records:
        if field == "issn":
            keys = record["issns"]
        elif field == "normalizedTitle":
            keys = [normalized_title(record["title"])]
        else:
            keys = [record["title"].strip().casefold()]
        for key in keys:
            index[key].append(record["title"])
    return [{"key": key, "titles": titles} for key, titles in index.items() if len(titles) > 1]


def summarize(table: dict, audit: dict) -> dict:
    records = table["records"]
    result = {
        "records": len(records),
        "recordsWithoutIssn": sum(not record["issns"] for record in records),
        "excludedInvalidIssns": audit["excludedIssns"],
        "titleCollisions": collisions(records, "title"),
        "normalizedTitleCollisions": collisions(records, "normalizedTitle"),
        "issnCollisions": collisions(records, "issn"),
    }
    if table["kind"] == "cas":
        result["divisionCounts"] = dict(collections.Counter(str(r["division"]) for r in records))
        result["topTrue"] = sum(r["top"] is True for r in records)
        result["topFalse"] = sum(r["top"] is False for r in records)
        result["topUnknown"] = sum(r["top"] is None for r in records)
    else:
        result["numericJif"] = sum(r["jif"] is not None for r in records)
        result["boundedJif"] = sum("jifDisplay" in r for r in records)
        result["missingJif"] = sum(r["jif"] is None and "jifDisplay" not in r for r in records)
        result["recordsWithoutQuartile"] = sum(not r["quartiles"] for r in records)
        result["categoryQuartiles"] = sum(len(r["quartiles"]) for r in records)
    return result


def sources_markdown(archive_sha: str, cas: dict, jcr: dict, summaries: dict) -> str:
    cas_stats, jcr_stats = summaries["cas"], summaries["jcr"]
    lines = [
        "# 本地指标数据来源与导入审计",
        "",
        "本文件由 `scripts/import-showjcr.py` 自动生成。原始输入是用户提供的",
        "`ShowJCR-master.zip`；转换时只读取两个明确列入白名单的 CSV，",
        "不解压 ZIP，不运行其中的代码，不读取 SQLite 数据库，不导入任何 XR/新锐分区。",
        "",
        "## 来源与使用范围",
        "",
        f"- 上游整理项目：[ShowJCR]({SOURCE})。本地 CSV 是第三方整理数据，不是本插件直接从官方 API 下载。",
        "- 本地 ZIP 的 README 声明：中科院升级版来源于 [中科院期刊分区表](https://advanced.fenqubiao.com/)，",
        "  `FQBJCR2025-UTF8.csv` 对应中科院 2025；JCR2025 于 2026 年 6 月 17 日发布。",
        "- ZIP 内的软件 LICENSE 为 GPL-3.0；该软件许可证不等同于原始期刊数据库的再分发授权。",
        "  这些转换文件及含数据安装包仅供用户在本地个人使用；未取得数据权利人许可时，不应另行公开、上传或分发。",
        "- 没有使用用户账号、密钥或绕过访问限制；未对全部期刊执行官方逐条复核。",
        f"- 原始 ZIP SHA-256：`{archive_sha}`。",
        "",
        "## 两个年份的含义",
        "",
        "| 输出 | 原始 CSV | 年份口径 | 记录数 |",
        "| --- | --- | --- | ---: |",
        f"| `cas-2025.json` | `{CAS_FILE}` | 中科院升级版 2025，大类分区和独立 Top 标志 | {len(cas['records']):,} |",
        f"| `jcr-2025.json` | `{JCR_FILE}` | 指标年 2025；JCR 发布版 2026 | {len(jcr['records']):,} |",
        "",
        "JCR 文件名中的 2025 指指标年，JSON 因此使用 `edition: 2026`、`metricYear: 2025`。",
        "CSV 表头为 `IF(2025)` 和 `IF Quartile(2025)_1..6`。",
        "[Clarivate 的 2026 发布说明](https://clarivate.com/news/clarivate-releases-journal-citation-reports-2026/)",
        "说明这版使用 2025 年数据并覆盖 22,643 本期刊，与本地表的行数一致；这只能核对版本/规模，不证明每个数值均无误。",
        "",
        "## 字段转换",
        "",
        "- `Journal` → `title`；不创造别名，`aliases` 默认为空数组。",
        "- `ISSN/EISSN` 或 `ISSN`、`EISSN` → `issns`；去重，统一 X 大写，检查格式及模 11 校验位。",
        "- 中科院 `年份` 必须为 2025；仅将 `大类分区`（例如 `1 [10/758]`）提取为 `division: 1`，不使用小类。",
        "- `Top` 中“是”→ true、“否”→ false；空值/缺失标记→ null，绝不由一区推断 Top。",
        "- `IF(2025)` 的数值→ `jif`；`N/A`/空值→ null；`<0.1` 保留为 `jif: null, jifDisplay: '<0.1'`。",
        "- 保留全部有效的学科及 Q1–Q4 配对；空值或 N/A 不补猜。单列如何聚合多个学科分区由插件显式决定。",
        "",
        "## 原表 SHA-256",
        "",
        f"- `{CAS_FILE}`：`{cas['sourceSha256']}`",
        f"- `{JCR_FILE}`：`{jcr['sourceSha256']}`",
        "",
        "## 质量审计",
        "",
        f"- 中科院：Top 是 {cas_stats['topTrue']:,}，否 {cas_stats['topFalse']:,}，未知 {cas_stats['topUnknown']:,}；所有行年份都是 2025。",
        f"- JCR：数值 JIF {jcr_stats['numericJif']:,}；`<0.1` {jcr_stats['boundedJif']:,}；缺失 JIF {jcr_stats['missingJif']:,}。",
        f"- JCR：保留 {jcr_stats['categoryQuartiles']:,} 个有效学科/分区配对；{jcr_stats['recordsWithoutQuartile']:,} 条没有可用 Q 分区。",
        "",
        "| 检查 | 中科院 | JCR |",
        "| --- | ---: | ---: |",
    ]
    for label, field in [
        ("刊名重复组（去首尾空白/忽略大小写）", "titleCollisions"),
        ("刊名宽松归一化碰撞组", "normalizedTitleCollisions"),
        ("有效 ISSN 对应多个记录的冲突组", "issnCollisions"),
    ]:
        lines.append(f"| {label} | {len(cas_stats[field])} | {len(jcr_stats[field])} |")
    lines.extend([
        f"| 没有任何有效 ISSN 的记录 | {cas_stats['recordsWithoutIssn']} | {jcr_stats['recordsWithoutIssn']} |",
        "",
        "宽松刊名归一化采用 NFKD、忽略大小写、&→and，并去除非字母/数字；有碰撞时应保持候选集合并要求 ISSN 消歧，不能取第一条。",
        "",
        "### 原表 ISSN 校验位错误",
        "",
        "下列原值从匹配索引中排除，未擅自纠正号码。其余有效 ISSN 和刊名仍可参与匹配。",
        "",
        "| 数据表 | 刊名 | 原始无效 ISSN |",
        "| --- | --- | --- |",
    ])
    for kind, stats in summaries.items():
        for record in stats["excludedInvalidIssns"]:
            lines.append(f"| {kind.upper()} | {record['title']} | `{record['issn']}` |")
    for kind, stats in summaries.items():
        for field in ("titleCollisions", "normalizedTitleCollisions", "issnCollisions"):
            if stats[field]:
                lines.extend(["", f"### {kind.upper()} / {field}", ""])
                for collision in stats[field]:
                    lines.append(f"- `{collision['key']}`：" + " / ".join(collision["titles"]))
    lines.extend([
        "",
        "## 抽样核对",
        "",
        "| 期刊 | 2025 JIF | JCR 各学科分区 | 中科院 2025 大类 | Top |",
        "| --- | ---: | --- | ---: | --- |",
    ])
    cas_titles = {r["title"].casefold(): r for r in cas["records"]}
    jcr_titles = {r["title"].casefold(): r for r in jcr["records"]}
    sample_titles = [
        "IEEE TRANSACTIONS ON PATTERN ANALYSIS AND MACHINE INTELLIGENCE",
        "NATURE", "SCIENCE", "CELL", "Scientific Reports",
    ]
    for title in sample_titles:
        cas_row, jcr_row = cas_titles.get(title.casefold()), jcr_titles.get(title.casefold())
        if not cas_row or not jcr_row:
            continue
        q = "; ".join(f"{r['category']}: {r['quartile']}" for r in jcr_row["quartiles"]) or "—"
        jif = jcr_row.get("jifDisplay", jcr_row["jif"])
        top = {True: "是", False: "否", None: "未知"}[cas_row["top"]]
        lines.append(f"| {title} | {jif if jif is not None else '—'} | {q} | {cas_row['division']} | {top} |")
    lines.extend([
        "",
        "以上抽样表由用户 CSV 原值生成。另通过 [IEEE Computer Society 官网](https://www.computer.org/publications)",
        "交叉核对 TPAMI 的 2025 年 JIF 为 20.4；不要继续把历史示例 23.6 当作最新值。",
        "",
        "## 可复现命令",
        "",
        "在项目根目录运行（Python 3.10+，不需要第三方库或网络）：",
        "",
        "```powershell",
        "python scripts/import-showjcr.py ShowJCR-master.zip",
        "python scripts/import-showjcr.py ShowJCR-master.zip --check",
        "```",
        "",
        "`--check` 只验证生成内容与磁盘文件完全相同，不改写文件。",
        "输出位置可以用 `--output-dir` 指定。导入失败、发现未知字段值或同名 CSV 多份时会报错停止。",
        "输出是固定版本的离线快照，不承诺下一年会自动变为最新；更新必须显式核验新数据与新年份。",
        "",
    ])
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", nargs="?", type=Path, default=ROOT / "ShowJCR-master.zip")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--check", action="store_true", help="Compare expected files without writing")
    args = parser.parse_args(argv)
    try:
        archive_sha = hashlib.sha256(args.archive.read_bytes()).hexdigest()
        with zipfile.ZipFile(args.archive) as archive:
            cas_blob, cas_rows = read_table(archive, CAS_FILE)
            jcr_blob, jcr_rows = read_table(archive, JCR_FILE)
        cas_audit, jcr_audit = {"excludedIssns": []}, {"excludedIssns": []}
        cas = import_cas(cas_blob, cas_rows, cas_audit)
        jcr = import_jcr(jcr_blob, jcr_rows, jcr_audit)
        summaries = {"cas": summarize(cas, cas_audit), "jcr": summarize(jcr, jcr_audit)}
        outputs = {
            "cas-2025.json": json.dumps(cas, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            "jcr-2025.json": json.dumps(jcr, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            "SOURCES.md": sources_markdown(archive_sha, cas, jcr, summaries),
        }
        if args.check:
            changed = [
                filename for filename, content in outputs.items()
                if not (args.output_dir / filename).is_file()
                or (args.output_dir / filename).read_bytes() != content.encode("utf-8")
            ]
            if changed:
                raise ImportFailure("Generated files are missing or stale: " + ", ".join(changed))
        else:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            for filename, content in outputs.items():
                (args.output_dir / filename).write_bytes(content.encode("utf-8"))
        print(json.dumps({"mode": "check" if args.check else "write", **summaries}, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, UnicodeError, csv.Error, zipfile.BadZipFile) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
