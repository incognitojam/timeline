#!/usr/bin/env python3
"""Name edge builds, check their update feed, and choose old DMGs to remove.

Every edge build lives in one rolling prerelease: its `appcast.xml` and the
DMGs of the newest builds. Removing old DMGs and patches is the only
deletion; the plan reads that one release and refuses the whole plan (raising
Refusal, so the caller deletes nothing) on anything it does not fully recognise.
"""

import argparse
from datetime import datetime, timedelta
import json
import os
import re
from pathlib import Path
import sys
import xml.etree.ElementTree as ElementTree


STABLE_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
EDGE_VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-edge\.([1-9][0-9]*)"
# The DMG package-dmg.sh writes for an edge version on Apple silicon, and its checksum.
BUILD_DMG = re.compile(rf"Timeline-{EDGE_VERSION}-macos-arm64\.dmg")
DELTA = re.compile(r"Timeline([1-9][0-9]*)-([1-9][0-9]*)\.delta")
CHECKSUM = ".sha256"
FEED_FILE = "appcast.xml"
KEEP_BUILDS = 5
# Besides the newest builds, keep each build uploaded less than RECENT before
# the current one that stayed the newest for at least LONG_LIVED: Macs check
# hourly, so a Mac that was off for a few days is most likely on one of those.
LONG_LIVED = timedelta(hours=4)
RECENT = timedelta(days=3)
# Patch sources per build, newest first, bounding the macOS time they take.
MAX_PATCH_SOURCES = 20
# A normal build removes one DMG and its checksum and the previous build's
# patches. A backlog, after a missed cleanup or fewer kept builds, is removed
# oldest first over several runs rather than refused.
MAX_EXPIRED_BUILDS = 5
MAX_SUPERSEDED_PATCHES = 50
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"


class Refusal(Exception):
    """Input this script does not fully recognise; act on none of it."""


def edge_version(stable_version: str, build: str) -> str:
    """Name the edge build `build` of a checkout whose package.json has `stable_version`.

    The next patch version keeps it after the current stable and before any
    later stable in semver order; the build number keeps each build distinct.
    """
    match = STABLE_VERSION.fullmatch(stable_version)
    if not match:
        raise Refusal(f"package.json version is not a stable x.y.z version: {stable_version!r}")
    if not re.fullmatch(r"[1-9][0-9]*", build):
        raise Refusal(f"build number must be a positive integer: {build!r}")
    major, minor, patch = (int(part) for part in match.groups())
    return f"{major}.{minor}.{patch + 1}-edge.{build}"


def _item(xml: str) -> ElementTree.Element:
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as error:
        raise Refusal(f"appcast is not valid XML: {error}") from error
    items = root.findall("./channel/item")
    if root.tag != "rss" or len(items) != 1:
        raise Refusal(f"appcast must be an RSS feed with one item, found {len(items)}")
    return items[0]


def feed_build(xml: str) -> int:
    """Return the build number the feed offers."""
    build = (_item(xml).findtext(f"{SPARKLE}version") or "").strip()
    if not re.fullmatch(r"[1-9][0-9]*", build):
        raise Refusal(f"appcast item has no build number: {build!r}")
    return int(build)


