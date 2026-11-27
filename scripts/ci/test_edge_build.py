from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from edge_build import BUILD_DMG, Refusal, check_appcast, edge_version, feed_build, offered_build, prune_plan, publish_action, kept_builds, retention


SCRIPT = Path(__file__).with_name("edge_build.py")
TAG = "nightly"


def dmg(build, version="0.21.1"):
    return f"Timeline-{version}-edge.{build}-macos-arm64.dmg"


def build_assets(*builds):
    return [name for build in builds for name in (dmg(build), dmg(build) + ".sha256")]


START = datetime(2026, 11, 20, 9, tzinfo=timezone.utc)


def release(names, times=None, **overrides):
    """The rolling release; build N's files were uploaded at `times[N]`, by default 10 minutes after build N-1's."""
    def asset(name):
        match = BUILD_DMG.fullmatch(name.removesuffix(".sha256"))
        if not match:
            return {"name": name, "created_at": START.isoformat()}
        build = int(match[1])
        uploaded = (times or {}).get(build, START + timedelta(minutes=10 * (build - 1000)))
        return {"name": name, "created_at": uploaded.isoformat().replace("+00:00", "Z")}
    return {"tag_name": TAG, "prerelease": True, "draft": False, "assets": [asset(name) for name in names], **overrides}


def removed_builds(plan):
    return sorted(int(match[1]) for name in plan if (match := BUILD_DMG.fullmatch(name)))


class EdgeVersionTests(unittest.TestCase):
    def test_names_the_next_patch_with_the_build(self):
        self.assertEqual(edge_version("0.21.0", "1347"), "0.21.1-edge.1347")
        self.assertEqual(edge_version("1.9.9", "2000"), "1.9.10-edge.2000")

    def test_refuses_bad_inputs(self):
        for version, build in (("0.21.1-edge.1347", "1348"), ("0.21", "1"), ("0.21.0", "0"), ("0.21.0", "01"), ("0.21.0", "")):
            with self.subTest(version=version, build=build), self.assertRaises(Refusal):
                edge_version(version, build)


