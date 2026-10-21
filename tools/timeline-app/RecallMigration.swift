import Foundation
import ServiceManagement
import Darwin

enum RecallMigration {
    static let label = "dev.incognitojam.timeline-recall"

    static func retire() throws {
        let agent = SMAppService.agent(plistName: "\(label).plist")
        try retire(home: FileManager.default.homeDirectoryForCurrentUser,
                   target: "gui/\(getuid())/\(label)",
                   unregister: {
                       if agent.status == .enabled || agent.status == .requiresApproval {
                           try agent.unregister()
                       }
                   }, command: { runCommand("/bin/launchctl", $0, captureStderr: false) })
    }

    static func retire(home: URL, target: String, unregister: () throws -> Void,
                       command: ([String]) -> CommandResult?) throws {
        let fm = FileManager.default
        let legacy = home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
        // Unregister the app-owned job before allowing in-process capture. The
        // bundled inert plist retains its identity solely for this migration.
        try unregister()
        guard let loaded = command(["print", target]) else {
            throw RecallError("Could not check the old Recall agent.")
        }
        if loaded.succeeded {
            guard let stopped = command(["bootout", target]), stopped.succeeded else {
                throw RecallError("Could not stop the old Recall agent.")
            }
        }
        guard let final = command(["print", target]), final.terminationStatus == 113 else {
            throw RecallError("Could not confirm that the old Recall agent stopped.")
        }
        if fm.fileExists(atPath: legacy.path) {
            // A unique backup preserves earlier migration backups too.
            let backup = legacy.appendingPathExtension("migrated-\(UUID().uuidString)")
            try fm.moveItem(at: legacy, to: backup)
        }
    }
}
