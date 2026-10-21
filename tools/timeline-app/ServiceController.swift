import Foundation
import SwiftUI
import AppKit

enum ServiceStatus: Equatable {
    case checking
    case running
    case notResponding
}

// Build identity from /api/health. Packaged services report the app's release
// version/build plus the source commit recorded when the bundle was built.
struct ServiceVersion: Equatable {
    let version: String?
    let build: String?
    let commit: String?
}

@MainActor
final class ServiceController: ObservableObject {
    @Published private(set) var status: ServiceStatus = .checking
    // nil while the service isn't responding.
    @Published private(set) var runningVersion: ServiceVersion?
    // Why the service can't start, from its own --check-config preflight.
    // Only checked while the service isn't responding.
    @Published private(set) var configurationError: String?

    let baseURL: URL

    private let healthURL: URL
    private var scheduler: RefreshScheduler?
    private var restartTask: Task<Void, Never>?
    private var healthRequestID = 0
    private var configurationCheckInFlight = false
    private var lastConfigurationCheck: Date?

    init(endpoint: TimelineServiceEndpoint = loadTimelineServiceEndpoint()) {
        baseURL = timelineServiceBaseURL(for: endpoint)
        healthURL = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("health")
        scheduler = RefreshScheduler { [weak self] in Task { @MainActor in self?.refresh() } }
        refresh()
    }

    func openTimeline() {
        NSWorkspace.shared.open(baseURL)
    }

    func restartService() {
        guard !isServiceMaintenanceHoldActive() else {
            writeError("Timeline service restart skipped: maintenance hold is active.\n")
            NotificationCenter.default.post(name: .timelineServiceAgentReconcileRequested, object: nil)
            return
        }

        restartTask?.cancel()
        // Invalidate any in-flight health response from before the kickstart.
        healthRequestID += 1
        apply(nil)

        restartTask = Task {
            let kickstartError: (any Error)? = await Task.detached(priority: .utility) {
                do {
                    try Self.kickstartLaunchAgent()
                    return nil
                } catch {
                    return error
                }
            }.value
            if let kickstartError {
                writeError("Timeline service restart failed: \(kickstartError)\n")
                writeError("Timeline service restart: requesting service-agent reconcile after kickstart failure.\n")
                NotificationCenter.default.post(name: .timelineServiceAgentReconcileRequested, object: nil)
            }

            // Probe every few seconds until a healthy response or the window
            // expires. A newer restart cancels this task; the cancelled task
            // must not touch state the newer restart now owns.
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if Task.isCancelled { return }
                if await self.checkHealthAndApply() != nil { break }
                if Task.isCancelled { return }
            }
        }
    }

    func refresh() {
        Task { await self.checkHealthAndApply() }
    }

    // One health check. Returns the applied payload so restart probes can
    // stop on the first healthy answer — nil when a newer request superseded
    // this one, so a discarded response can't end the restart loop either.
    @discardableResult
    private func checkHealthAndApply() async -> ServiceVersion? {
        healthRequestID += 1
        let requestID = healthRequestID
        let health = await Self.checkHealth(url: healthURL)
        guard healthRequestID == requestID else { return nil }
        apply(health)
        if health == nil { checkConfiguration() }
        return health
    }

    private func checkConfiguration() {
        guard !configurationCheckInFlight, !isServiceMaintenanceHoldActive() else { return }
        if let last = lastConfigurationCheck, Date().timeIntervalSince(last) < 60 { return }
        configurationCheckInFlight = true
        lastConfigurationCheck = Date()
        Task {
            let error = await Task.detached(priority: .utility) { Self.runConfigurationCheck() }.value
            configurationCheckInFlight = false
            // A service that recovered meanwhile has nothing to explain.
            configurationError = status == .notResponding ? error : nil
        }
    }

    nonisolated private static func runConfigurationCheck() -> String? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        return checkTimelineServiceConfiguration(
            launcher: resources.appendingPathComponent("timeline-service/bin/timeline-service").path
        )
    }

    private func apply(_ health: ServiceVersion?) {
        let next: ServiceStatus = health != nil ? .running : .notResponding
        if next != status { status = next }
        if health != runningVersion { runningVersion = health }
        if health != nil {
            if configurationError != nil { configurationError = nil }
            lastConfigurationCheck = nil
        }
    }

    // nil = not responding; non-nil = healthy, with whatever version fields
    // the health payload carried.
    nonisolated private static func checkHealth(url: URL) async -> ServiceVersion? {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { return nil }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let version = json?["version"] as? [String: Any]
            return ServiceVersion(
                version: version?["version"] as? String,
                build: version?["build"] as? String,
                commit: version?["commit"] as? String
            )
        } catch {
            return nil
        }
    }

    nonisolated private static func kickstartLaunchAgent() throws {
        let target = serviceLaunchAgentConfig.launchdTarget
        guard let result = runCommand("/bin/launchctl", ["kickstart", "-k", target], captureStderr: false) else {
            throw NSError(
                domain: "TimelineServiceController",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "launchctl kickstart did not complete"]
            )
        }
        guard result.succeeded else {
            throw NSError(
                domain: "TimelineServiceController",
                code: Int(result.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: "launchctl exited with status \(result.terminationStatus)"]
            )
        }
    }

    deinit {
        restartTask?.cancel()
    }
}