class PrunePlanTests(unittest.TestCase):
    def test_keeps_the_newest_five_builds_and_the_feed(self):
        names = ["appcast.xml", *build_assets(1340, 1341, 1342, 1343, 1344, 1345, 1346)]
        self.assertEqual(
            prune_plan(release(names), TAG, 1346),
            [dmg(1340), dmg(1340) + ".sha256", dmg(1341), dmg(1341) + ".sha256"],
        )

    def test_removes_superseded_patches_before_images(self):
        old = "Timeline1345-1340.delta"
        kept = "Timeline1346-1345.delta"
        names = ["appcast.xml", old, kept, *build_assets(*range(1340, 1347))]
        self.assertEqual(prune_plan(release(names), TAG, 1346), [
            old, dmg(1340), dmg(1340) + ".sha256", dmg(1341), dmg(1341) + ".sha256",
        ])
        for stray in ("Timeline9999-1340.delta", "Timeline1345-1346.delta", kept + ".bak"):
            with self.subTest(stray=stray), self.assertRaises(Refusal):
                prune_plan(release(names + [stray]), TAG, 1346)

    def test_catches_up_after_one_missed_cleanup(self):
        patches = [f"Timeline{target}-{old}.delta" for target in (1344, 1345)
                   for old in range(target - 5, target)]
        names = ["appcast.xml", *patches, *build_assets(*range(1340, 1347))]
        plan = prune_plan(release(names), TAG, 1346)
        self.assertEqual(plan[:10], sorted(patches))
        self.assertEqual(plan[10:], build_assets(1340, 1341))

    def test_orders_builds_numerically(self):
        names = ["appcast.xml", *build_assets(999, 1000, 1001, 1002, 1003, 1004)]
        self.assertEqual(prune_plan(release(names), TAG, 1004), [dmg(999), dmg(999) + ".sha256"])

    def test_deletes_nothing_with_few_builds(self):
        self.assertEqual(prune_plan(release(["appcast.xml", *build_assets(1347)]), TAG, 1347), [])

    def test_a_version_bump_does_not_reorder_builds(self):
        names = ["appcast.xml", dmg(1340, "0.21.1"), dmg(1340, "0.21.1") + ".sha256"]
        names += [name for build in range(1341, 1346) for name in (dmg(build, "0.22.1"), dmg(build, "0.22.1") + ".sha256")]
        self.assertEqual(prune_plan(release(names), TAG, 1345), [dmg(1340, "0.21.1"), dmg(1340, "0.21.1") + ".sha256"])

    def test_refuses_anything_but_the_published_rolling_prerelease(self):
        names = ["appcast.xml", *build_assets(1340, 1341, 1342, 1343, 1344, 1345, 1346)]
        for name, value in {
            "stable release": release(names, prerelease=False),
            "draft": release(names, draft=True),
            "other tag": release(names, tag_name="v0.21.0"),
            "missing flags": {"tag_name": TAG, "assets": []},
            "string flag": release(names, prerelease="true"),
            "not an object": [release(names)],
            "no asset list": release(names, assets=None),
        }.items():
            with self.subTest(name), self.assertRaises(Refusal):
                prune_plan(value, TAG, 1346)

    def test_refuses_unexpected_assets(self):
        unexpected = [
            "Timeline-0.20.1-nightly.20261118-macos-arm64.dmg",
            "Timeline-0.21.1-edge.1340-macos-x86_64.dmg",
            "Timeline-0.21.1-edge.01340-macos-arm64.dmg",
            "Timeline-0.21.0-macos-arm64.dmg",
            "timeline-0.21.1-edge.1340-macos-arm64.dmg",
            "Timeline-0.21.1-edge.1340-macos-arm64.dmg.bak",
            "appcast.xml.old",
            "notes.md",
            "",
        ]
        for name in unexpected:
            with self.subTest(name=name), self.assertRaises(Refusal):
                prune_plan(release(["appcast.xml", name, *build_assets(1346)]), TAG, 1346)

    def test_refuses_inconsistent_state(self):
        cases = {
            "no feed": release(build_assets(1345, 1346)),
            "feed not at the newest DMG": release(["appcast.xml", *build_assets(1345, 1346)]),
            "current DMG missing": release(["appcast.xml", *build_assets(1345)]),
            "no DMGs": release(["appcast.xml"]),
            "duplicate name": release(["appcast.xml", *build_assets(1346), dmg(1346)]),
            "asset without a name": {**release(["appcast.xml", dmg(1346)]), "assets": [{"name": "appcast.xml"}, {"size": 1}]},
            "orphan checksums push out the only DMG": release(["appcast.xml", *build_assets(1340), *[dmg(build) + ".sha256" for build in range(1341, 1346)]]),
            "current build only a checksum": release(["appcast.xml", *build_assets(1345), dmg(1346) + ".sha256"]),
            "DMG without a checksum": release(["appcast.xml", *build_assets(1345), dmg(1346)]),
            "orphan checksum beside a valid newest DMG": release(["appcast.xml", *build_assets(1346), dmg(1340) + ".sha256"]),
            "stray checksum file": release(["appcast.xml", *build_assets(1346), "notes.sha256"]),
            "two DMGs for one build": release(["appcast.xml", *build_assets(1346), dmg(1346, "0.22.1"), dmg(1346, "0.22.1") + ".sha256"]),
        }
        current = {"feed not at the newest DMG": 1345, "orphan checksums push out the only DMG": 1345}
        for name, value in cases.items():
            with self.subTest(name), self.assertRaises(Refusal):
                prune_plan(value, TAG, current.get(name, 1346))

    def test_removes_a_backlog_of_images_oldest_first_over_several_runs(self):
        # As after keeping fewer builds, for example when reverting to an older retention rule.
        builds = list(range(1300, 1320))
        runs = 0
        while True:
            plan = prune_plan(release(["appcast.xml", *build_assets(*builds)]), TAG, 1319)
            if not plan:
                break
            removed = sorted(int(name.split("edge.")[1].split("-")[0]) for name in plan if name.endswith(".dmg"))
            self.assertEqual(removed, builds[:len(removed)])
            self.assertLessEqual(len(removed), 5)
            builds = [build for build in builds if build not in removed]
            runs += 1
        self.assertEqual((builds, runs), (list(range(1315, 1320)), 3))

    def test_removes_a_backlog_of_patches_oldest_first_and_their_images_meanwhile(self):
        # More patches to the oldest expired build than one run removes.
        orphans = [f"Timeline1340-{old}.delta" for old in range(1280, 1340)]
        newer = [f"Timeline1341-{old}.delta" for old in range(1331, 1341)]
        current = [f"Timeline1346-{old}.delta" for old in range(1336, 1346)]
        names = ["appcast.xml", *orphans, *newer, *current, *build_assets(*range(1340, 1347))]
        plan = prune_plan(release(names), TAG, 1346)
        self.assertEqual([name for name in plan if name.endswith(".delta")], orphans[:50])
        self.assertEqual(removed_builds(plan), [1340, 1341])
        # The next run accepts the patches whose image is gone and removes them.
        names = [name for name in names if name not in plan]
        self.assertEqual(prune_plan(release(names), TAG, 1346), orphans[50:] + newer)


