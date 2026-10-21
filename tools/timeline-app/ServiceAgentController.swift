import Foundation
import SwiftUI
import ServiceManagement

@MainActor
final class ServiceAgentController: ObservableObject {
    private enum Issue: Equatable {
        case runInstalledApp
        case maintenanceHold
        case requiresApproval
        case missingBundledAgent
        case migrationFailed
        case sessionOnlyRegistration
        case reloading
        case failed
    }

    private struct State: Equatable {
        var issue: Issue?
    }

    @Published private var state: State
    // Set when the running app is installed and the other Applications
    // folder also holds a copy, which would register its own agents.
    @Published private(set) var otherInstalledCopy: URL?
    let config: LaunchAgentConfig
    private var scheduler: RefreshScheduler?
    private var reconcileObserver: NSObjectProtocol?
    private var reconcileInFlight = false
    private var updateSuspended = false

    func suspendForUpdate() async throws {
        updateSuspended = true
        let deadline = ProcessInfo.processInfo.systemUptime + 45
        while reconcileInFlight {
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                throw NSError(domain: "TimelineServiceAgent", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "The service agent is still reconciling. Try updating again."])
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    func resumeAfterUpdate() {
        updateSuspended = false
        refresh()
    }

    init(config: LaunchAgentConfig) {
        self.config = config
        state = State(issue: Self.isRunningFromInstalledLocation() ? nil : .runInstalledApp)
        scheduler = RefreshScheduler { [weak self] in Task { @MainActor in self?.refresh() } }
        startObservingReconcileRequests()
        refresh()
    }

    var issueText: String? {
        let name = config.displayName
        switch state.issue {
        case .none:
            return nil
        case .runInstalledApp:
            return "\(name): run installed app to manage"
        case .maintenanceHold:
            // Only the service instance can hit this (honorsMaintenanceHold),
            // so keep the historical user-facing wording.
            return "Service: maintenance hold"
        case .requiresApproval:
            return "\(name): approval required"
        case .missingBundledAgent:
            return "\(name): bundled plist missing"
        case .migrationFailed:
            return "\(name): migration failed"
        case .sessionOnlyRegistration:
            return "\(name): session-only registration"
        case .reloading:
            return "\(name): reloading..."
        case .failed:
            return "\(name): registration failed"
        }
    }

    var requiresApproval: Bool {
        state.issue == .requiresApproval
    }

    func refresh() {
        guard !updateSuspended else { return }
        let other = Self.findOtherInstalledCopy()
        if other != otherInstalledCopy { otherInstalledCopy = other }
        guard Self.isRunningFromInstalledLocation() else {
            writeError("Timeline \(config.label): not managing agent because this app is not running from an Applications folder.\n")
            apply(State(issue: .runInstalledApp))
            return
        }

        guard !reconcileInFlight else { return }
        reconcileInFlight = true

        let config = self.config
        Task.detached(priority: .utility) {
            let next = await Self.reconcileInstalledAgent(config: config) {
                await MainActor.run {
                    self.apply(State(issue: .reloading))
                }
            }
            await MainActor.run {
                self.reconcileInFlight = false
                if let next {
                    self.apply(next)
                }
            }
        }
    }

    private func apply(_ next: State) {
        guard next != state else { return }
        state = next
    }

    // The service-restart flow posts this to nudge the service agent to
    // reconcile; only the service instance (the one owning the hold) reacts.
    private func startObservingReconcileRequests() {
        guard config.honorsMaintenanceHold else { return }
        reconcileObserver = NotificationCenter.default.addObserver(
            forName: .timelineServiceAgentReconcileRequested,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    nonisolated private static let installedLocations = [
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Timeline.app"),
        URL(fileURLWithPath: "/Applications/Timeline.app")
    ]

    nonisolated static func isRunningFromInstalledLocation() -> Bool {
        guard let bundlePath = LaunchAgentIdentity.realPath(Bundle.main.bundleURL) else { return false }
        return installedLocations.contains { LaunchAgentIdentity.realPath($0) == bundlePath }
    }

    nonisolated private static func findOtherInstalledCopy() -> URL? {
        guard isRunningFromInstalledLocation(),
              let bundlePath = LaunchAgentIdentity.realPath(Bundle.main.bundleURL) else { return nil }
        return installedLocations.first { location in
            guard let path = LaunchAgentIdentity.realPath(location) else { return false }
            return path != bundlePath
        }
    }

    nonisolated static func bundledAgentPlistURL(config: LaunchAgentConfig) -> URL {
        Bundle.main.bundleURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("LaunchAgents", isDirectory: true)
            .appendingPathComponent(config.plistName)
    }

    nonisolated private static func reconcileInstalledAgent(
        config: LaunchAgentConfig,
        onReloading: @escaping @Sendable () async -> Void
    ) async -> State? {
        if config.honorsMaintenanceHold, isServiceMaintenanceHoldActive() {
            return State(issue: .maintenanceHold)
        }

        let bundledAgentPlist = bundledAgentPlistURL(config: config)
        guard FileManager.default.fileExists(atPath: bundledAgentPlist.path) else {
            writeError("Timeline \(config.label): bundled LaunchAgent \(config.plistName) was not found in the app bundle.\n")
            return State(issue: .missingBundledAgent)
        }

        do {
            try migrateLegacyLaunchAgentIfNeeded(config: config)
        } catch {
            writeError("Timeline \(config.label) migration failed: \(error)\n")
            return State(issue: .migrationFailed)
        }

        let agent = SMAppService.agent(plistName: config.plistName)
        let status = agent.status

        if status == .enabled {
            switch launchAgentLoadState(config: config) {
            case .loaded(let loadedJob):
                if LaunchAgentIdentity.isBundledAgentLoaded(
                    loadedJob,
                    bundledAgentPlist: bundledAgentPlist
                ) {
                    return State(issue: nil)
                }
                writeError("Timeline \(config.label): loaded program does not match the installed app; reloading registration.\n")
                await onReloading()

                do {
                    try reloadRegisteredAgent(agent, config: config)
                } catch {
                    writeError("Timeline \(config.label) reload failed: \(error)\n")
                    return State(issue: .failed)
                }

                return waitForRegisteredAgentToSettle(
                    agent,
                    config: config,
                    bundledAgentPlist: bundledAgentPlist
                )
            case .unknown:
                return nil
            case .unloaded:
                writeError("Timeline \(config.label): SMAppService is enabled but \(config.launchdTarget) is not loaded; reloading registration.\n")
                await onReloading()

                do {
                    try reloadRegisteredAgent(agent, config: config)
                } catch {
                    writeError("Timeline \(config.label) reload failed: \(error)\n")
                    return State(issue: .failed)
                }

                return waitForRegisteredAgentToSettle(agent, config: config, bundledAgentPlist: bundledAgentPlist)
            }
        }

        if status == .requiresApproval {
            return State(issue: .requiresApproval)
        }

        if status == .notRegistered || status == .notFound {
            switch launchAgentLoadState(config: config) {
            case .unknown:
                return nil
            case .loaded(let loadedJob):
                if LaunchAgentIdentity.isBundledAgentLoaded(loadedJob, bundledAgentPlist: bundledAgentPlist) {
                    writeError("Timeline \(config.label): launchd has the bundled agent loaded, but SMAppService registration did not persist; leaving session-only registration in place. This is likely signing-related.\n")
                    return State(issue: .sessionOnlyRegistration)
                }
                writeError("Timeline \(config.label): refusing to register while \(config.launchdTarget) is loaded from \(loadedJob.plistPath ?? "an unknown plist path").\n")
                return State(issue: .migrationFailed)
            case .unloaded:
                break
            }

            do {
                writeError("Timeline \(config.label): registering bundled LaunchAgent \(config.plistName).\n")
                try registerAgentWithRetry(agent, config: config)
            } catch {
                writeError("Timeline \(config.label) registration failed: \(error)\n")
                return State(issue: .failed)
            }

            return waitForRegisteredAgentToSettle(agent, config: config, bundledAgentPlist: bundledAgentPlist)
        }

        writeError("Timeline \(config.label) has unexpected status: \(status).\n")
        return State(issue: .failed)
    }

    nonisolated private static func reloadRegisteredAgent(_ agent: SMAppService, config: LaunchAgentConfig) throws {
        do {
            try agent.unregister()
        } catch {
            writeError("Timeline \(config.label): unregister before reload returned error; continuing: \(error)\n")
        }

        try registerAgentWithRetry(agent, config: config)
    }

    nonisolated private static func migrateLegacyLaunchAgentIfNeeded(config: LaunchAgentConfig) throws {
        guard let legacyPlist = config.legacyPlistURL else { return }

        let fileManager = FileManager.default

        guard fileManager.fileExists(atPath: legacyPlist.path) else { return }

        writeError("Timeline \(config.label) migration: found legacy plist at \(legacyPlist.path).\n")
        let migratedPlist = legacyPlist.deletingLastPathComponent()
            .appendingPathComponent("\(legacyPlist.lastPathComponent).migrated")
        writeError("Timeline \(config.label) migration: renaming legacy plist to \(migratedPlist.path).\n")
        if fileManager.fileExists(atPath: migratedPlist.path) {
            try fileManager.removeItem(at: migratedPlist)
        }
        try fileManager.moveItem(at: legacyPlist, to: migratedPlist)

        do {
            try bootoutLegacyLaunchAgent(config: config)
            try waitUntilLegacyLaunchAgentUnloaded(config: config)
        } catch {
            writeError("Timeline \(config.label) migration: restoring legacy plist after failed teardown.\n")
            try restoreLegacyPlist(from: migratedPlist, to: legacyPlist)
            throw error
        }
    }

    nonisolated private static func restoreLegacyPlist(from migratedPlist: URL, to legacyPlist: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: legacyPlist.path) {
            try fileManager.removeItem(at: legacyPlist)
        }
        try fileManager.moveItem(at: migratedPlist, to: legacyPlist)
    }

    nonisolated private static func bootoutLegacyLaunchAgent(config: LaunchAgentConfig) throws {
        guard let result = runCommand("/bin/launchctl", ["bootout", config.launchdTarget], captureStderr: false) else {
            throw NSError(
                domain: "TimelineServiceAgentMigration",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "launchctl bootout did not complete"]
            )
        }
        if result.succeeded {
            writeError("Timeline \(config.label) migration: booted out legacy LaunchAgent.\n")
        } else {
            writeError("Timeline \(config.label) migration: bootout returned \(result.terminationStatus); continuing.\n")
        }
    }

    nonisolated private static func waitUntilLegacyLaunchAgentUnloaded(config: LaunchAgentConfig) throws {
        for _ in 0..<20 {
            if launchAgentLoadState(config: config) == .unloaded {
                writeError("Timeline \(config.label) migration: legacy LaunchAgent is unloaded.\n")
                return
            }
            Thread.sleep(forTimeInterval: 0.25)
        }

        throw NSError(
            domain: "TimelineServiceAgentMigration",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "legacy LaunchAgent did not unload"]
        )
    }

