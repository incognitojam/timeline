import AppKit
import Combine
import Sparkle

@MainActor
final class UpdateController: NSObject, ObservableObject, NSApplicationDelegate, SPUUpdaterDelegate {
    @Published private(set) var canCheck = false
    @Published private(set) var issue: String?
    // Follow Sparkle's settings, which it keeps in user defaults.
    @Published private(set) var settingsAvailable = false
    @Published private(set) var automaticallyChecks = false
    @Published private(set) var automaticallyDownloads = false
    @Published private(set) var allowsAutomaticDownloads = false
    private var serviceAgent: ServiceAgentController?
    private var controller: SPUStandardUpdaterController?
    private let maintenance = UpdateMaintenance(directory: timelineDataDirectory())
    @Published private var installation = UpdateInstallation()
    private var immediateInstall: (() -> Void)?
    // Sparkle announced it will relaunch the app after installing.
    private var relaunchAnnounced = false

    var updateStaged: Bool { installation.staged }
    var canInstallStagedUpdate: Bool {
        !installation.preparing && (canCheck || immediateInstall != nil)
    }

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
        let installed = ServiceAgentController.isRunningFromInstalledLocation()
        let controller = SPUStandardUpdaterController(startingUpdater: installed, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        if installed {
            let updater = controller.updater
            updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
            updater.publisher(for: \.automaticallyChecksForUpdates).assign(to: &$automaticallyChecks)
            updater.publisher(for: \.automaticallyDownloadsUpdates).assign(to: &$automaticallyDownloads)
            updater.publisher(for: \.allowsAutomaticUpdates).assign(to: &$allowsAutomaticDownloads)
            settingsAvailable = true
        } else {
            issue = "Install Timeline in Applications to enable updates."
        }
    }

    func checkForUpdates() {
        if let immediateInstall {
            // Sparkle announces a relaunch only once, and the immediate
            // handler installs and relaunches.
            relaunchAnnounced = true
            immediateInstall()
        } else {
            controller?.checkForUpdates(nil)
        }
    }

    func setAutomaticallyChecks(_ enabled: Bool) {
        controller?.updater.automaticallyChecksForUpdates = enabled
    }

    func setAutomaticallyDownloads(_ enabled: Bool) {
        controller?.updater.automaticallyDownloadsUpdates = enabled
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        installation.stage()
    }

    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) {
        installation.stage()
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        installation.stage()
        // Retain the handler so the menu can retry after refused termination.
        immediateInstall = immediateInstallHandler
        immediateInstallHandler()
        return true
    }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        relaunchAnnounced = true
    }

    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice,
                 forUpdate item: SUAppcastItem, state: SPUUserUpdateState) {
        installation.recordChoice(skipped: choice == .skip, installerRunning: state.stage == .installing)
    }

    // Sparkle waits for this app to terminate before replacing its bundle.
    // Refusing termination prevents replacement if preparation fails.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        switch installation.terminationDecision {
        case .allow: return .terminateNow
        case .wait: return .terminateLater
        case .prepare: break
        }
        guard let serviceAgent else {
            issue = "Update paused: the service agent is not ready."
            return .terminateCancel
        }
        installation.beginPreparation()
        issue = nil
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
                guard installation.completePreparation() else {
                    try maintenance.recover()
                    installation.resetPreparation()
                    serviceAgent.resumeAfterUpdate()
                    relaunchAnnounced = false
                    sender.reply(toApplicationShouldTerminate: false)
                    return
                }
                if relaunchAnnounced {
                    NotificationCenter.default.post(name: .timelineQuittingForUpdate, object: nil)
                }
                sender.reply(toApplicationShouldTerminate: true)
            } catch {
                installation.resetPreparation()
                serviceAgent.resumeAfterUpdate()
                issue = "Update paused: \(error.localizedDescription)"
                // A later quit is not this relaunch; a retry announces again.
                relaunchAnnounced = false
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
        installation.discard()
        recoverAfterCycle()
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        installation.finishCycle(failed: error != nil)
        recoverAfterCycle()
    }

    private func recoverAfterCycle() {
        immediateInstall = nil
        relaunchAnnounced = false
        guard !installation.staged, installation.prepared else { return }
        do {
            try maintenance.recover()
            installation.resetPreparation()
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
