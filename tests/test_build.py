"""The single XPI requires metric tables and excludes unrelated local files."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("scholar_build", ROOT / "scripts/build.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        for name in builder.FILES + builder.DATA_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"synthetic package file\n")
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        self.patch = patch.object(builder, "ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def add_private_files(self):
        for name in ["data/unrelated.json", "legacy/old.xpi", "work/private.log", "ShowJCR-master.zip", ".env"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"PRIVATE FIXTURE, NOT FOR PUBLIC RELEASE")

    def test_single_build_bundles_required_tables_but_excludes_unrelated_files(self):
        self.add_private_files()
        result = builder.build(self.root / "dist")
        self.assertEqual(Path(result["file"]).name, f"zotero10-scholar-{self.manifest['version']}.xpi")
        with ZipFile(result["file"]) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(set(archive.namelist()), set(builder.FILES + builder.DATA_FILES))
            self.assertFalse(any(b"PRIVATE FIXTURE" in archive.read(name) for name in archive.namelist()))

    def test_missing_table_cannot_silently_create_an_incomplete_variant(self):
        (self.root / "data/jcr-2025.json").unlink()
        output = self.root / "uncreated"
        with self.assertRaisesRegex(ValueError, "data/jcr-2025.json"):
            builder.build(output)
        self.assertFalse(output.exists())

    def test_same_sources_produce_same_xpi_and_hash(self):
        first = builder.build(self.root / "first")
        second = builder.build(self.root / "second")
        self.assertEqual(Path(first["file"]).read_bytes(), Path(second["file"]).read_bytes())
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(Path(first["file"] + ".sha256").read_text().split()[0], first["sha256"])

    def test_removed_variant_option_cannot_create_a_second_variant(self):
        output = self.root / "uncreated"
        with self.assertRaises(TypeError):
            builder.build(output, with_data=True)
        self.assertFalse(output.exists())

    def test_missing_runtime_file_fails_before_creating_output(self):
        (self.root / "src/core.js").unlink()
        output = self.root / "uncreated"
        with self.assertRaisesRegex(ValueError, "src/core.js"):
            builder.build(output)
        self.assertFalse(output.exists())

    def test_unsafe_manifest_version_cannot_escape_output_directory(self):
        self.manifest["version"] = "../../outside"
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "version string"):
            builder.build(self.root / "uncreated")


if __name__ == "__main__":
    unittest.main()
