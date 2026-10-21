#!/usr/bin/env bash
# Prints CFBundleVersion for distribution builds: the commit count, plus the
# 1,128 commits whose history was squashed into this repository's first commit.
# Builds shipped from that history reached 1111 (v0.11.0), so numbers keep rising.
set -euo pipefail

imported_commits=1128
echo $(( $(git rev-list --count HEAD) + imported_commits ))
