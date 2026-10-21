#!/bin/bash
# Build the Timeline menu bar app.
# Output: ./Timeline.app (in this directory)
set -euo pipefail
cd "$(dirname "$0")"

APP="Timeline.app"
REPO_ROOT="$(cd ../.. && pwd)"
IDENTITY="Timeline Recall Signing"
SERVICE_LABEL="dev.incognitojam.timeline-service"
INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL=1
      ;;
    *)
      echo "usage: ./build.sh [--install]" >&2
      exit 2
      ;;
  esac
  shift
done

source "$PWD/sparkle.sh"

# Compile the SwiftUI app. -parse-as-library makes @main the entry point (the
# file is not named main.swift, so top-level code is not assumed).
swiftc -target "$(uname -m)-apple-macos14.0" -O -parse-as-library \
  -F "$SPARKLE_ROOT" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  TimelineApp.swift LaunchAgentConfig.swift RefreshScheduler.swift \
  RecallController.swift LoginItemController.swift ServiceAgentController.swift \
  ServiceController.swift RecallNotifier.swift RemoteAccess.swift \
  RecallLog.swift RecallCapture.swift RecallPipeline.swift RecallMigration.swift \
  TimelineServiceConfig.swift LaunchAgentIdentity.swift Subprocess.swift \
  UpdateController.swift UpdateMaintenance.swift -o Timeline

# Assemble a minimal .app bundle.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
mkdir -p "$APP/Contents/Frameworks"
ditto "$SPARKLE_ROOT/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
cp "$SPARKLE_ROOT/LICENSE" "$APP/Contents/Resources/Sparkle-LICENSE"
cp Info.plist "$APP/Contents/Info.plist"
PRODUCT_VERSION="$(bun run "$REPO_ROOT/scripts/print-product-version.ts")"
BUNDLE_BUILD="${TIMELINE_BUILD_NUMBER:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' Info.plist)}"
if [[ ! "$BUNDLE_BUILD" =~ ^[0-9]+$ ]]; then
  echo "Error: Timeline build number must contain only digits: $BUNDLE_BUILD" >&2
  exit 1
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PRODUCT_VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUNDLE_BUILD" "$APP/Contents/Info.plist"
bun run update-config.ts "$APP/Contents/Info.plist"
cp ../../deploy/macos/run-tailscale.sh "$APP/Contents/Resources/run-tailscale.sh"
chmod 755 "$APP/Contents/Resources/run-tailscale.sh"
mv Timeline "$APP/Contents/MacOS/Timeline"
swiftc -target "$(uname -m)-apple-macos14.0" -O -parse-as-library AgentLauncher.swift -o "$APP/Contents/MacOS/TimelineAgent"

SERVICE_ARTIFACT="$APP/Contents/Resources/timeline-service"
TIMELINE_BUILD_NUMBER="$BUNDLE_BUILD" bun run "$REPO_ROOT/scripts/build-service-artifact.ts" --output "$SERVICE_ARTIFACT"

bun run render-agents.ts "$APP"

# A stable identity preserves Screen Recording permission and background-item
# registration across rebuilds. Ad-hoc builds may require permission again.
# TIMELINE_CODESIGN_IDENTITY overrides auto-detection; set it to "-"
# for an explicit ad-hoc signature in non-interactive CI sessions.
if [[ -n "${TIMELINE_CODESIGN_IDENTITY:-}" ]]; then
  SIGNING_IDENTITY="$TIMELINE_CODESIGN_IDENTITY"
elif security find-identity -p codesigning | grep -qF "$IDENTITY"; then
  SIGNING_IDENTITY="$IDENTITY"
else
  echo "note: '$IDENTITY' not found; signing $APP ad-hoc." >&2
  echo "      (run ../timeline-recall/create-signing-identity.sh for a stable identity)" >&2
  SIGNING_IDENTITY="-"
fi
codesign --force --sign "$SIGNING_IDENTITY" "$APP/Contents/MacOS/TimelineAgent"
codesign --force --identifier com.incognitojam.timeline --sign "$SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"

echo "Built and signed $(pwd)/$APP"

if [[ "$INSTALL" -eq 1 ]]; then
  INSTALL_DIR="$HOME/Applications"
  INSTALLED_APP="$INSTALL_DIR/$APP"
  PREVIOUS_APP="$INSTALL_DIR/Timeline.app.previous"
  STAGED_APP="$INSTALL_DIR/.Timeline.app.install.$$"
  HOLD_DIR="$HOME/.local/share/timeline"
  HOLD_FILE="$HOLD_DIR/service.hold"
  LAUNCHD_TARGET="gui/$(id -u)/$SERVICE_LABEL"
  HOLD_CREATED=0

  if [[ -e "$HOLD_FILE" ]]; then
    echo "Error: refusing to install while the service maintenance hold exists: $HOLD_FILE" >&2
    exit 1
  fi

  echo "Checking packaged service configuration..."
  "$SERVICE_ARTIFACT/bin/timeline-service" --check-config

  cleanup_install() {
    status=$?
    trap - EXIT
    set +e
    if [[ "$status" -ne 0 ]]; then
      rm -rf "$STAGED_APP"
      if [[ ! -e "$INSTALLED_APP" && -e "$PREVIOUS_APP" ]]; then
        if mv "$PREVIOUS_APP" "$INSTALLED_APP"; then
          echo "Restored $INSTALLED_APP after failed install" >&2
        else
          echo "Error: could not restore $INSTALLED_APP after failed install" >&2
        fi
      fi
    fi
    if [[ "$HOLD_CREATED" -eq 1 ]]; then
      rm -f "$HOLD_FILE"
    fi
    if [[ "$status" -ne 0 && -e "$INSTALLED_APP" ]]; then
      if open "$INSTALLED_APP"; then
        echo "Relaunched $INSTALLED_APP after failed install" >&2
      else
        echo "Error: could not relaunch $INSTALLED_APP after failed install" >&2
      fi
    fi
    exit "$status"
  }
  trap cleanup_install EXIT

  mkdir -p "$HOLD_DIR"
  touch "$HOLD_FILE"
  HOLD_CREATED=1

  if pgrep -x Timeline >/dev/null; then
    osascript -e 'tell application id "com.incognitojam.timeline" to quit' >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! pgrep -x Timeline >/dev/null; then
        break
      fi
      sleep 0.25
    done
    if pgrep -x Timeline >/dev/null; then
      pkill -x Timeline || true
    fi
  fi

  if launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
    launchctl bootout --wait "$LAUNCHD_TARGET"
  fi

  # The live service could accept a settings change after the initial check.
  # With the hold active and launchd stopped, this result remains valid through
  # the bundle replacement.
  echo "Rechecking packaged service configuration..."
  "$SERVICE_ARTIFACT/bin/timeline-service" --check-config

  mkdir -p "$INSTALL_DIR"
  rm -rf "$STAGED_APP"
  ditto "$APP" "$STAGED_APP"
  codesign --verify --deep --strict "$STAGED_APP"

  rm -rf "$PREVIOUS_APP"
  if [[ -e "$INSTALLED_APP" ]]; then
    mv "$INSTALLED_APP" "$PREVIOUS_APP"
  fi
  mv "$STAGED_APP" "$INSTALLED_APP"
  echo "Installed $INSTALLED_APP"

  rm -f "$HOLD_FILE"
  HOLD_CREATED=0
  open "$INSTALLED_APP"
  echo "Launched $INSTALLED_APP"
  trap - EXIT
fi
