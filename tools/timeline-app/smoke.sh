#!/usr/bin/env bash
set -euo pipefail

if ! command -v cwebp >/dev/null 2>&1; then
  echo "Missing required tool: cwebp. Install it with brew install webp (or run bun run setup)." >&2
  exit 1
fi

portable=1
if [ "${1:-}" = --native-only ]; then
  portable=0
  shift
fi
APP="${1:-Timeline.app}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFO_PLIST="$APP/Contents/Info.plist"
RESOURCES="$APP/Contents/Resources"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "$portable" -eq 1 ]; then
  "$ROOT/tools/timeline-app/test-portable.sh" "$RESOURCES/timeline-service"
fi
test -f "$APP/Contents/Frameworks/Sparkle.framework/Sparkle"
test -f "$RESOURCES/Sparkle-LICENSE"
otool -L "$APP/Contents/MacOS/Timeline" | grep -q '@rpath/Sparkle.framework'

swiftc -target "$(uname -m)-apple-macos14.0" -parse-as-library RecallTests.swift RecallCapture.swift RecallPipeline.swift RecallMigration.swift RecallLog.swift RecallAgeMenu.swift Subprocess.swift -o "$TMP/recall-tests"
"$TMP/recall-tests" "$TMP" "$(command -v cwebp)"

plutil -lint "$INFO_PLIST" >/dev/null

SIDECAR="$RESOURCES/timeline-service/bin/timeline-gmessages"
codesign --verify --strict "$SIDECAR"
codesign -d --verbose=4 "$SIDECAR" > "$TMP/sidecar-codesign" 2>&1
grep -q 'flags=.*runtime' "$TMP/sidecar-codesign"
test -f "$RESOURCES/timeline-service/Resources/licenses/timeline-gmessages/LICENSE"
test -f "$RESOURCES/timeline-service/Resources/licenses/timeline-gmessages/NOTICE.txt"
tar -tzf "$RESOURCES/timeline-service/Resources/licenses/timeline-gmessages/source.tar.gz" > "$TMP/sidecar-source-files"
grep -q 'timeline-gmessages/vendor/modules.txt' "$TMP/sidecar-source-files"

test ! -e "$RESOURCES/capture.sh"
test -x "$RESOURCES/run-tailscale.sh"

python3 "$ROOT/tools/timeline-app/check-plists.py" "$APP"
test -x "$APP/Contents/MacOS/TimelineAgent"
"$APP/Contents/MacOS/TimelineAgent" recall

app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
app_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST")"
multiple_instances="$(/usr/libexec/PlistBuddy -c 'Print :LSMultipleInstancesProhibited' "$INFO_PLIST")"
test "$multiple_instances" = "true"

artifact_version="$($RESOURCES/timeline-service/bin/bun --no-env-file -e \
  'const value = await Bun.file(process.argv[1]).json(); process.stdout.write(`${value.version}\n${value.build}`)' \
  "$RESOURCES/timeline-service/Resources/version.json")"
test "$artifact_version" = "$app_version
$app_build"

# The packaged updater must carry the reviewed feed/key and prompt-first settings.
for key in SUFeedURL SUPublicEDKey SUEnableAutomaticChecks SUAutomaticallyUpdate; do
  test "$(/usr/libexec/PlistBuddy -c "Print :$key" "$INFO_PLIST")" = "$(/usr/libexec/PlistBuddy -c "Print :$key" Info.plist)"
done

codesign --verify --deep --strict "$APP"
"$ROOT/tools/timeline-app/smoke-updater.sh" "$APP"

COPIED_APP="$TMP/Timeline.app"
ditto "$APP" "$COPIED_APP"
COPIED_SERVICE="$COPIED_APP/Contents/Resources/timeline-service"
# Run the artifact probes against the relocated, signed bundle, including its
# Darwin Sharp and sqlite-vec binaries, without rebuilding a second artifact.
"$ROOT/scripts/smoke-service-artifact.sh" "$COPIED_SERVICE"

echo "OK: Timeline.app owns and runs its packaged service."
