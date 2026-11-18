#!/usr/bin/env python3
"""Name nightly prereleases, check their update feeds, and choose old ones to prune.

Pruning deletes releases and tags. It acts only on the release list it is
given, and refuses the whole plan (raising Refusal, so the caller deletes
nothing) when an entry is malformed or contradictory: a missing or duplicate
tag, a nightly-named release that is not a prerelease, or a date in the
future. It cannot tell that a well-formed list is incomplete; a missing
release can only make it delete less, because it deletes nothing that is not
listed, keeps the newest listed nightlies, and never deletes a young one.
"""

import argparse
from datetime import date, datetime, timedelta, timezone
import json
import re
import sys
import xml.etree.ElementTree as ElementTree


NIGHTLY_TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-nightly\.([0-9]{8})")
STABLE_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
KEEP_DAYS = 14
KEEP_MIN = 3
# A normal night prunes one release; far more means something is wrong.
MAX_DELETIONS = 30
# Tag dates are UTC build dates; allow a day for clocks and time zones.
FUTURE_TOLERANCE = timedelta(days=1)
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"


class Refusal(Exception):
    """Input this script does not fully understand; act on none of it."""


def nightly_tag(stable_version: str, day: date) -> str:
    """Name the nightly built on `day` from a checkout whose package.json has `stable_version`.

    The next patch version keeps the nightly after the current stable and
    before any later stable in semver order.
    """
    match = STABLE_VERSION.fullmatch(stable_version)
    if not match:
        raise Refusal(f"package.json version is not a stable x.y.z version: {stable_version!r}")
    major, minor, patch = (int(part) for part in match.groups())
    return f"v{major}.{minor}.{patch + 1}-nightly.{day:%Y%m%d}"


def _tag_date(tag: str) -> date:
    match = NIGHTLY_TAG.fullmatch(tag)
    if not match:
        raise Refusal(f"not a nightly tag: {tag!r}")
    try:
        return datetime.strptime(match.group(4), "%Y%m%d").date()
    except ValueError as error:
        raise Refusal(f"nightly tag has an invalid date: {tag!r}") from error