    private enum LaunchAgentLoadState: Equatable {
        case loaded(LaunchCtlLoadedJob)
        case unloaded
        case unknown
    }

    nonisolated private static func launchAgentLoadState(config: LaunchAgentConfig) -> LaunchAgentLoadState {
        guard let result = runCommand("/bin/launchctl", ["print", config.launchdTarget], captureStderr: false) else {
            writeError("Timeline \(config.label): launchctl print failed.\n")
            return .unknown
        }
        guard result.succeeded else { return .unloaded }
        return .loaded(LaunchAgentIdentity.loadedJob(from: result.output))
    }

    nonisolated private static func waitForRegisteredAgentToSettle(
        _ agent: SMAppService,
        config: LaunchAgentConfig,
        bundledAgentPlist: URL
    ) -> State? {
        for attempt in 1...10 {
            let status = agent.status
            let loadState = launchAgentLoadState(config: config)

            if status == .enabled {
                switch loadState {
                case .loaded(let loadedJob):
                    if LaunchAgentIdentity.isBundledAgentLoaded(
                        loadedJob,
                        bundledAgentPlist: bundledAgentPlist
                    ) {
                        return State(issue: nil)
                    }
                case .unknown:
                    return nil
                case .unloaded:
                    break
                }
            }

            if status == .requiresApproval {
                return State(issue: .requiresApproval)
            }

            if (status == .notRegistered || status == .notFound),
               case .loaded(let loadedJob) = loadState,
               LaunchAgentIdentity.isBundledAgentLoaded(loadedJob, bundledAgentPlist: bundledAgentPlist) {
                writeError("Timeline \(config.label): launchd has the bundled agent loaded, but SMAppService registration did not persist after register(); leaving session-only registration in place. This is likely signing-related.\n")
                return State(issue: .sessionOnlyRegistration)
            }

            if loadState == .unknown {
                return nil
            }

            guard attempt < 10 else { break }
            Thread.sleep(forTimeInterval: 0.25)
        }

        writeError("Timeline \(config.label) registration did not settle; status: \(agent.status), launchd: \(launchAgentLoadState(config: config)).\n")
        return State(issue: .failed)
    }

    nonisolated private static func registerAgentWithRetry(_ agent: SMAppService, config: LaunchAgentConfig) throws {
        var lastError: Error?
        for attempt in 1...10 {
            do {
                try agent.register()
                return
            } catch {
                lastError = error
                if attempt == 1 {
                    writeError("Timeline \(config.label): registration failed after teardown; retrying briefly.\n")
                }
                guard attempt < 10 else { break }
                Thread.sleep(forTimeInterval: 0.5)
            }
        }

        if let lastError {
            throw lastError
        }
    }

    deinit {
        if let reconcileObserver { NotificationCenter.default.removeObserver(reconcileObserver) }
    }
}
