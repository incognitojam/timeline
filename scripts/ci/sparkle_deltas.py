"""Stage published source DMGs for Sparkle, then promote only a validated feed."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from edge_build import BUILD_DMG, KEEP_BUILDS, STABLE_VERSION, check_appcast


def read(*args):
    return subprocess.check_output(args, text=True).strip()


def sources(tag, current):
    """The edge DMGs retained after upload and the last stable DMG."""
    repo = os.environ["GH_REPO"]
    if tag.startswith("v"):
        if not STABLE_VERSION.fullmatch(tag[1:]):
            return
        tags = read("gh", "api", "--paginate", f"repos/{repo}/releases", "--jq",
                    '.[] | select(.draft == false and .prerelease == false) | .tag_name').splitlines()
        versions = [tuple(map(int, candidate[1:].split("."))) for candidate in tags
                    if candidate.startswith("v") and STABLE_VERSION.fullmatch(candidate[1:])]
        target = tuple(map(int, tag[1:].split(".")))
        previous = max((v for v in versions if v < target), default=None)
        if previous is None:
            return
        stable = "v" + ".".join(map(str, previous))
    else:
        release = json.loads(read("gh", "api", f"repos/{os.environ['GH_REPO']}/releases/tags/{tag}"))
        edges = []
        for asset in release["assets"]:
            match = BUILD_DMG.fullmatch(asset["name"])
            if match and asset["state"] == "uploaded" and int(match[1]) < current:
                edges.append((int(match[1]), tag, asset["name"]))
        yield from sorted(edges, reverse=True)[:KEEP_BUILDS - 1]
        stable = read("gh", "api", f"repos/{os.environ['GH_REPO']}/releases/latest", "--jq", ".tag_name")
    if stable.startswith("v") and STABLE_VERSION.fullmatch(stable[1:]):
        build = int(read("scripts/print-build-number.sh", stable))
        if build < current:
            yield build, stable, f"Timeline-{stable[1:]}-macos-arm64.dmg"


def generate(output, stage, version, build):
    tag = os.environ["RELEASE_TAG"]
    dmg = f"Timeline-{version}-macos-arm64.dmg"
    shutil.copyfile(output / dmg, stage / dmg)
    candidates = {}
    try:
        for old, source_tag, name in sources(tag, build):
            try:
                subprocess.run(["gh", "release", "download", source_tag, "--pattern", name, "--dir", stage], check=True)
            except subprocess.CalledProcessError:
                (stage / name).unlink(missing_ok=True)
                print(f"::warning::Skipping delta from {old}: download failed")
                continue
            candidates[old] = name
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"::warning::Incomplete delta source list: {error}")
    if not candidates:
        return
    subprocess.run(["tools/timeline-app/generate-appcast.sh", str(build), str(len(candidates))],
                   env={**os.environ, "TIMELINE_UPDATE_OUTPUT": str(stage)}, check=True)
    feed = stage / "appcast.xml"
    patches = check_appcast(feed.read_text(), os.environ["GH_REPO"], tag, version,
                            (output / dmg).stat().st_size, stage, candidates, build)
    for old in candidates:
        if f"Timeline{build}-{old}.delta" not in patches:
            print(f"::warning::Sparkle omitted delta from build {old}")
    for name in patches:
        (stage / name).replace(output / name)
    feed.replace(output / "appcast.xml")


if __name__ == "__main__":
    if sys.argv[1] == "sources":
        for build, _, _ in sources(sys.argv[2], int(sys.argv[3])):
            print(build)
        sys.exit(0)
    with tempfile.TemporaryDirectory(dir=os.environ["RUNNER_TEMP"]) as directory:
        generate(Path("dist/macos"), Path(directory), sys.argv[1], int(sys.argv[2]))