def _timestamp(value: object, tag: str) -> datetime:
    if not isinstance(value, str):
        raise Refusal(f"{tag} has no publication time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise Refusal(f"{tag} has an invalid publication time: {value!r}") from error
    if parsed.tzinfo is None:
        raise Refusal(f"{tag} publication time has no time zone: {value!r}")
    return parsed


def _published_nightlies(pages: object, now: datetime) -> list[tuple[date, datetime, str]]:
    """Published nightly prereleases from `gh api --paginate --slurp` output, newest first.

    Newest means the latest tag date (the UTC build date), then the latest
    publication time. Only exact nightly tags count; drafts are left out.
    """
    if not isinstance(pages, list) or not all(isinstance(page, list) for page in pages):
        raise Refusal("expected a list of release pages")
    seen: set[str] = set()
    nightlies = []
    for release in (release for page in pages for release in page):
        if not isinstance(release, dict):
            raise Refusal("a release is not an object")
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not tag:
            raise Refusal("a release has no tag name")
        if tag in seen:
            raise Refusal(f"more than one release uses tag {tag}")
        seen.add(tag)
        for field in ("draft", "prerelease"):
            if not isinstance(release.get(field), bool):
                raise Refusal(f"{tag} has no boolean {field} field")
        if not NIGHTLY_TAG.fullmatch(tag) or release["draft"]:
            continue
        if not release["prerelease"]:
            raise Refusal(f"{tag} is named like a nightly but is not a prerelease")
        built = _tag_date(tag)
        published = _timestamp(release.get("published_at"), tag)
        if built > (now + FUTURE_TOLERANCE).date() or published > now + FUTURE_TOLERANCE:
            raise Refusal(f"{tag} is dated in the future (published {published.isoformat()})")
        nightlies.append((built, published, tag))
    return sorted(nightlies, reverse=True)


def latest_nightly(pages: object, now: datetime) -> str | None:
    """Return the newest published nightly tag, or None when there is none yet."""
    nightlies = _published_nightlies(pages, now)
    return nightlies[0][2] if nightlies else None


def prune_plan(pages: object, now: datetime, newest: str) -> list[str]:
    """Return the nightly tags to delete, oldest first.

    `newest` is the nightly just published; the list must agree, which shows
    it is current. The newest `KEEP_MIN` always stay, and of the rest only
    those published more than `KEEP_DAYS` ago go.
    """
    if now.tzinfo is None:
        raise Refusal("the current time has no time zone")
    nightlies = _published_nightlies(pages, now)
    if not nightlies or nightlies[0][2] != newest:
        raise Refusal(f"the release list does not show {newest} as the newest nightly")
    cutoff = now - timedelta(days=KEEP_DAYS)
    doomed = [tag for _, published, tag in nightlies[KEEP_MIN:] if published < cutoff]
    if len(doomed) > MAX_DELETIONS:
        raise Refusal(f"refusing to delete {len(doomed)} nightlies at once (limit {MAX_DELETIONS})")
    return list(reversed(doomed))


def check_appcast(xml: str, repository: str, tag: str, build: str) -> None:
    """Require a feed whose one signed item is the DMG on `tag` at `build`.

    Sparkle checks only that an item is signed with the app's key and newer
    than the running build, so a validly signed feed for the wrong release
    would still be offered. This runs before the feed is replaced.
    """
    _tag_date(tag)
    if not re.fullmatch(r"[0-9]+", build):
        raise Refusal(f"build number must be digits: {build!r}")
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as error:
        raise Refusal(f"appcast is not valid XML: {error}") from error
    items = root.findall("./channel/item")
    if root.tag != "rss" or len(items) != 1:
        raise Refusal(f"appcast must be an RSS feed with one item, found {len(items)}")
    item = items[0]
    if (item.findtext(f"{SPARKLE}version") or "").strip() != build:
        raise Refusal(f"appcast item is not build {build}")
    if (item.findtext(f"{SPARKLE}shortVersionString") or "").strip() != tag.removeprefix("v"):
        raise Refusal(f"appcast item is not version {tag.removeprefix('v')}")
    enclosures = item.findall("enclosure")
    if len(enclosures) != 1:
        raise Refusal("appcast item must have one enclosure")
    url = enclosures[0].get("url", "")
    prefix = f"https://github.com/{repository}/releases/download/{tag}/"
    if not url.startswith(prefix) or not url.endswith(".dmg") or "/" in url.removeprefix(prefix):
        raise Refusal(f"appcast download is not a DMG on {tag}: {url}")
    if not enclosures[0].get(f"{SPARKLE}edSignature"):
        raise Refusal("appcast download has no EdDSA signature")


def _load(path: str) -> object:
    with open(path, encoding="utf-8") as file:
        return json.load(file)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("tag", help="print today's nightly tag for a package.json version").add_argument("version")
    commands.add_parser("check-tag", help="fail unless the tag is a nightly tag").add_argument("tag")
    releases_help = "gh api --paginate --slurp output for the releases endpoint"
    commands.add_parser("latest-nightly", help="print the newest published nightly tag, if any").add_argument("releases", help=releases_help)
    prune_command = commands.add_parser("prune-plan", help="print nightly tags to delete, one per line")
    prune_command.add_argument("releases", help=releases_help)
    prune_command.add_argument("--newest", required=True, help="the nightly just published")
    feed_command = commands.add_parser("check-appcast", help="validate a nightly appcast")
    feed_command.add_argument("appcast")
    feed_command.add_argument("--repository", required=True)
    feed_command.add_argument("--tag", required=True)
    feed_command.add_argument("--build", required=True)
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    try:
        if args.command == "tag":
            print(nightly_tag(args.version, now.date()))
        elif args.command == "check-tag":
            _tag_date(args.tag)
        elif args.command == "latest-nightly":
            print(latest_nightly(_load(args.releases), now) or "")
        elif args.command == "prune-plan":
            for tag in prune_plan(_load(args.releases), now, args.newest):
                print(tag)
        else:
            with open(args.appcast, encoding="utf-8") as file:
                check_appcast(file.read(), args.repository, args.tag, args.build)
    except (Refusal, OSError, json.JSONDecodeError) as error:
        print(f"nightly_release: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
