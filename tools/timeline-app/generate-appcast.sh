#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
APP="${TIMELINE_UPDATE_APP_BUNDLE:-$PWD/Timeline.app}"
PLIST="$APP/Contents/Info.plist"
if ! /usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$PLIST" >/dev/null 2>&1; then
  if [ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]; then
    echo 'Update signing is configured but native updates are disabled in the app.' >&2
    exit 1
  fi
  echo 'Manual distribution: no native update feed generated.'
  exit 0
fi
: "${SPARKLE_ED_PRIVATE_KEY:?Set the Sparkle update signing secret}"
: "${GH_REPO:?Set the GitHub release repository}"
: "${RELEASE_TAG:?Set the release tag}"
source "$PWD/sparkle.sh"
public_key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$PLIST")"
bun run update-key.ts "$public_key"
output="${TIMELINE_UPDATE_OUTPUT:-$REPO_ROOT/dist/macos}"
printf '%s\n' "$SPARKLE_ED_PRIVATE_KEY" | "$SPARKLE_ROOT/bin/generate_appcast" \
  --ed-key-file - --maximum-deltas 0 --maximum-versions 1 \
  --download-url-prefix "https://github.com/$GH_REPO/releases/download/$RELEASE_TAG/" \
  --link "https://github.com/$GH_REPO/releases/tag/$RELEASE_TAG" \
  --full-release-notes-url "https://github.com/$GH_REPO/releases/tag/$RELEASE_TAG" \
  -o "$output/appcast.xml" "$output"
test -s "$output/appcast.xml"
grep -q 'sparkle:edSignature=' "$output/appcast.xml"
echo 'Signed update feed ready.'