class RetentionTests(unittest.TestCase):
    def plan(self, times, current=None):
        current = current or max(times)
        return removed_builds(prune_plan(release(["appcast.xml", *build_assets(*times)], times), TAG, current))

    def test_a_burst_of_short_lived_builds_keeps_only_the_newest_five(self):
        times = {build: START + timedelta(minutes=12 * index) for index, build in enumerate(range(1400, 1410))}
        self.assertEqual(self.plan(times), [1400, 1401, 1402, 1403, 1404])

    def test_keeps_a_build_that_stayed_newest_for_four_hours(self):
        times = {1400: START, 1401: START + timedelta(hours=4), **{b: START + timedelta(hours=4, minutes=10 * (b - 1401)) for b in range(1402, 1407)}}
        self.assertEqual(self.plan(times), [1401])
        times[1401] = START + timedelta(hours=3, minutes=59)
        self.assertEqual(self.plan(times), [1400, 1401])

    def test_a_quiet_weekend_keeps_fridays_last_build(self):
        friday = START + timedelta(days=1)
        times = {b: friday + timedelta(minutes=10 * (b - 1340)) for b in range(1340, 1346)}
        monday = friday + timedelta(days=2, hours=12)
        times |= {b: monday + timedelta(minutes=10 * (b - 1346)) for b in range(1346, 1351)}
        self.assertEqual(self.plan(times), [1340, 1341, 1342, 1343, 1344])
        doomed, lines = retention(release(["appcast.xml", *build_assets(*times)], times), TAG, 1350)
        self.assertIn("1345: keep: newest for 59.2 h, uploaded 2.5 days before the current build", lines)
        self.assertIn("1344: expire: newest for 0.2 h, under 4 h", lines)

    def test_a_long_lived_build_expires_three_days_after_its_upload(self):
        for age, removed in ((timedelta(days=2, hours=23), [1400]), (timedelta(days=3), [1400, 1401])):
            times = {1400: START, 1401: START + timedelta(hours=1), 1402: START + timedelta(hours=9)}
            times |= {b: times[1401] + age - timedelta(minutes=10 * (1406 - b)) for b in range(1403, 1407)}
            with self.subTest(age=age):
                self.assertEqual(self.plan(times), removed)

    def test_repeated_cleanup_still_expires_a_long_lived_build(self):
        # A build stands over a weekend, then one arrives every 3 hours and each run cleans up.
        times = {1400: START, 1401: START + timedelta(hours=64)}
        names = ["appcast.xml", *build_assets(1400, 1401)]
        for build in range(1402, 1470):
            times[build] = times[build - 1] + timedelta(hours=3)
            names += build_assets(build)
            plan = prune_plan(release(names, times), TAG, build)
            names = [name for name in names if name not in plan]
            if dmg(1400) not in names:
                # The first run after it left the newest five, and over three days after its upload.
                self.assertEqual(times[build] - START, timedelta(hours=64 + 4 * 3))
                return
        self.fail("build 1400 was never removed")

    def test_patch_sources_are_the_kept_builds(self):
        times = {b: START + timedelta(minutes=10 * (b - 1400)) for b in range(1400, 1408)}
        times[1401] = START + timedelta(minutes=5)
        times |= {b: times[1401] + timedelta(hours=5, minutes=10 * (b - 1402)) for b in range(1402, 1408)}
        self.assertEqual(kept_builds(release(["appcast.xml", *build_assets(*times)], times), TAG), [1407, 1406, 1405, 1404, 1403, 1401])

    def test_first_run_after_the_change_with_only_five_dmgs(self):
        stood_long = {1430: START, **{b: START + timedelta(hours=6, minutes=10 * (b - 1431)) for b in range(1431, 1436)}}
        self.assertEqual(self.plan(stood_long), [])
        stood_short = {1430: START, **{b: START + timedelta(minutes=30 + 10 * (b - 1431)) for b in range(1431, 1436)}}
        self.assertEqual(self.plan(stood_short), [1430])

    def test_refuses_doubtful_upload_times(self):
        times = {b: START + timedelta(minutes=10 * (b - 1400)) for b in range(1400, 1407)}
        out_of_order = {**times, 1401: times[1402] + timedelta(minutes=1)}
        with self.assertRaises(Refusal):
            self.plan(out_of_order)
        names = ["appcast.xml", *build_assets(*times)]
        broken = release(names, times)
        next(asset for asset in broken["assets"] if asset["name"] == dmg(1400))["created_at"] = "yesterday"
        with self.assertRaises(Refusal):
            prune_plan(broken, TAG, 1406)
        next(asset for asset in broken["assets"] if asset["name"] == dmg(1400))["created_at"] = "2026-11-20T09:00:00"
        with self.assertRaises(Refusal):
            prune_plan(broken, TAG, 1406)
        del next(asset for asset in broken["assets"] if asset["name"] == dmg(1400))["created_at"]
        with self.assertRaises(Refusal):
            prune_plan(broken, TAG, 1406)


