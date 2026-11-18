#!/usr/bin/env bash
# Prints CFBundleVersion for app and service builds of HEAD, or of the revision
# given as the only argument: the commit count, plus the 1,128 commits whose
# history was squashed into this repository's first commit. Builds shipped from
# that history reached 1111 (v0.11.0), so numbers keep rising.
set -euo pipefail

imported_commits=1128
commits="$(git rev-list --count "${1:-HEAD}")"
echo $(( commits + imported_commits ))
