import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from native_check import detect, native_path


ROOT = Path(__file__).resolve().parents[2]


class NativeCheckTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / ".scratch"
        subprocess.run(["git", "check-ignore", "-q", ".scratch/"], cwd=ROOT, check=True)
        scratch.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="native-check-test-", dir=scratch)
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("config", "user.name", "Test Author")
        self.git("config", "user.email", "author@example.com")
        self.write("src/example.ts", "// portable\n")
        self.write("tools/timeline-app/Example.swift", "// native\n")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.PIPE).decode().strip()

    def write(self, path, text):
        destination = self.repo / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)

    def commit(self):
        self.git("add", "--all")
        self.git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
                 "commit", "--quiet", "-m", "test: synthetic change")
        return self.git("rev-parse", "HEAD")

    def test_portable_only_changes_skip(self):
        self.write("src/example.ts", "// changed portable code\n")
        self.write("web/src/example.ts", "// web\n")
        self.write(".changeset/synthetic.md", "---\n---\n")
        self.assertFalse(detect(self.base, self.commit(), self.repo)[0])

    def test_native_addition_and_odd_filename_run(self):
        self.write("tools/timeline-app/space and\nnewline.swift", "// native\n")
        self.assertTrue(detect(self.base, self.commit(), self.repo)[0])

    def test_native_deletion_runs(self):
        (self.repo / "tools/timeline-app/Example.swift").unlink()
        self.assertTrue(detect(self.base, self.commit(), self.repo)[0])

    def test_rename_out_of_native_directory_runs(self):
        self.git("mv", "tools/timeline-app/Example.swift", "src/moved.swift")
        self.assertTrue(detect(self.base, self.commit(), self.repo)[0])

    def test_rename_into_native_directory_runs(self):
        self.git("mv", "src/example.ts", "tools/timeline-app/moved.ts")
        self.assertTrue(detect(self.base, self.commit(), self.repo)[0])

    def test_full_pr_diff_keeps_earlier_native_change(self):
        self.write("tools/timeline-app/Example.swift", "// changed native\n")
        self.commit()
        self.write("src/example.ts", "// later portable change\n")
        self.assertTrue(detect(self.base, self.commit(), self.repo)[0])

    def test_base_branch_changes_do_not_count_as_pr_changes(self):
        self.git("switch", "--quiet", "-c", "feature")
        self.write("src/example.ts", "// branch portable change\n")
        head = self.commit()
        self.git("switch", "--quiet", "main")
        self.write("tools/timeline-app/Example.swift", "// main native change\n")
        self.assertFalse(detect(self.commit(), head, self.repo)[0])

    def test_unknown_commit_runs(self):
        required, reason = detect(self.base, "0" * 40, self.repo)
        self.assertTrue(required)
        self.assertIn("could not determine", reason)

    def test_malformed_sha_runs(self):
        self.assertTrue(detect("--not-a-sha", self.base, self.repo)[0])

    def test_git_error_and_partial_output_run(self):
        with patch("native_check.git", side_effect=FileNotFoundError):
            self.assertTrue(detect(self.base, self.base, self.repo)[0])
        with patch("native_check.git", side_effect=[self.base.encode(), b"src/example.ts"]):
            self.assertTrue(detect(self.base, self.base, self.repo)[0])
        with patch("native_check.git", return_value=b"a\nb\n"):
            self.assertTrue(detect(self.base, self.base, self.repo)[0])

    def test_failure_emits_true_for_actions(self):
        output = self.repo / "actions-output"
        result = subprocess.run(
            ["python3", str(ROOT / "scripts/ci/native_check.py"), self.base, "0" * 40],
            cwd=self.repo, env={**os.environ, "GITHUB_OUTPUT": str(output)},
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(output.read_text(), "required=true\n")
        self.assertIn("could not determine", result.stdout)

    def test_native_dependency_and_coverage_paths(self):
        for path in ["mise.toml", "package.json", "bun.lock", "scripts/print-build-number.sh",
                     "scripts/build-service-artifact.ts", "scripts/artifact/timeline-service",
                     "scripts/sqlite/build.ts", "scripts/smoke-service.sh",
                     "tools/timeline-app/sparkle.sh", "tools/timeline-app/package-dmg.sh",
                     "tools/timeline-recall/create-signing-identity.sh",
                     "tools/timeline-gmessages/go.sum", "deploy/macos/run-tailscale.sh",
                     ".github/workflows/ci.yml", ".github/actions/setup/action.yml",
                     "scripts/ci/native_check.py"]:
            with self.subTest(path=path):
                self.assertTrue(native_path(path))
        for path in ["src/service.ts", "web/bun.lock", "docs/operations/development.md",
                     "tools/timeline-app-other/file", "AGENTS.md"]:
            with self.subTest(path=path):
                self.assertFalse(native_path(path))


if __name__ == "__main__":
    unittest.main()