def feed(build):
    return APPCAST.replace("1347", str(build))


class OfferedBuildTests(unittest.TestCase):
    def test_is_the_feed_build_when_there_is_a_feed(self):
        self.assertEqual(offered_build(release(["appcast.xml", *build_assets(1346, 1347)]), TAG, feed(1346)), 1346)

    def test_is_the_newest_dmg_without_a_feed(self):
        self.assertEqual(offered_build(release(build_assets(1345, 1346)), TAG, None), 1346)
        self.assertEqual(offered_build(release([]), TAG, None), 0)

    def test_ignores_unrecognised_assets(self):
        self.assertEqual(offered_build(release(["notes.md", dmg(1350) + ".sha256", *build_assets(1346)]), TAG, None), 1346)

    def test_refuses_another_release(self):
        for value in (release([], prerelease=False), release([], draft=True), release([], tag_name="v0.21.0")):
            with self.subTest(value=value), self.assertRaises(Refusal):
                offered_build(value, TAG, None)


class PublishActionTests(unittest.TestCase):
    def test_uploads_a_build_newer_than_everything(self):
        self.assertEqual(publish_action(release(["appcast.xml", *build_assets(1346)]), TAG, feed(1346), 1347), "upload")

    def test_retries_over_its_own_dmg_from_an_earlier_attempt(self):
        self.assertEqual(publish_action(release(["appcast.xml", *build_assets(1346, 1347)]), TAG, feed(1346), 1347), "upload")

    def test_restores_a_missing_feed_from_the_newest_build(self):
        self.assertEqual(publish_action(release(build_assets(1346, 1347)), TAG, None, 1347), "upload")

    def test_skips_the_upload_when_the_feed_already_offers_the_build(self):
        self.assertEqual(publish_action(release(["appcast.xml", *build_assets(1346, 1347)]), TAG, feed(1347), 1347), "published")

    def test_ignores_unrecognised_assets(self):
        self.assertEqual(publish_action(release(["appcast.xml", "notes.md", *build_assets(1346)]), TAG, feed(1346), 1347), "upload")

    def test_never_goes_back(self):
        cases = {
            "feed is newer": (release(["appcast.xml", *build_assets(1348)]), feed(1348)),
            "feed is newer than any DMG": (release(["appcast.xml", *build_assets(1346)]), feed(1348)),
            "a newer DMG without a feed": (release(build_assets(1348)), None),
            "a newer DMG beside the feed": (release(["appcast.xml", *build_assets(1346, 1348)]), feed(1346)),
            "stable release": (release(["appcast.xml"], prerelease=False), feed(1346)),
        }
        for name, (value, current) in cases.items():
            with self.subTest(name), self.assertRaises(Refusal):
                publish_action(value, TAG, current, 1347)


APPCAST = """<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Timeline</title>
        <item>
            <title>0.21.1-edge.1347</title>
            <sparkle:version>1347</sparkle:version>
            <sparkle:shortVersionString>0.21.1-edge.1347</sparkle:shortVersionString>
            <enclosure url="https://github.com/example/timeline/releases/download/nightly/Timeline-0.21.1-edge.1347-macos-arm64.dmg" length="1" type="application/octet-stream" sparkle:edSignature="c2lnbmF0dXJl"/>
        </item>
    </channel>
</rss>
"""
VERSION = "0.21.1-edge.1347"


