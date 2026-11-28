import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("edge_notes.py")
BUILD_NUMBER = Path(__file__).resolve().parents[1] / "print-build-number.sh"
EMPTY = "---\n\n---\n\n\n"


def changeset(bump, text):
    return f'---\n"timeline": {bump}\n---\n\n{text}\n'


class Repository:
    """A main branch shaped like this repository's: squash commits that each add a changeset."""

    def __init__(self, directory):
        self.path = Path(directory)
        self.git("init", "--quiet", "--initial-branch=main")
        self.commit("chore: start", {"package.json": json.dumps({"name": "timeline", "version": "0.21.0"}),
                                     ".changeset/README.md": "# Changesets\n", ".changeset/config.json": "{}\n"})

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
                              cwd=self.path, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, subject, files=(), removed=()):
        for name, content in dict(files).items():
            (self.path / name).parent.mkdir(parents=True, exist_ok=True)
            (self.path / name).write_text(content)
        for name in removed:
            (self.path / name).unlink()
        self.git("add", "--all")
        self.git("commit", "--quiet", "--allow-empty", "-m", subject)
        return self.build()

    def build(self):
        return int(subprocess.run([str(BUILD_NUMBER)], cwd=self.path, check=True, capture_output=True, text=True).stdout)

    def notes(self, previous_build, commit="HEAD", *options):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), commit, "--previous-build", str(previous_build), "--repo", str(self.path), *options],
                                capture_output=True, text=True)
        self.assertion.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout


class EdgeNotesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.repo = Repository(directory.name)
        self.repo.assertion = self
        self.first = self.repo.commit("web: show covers (#10)", {".changeset/blue-cats-run.md": changeset("minor", "Show playlist covers.")})
        self.repo.commit("ci: tidy (#11)", {".changeset/clean-geckos-sniff.md": EMPTY})
        self.repo.commit("sync: retry once (#12)", {".changeset/quiet-dogs-sing.md": changeset(
            "patch", "Retry a failed sync once.\n\nThe second attempt opens a fresh connection.")})

    def test_lists_new_changes_first_then_the_rest_since_stable(self):
        self.assertEqual(self.repo.notes(self.first), "\n".join([
            "## New in this build", "",
            "### Patch Changes", "",
            "- Retry a failed sync once.", "", "  The second attempt opens a fresh connection. (#12)", "",
            "## Also unreleased since 0.21.0", "",
            "### Minor Changes", "",
            "- Show playlist covers. (#10)", "",
        ]))

    def test_a_build_with_no_user_visible_change(self):
        previous = self.repo.build()
        self.repo.commit("test: cover retries (#13)", {".changeset/hot-tables-camp.md": EMPTY})
        notes = self.repo.notes(previous)
        self.assertTrue(notes.startswith("## New in this build\n\nNo user-visible changes in this build.\n\n## Also unreleased since 0.21.0\n"), notes)
        self.assertIn("- Show playlist covers. (#10)", notes)

    def test_nothing_since_the_last_stable_release(self):
        self.repo.commit("release: version packages (#14)", {"package.json": json.dumps({"name": "timeline", "version": "0.22.0"})},
                         removed=[".changeset/blue-cats-run.md", ".changeset/clean-geckos-sniff.md", ".changeset/quiet-dogs-sing.md"])
        previous = self.repo.build()
        self.repo.commit("docs: fix a link (#15)", {".changeset/free-buses-enjoy.md": EMPTY})
        self.assertEqual(self.repo.notes(previous), "No user-visible changes since 0.22.0.\n")

    def test_an_edited_changeset_keeps_the_build_that_added_it(self):
        previous = self.repo.build()
        self.repo.commit("web: reword covers (#16)", {".changeset/blue-cats-run.md": changeset("minor", "Show playlist covers on the Excluded page.")})
        notes = self.repo.notes(previous)
        self.assertIn("No user-visible changes in this build.", notes)
        self.assertIn("- Show playlist covers on the Excluded page. (#10)", notes)

    def test_a_change_merged_from_a_side_branch_counts_from_its_merge(self):
        start = self.repo.build()
        self.repo.git("switch", "--quiet", "-c", "side", "HEAD~1")
        self.repo.commit("web: from a branch (#20)", {".changeset/side-quest.md": changeset("patch", "Came from a side branch.")})
        self.repo.git("switch", "--quiet", "main")
        for index in range(3):
            self.repo.commit(f"chore: mainline {index} (#2{index + 1})")
        previous = self.repo.build()
        self.assertGreater(previous, start)
        self.repo.git("merge", "--quiet", "--no-ff", "-m", "Merge side (#24)", "side")
        notes = self.repo.notes(previous)
        self.assertTrue(notes.startswith("## New in this build\n\n### Patch Changes\n\n- Came from a side branch."), notes)

    def test_reads_history_without_changing_the_checkout(self):
        before = (self.repo.git("rev-parse", "HEAD"), self.repo.git("status", "--porcelain"))
        self.repo.notes(0)
        self.assertEqual((self.repo.git("rev-parse", "HEAD"), self.repo.git("status", "--porcelain")), before)
        self.assertTrue((self.repo.path / ".changeset/quiet-dogs-sing.md").exists())

    def html(self):
        return self.repo.notes(0, "HEAD", "--html", "example/timeline", "--build", str(self.repo.build() + 1))

    def test_html_lists_every_change_newest_first_with_installed_markers(self):
        first, current = self.first, self.repo.build() + 1
        html = self.html()
        marker = '<li class="installed" data-sparkle-version="{}">Earlier changes are already on this Mac.</li>'
        self.assertIn("li.installed { display: none;", html)
        body = html.split("<ul>\n", 1)[1]
        self.assertEqual(body.splitlines(), [
            marker.format(current - 1),
            '<li><p>Retry a failed sync once.</p><p>The second attempt opens a fresh connection. (<a href="https://github.com/example/timeline/pull/12">#12</a>)</p></li>',
            *[marker.format(build) for build in range(current - 2, first - 1, -1)],
            '<li><p>Show playlist covers. (<a href="https://github.com/example/timeline/pull/10">#10</a>)</p></li>',
            "</ul>",
        ])

    def test_html_escapes_changeset_text(self):
        self.repo.commit("web: angle brackets (#18)", {".changeset/sharp-owls-fly.md": changeset("patch", "Show `<b>` & **bold** safely.")})
        self.assertIn("<li><p>Show <code>&lt;b&gt;</code> &amp; <strong>bold</strong> safely.", self.html())

    def test_html_with_nothing_since_stable(self):
        self.repo.commit("release: version packages (#14)", {"package.json": json.dumps({"name": "timeline", "version": "0.22.0"})},
                         removed=[".changeset/blue-cats-run.md", ".changeset/clean-geckos-sniff.md", ".changeset/quiet-dogs-sing.md"])
        self.assertEqual(self.html(), "<p>No user-visible changes since 0.22.0.</p>\n")

    def test_falls_back_without_failing(self):
        self.repo.commit("web: broken changeset (#17)", {".changeset/broken.md": "no front matter\n"})
        self.assertEqual(self.repo.notes(0), "Notes unavailable.\n")
        self.assertEqual(self.repo.notes(0, commit="0" * 40), "Notes unavailable.\n")
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "0" * 40, "--previous-build", "0", "--repo", str(self.repo.path),
                                 "--html", "example/timeline", "--build", "1"], capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout), (1, ""))


if __name__ == "__main__":
    unittest.main()
