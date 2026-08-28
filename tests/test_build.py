"""Public packaging must never pick up private data or legacy files by default."""
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
        for name in builder.FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"synthetic package file\n")
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        self.patch = patch.object(builder, "ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def add_private_files(self):
        for name in builder.DATA_FILES + ["legacy/old.xpi", "work/private.log", "ShowJCR-master.zip", ".env"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"PRIVATE FIXTURE, NOT FOR PUBLIC RELEASE")

    def test_default_build_excludes_all_private_and_legacy_files(self):
        self.add_private_files()
        result = builder.build(self.root / "dist")
        self.assertEqual(result["mode"], "public-without-data")
        with ZipFile(result["file"]) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(set(archive.namelist()), set(builder.FILES))
            self.assertFalse(any(b"PRIVATE FIXTURE" in archive.read(name) for name in archive.namelist()))

    def test_personal_build_requires_explicit_opt_in_and_has_distinct_filename(self):
        self.add_private_files()
        public = builder.build(self.root / "dist")
        personal = builder.build(self.root / "dist", with_data=True)
        self.assertNotEqual(public["file"], personal["file"])
        self.assertTrue(personal["file"].endswith("-personal.xpi"))
        with ZipFile(personal["file"]) as archive:
            self.assertEqual(set(archive.namelist()), set(builder.FILES + builder.DATA_FILES))

    def test_same_sources_produce_same_xpi_and_hash(self):
        first = builder.build(self.root / "first")
        second = builder.build(self.root / "second")
        self.assertEqual(Path(first["file"]).read_bytes(), Path(second["file"]).read_bytes())
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(Path(first["file"] + ".sha256").read_text().split()[0], first["sha256"])

    def test_missing_private_input_fails_before_creating_output(self):
        output = self.root / "uncreated"
        with self.assertRaisesRegex(ValueError, "Missing package file"):
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
