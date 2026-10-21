import Foundation
import Darwin

// Identity + behaviour flags for an SMAppService-owned LaunchAgent. The same
// own/reconcile machinery (ServiceAgentController) drives multiple agents; the
// service-specific bits (maintenance hold, legacy-plist migration) are gated on
// this config so they only apply to the agents that need them.
struct LaunchAgentConfig: Equatable {
    let label: String
    let displayName: String
    // When true, the reconcile skips while ~/.local/share/timeline/service.hold
    // exists. Specific to the Timeline service (see docs "maintenance hold").
    let honorsMaintenanceHold: Bool
    // A pre-existing hand-installed plist at ~/Library/LaunchAgents/<label>.plist
    // is booted out and renamed before registering the bundled agent. The
    // .migrated file is the rollback point.
    let migratesLegacyPlist: Bool

    var plistName: String { "\(label).plist" }
    var launchdTarget: String { "gui/\(getuid())/\(label)" }
    var legacyPlistURL: URL? {
        guard migratesLegacyPlist else { return nil }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(plistName)")
    }
}

let serviceLaunchAgentConfig = LaunchAgentConfig(
    label: "dev.incognitojam.timeline-service",
    displayName: "Service agent",
    honorsMaintenanceHold: true,
    migratesLegacyPlist: true
)

extension Notification.Name {
    static let timelineServiceAgentReconcileRequested = Notification.Name("timelineServiceAgentReconcileRequested")
}

func timelineDataDirectory() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/share/timeline", isDirectory: true)
}

func serviceMaintenanceHoldURL(directory: URL = timelineDataDirectory()) -> URL {
    directory.appendingPathComponent("service.hold")
}

func isServiceMaintenanceHoldActive() -> Bool {
    FileManager.default.fileExists(atPath: serviceMaintenanceHoldURL().path)
}