def check_appcast(xml: str, repository: str, release_tag: str, version: str, dmg_size: int, directory=None, sources=(), build=None) -> list[str]:
    """Require a feed whose one signed item is `version`'s DMG, of `dmg_size` bytes, on the rolling release.

    Sparkle checks only that an item is signed with the app's key and newer
    than the running build, so a validly signed feed for the wrong build would
    still be offered. This runs before the feed is replaced.
    """
    match = re.fullmatch(EDGE_VERSION, version)
    if match:
        build = int(match[1])
    elif not STABLE_VERSION.fullmatch(version) or release_tag != f"v{version}" or build is None:
        raise Refusal(f"unexpected release version: {version!r}")
    item = _item(xml)
    if feed_build(xml) != build:
        raise Refusal(f"appcast item is not build {build}")
    if (item.findtext(f"{SPARKLE}shortVersionString") or "").strip() != version:
        raise Refusal(f"appcast item is not version {version}")
    enclosures = item.findall("enclosure")
    if len(enclosures) != 1:
        raise Refusal("appcast item must have one enclosure")
    expected = f"https://github.com/{repository}/releases/download/{release_tag}/Timeline-{version}-macos-arm64.dmg"
    if enclosures[0].get("url") != expected:
        raise Refusal(f"appcast download is {enclosures[0].get('url')!r}, not {expected}")
    if enclosures[0].get("length") != str(dmg_size):
        raise Refusal(f"appcast length {enclosures[0].get('length')!r} is not the DMG's {dmg_size} bytes")
    if not enclosures[0].get(f"{SPARKLE}edSignature"):
        raise Refusal("appcast download has no EdDSA signature")

    patches = []
    for enclosure in item.findall(f"{SPARKLE}deltas/enclosure"):
        old = enclosure.get(f"{SPARKLE}deltaFrom", "")
        if not re.fullmatch(r"[1-9][0-9]*", old) or int(old) not in sources or int(old) >= build:
            raise Refusal(f"unexpected delta source {old!r}")
        name = f"Timeline{build}-{old}.delta"
        if name in patches or enclosure.get("url") != expected.rsplit("/", 1)[0] + "/" + name:
            raise Refusal(f"duplicate or incorrect delta URL for {name}")
        size = (directory / name).stat().st_size
        if not size or enclosure.get("length") != str(size) or not enclosure.get(f"{SPARKLE}edSignature", "").strip():
            raise Refusal(f"incorrect length or missing signature for {name}")
        patches.append(name)
    return patches


def _asset_names(release: object, release_tag: str) -> list[str]:
    """Asset names of `release`, which must be the published rolling prerelease."""
    if not isinstance(release, dict):
        raise Refusal("the release is not an object")
    if release.get("tag_name") != release_tag:
        raise Refusal(f"expected release {release_tag}, got {release.get('tag_name')!r}")
    if release.get("prerelease") is not True or release.get("draft") is not False:
        raise Refusal(f"{release_tag} is not a published prerelease")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise Refusal("the release has no asset list")
    names = []
    for asset in assets:
        name = asset.get("name") if isinstance(asset, dict) else None
        if not isinstance(name, str) or not name:
            raise Refusal("an asset has no name")
        if name in names:
            raise Refusal(f"more than one asset is named {name}")
        names.append(name)
    return names


def _dmg_builds(names: list[str]) -> dict[str, int]:
    builds = {}
    for name in names:
        match = BUILD_DMG.fullmatch(name)
        if match:
            builds[name] = int(match.group(1))
    if len(set(builds.values())) != len(builds):
        raise Refusal("more than one DMG has the same build number")
    return builds


def offered_build(release: object, release_tag: str, feed: str | None) -> int:
    """The build the rolling release offers: the feed's, or without a feed its newest DMG's (0 for none).

    Without a feed, the newest DMG may never have been offered, but nothing
    older may be offered again.
    """
    builds = _dmg_builds(_asset_names(release, release_tag)).values()
    return feed_build(feed) if feed is not None else max(builds, default=0)


def publish_action(release: object, release_tag: str, feed: str | None, build: int) -> str:
    """Return "published" if the feed already offers `build`, or "upload" if `build` may replace it.

    Newest wins: refuse unless `build` is newer than the feed and than every
    other edge DMG on the release, so neither a late retry nor a restored feed
    can offer an older build. Assets other than edge DMGs are ignored here.
    """
    others = [other for other in _dmg_builds(_asset_names(release, release_tag)).values() if other != build]
    offered = feed_build(feed) if feed is not None else None
    if others and max(others) > build:
        raise Refusal(f"build {max(others)} is already on {release_tag}; build {build} is older")
    if offered == build:
        return "published"
    if offered is not None and offered > build:
        raise Refusal(f"the feed already offers build {offered}; build {build} is older")
    return "upload"


