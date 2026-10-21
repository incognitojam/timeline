#!/usr/bin/env bash
set -euo pipefail

APP="${1:-Timeline.app}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_PLIST="$APP/Contents/Library/LaunchAgents/dev.incognitojam.timeline-service.plist"
RECALL_PLIST="$APP/Contents/Library/LaunchAgents/dev.incognitojam.timeline-recall.plist"
TAILSCALE_PLIST="$APP/Contents/Library/LaunchAgents/dev.incognitojam.timeline-tailscale.plist"
INFO_PLIST="$APP/Contents/Info.plist"
RESOURCES="$APP/Contents/Resources"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

swiftc LaunchAgentIdentity.swift LaunchAgentIdentityTests.swift -o "$TMP/launch-agent-identity-tests"
"$TMP/launch-agent-identity-tests"

swiftc LaunchAgentConfig.swift UpdateMaintenance.swift UpdateMaintenanceTests.swift -o "$TMP/update-maintenance-tests"
"$TMP/update-maintenance-tests" "$TMP"
test -f "$APP/Contents/Frameworks/Sparkle.framework/Sparkle"
test -f "$RESOURCES/Sparkle-LICENSE"
otool -L "$APP/Contents/MacOS/Timeline" | grep -q '@rpath/Sparkle.framework'

swiftc TimelineServiceConfig.swift Subprocess.swift ServiceConfigurationCheckTests.swift -o "$TMP/service-configuration-check-tests"
mkdir "$TMP/config-check-home"
env -u TIMELINE_CONFIG -u TIMELINE_DB_PATH -u AUTH_PASSWORD HOME="$TMP/config-check-home" \
  "$TMP/service-configuration-check-tests" "$RESOURCES/timeline-service/bin/timeline-service" "$TMP"

swiftc -target "$(uname -m)-apple-macos14.0" -parse-as-library RecallTests.swift RecallCapture.swift RecallPipeline.swift RecallMigration.swift RecallLog.swift Subprocess.swift -o "$TMP/recall-tests"
if command -v cwebp >/dev/null 2>&1; then
  "$TMP/recall-tests" "$TMP" "$(command -v cwebp)"
else
  "$TMP/recall-tests" "$TMP"
fi

for plist in "$SERVICE_PLIST" "$RECALL_PLIST" "$TAILSCALE_PLIST" "$INFO_PLIST"; do
  plutil -lint "$plist" >/dev/null
done

test -x "$RESOURCES/timeline-service/bin/timeline-service"
test -x "$RESOURCES/timeline-service/bin/bun"
test -r "$RESOURCES/timeline-service/bin/timeline-environment"
grep -q 'NODE_ENV:=production' "$RESOURCES/timeline-service/bin/timeline-environment"
grep -q '/opt/homebrew/bin:/usr/local/bin' "$RESOURCES/timeline-service/bin/timeline-environment"
test ! -e "$RESOURCES/capture.sh"
test -x "$RESOURCES/run-tailscale.sh"
test -f "$RESOURCES/timeline-service/Resources/version.json"
test -f "$RESOURCES/timeline-service/Resources/web/index.html"
test -f "$RESOURCES/timeline-service/Resources/runtime/parsers/monzo.js"

for name in service recall tailscale; do
  plist="$APP/Contents/Library/LaunchAgents/dev.incognitojam.timeline-$name.plist"
  test "$(/usr/libexec/PlistBuddy -c 'Print :BundleProgram' "$plist")" = "Contents/MacOS/TimelineAgent"
  test "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist")" = "$name"
  test "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist")" = "dev.incognitojam.timeline-$name"
  test "$(/usr/libexec/PlistBuddy -c 'Print :AssociatedBundleIdentifiers:0' "$plist")" = "com.incognitojam.timeline"
  for key in Program StandardOutPath StandardErrorPath EnvironmentVariables WorkingDirectory; do
    ! /usr/libexec/PlistBuddy -c "Print :$key" "$plist" >/dev/null 2>&1
  done
  ! grep -qF "$HOME" "$plist"
done
test -x "$APP/Contents/MacOS/TimelineAgent"
! /usr/libexec/PlistBuddy -c 'Print :StartInterval' "$RECALL_PLIST" >/dev/null 2>&1
! /usr/libexec/PlistBuddy -c 'Print :RunAtLoad' "$RECALL_PLIST" >/dev/null 2>&1
"$APP/Contents/MacOS/TimelineAgent" recall
! /usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$RECALL_PLIST" >/dev/null 2>&1
! /usr/libexec/PlistBuddy -c 'Print :ProcessType' "$RECALL_PLIST" >/dev/null 2>&1
# The service serves the API at normal priority; its sync worker lowers its own thread.
! /usr/libexec/PlistBuddy -c 'Print :ProcessType' "$SERVICE_PLIST" >/dev/null 2>&1
test "$(/usr/libexec/PlistBuddy -c 'Print :ProcessType' "$TAILSCALE_PLIST")" = "Background"

app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
app_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST")"
multiple_instances="$(/usr/libexec/PlistBuddy -c 'Print :LSMultipleInstancesProhibited' "$INFO_PLIST")"
test "$multiple_instances" = "true"

artifact_version="$($RESOURCES/timeline-service/bin/bun --no-env-file -e \
  'const value = await Bun.file(process.argv[1]).json(); process.stdout.write(`${value.version}\n${value.build}`)' \
  "$RESOURCES/timeline-service/Resources/version.json")"
test "$artifact_version" = "$app_version
$app_build"

codesign --verify --deep --strict "$APP"
"$ROOT/tools/timeline-app/smoke-updater.sh" "$APP"

COPIED_APP="$TMP/Timeline.app"
RUN_CWD="$TMP/run"
ditto "$APP" "$COPIED_APP"
mkdir -p "$RUN_CWD"
COPIED_SERVICE="$COPIED_APP/Contents/Resources/timeline-service"
commit="$($COPIED_SERVICE/bin/bun --no-env-file -e \
  'process.stdout.write((await Bun.file(process.argv[1]).json()).commit)' \
  "$COPIED_SERVICE/Resources/version.json")"

PATH="/usr/bin:/bin" \
  PORT=3019 \
  TIMELINE_SERVICE_EXECUTABLE="$COPIED_SERVICE/bin/timeline-service" \
  TIMELINE_SERVICE_CWD="$RUN_CWD" \
  TIMELINE_SMOKE_EXPECT_COMMIT="$commit" \
  TIMELINE_SMOKE_EXPECT_WEB=1 \
  "$ROOT/scripts/smoke-service.sh"

echo "OK: Timeline.app owns and runs its packaged service."
