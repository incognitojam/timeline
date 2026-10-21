import AppKit
import Combine
import Sparkle

@MainActor
final class UpdateController: NSObject, ObservableObject, NSApplicationDelegate, SPUUpdaterDelegate {
    @Published private(set) var canCheck = true
    @Published private(set) var issue: String?
    private var serviceAgent: ServiceAgentController?
    private var controller: SPUStandardUpdaterController?
    private let maintenance = UpdateMaintenance(directory: timelineDataDirectory())
    private var installingUpdate = false
    private var preparing = false
    private var prepared = false

    var automaticUpdatesEnabled: Bool { controller != nil }

    override init() {
        var recoveryError: Error?
        let maintenance = UpdateMaintenance(directory: timelineDataDirectory())
        do { try maintenance.recover() } catch { recoveryError = error }
        super.init()
        if let recoveryError { issue = "Update recovery: \(recoveryError.localizedDescription)" }
    }

    func configure(serviceAgent: ServiceAgentController) {
        guard self.serviceAgent == nil else { return }
        self.serviceAgent = serviceAgent
        if Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil {
            controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
            controller?.updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
        }
    }

    func checkForUpdates() {
        if let controller {
            controller.checkForUpdates(nil)
        } else {
            guard let value = Bundle.main.object(forInfoDictionaryKey: "TimelineReleaseURL") as? String,
                  let url = URL(string: value) else {
                fatalError("The Timeline bundle has no release download URL")
            }
            NSWorkspace.shared.open(url)
        }
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        installingUpdate = true
    }

    // Sparkle waits for this app to terminate before replacing its bundle.
    // Refusing termination prevents replacement if preparation fails.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard installingUpdate, !prepared else { return .terminateNow }
        guard let serviceAgent else {
            issue = "Update paused: the service agent is not ready."
            return .terminateCancel
        }
        guard !preparing else { return .terminateLater }
        preparing = true
        let maintenance = self.maintenance
        Task {
            do {
                try await serviceAgent.suspendForUpdate()
                try await Task.detached(priority: .utility) {
                    try maintenance.prepare {
                        let target = serviceLaunchAgentConfig.launchdTarget
                        guard let status = runCommand("/bin/launchctl", ["print", target]) else {
                            throw Self.stopError("Could not check the service LaunchAgent.")
                        }
                        // launchctl print uses ESRCH (3) when the job is absent.
                        if status.terminationStatus == 3 { return }
                        guard status.succeeded else { throw Self.stopError("Could not check the service LaunchAgent.") }
                        guard let stopped = runCommand("/bin/launchctl", ["bootout", "--wait", target]), stopped.succeeded else {
                            throw Self.stopError("Could not stop the service before updating.")
                        }
                    }
                }.value
                guard installingUpdate else {
                    try maintenance.recover()
                    preparing = false
                    serviceAgent.resumeAfterUpdate()
                    sender.reply(toApplicationShouldTerminate: false)
                    return
                }
                prepared = true
                sender.reply(toApplicationShouldTerminate: true)
            } catch {
                preparing = false
                serviceAgent.resumeAfterUpdate()
                issue = "Update paused: \(error.localizedDescription)"
                sender.reply(toApplicationShouldTerminate: false)
                let alert = NSAlert()
                alert.messageText = "Timeline could not prepare the update"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
        }
        return .terminateLater
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        installingUpdate = false
        guard prepared else { return }
        do {
            try maintenance.recover()
            prepared = false
            preparing = false
            serviceAgent?.resumeAfterUpdate()
        } catch {
            issue = "Update recovery: \(error.localizedDescription)"
        }
    }

    nonisolated private static func stopError(_ message: String) -> NSError {
        NSError(domain: "TimelineUpdateController", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }
}
