#!/usr/bin/env python3
"""Write release notes for an edge build from the changesets at its commit.

The changesets present at a commit are the changes since the last stable
release, because releasing deletes them. Nothing here changes a changeset.
"""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import subprocess
import sys


BUILD_NUMBER = Path(__file__).resolve().parents[1] / "print-build-number.sh"
FRONT_MATTER = re.compile(r"---\n(.*?)\n?---\n?(.*)", re.DOTALL)
PACKAGE_BUMP = re.compile(r'"[^"]+":\s*(major|minor|patch)')
PULL_REQUEST = re.compile(r"\(#([0-9]+)\)$")
BUMPS = ("major", "minor", "patch")


@dataclass
class Change:
    bump: str
    text: str
    build: int
    pull_request: str | None


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True, timeout=30).stdout


def _mainline_build(repo: Path, added: str, mainline: list[str]) -> int:
    """The build number of the first commit on `mainline` (newest first) that contains `added`.

    Builds are numbered along main, so a change merged from a side branch
    arrives with its merge, not at its own commit's number.
    """
    if added not in mainline:
        def contains(index: int) -> bool:
            result = subprocess.run(["git", "merge-base", "--is-ancestor", added, mainline[index]], cwd=repo, timeout=30)
            if result.returncode > 1:
                raise ValueError(f"cannot tell whether {mainline[index]} contains {added}")
            return result.returncode == 0
        newest, oldest = 0, len(mainline) - 1
        if not contains(newest):
            raise ValueError(f"{added} is not in the build")
        while newest < oldest:
            middle = (newest + oldest + 1) // 2
            newest, oldest = (middle, oldest) if contains(middle) else (newest, middle - 1)
        added = mainline[newest]
    return int(subprocess.run([str(BUILD_NUMBER), added], cwd=repo, check=True, capture_output=True, text=True, timeout=30).stdout)


def changes(repo: Path, commit: str) -> list[Change]:
    """The user-visible changesets at `commit`, newest first; empty ones are skipped."""
    found = []
    mainline = git(repo, "rev-list", "--first-parent", commit).split()
    for path in git(repo, "ls-tree", "--name-only", commit, ".changeset/").splitlines():
        if not path.endswith(".md") or path == ".changeset/README.md":
            continue
        match = FRONT_MATTER.fullmatch(git(repo, "show", f"{commit}:{path}"))
        if not match:
            raise ValueError(f"{path} has no front matter")
        bumps = PACKAGE_BUMP.findall(match[1])
        text = match[2].strip()
        if not bumps or not text:
            continue
        added, subject = git(repo, "log", "-1", "--diff-filter=A", "--format=%H%x00%s", commit, "--", path).strip().split("\0", 1)
        build = _mainline_build(repo, added, mainline)
        number = PULL_REQUEST.search(subject)
        found.append(Change(min(bumps, key=BUMPS.index), text, build, number[1] if number else None))
    return sorted(found, key=lambda change: -change.build)


def markdown(found: list[Change], previous_build: int, stable: str) -> str:
    new = [change for change in found if change.build > previous_build]
    older = [change for change in found if change.build <= previous_build]
    if not found:
        return f"No user-visible changes since {stable}.\n"

    def section(title: str, entries: list[Change]) -> list[str]:
        lines = [f"## {title}", ""]
        for bump in BUMPS:
            group = [change for change in entries if change.bump == bump]
            if group:
                lines += [f"### {bump.capitalize()} Changes", ""]
                for change in group:
                    suffix = f" (#{change.pull_request})" if change.pull_request else ""
                    lines.append("- " + (change.text + suffix).replace("\n", "\n  ").replace("\n  \n", "\n\n"))
                lines.append("")
        return lines

    lines = section("New in this build", new) if new else ["## New in this build", "", "No user-visible changes in this build.", ""]
    if older:
        lines += section(f"Also unreleased since {stable}", older)
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit")
    parser.add_argument("--previous-build", required=True, type=int, help="the edge build the feed offered before this one")
    parser.add_argument("--repo", default=".", type=Path)
    args = parser.parse_args(argv)
    # The one deliberate exception to failing fast: notes only describe a
    # build, so a missing or broken note must never hold back an update.
    try:
        stable = json.loads(git(args.repo, "show", f"{args.commit}:package.json"))["version"]
        print(markdown(changes(args.repo, args.commit), args.previous_build, stable), end="")
    except Exception as error:  # noqa: BLE001 - see above
        print(f"edge_notes: {error}", file=sys.stderr)
        print("Notes unavailable.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
