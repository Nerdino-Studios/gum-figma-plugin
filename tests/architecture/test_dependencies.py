"""T01 architecture gate: run with python3 -m unittest discover -s tests/architecture."""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
PROJECTS = {
    "Contracts": set(),
    "Conversion": {"Contracts"},
    "Application": {"Contracts", "Conversion"},
    "Infrastructure": {"Contracts", "Application"},
    "Host": {"Application", "Infrastructure"},
}
CORE = ("Contracts", "Conversion")
FORBIDDEN_SOURCE = re.compile(
    r"\b(?:System\s*\.\s*(?:IO|Net|Diagnostics\s*\.\s*Process)|"
    r"Microsoft\s*\.\s*AspNetCore|Figma\b|FlatRedBall|MonoGame|"
    r"Microsoft\s*\.\s*ModelContextProtocol)\b"
)


class DependencyRules(unittest.TestCase):
    def test_project_references_and_core_packages(self):
        for name, allowed in PROJECTS.items():
            with self.subTest(project=name):
                project = ROOT / "src" / f"GumBridge.{name}" / f"GumBridge.{name}.csproj"
                tree = ET.parse(project)
                refs = set()
                for element in tree.iter("ProjectReference"):
                    target = (project.parent / element.attrib["Include"].replace("\\", "/")).resolve()
                    self.assertTrue(target.is_relative_to(ROOT / "src"), target)
                    refs.add(target.stem)
                self.assertEqual(refs, {f"GumBridge.{item}" for item in allowed})
                if name in CORE:
                    for tag in ("PackageReference", "FrameworkReference", "Reference", "COMReference"):
                        self.assertEqual(list(tree.iter(tag)), [], f"{name} cannot use {tag}")
                    self.assertEqual(tree.findtext(".//TargetFramework"), "net10.0")
                    self.assertNotEqual(tree.findtext(".//OutputType"), "Exe")

    def test_core_has_no_side_effect_imports(self):
        for name in CORE:
            for source in (ROOT / "src" / f"GumBridge.{name}").rglob("*.cs"):
                if "obj" in source.parts or "bin" in source.parts:
                    continue
                with self.subTest(source=str(source.relative_to(ROOT))):
                    self.assertIsNone(FORBIDDEN_SOURCE.search(source.read_text()),
                                      f"{source} imports a forbidden core dependency")


if __name__ == "__main__":
    unittest.main()
