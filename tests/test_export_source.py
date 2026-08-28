"""Safety and reproducibility checks for the public-source exporter."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export-source.py"
SPEC = importlib.util.spec_from_file_location("scholar_source_export", SCRIPT)
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


class SourceExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="scholar-export-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.payloads = {
            "manifest.json": json.dumps({"version": "9.8.7"}).encode("utf-8"),
            "README.md": "# Test source\nOnly synthetic fixtures.\n".encode("utf-8"),
            "src/core.js": b"// Synthetic test implementation\n",
            "data/README.md": b"No journal data is distributed.\n",
            "scripts/export-source.py": b"# Synthetic exporter fixture\n",
        }
        for name, payload in self.payloads.items():
            self.write(name, payload)
        self.root_patch = patch.object(EXPORT, "ROOT", self.root)
        self.files_patch = patch.object(EXPORT, "FILES", tuple(self.payloads))
        self.root_patch.start()
        self.files_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.addCleanup(self.files_patch.stop)
        self.output = self.root / "publish" / "zotero10-scholar"
        self.archive = self.root / "dist" / "zotero10-scholar-9.8.7-source.zip"

    def write(self, name, payload):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def make_link(self, link, target, *, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError):
            self.skipTest("This platform does not permit creation of symbolic-link fixtures")

    def assert_no_export(self):
        self.assertFalse(self.output.exists())
        self.assertFalse((self.root / "dist").exists())

    def test_only_allowlisted_files_are_exported_with_valid_zip_and_checksum(self):
        forbidden = (
            ".git/config", "legacy/original.js", "__data/table.json",
            "ShowJCR-master.zip", "data/jcr-2025.json", "data/SOURCES.md",
            "work/runtime-report.json", ".cache/session.log",
            "chrome/content/icons/favicon.png", "dist/old.xpi", "private.txt",
        )
        for name in forbidden:
            self.write(name, b"PRIVATE FIXTURE: MUST NOT BE EXPORTED")

        result = EXPORT.export_source()

        exported = {path.relative_to(self.output).as_posix()
                    for path in self.output.rglob("*") if path.is_file()}
        self.assertEqual(exported, set(self.payloads))
        for name, payload in self.payloads.items():
            self.assertEqual((self.output / name).read_bytes(), payload)
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(archive.namelist(), sorted(self.payloads))
            self.assertIsNone(archive.testzip())
            for name, payload in self.payloads.items():
                self.assertEqual(archive.read(name), payload)
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        checksum = self.archive.with_name(self.archive.name + ".sha256")
        self.assertEqual(checksum.read_text(encoding="ascii"), f"{digest}  {self.archive.name}\n")
        self.assertEqual(result["sha256"], digest)
        self.assertEqual(result["files"], len(self.payloads))
        self.assertEqual(Path(result["directory"]), self.output)
        for name in forbidden:
            self.assertTrue((self.root / name).is_file(), name)

    def test_existing_nonempty_output_is_preserved(self):
        self.output.mkdir(parents=True)
        marker = self.output / "keep.txt"
        marker.write_bytes(b"Do not change")
        with self.assertRaisesRegex(FileExistsError, "nonempty"):
            EXPORT.export_source()
        self.assertEqual(marker.read_bytes(), b"Do not change")
        self.assertEqual(list(self.output.iterdir()), [marker])
        self.assertFalse((self.root / "dist").exists())

    def test_existing_empty_output_is_supported(self):
        self.output.mkdir(parents=True)
        EXPORT.export_source()
        self.assertEqual((self.output / "README.md").read_bytes(), self.payloads["README.md"])

    def test_missing_file_fails_before_creating_any_output(self):
        (self.root / "src/core.js").unlink()
        custom = self.base / "not-created" / "clean-source"
        with self.assertRaises(FileNotFoundError):
            EXPORT.export_source(custom)
        self.assertFalse(custom.parent.exists())
        self.assert_no_export()

    def test_source_file_symlink_is_rejected(self):
        outside = self.base / "private.txt"
        outside.write_bytes(b"Private fixture")
        source = self.root / "README.md"
        source.unlink()
        self.make_link(source, outside)
        with self.assertRaisesRegex(ValueError, "links|reparse"):
            EXPORT.export_source()
        self.assert_no_export()
        self.assertEqual(outside.read_bytes(), b"Private fixture")

    def test_source_directory_symlink_is_rejected(self):
        (self.root / "src/core.js").unlink()
        (self.root / "src").rmdir()
        outside = self.base / "outside-source"
        outside.mkdir()
        (outside / "core.js").write_bytes(b"Private source fixture")
        self.make_link(self.root / "src", outside, directory=True)
        with self.assertRaisesRegex(ValueError, "links|reparse"):
            EXPORT.export_source()
        self.assert_no_export()

    def test_destination_parent_symlink_is_rejected(self):
        outside = self.base / "outside-output"
        outside.mkdir()
        linked_parent = self.root / "linked-parent"
        self.make_link(linked_parent, outside, directory=True)
        with self.assertRaisesRegex(ValueError, "links|reparse"):
            EXPORT.export_source(linked_parent / "clean-source")
        self.assertEqual(list(outside.iterdir()), [])
        self.assert_no_export()

    def test_windows_reparse_attribute_is_rejected_without_following(self):
        original_lstat = Path.lstat
        linked_directory = self.root / "src"

        def simulated_junction(path):
            info = original_lstat(path)
            if path == linked_directory:
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info

        with patch.object(Path, "lstat", simulated_junction):
            with self.assertRaisesRegex(ValueError, "reparse"):
                EXPORT.export_source()
        self.assert_no_export()

    def test_source_destination_must_not_include_dist_artifacts(self):
        with self.assertRaisesRegex(ValueError, "dist"):
            EXPORT.export_source(self.root / "dist")
        self.assert_no_export()

    def test_unsafe_allowlist_entries_are_rejected_before_export(self):
        for name in ("../private.txt", "/README.md", "./README.md", "src\\core.js", "C:/private.txt"):
            with self.subTest(name=name), patch.object(EXPORT, "FILES", (*self.payloads, name)):
                with self.assertRaisesRegex(ValueError, "Unsafe source path"):
                    EXPORT.export_source()
                self.assert_no_export()

    def test_invalid_manifest_version_cannot_escape_archive_directory(self):
        self.write("manifest.json", json.dumps({"version": "../../private"}).encode("utf-8"))
        with self.assertRaisesRegex(ValueError, "version"):
            EXPORT.export_source()
        self.assert_no_export()

    def test_fresh_destination_can_atomically_replace_same_version_archive(self):
        first = EXPORT.export_source()
        original_archive = self.archive.read_bytes()
        self.archive.write_bytes(b"Old archive fixture")
        checksum = self.archive.with_name(self.archive.name + ".sha256")
        checksum.write_bytes(b"Old checksum fixture")
        second_output = self.base / "second-export"
        second = EXPORT.export_source(second_output)
        self.assertEqual(self.archive.read_bytes(), original_archive)
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual((self.output / "README.md").read_bytes(), self.payloads["README.md"])
        self.assertEqual((second_output / "README.md").read_bytes(), self.payloads["README.md"])
        self.assertFalse(list(self.root.glob("dist/.scholar-source-*")))
        self.assertFalse(list(second_output.parent.glob(".scholar-source-*")))

    def test_an_exported_source_tree_can_be_exported_again(self):
        EXPORT.export_source()
        new_output = self.base / "re-export"
        with patch.object(EXPORT, "ROOT", self.output):
            result = EXPORT.export_source(new_output)
        self.assertEqual((new_output / "manifest.json").read_bytes(), self.payloads["manifest.json"])
        self.assertEqual(result["files"], len(self.payloads))
        self.assertTrue((self.output / "dist/zotero10-scholar-9.8.7-source.zip").is_file())


if __name__ == "__main__":
    unittest.main()
