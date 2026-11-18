from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from nightly_release import Refusal, check_appcast, latest_nightly, nightly_tag, prune_plan


SCRIPT = Path(__file__).with_name("nightly_release.py")
NOW = datetime(2026, 12, 1, 3, 30, tzinfo=timezone.utc)


def release(tag, days_ago, prerelease=True, draft=False):
    published = None if draft else (NOW - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")
    return {"tag_name": tag, "prerelease": prerelease, "draft": draft, "published_at": published}


def nightly(days_ago):
    day = (NOW - timedelta(days=days_ago)).date()
    return release(f"v0.21.1-nightly.{day:%Y%m%d}", days_ago)


NEWEST = nightly(0)


def plan(*pages):
    """Plan as the prune job does, right after publishing NEWEST."""
    return prune_plan([[NEWEST], *pages], NOW, NEWEST["tag_name"])


class NightlyTagTests(unittest.TestCase):
    def test_names_the_next_patch_nightly(self):
        self.assertEqual(nightly_tag("0.20.0", date(2026, 11, 18)), "v0.20.1-nightly.20261118")
        self.assertEqual(nightly_tag("1.9.9", date(2027, 1, 2)), "v1.9.10-nightly.20270102")

    def test_refuses_versions_that_are_not_stable(self):
        for version in ("0.20.1-nightly.20261118", "0.20", "v0.20.0", "01.2.3", ""):
            with self.subTest(version=version), self.assertRaises(Refusal):
                nightly_tag(version, date(2026, 11, 18))


class PrunePlanTests(unittest.TestCase):
    def test_deletes_only_old_nightlies_beyond_the_newest_three(self):
        nightlies = [nightly(days) for days in (1, 2, 15, 16, 30)]
        others = [
            release("v0.21.0", 40, prerelease=False),
            release("v0.21.0-nightly", 40),
            release("nightly-v0.21.0", 40),
            release("v0.21.0-nightly.2026111", 40),
            release("v0.21.0-nightly.20261101-1", 40),
            release("v0.21.0-beta.1", 40),
            release("nightly", 400),
            release("v0.21.1-nightly.20261020", 0, draft=True),
        ]
        doomed = plan(nightlies[:2] + others[:4], others[4:] + nightlies[2:])
        self.assertEqual(doomed, [nightlies[4]["tag_name"], nightlies[3]["tag_name"], nightlies[2]["tag_name"]])

    def test_keeps_the_minimum_even_when_all_are_old(self):
        old = [nightly(days) for days in (20, 21, 22)]
        self.assertEqual(plan(old), [old[2]["tag_name"]])
        self.assertEqual(plan(old[:2]), [])

    def test_keeps_nightlies_younger_than_the_window(self):
        self.assertEqual(plan([nightly(days) for days in (1, 5, 9, 13)]), [])

    def test_refuses_a_list_that_does_not_show_the_new_nightly_as_newest(self):
        for pages in ([], [[]], [[nightly(20), nightly(21)]], [[NEWEST, release("v0.21.2-nightly.20261201", -0.01)]]):
            with self.subTest(pages=pages), self.assertRaises(Refusal):
                prune_plan(pages, NOW, NEWEST["tag_name"])

    def test_never_selects_stable_or_lookalike_releases(self):
        stable = [release(f"v0.{minor}.0", 100 + minor, prerelease=False) for minor in range(10)]
        lookalikes = [
            release("v0.21.0-nightly", 100),
            release("nightly-v0.21.0", 100),
            release("nightly", 100),
            release("V0.21.0-nightly.20260101", 100),
            release("v0.21.0-nightly.20260101 ", 100),
            release("0.21.0-nightly.20260101", 100),
            release("v0.21.0-nightly.20260101-rc", 100),
        ]
        recent = [nightly(days) for days in (1, 2)]
        self.assertEqual(plan(recent + stable + lookalikes), [])

    def test_refuses_unexpected_input(self):
        bad_inputs = {
            "not pages": {"tag_name": "v0.21.1-nightly.20261101"},
            "flat list": [nightly(20)],
            "page not a list": [nightly(20)],
            "release not an object": [["v0.21.1-nightly.20261101"]],
            "missing tag": [[{"prerelease": True, "draft": False, "published_at": "2026-11-01T00:00:00Z"}]],
            "string flag": [[{**nightly(20), "prerelease": "true"}]],
            "missing draft": [[{key: value for key, value in nightly(20).items() if key != "draft"}]],
            "nightly name on a stable release": [[release("v0.21.1-nightly.20261101", 30, prerelease=False)]],
            "duplicate tag": [[nightly(20), nightly(20)]],
            "no publication time": [[{**nightly(20), "published_at": None}]],
            "bad publication time": [[{**nightly(20), "published_at": "yesterday"}]],
            "naive publication time": [[{**nightly(20), "published_at": "2026-11-01T00:00:00"}]],
            "published in the future": [[nightly(-5)]],
            "tag dated in the future": [[release("v0.21.1-nightly.20991231", 30)]],
            "impossible tag date": [[release("v0.21.1-nightly.20261399", 30)]],
        }
        for name, pages in bad_inputs.items():
            with self.subTest(name), self.assertRaises(Refusal):
                plan(*pages)

    def test_future_tags_cannot_displace_real_nightlies(self):
        future = [release(f"v0.21.1-nightly.2099010{day}", 30) for day in (1, 2, 3)]
        with self.assertRaises(Refusal):
            plan(future + [nightly(30)])

    def test_refuses_more_deletions_than_a_normal_night(self):
        many = [nightly(days) for days in range(15, 60)]
        with self.assertRaises(Refusal):
            plan(many)
        with self.assertRaises(Refusal):
            prune_plan([[NEWEST]], NOW.replace(tzinfo=None), NEWEST["tag_name"])


class LatestNightlyTests(unittest.TestCase):
    def test_finds_the_newest_published_nightly(self):
        pages = [[nightly(9), release("v0.22.0", 0, prerelease=False), nightly(2)], [release("v0.21.1-nightly.20261201", 0, draft=True), release("nightly", 0)]]
        self.assertEqual(latest_nightly(pages, NOW), nightly(2)["tag_name"])

    def test_returns_none_without_nightlies(self):
        self.assertIsNone(latest_nightly([[release("v0.22.0", 0, prerelease=False), release("nightly", 0)]], NOW))
        self.assertIsNone(latest_nightly([], NOW))

    def test_refuses_a_future_dated_nightly(self):
        with self.assertRaises(Refusal):
            latest_nightly([[nightly(2), release("v0.21.1-nightly.20991231", 1)]], NOW)


APPCAST = """<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Timeline</title>
        <item>
            <title>0.20.1-nightly.20261118</title>
            <sparkle:version>1330</sparkle:version>
            <sparkle:shortVersionString>0.20.1-nightly.20261118</sparkle:shortVersionString>
            <enclosure url="https://github.com/example/timeline/releases/download/v0.20.1-nightly.20261118/Timeline-0.20.1-nightly.20261118-macos-arm64.dmg" length="1" type="application/octet-stream" sparkle:edSignature="c2lnbmF0dXJl"/>
        </item>
    </channel>
</rss>
"""
TAG = "v0.20.1-nightly.20261118"


class AppcastTests(unittest.TestCase):
    def test_accepts_the_signed_nightly_item(self):
        check_appcast(APPCAST, "example/timeline", TAG, "1330")

    def test_refuses_feeds_for_anything_else(self):
        cases = {
            "wrong build": (APPCAST, "example/timeline", TAG, "1331"),
            "stable tag": (APPCAST.replace(TAG, "v0.20.0").replace("0.20.1-nightly.20261118", "0.20.0"), "example/timeline", "v0.20.0", "1330"),
            "other repository": (APPCAST, "other/timeline", TAG, "1330"),
            "unsigned": (APPCAST.replace(' sparkle:edSignature="c2lnbmF0dXJl"', ""), "example/timeline", TAG, "1330"),
            "two items": (APPCAST.replace("</channel>", "<item/></channel>"), "example/timeline", TAG, "1330"),
            "other release's download": (APPCAST.replace(f"download/{TAG}/", "download/v0.20.0/"), "example/timeline", TAG, "1330"),
            "not a DMG": (APPCAST.replace("arm64.dmg", "arm64.zip"), "example/timeline", TAG, "1330"),
            "wrong short version": (APPCAST.replace(">0.20.1-nightly.20261118</sparkle:short", ">0.20.0</sparkle:short"), "example/timeline", TAG, "1330"),
            "not XML": ("<rss", "example/timeline", TAG, "1330"),
        }
        for name, args in cases.items():
            with self.subTest(name), self.assertRaises(Refusal):
                check_appcast(*args)


class CommandLineTests(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *args], capture_output=True, text=True)

    def test_prune_plan_prints_nothing_and_fails_on_bad_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "releases.json")
            path.write_text(json.dumps([[release("v0.21.1-nightly.20200101", 3000, prerelease=False)]]))
            result = self.run_script("prune-plan", str(path), "--newest", "v0.21.1-nightly.20200101")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            path.write_text("not json")
            result = self.run_script("prune-plan", str(path), "--newest", "v0.21.1-nightly.20200101")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")

    def test_check_tag_command(self):
        self.assertEqual(self.run_script("check-tag", "v0.20.1-nightly.20261118").returncode, 0)
        for tag in ("v0.20.0", "nightly", "v0.20.1-nightly.20261318"):
            with self.subTest(tag=tag):
                self.assertEqual(self.run_script("check-tag", tag).returncode, 1)

    def test_tag_command(self):
        result = self.run_script("tag", "0.20.0")
        self.assertEqual(result.returncode, 0)
        self.assertRegex(result.stdout, r"^v0\.20\.1-nightly\.[0-9]{8}\n$")


if __name__ == "__main__":
    unittest.main()
