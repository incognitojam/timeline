import Foundation

// The nonce distinguishes an updater-owned hold from a user's maintenance hold.
// It survives replacement of the app so the relaunched bundle can recover it.
struct UpdateMaintenance: Sendable {
    let directory: URL
    private var hold: URL { serviceMaintenanceHoldURL(directory: directory) }
    private var marker: URL { directory.appendingPathComponent("update.hold") }

    func prepare(stopService: () throws -> Void) throws {
        let files = FileManager.default
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        guard !files.fileExists(atPath: marker.path) else {
            throw failure("An earlier update hold needs recovery. Quit and reopen Timeline.")
        }
        let nonce = Data(UUID().uuidString.utf8)
        do {
            try nonce.write(to: hold, options: .withoutOverwriting)
        } catch {
            throw failure("A service maintenance hold is active. Remove it before updating.")
        }
        do {
            try nonce.write(to: marker, options: .atomic)
            try stopService()
        } catch {
            // If writing the marker failed, the hold still belongs to this call.
            if (try? Data(contentsOf: hold)) == nonce { try files.removeItem(at: hold) }
            if (try? Data(contentsOf: marker)) == nonce { try files.removeItem(at: marker) }
            throw error
        }
    }

    func recover() throws {
        let files = FileManager.default
        guard files.fileExists(atPath: marker.path) else { return }
        let nonce = try Data(contentsOf: marker)
        guard !nonce.isEmpty else { throw failure("The update hold marker is empty.") }
        if files.fileExists(atPath: hold.path) {
            guard try Data(contentsOf: hold) == nonce else {
                throw failure("The service hold changed during an update; it has been left in place.")
            }
            try files.removeItem(at: hold)
        }
        try files.removeItem(at: marker)
    }

    private func failure(_ message: String) -> NSError {
        NSError(domain: "TimelineUpdateMaintenance", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
}