def _uploaded(release: object, name: str) -> datetime:
    """When the asset `name`, which `_asset_names` found on `release`, was uploaded."""
    asset = next(asset for asset in release["assets"] if asset["name"] == name)
    try:
        uploaded = datetime.fromisoformat(asset["created_at"])
    except (KeyError, TypeError, ValueError) as error:
        raise Refusal(f"{name} has no upload time") from error
    if uploaded.tzinfo is None:
        raise Refusal(f"{name}'s upload time has no time zone")
    return uploaded


def retention(release: object, release_tag: str, current: int) -> tuple[list[str], list[str]]:
    """Return what `prune_plan` deletes, and a line per edge build saying whether the rule keeps it and why."""
    doomed = prune_plan(release, release_tag, current)
    reasons = _reasons(release, _dmg_builds(_asset_names(release, release_tag)))
    return doomed, [f"{build}: {reason}" for build, (_, reason) in sorted(reasons.items(), reverse=True)]


def _reasons(release: object, builds: dict[str, int]) -> dict[int, tuple[str, str]]:
    """Map each build to its DMG and the reason it is kept or expired, by the retention rule.

    How long a build stayed the newest is measured to the next newer DMG still
    on the release. That is exact when the build first leaves the newest
    builds, and later only ever longer, so the decision then stands.
    """
    newest_first = sorted(((build, dmg) for dmg, build in builds.items()), reverse=True)
    uploaded = {build: _uploaded(release, dmg) for build, dmg in newest_first}
    now = uploaded[newest_first[0][0]] if newest_first else None
    reasons = {}
    for index, (build, dmg) in enumerate(newest_first):
        if index < KEEP_BUILDS:
            reasons[build] = (dmg, f"keep: one of the newest {KEEP_BUILDS}")
            continue
        stood, age = uploaded[newest_first[index - 1][0]] - uploaded[build], now - uploaded[build]
        if stood < timedelta(0):
            raise Refusal(f"build {build} was uploaded after the newer build {newest_first[index - 1][0]}")
        hours, days = stood / timedelta(hours=1), age / timedelta(days=1)
        if age >= RECENT:
            reasons[build] = (dmg, f"expire: uploaded {days:.1f} days before the current build, {RECENT.days} or more")
        elif stood < LONG_LIVED:
            reasons[build] = (dmg, f"expire: newest for {hours:.1f} h, under {LONG_LIVED / timedelta(hours=1):g} h")
        else:
            reasons[build] = (dmg, f"keep: newest for {hours:.1f} h, uploaded {days:.1f} days before the current build")
    return reasons


def kept_builds(release: object, release_tag: str) -> list[int]:
    """The edge builds on `release` that the retention rule keeps, newest first."""
    reasons = _reasons(release, _dmg_builds(_asset_names(release, release_tag)))
    return [build for build, (_, reason) in sorted(reasons.items(), reverse=True) if reason.startswith("keep")]


