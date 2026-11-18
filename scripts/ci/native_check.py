#!/usr/bin/env python3
"""Decide whether a PR needs Darwin coverage; uncertainty always requests it."""

import os
from pathlib import Path
import re
import subprocess
import sys


# Most src/ and web/ changes use Linux; Darwin-only code and dependency pins
# below are narrow exceptions. Keep the exact policy beside the detector.
NATIVE_DIRECTORIES = (
    "tools/timeline-app/",       # Swift, plists, Sparkle, signing and DMG assets
    "tools/timeline-gmessages/", # Darwin sidecar and its Go dependencies
    "tools/timeline-recall/",    # Capture tools and the local signing identity
    "deploy/macos/",            # Files copied into the app and launchd helpers
    "scripts/artifact/",        # Packaged launchers and environment handling
    "scripts/sqlite/",          # Native macOS library builder and verification
    "scripts/ci/",              # Changes to this coverage decision must run on Mac
    ".github/workflows/",
    ".github/actions/",
)
NATIVE_FILES = {
    "mise.toml",
    "bunfig.toml",              # Installation policy also affects native packages
    "package.json",             # Bun pin and native runtime dependencies
    "bun.lock",                 # Includes Darwin Sharp/libvips/sqlite-vec packages
    "bun.lockb",
    "web/package.json",         # Darwin esbuild/Rollup/Tailwind binaries
    "web/bun.lock",
    "web/bun.lockb",
    "web/bunfig.toml",
    "src/lib/background-priority.ts", # Darwin FFI runs during worker startup
    "scripts/build-service-artifact.ts",
    "scripts/smoke-service-artifact.sh",
    "scripts/smoke-service.sh",
    "scripts/print-build-number.sh",
    "scripts/print-product-version.ts",
    "scripts/sync-product-version.ts",
    "scripts/check-product-version.ts",
    "scripts/toolchain.sh",
}


def native_path(path: str) -> bool:
    return path in NATIVE_FILES or path.startswith(NATIVE_DIRECTORIES)


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=30,
    ).stdout


def detect(base: str, head: str, root: Path) -> tuple[bool, str]:
    try:
        if not all(re.fullmatch(r"[0-9a-fA-F]{40}", sha) for sha in (base, head)):
            raise ValueError("expected full base and head commit SHAs")
        bases = git(root, "merge-base", "--all", base, head).splitlines()
        if len(bases) != 1:
            raise ValueError("no unambiguous merge base")
        # Disable rename detection so moving OUT of a native directory still
        # includes the deleted native path. NUL delimiters preserve odd filenames.
        changed = git(root, "diff", "--name-only", "--no-renames", "-z",
                      bases[0].decode("ascii"), head, "--")
        if changed and not changed.endswith(b"\0"):
            raise ValueError("incomplete changed-path output")
        paths = changed.decode("utf-8").split("\0")
        matches = [path for path in paths if path and native_path(path)]
        if matches:
            return True, f"{len(matches)} native path(s) changed"
        return False, "complete diff contains no native paths"
    except (OSError, subprocess.SubprocessError, ValueError, UnicodeError) as error:
        return True, f"could not determine changed paths ({type(error).__name__})"


def main() -> None:
    if len(sys.argv) == 3:
        required, reason = detect(sys.argv[1], sys.argv[2], Path.cwd())
    else:
        required, reason = True, "expected base and head arguments"
    decision = f"required={str(required).lower()}"
    print(f"Native check: {decision}; {reason}")
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(decision + "\n")


if __name__ == "__main__":
    main()
