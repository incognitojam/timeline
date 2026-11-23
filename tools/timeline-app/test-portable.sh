#!/usr/bin/env bash
set -euo pipefail
: "${1:?usage: test-portable.sh <service-artifact>}"
artifact="$(cd "$1" && pwd)"
cd "$(dirname "$0")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Keep assertions enabled; these drivers use precondition as well as fatalError.
swiftc -Onone LaunchAgentIdentity.swift LaunchAgentIdentityTests.swift -o "$work/identity"
"$work/identity"
swiftc -Onone UpdateInstallation.swift UpdateInstallationTests.swift -o "$work/installation"
"$work/installation"
swiftc -Onone LaunchAgentConfig.swift UpdateMaintenance.swift UpdateMaintenanceTests.swift -o "$work/maintenance"
"$work/maintenance" "$work"
swiftc -Onone PublicAccess.swift PublicAccessTests.swift -o "$work/public-access"
"$work/public-access"
swiftc -Onone TimelineServiceConfig.swift Subprocess.swift ServiceConfigurationCheckTests.swift -o "$work/configuration"
mkdir "$work/home"
env -u TIMELINE_CONFIG -u TIMELINE_DB_PATH -u AUTH_PASSWORD HOME="$work/home" \
  "$work/configuration" "$artifact/bin/timeline-service" "$work"

bun run render-agents.ts "$work/Timeline.app"
python3 check-plists.py "$work/Timeline.app"