def prune_plan(release: object, release_tag: str, current: int) -> list[str]:
    """Return the asset names to delete from the rolling release, oldest build first.

    `release` is the GitHub release object for `release_tag`, read after the
    feed was switched to build `current`. It must be that published
    prerelease and hold the feed plus edge DMGs, each with its checksum, the
    newest being `current`. The DMGs the retention rule keeps and their
    checksums stay, as do the patches to `current`, the only ones the feed offers. At
    most `MAX_EXPIRED_BUILDS` DMGs and `MAX_SUPERSEDED_PATCHES` patches go per
    run, oldest first.
    """
    names = _asset_names(release, release_tag)
    if FEED_FILE not in names:
        raise Refusal(f"the release has no {FEED_FILE}")
    builds = _dmg_builds(names)
    old_patches = []
    for name in names:
        patch = DELTA.fullmatch(name)
        # A patch to a build whose DMG an earlier run removed is superseded too.
        if patch and int(patch[2]) < int(patch[1]) and (int(patch[1]) in builds.values() or int(patch[1]) < current):
            if int(patch[1]) != current:
                old_patches.append((int(patch[1]), int(patch[2]), name))
            continue
        if name != FEED_FILE and name not in builds and name.removesuffix(CHECKSUM) not in builds:
            raise Refusal(f"unexpected asset {name!r}")
    for dmg in builds:
        if dmg + CHECKSUM not in names:
            raise Refusal(f"{dmg} has no checksum")
    if max(builds.values(), default=None) != current:
        raise Refusal(f"the newest DMG on {release_tag} is not build {current}")
    doomed = [name for _, _, name in sorted(old_patches)[:MAX_SUPERSEDED_PATCHES]]
    expired = sorted((build, dmg) for build, (dmg, reason) in _reasons(release, builds).items() if reason.startswith("expire"))
    for _, dmg in expired[:MAX_EXPIRED_BUILDS]:
        doomed += [dmg, dmg + CHECKSUM]
    return doomed


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as file:
        return file.read()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    version_command = commands.add_parser("version", help="print the edge version for a package.json version and build")
    version_command.add_argument("stable_version")
    version_command.add_argument("build")
    feed_command = commands.add_parser("check-appcast", help="validate a new edge feed against its DMG")
    feed_command.add_argument("appcast")
    feed_command.add_argument("--repository", required=True)
    feed_command.add_argument("--tag", required=True, help="the rolling release's tag")
    feed_command.add_argument("--version", required=True)
    feed_command.add_argument("--dmg", required=True, help="the DMG the feed must describe")
    feed_command.add_argument("--build-sources", nargs="*", type=int, default=[])
    release_help = "gh api output for the rolling release"
    offered_command = commands.add_parser("offered-build", help="print the build the rolling release offers")
    offered_command.add_argument("release", help=release_help)
    offered_command.add_argument("--tag", required=True, help="the rolling release's tag")
    offered_command.add_argument("--feed", help="its current appcast.xml, if it has one")
    action_command = commands.add_parser("publish-action", help="print upload or published for a build, or refuse")
    action_command.add_argument("release", help=release_help)
    action_command.add_argument("--tag", required=True, help="the rolling release's tag")
    action_command.add_argument("--feed", help="its current appcast.xml, if it has one")
    action_command.add_argument("--build", required=True, type=int)
    prune_command = commands.add_parser("prune-plan", help="print asset names to delete, one per line")
    prune_command.add_argument("release", help=release_help)
    prune_command.add_argument("--tag", required=True, help="the rolling release's tag")
    prune_command.add_argument("--current", required=True, type=int, help="the build the feed now offers")
    retention_command = commands.add_parser("retention", help="print each edge build with whether it stays and why, then what prune-plan deletes")
    retention_command.add_argument("release", help=release_help)
    retention_command.add_argument("--tag", required=True, help="the rolling release's tag")
    retention_command.add_argument("--current", required=True, type=int, help="the build the feed offers after this build")
    args = parser.parse_args(argv)
    try:
        if args.command == "version":
            print(edge_version(args.stable_version, args.build))
        elif args.command == "check-appcast":
            patches = check_appcast(_read(args.appcast), args.repository, args.tag, args.version, os.path.getsize(args.dmg), Path(args.dmg).parent, args.build_sources)
            for name in patches:
                print(name)
        else:
            release = json.loads(_read(args.release))
            if args.command == "offered-build":
                print(offered_build(release, args.tag, _read(args.feed) if args.feed else None))
            elif args.command == "publish-action":
                print(publish_action(release, args.tag, _read(args.feed) if args.feed else None, args.build))
            elif args.command == "retention":
                doomed, decisions = retention(release, args.tag, args.current)
                for line in decisions:
                    print(line)
                for name in doomed:
                    print(f"remove {name}")
            else:
                for name in prune_plan(release, args.tag, args.current):
                    print(name)
    except (Refusal, OSError, json.JSONDecodeError) as error:
        print(f"edge_build: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
