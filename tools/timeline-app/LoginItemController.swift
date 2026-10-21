import Foundation
import SwiftUI
import ServiceManagement

@MainActor
final class LoginItemController: ObservableObject {
    @Published private var status = SMAppService.mainApp.status
    private var scheduler: RefreshScheduler?

    init() {
        scheduler = RefreshScheduler { [weak self] in Task { @MainActor in self?.refresh() } }
    }

    var isEnabled: Bool { status == .enabled }
    var requiresApproval: Bool { status == .requiresApproval }

    func setEnabled(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            writeError("Timeline launch-at-login update failed: \(error)\n")
        }
        refresh()
    }

    func refresh() {
        let next = SMAppService.mainApp.status
        if next != status { status = next }
    }
}
