#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
APP="${TIMELINE_UPDATE_APP_BUNDLE:-$PWD/Timeline.app}"
PLIST="$APP/Contents/Info.plist"
: "${SPARKLE_ED_PRIVATE_KEY:?Set the Sparkle update signing secret}"
: "${GH_REPO:?Set the GitHub release repository}"
: "${RELEASE_TAG:?Set the release tag}"
source "$PWD/sparkle.sh"
public_key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$PLIST")"
bun run update-key.ts "$public_key"
output="${TIMELINE_UPDATE_OUTPUT:-$REPO_ROOT/dist/macos}"
options=(--maximum-deltas 0)
if [ "$#" -eq 2 ]; then options=(--versions "$1" --maximum-deltas "$2"); fi
printf '%s\n' "$SPARKLE_ED_PRIVATE_KEY" | "$SPARKLE_ROOT/bin/generate_appcast" \
  --ed-key-file - "${options[@]}" --maximum-versions 1 \
  --download-url-prefix "https://github.com/$GH_REPO/releases/download/$RELEASE_TAG/" \
  --link "https://github.com/$GH_REPO/releases/tag/$RELEASE_TAG" \
  --full-release-notes-url "https://github.com/$GH_REPO/releases/tag/$RELEASE_TAG" \
  -o "$output/appcast.xml" "$output"
test -s "$output/appcast.xml"
grep -q 'sparkle:edSignature=' "$output/appcast.xml"
echo 'Signed update feed ready.'
