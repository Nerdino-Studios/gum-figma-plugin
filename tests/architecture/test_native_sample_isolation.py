"""T02: a failed GumCli codegen must not write to the native sample checkout."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "samples/GumBridge.Sample"


class NativeSampleIsolation(unittest.TestCase):
    @unittest.skipUnless(shutil.which("bash"), "native sample smoke requires bash")
    def test_partial_codegen_failure_stays_in_disposable_staging(self):
        with tempfile.TemporaryDirectory(prefix="gum209-isolation-") as temp:
            temp = Path(temp)
            executable = temp / "dotnet"
            executable.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import sys

command, project = sys.argv[5:7]  # tool run gumcli -- <command> <project>
project = Path(project)
with open(os.environ["GUM209_TEST_LOG"], "a") as log:
    log.write(f"{command} {project}\\n")
if command == "fonts":
    cache = project.parent / "FontCache"
    cache.mkdir(exist_ok=True)
    (cache / "Font24Arial.fnt").write_text("font")
    (cache / "Font24Arial_0.png").write_bytes(b"atlas")
if command == "codegen":
    destination = project.parent.parent.parent / "Screens"
    destination.mkdir(exist_ok=True)
    (destination / "PreviewRuntime.Generated.cs").write_text("partial")
    sys.exit(1)
''')
            executable.chmod(0o755)
            log = temp / "calls.log"
            env = dict(os.environ, PATH=f'{temp}{os.pathsep}{os.environ["PATH"]}',
                       TMPDIR=str(temp), GUM209_TEST_LOG=str(log))
            generated = SAMPLE / "Screens/PreviewRuntime.Generated.cs"
            before = generated.read_bytes() if generated.exists() else None
            result = subprocess.run(["bash", str(ROOT / "scripts/check-native-sample.sh")],
                                    cwd=ROOT, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = log.read_text().splitlines()
            self.assertEqual([line.split()[0] for line in calls], ["check", "fonts", "codegen"])
            for call in calls:
                project = Path(call.split(" ", 1)[1])
                self.assertTrue(project.is_relative_to(temp), call)
                self.assertNotEqual(project, SAMPLE / "Content/GumProject/GumProject.gumx")
            self.assertEqual(generated.read_bytes() if generated.exists() else None, before)
            self.assertEqual(list(temp.glob("gum209-native.*")), [], "staging survived failure")


if __name__ == "__main__":
    unittest.main()