class AppcastTests(unittest.TestCase):
    def test_delta_must_match_retained_source_and_local_file(self):
        name = "Timeline1347-1346.delta"
        enclosure = f'<enclosure url="https://github.com/example/timeline/releases/download/nightly/{name}" length="3" sparkle:deltaFrom="1346" sparkle:edSignature="sig"/>'
        def check(element, directory, sources=(1346,)):
            xml = APPCAST.replace("</item>", f"<sparkle:deltas>{element}</sparkle:deltas></item>")
            return check_appcast(xml, "example/timeline", TAG, VERSION, 1, directory, sources)
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / name).write_bytes(b"abc")
            self.assertEqual(check(enclosure, directory), [name])
            for invalid in (enclosure.replace("/nightly/", "/other/"), enclosure.replace('length="3"', 'length="1"'),
                            enclosure.replace('="sig"', '=""'), enclosure * 2):
                with self.subTest(invalid=invalid), self.assertRaises(Refusal):
                    check(invalid, directory)
            with self.assertRaises(Refusal):
                check(enclosure, directory, ())

    def test_stable_feed_matches_release_tag_and_bundle_build(self):
        xml = APPCAST.replace(VERSION, "0.21.1").replace("/nightly/", "/v0.21.1/")
        check_appcast(xml, "example/timeline", "v0.21.1", "0.21.1", 1, build=1347)
        for tag, build in (("v0.21.0", 1347), ("v0.21.1", 1346)):
            with self.assertRaises(Refusal):
                check_appcast(xml, "example/timeline", tag, "0.21.1", 1, build=build)

    def test_reads_the_offered_build(self):
        self.assertEqual(feed_build(APPCAST), 1347)

    def test_accepts_the_signed_edge_item(self):
        check_appcast(APPCAST, "example/timeline", TAG, VERSION, 1)

    def test_refuses_feeds_for_anything_else(self):
        cases = {
            "other build": (APPCAST, VERSION.replace("1347", "1348")),
            "other release": (APPCAST.replace("download/nightly/", "download/v0.21.0/"), VERSION),
            "other repository": (APPCAST.replace("example/timeline", "other/timeline"), VERSION),
            "unsigned": (APPCAST.replace(' sparkle:edSignature="c2lnbmF0dXJl"', ""), VERSION),
            "two items": (APPCAST.replace("</channel>", "<item/></channel>"), VERSION),
            "not a DMG": (APPCAST.replace("arm64.dmg", "arm64.zip"), VERSION),
            "stable version": (APPCAST, "0.21.0"),
            "not XML": ("<rss", VERSION),
        }
        for name, (xml, version) in cases.items():
            with self.subTest(name), self.assertRaises(Refusal):
                check_appcast(xml, "example/timeline", TAG, version, 1)
        with self.assertRaises(Refusal):
            check_appcast(APPCAST, "example/timeline", TAG, VERSION, 2)

    def test_feed_build_refuses_a_feed_without_one(self):
        for xml in (APPCAST.replace("<sparkle:version>1347</sparkle:version>", ""), APPCAST.replace(">1347</sparkle:version>", ">abc</sparkle:version>"), "<rss/>"):
            with self.subTest(xml=xml[-40:]), self.assertRaises(Refusal):
                feed_build(xml)


class CommandLineTests(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *args], capture_output=True, text=True)

    def test_prune_plan_prints_nothing_and_fails_on_bad_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "release.json")
            path.write_text(json.dumps(release(["appcast.xml", "Timeline-0.21.0-macos-arm64.dmg", *build_assets(*range(1340, 1347))])))
            result = self.run_script("prune-plan", str(path), "--tag", TAG, "--current", "1346")
            self.assertEqual((result.returncode, result.stdout), (1, ""))
            path.write_text("not json")
            result = self.run_script("prune-plan", str(path), "--tag", TAG, "--current", "1346")
            self.assertEqual((result.returncode, result.stdout), (1, ""))

    def test_prune_plan_prints_one_name_per_line(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "release.json")
            path.write_text(json.dumps(release(["appcast.xml", *build_assets(*range(1340, 1346))])))
            result = self.run_script("prune-plan", str(path), "--tag", TAG, "--current", "1345")
            self.assertEqual((result.returncode, result.stdout), (0, f"{dmg(1340)}\n{dmg(1340)}.sha256\n"))

    def test_retention_prints_each_build_and_what_it_removes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "release.json")
            path.write_text(json.dumps(release(["appcast.xml", *build_assets(*range(1340, 1346))])))
            result = self.run_script("retention", str(path), "--tag", TAG, "--current", "1345")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), [
                *[f"{build}: keep: one of the newest 5" for build in range(1345, 1340, -1)],
                "1340: expire: newest for 0.2 h, under 4 h",
                f"remove {dmg(1340)}", f"remove {dmg(1340)}.sha256",
            ])

    def test_version_command(self):
        self.assertEqual(self.run_script("version", "0.21.0", "1347").stdout, "0.21.1-edge.1347\n")


if __name__ == "__main__":
    unittest.main()
