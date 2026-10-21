// Remote Access (Tailscale Funnel) ownership for the Timeline menu bar app.
//
// A userspace `tailscaled` (run by the dev.incognitojam.timeline-tailscale
// LaunchAgent, see deploy/macos/run-tailscale.sh) exposes the local Timeline
// service publicly via Tailscale Funnel. This controller owns that agent (reusing
// ServiceAgentController's SMAppService own/reconcile machinery) and drives the
// tailscale login/funnel state through the CLI over the node's own socket.
//
// Opt-in: nothing is registered or spawned until the user sets it up (which
// creates the state directory). Turning it off unregisters the agent but keeps
// the state directory, so login/funnel state persists for a later re-enable.
// Login is strictly user-initiated — the app never re-runs `tailscale up` while
// a login is pending, because that regenerates the node key and orphans a
// registration the user may have just authorized; the pending state stays
// latched until the backend actually reaches Running, and an explicit retry is
// offered only after a cooldown.

import Foundation
import SwiftUI
import AppKit
import ServiceManagement

// Config for the tailscale agent — no maintenance hold, no legacy migration.
let tailscaleLaunchAgentConfig = LaunchAgentConfig(
    label: "dev.incognitojam.timeline-tailscale",
    displayName: "Remote access",
    honorsMaintenanceHold: false,
    migratesLegacyPlist: false
)

private let tailscaledExecutable = "/opt/homebrew/bin/tailscaled"
private let tailscaleExecutable = "/opt/homebrew/bin/tailscale"

private func tailscaleStateDirectory() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/share/timeline/tailscale", isDirectory: true)
}

private func tailscaleSocketPath() -> String {
    tailscaleStateDirectory().appendingPathComponent("tailscaled.sock").path
}

// Marker distinguishing "turned off" from "never set up": the state directory
// is kept on turn-off (it holds the login), so enablement is statedir present
// AND this marker absent.
private func tailscaleDisabledMarkerURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/share/timeline/tailscale.disabled")
}

private func isRemoteAccessEnabled() -> Bool {
    FileManager.default.fileExists(atPath: tailscaleStateDirectory().path)
        && !FileManager.default.fileExists(atPath: tailscaleDisabledMarkerURL().path)
}

// A snapshot of what to show in the menu, derived off-main on each poll.
enum RemoteAccessState: Equatable {
    // Opt-in not taken (never set up, or turned off): agent not registered.
    case notSetUp
    // brew binary missing — the feature can't run until tailscale is installed.
    case notInstalled
    // Agent owned but the daemon isn't answering its socket yet.
    case starting
    // Logged out / never logged in: user must start login.
    case needsLogin
    // A user-initiated login is pending (auth URL opened); latched until the
    // backend reaches Running so the button can't fire a second `tailscale up`.
    case loggingIn
    // Up and funnelling; dnsName is the node's DNS name (trailing dot stripped).
    case running(dnsName: String)
}

@MainActor
final class RemoteAccessController: ObservableObject {
    @Published private(set) var state: RemoteAccessState = .notSetUp
    // Surfaces the underlying agent ownership issue (approval, failed, …) when set.
    @Published private(set) var agentIssueText: String?

    // The service port is the single source of truth for what to funnel.
    private let servicePort: Int
    private var agent: ServiceAgentController?
    private var scheduler: RefreshScheduler?
    private var refreshInFlight = false
    // Latched at logIn() and cleared only when the backend reaches Running (or
    // the feature is turned off / the login never started). While latched the
    // poll renders .loggingIn instead of .needsLogin, so the login button can't
    // fire a second `tailscale up` that would regenerate the node key.
    private var loginPendingSince: Date?
    // How long a pending login blocks retries. After this, an explicit
    // "Retry Login…" is offered (retrying invalidates the pending auth URL).
    private let loginRetryCooldown: TimeInterval = 180
    // Funnel-config cache (fix for per-poll subprocess spawn): once confirmed
    // configured, stop running `funnel status` every 30s. Reset when the node
    // leaves Running.
    private var funnelConfirmed = false
    private var funnelCheckInFlight = false

    init(endpoint: TimelineServiceEndpoint = loadTimelineServiceEndpoint()) {
        servicePort = endpoint.port
        adoptAgentIfEnabled()
        scheduler = RefreshScheduler { [weak self] in Task { @MainActor in self?.refresh() } }
        refresh()
    }

    var requiresApproval: Bool {
        agent?.requiresApproval ?? false
    }

    // https URL for the running node, or nil when not running.
    var publicURL: URL? {
        guard case .running(let dnsName) = state else { return nil }
        return URL(string: "https://\(dnsName)")
    }

    // True while a pending login has outlived the cooldown: offer an explicit
    // retry (which the user takes knowing it invalidates the pending URL).
    var canRetryLogin: Bool {
        guard state == .loggingIn, let since = loginPendingSince else { return false }
        return Date().timeIntervalSince(since) >= loginRetryCooldown
    }

    // Opt-in: create the state directory, register the agent, and flow into login.
    func setUp() {
        try? FileManager.default.createDirectory(
            at: tailscaleStateDirectory(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: tailscaleDisabledMarkerURL())
        adoptAgentIfEnabled()
        refresh()
    }

    // Reversal path for the opt-in: unregister the agent (stopping tailscaled)
    // but keep the state directory, so re-enabling needs no re-login.
    func turnOff() {
        guard agent != nil else { return }
        FileManager.default.createFile(atPath: tailscaleDisabledMarkerURL().path, contents: nil)
        agent = nil
        loginPendingSince = nil
        funnelConfirmed = false
        agentIssueText = nil
        apply(.notSetUp)

        Task.detached(priority: .utility) {
            let sm = SMAppService.agent(plistName: tailscaleLaunchAgentConfig.plistName)
            do {
                try await sm.unregister()
            } catch {
                writeError("Timeline remote access: turn off failed to unregister agent: \(error)\n")
            }
            await MainActor.run { self.refresh() }
        }
    }

    // User-initiated login. Runs `tailscale up --hostname=timeline`, opens the
    // printed auth URL, then abandons the process (the daemon finishes the
    // login). Only reachable from .needsLogin, or from a pending login after
    // the retry cooldown.
    func logIn() {
        switch state {
        case .needsLogin:
            break
        case .loggingIn where canRetryLogin:
            break
        default:
            return
        }

        loginPendingSince = Date()
        apply(.loggingIn)

        let socket = tailscaleSocketPath()
        Task.detached(priority: .userInitiated) {
            let url = Self.startInteractiveLogin(socket: socket)
            await MainActor.run {
                if let url {
                    _ = NSWorkspace.shared.open(url)
                    // Latch stays set: the poll keeps showing .loggingIn until
                    // the backend reaches Running.
                } else {
                    writeError("Timeline remote access: could not obtain a login URL.\n")
                    self.loginPendingSince = nil
                }
                self.refresh()
            }
        }
    }

    func copyPublicURL() {
        guard let url = publicURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }

    // Register (own) the agent only while the user's opt-in is active.
    private func adoptAgentIfEnabled() {
        guard agent == nil, isRemoteAccessEnabled() else { return }
        agent = ServiceAgentController(config: tailscaleLaunchAgentConfig)
    }

    func refresh() {
        agentIssueText = agent?.issueText

        guard !refreshInFlight else { return }
        refreshInFlight = true

        let enabled = isRemoteAccessEnabled()
        let socket = tailscaleSocketPath()
        let loginPending = loginPendingSince != nil

        Task.detached(priority: .utility) {
            let next = Self.computeState(
                enabled: enabled,
                socket: socket,
                loginPending: loginPending
            )
            await MainActor.run {
                self.refreshInFlight = false
                self.apply(next)
                if case .running(let dnsName) = next {
                    // Reaching Running resolves any pending login.
                    self.loginPendingSince = nil
                    self.ensureFunnel(socket: socket, dnsName: dnsName)
                } else {
                    self.funnelConfirmed = false
                    if next == .notSetUp || next == .notInstalled {
                        self.loginPendingSince = nil
                    }
                }
            }
        }
    }

    private func apply(_ next: RemoteAccessState) {
        guard next != state else { return }
        state = next
    }

    // Apply the funnel config idempotently: only when the running node isn't
    // already funnelling the configured port. Once confirmed configured, the
    // result is cached so polls stop spawning `funnel status`; an in-flight
    // guard keeps overlapping wake+timer events from racing.
    private func ensureFunnel(socket: String, dnsName: String) {
        guard !funnelConfirmed, !funnelCheckInFlight else { return }
        funnelCheckInFlight = true
        let port = servicePort

        Task.detached(priority: .utility) {
            let configured = Self.isFunnelConfigured(socket: socket, port: port, dnsName: dnsName)
            if !configured {
                writeError("Timeline remote access: applying funnel for port \(port).\n")
                _ = Self.runTailscale(socket: socket, ["funnel", "--bg", String(port)])
                // Leave funnelConfirmed false: the next poll re-checks and
                // caches only a verified config.
            }
            await MainActor.run {
                self.funnelCheckInFlight = false
                self.funnelConfirmed = configured
            }
        }
    }

    // MARK: - CLI (off-main)

    nonisolated private static func computeState(
        enabled: Bool,
        socket: String,
        loginPending: Bool
    ) -> RemoteAccessState {
        guard enabled else { return .notSetUp }
        guard FileManager.default.isExecutableFile(atPath: tailscaledExecutable),
              FileManager.default.isExecutableFile(atPath: tailscaleExecutable) else {
            return .notInstalled
        }

        guard let status = runTailscale(socket: socket, ["status", "--json"]),
              let json = try? JSONSerialization.jsonObject(with: Data(status.utf8)) as? [String: Any] else {
            // Daemon not answering the socket yet (just registered / restarting).
            return loginPending ? .loggingIn : .starting
        }

        let backendState = json["BackendState"] as? String
        switch backendState {
        case "Running":
            if let dnsName = Self.dnsName(from: json) {
                return .running(dnsName: dnsName)
            }
            return .starting
        case "NeedsLogin", "Stopped":
            return loginPending ? .loggingIn : .needsLogin
        default:
            return loginPending ? .loggingIn : .starting
        }
    }

    nonisolated private static func dnsName(from statusJSON: [String: Any]) -> String? {
        guard let selfNode = statusJSON["Self"] as? [String: Any],
              let dnsName = selfNode["DNSName"] as? String,
              !dnsName.isEmpty else { return nil }
        // The status DNSName carries a trailing dot; strip it for a usable host.
        return dnsName.hasSuffix(".") ? String(dnsName.dropLast()) : dnsName
    }

    nonisolated private static func isFunnelConfigured(socket: String, port: Int, dnsName: String) -> Bool {
        guard let output = runTailscale(socket: socket, ["funnel", "status", "--json"]),
              let json = try? JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any] else {
            return false
        }
        // Configured means BOTH halves are present: the Web proxy mapping to our
        // local port AND funnel (public) exposure enabled for the node's :443.
        // A serve-only config (proxy without AllowFunnel) is not public, so it
        // must not short-circuit the apply.
        guard let allowFunnel = json["AllowFunnel"] as? [String: Any],
              allowFunnel["\(dnsName):443"] as? Bool == true else {
            return false
        }
        guard let web = json["Web"] as? [String: Any] else { return false }
        let needle = "http://127.0.0.1:\(port)"
        return jsonContainsProxyTarget(web, needle: needle)
    }

    nonisolated private static func jsonContainsProxyTarget(_ node: Any, needle: String) -> Bool {
        switch node {
        case let dict as [String: Any]:
            for (_, value) in dict {
                if let proxy = value as? String, proxy == needle { return true }
                if jsonContainsProxyTarget(value, needle: needle) { return true }
            }
            return false
        case let array as [Any]:
            return array.contains { jsonContainsProxyTarget($0, needle: needle) }
        case let string as String:
            return string == needle
        default:
            return false
        }
    }

    // Runs `tailscale up --hostname=timeline` with a pipe, parses the auth URL
    // from its stdout, then terminates the process (the daemon continues the
    // login independently). Never re-runs while a login is already pending — the
    // caller (logIn) is gated on the loginPendingSince latch.
    nonisolated private static func startInteractiveLogin(socket: String) -> URL? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tailscaleExecutable)
        process.arguments = ["--socket=\(socket)", "up", "--hostname=timeline"]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = stdout

        do {
            try process.run()
        } catch {
            writeError("Timeline remote access: failed to launch `tailscale up`: \(error)\n")
            return nil
        }

        // `up` prints "To authenticate, visit:\n\n\t<URL>" then blocks. Read the
        // stream until a URL appears, then abandon the process.
        //
        // availableData blocks until data or EOF, so the wall-clock check below
        // can't fire while `tailscale up` stalls before printing anything (e.g.
        // a daemon/socket handshake hang). The watchdog enforces the deadline
        // for real: terminating the process EOFs the pipe, which unblocks the
        // read, the loop exits, and the caller's failure path clears the
        // pending-login latch so the login button returns immediately.
        let timeout: TimeInterval = 30
        let deadline = Date().addingTimeInterval(timeout)
        let watchdog = DispatchWorkItem {
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: watchdog)
        // Sole cleanup for every exit: terminate at most once more (guarded —
        // terminate() after exit would raise), then reap. waitUntilExit always
        // runs after any terminate, including one the watchdog already sent.
        defer {
            watchdog.cancel()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }

        let handle = stdout.fileHandleForReading
        var buffer = Data()
        while Date() < deadline {
            let chunk = handle.availableData
            if chunk.isEmpty {
                if !process.isRunning { break }
                Thread.sleep(forTimeInterval: 0.2)
                continue
            }
            buffer.append(chunk)
            if let url = firstURL(inLoginOutput: String(decoding: buffer, as: UTF8.self)) {
                return url
            }
        }

        return firstURL(inLoginOutput: String(decoding: buffer, as: UTF8.self))
    }

    nonisolated private static func firstURL(inLoginOutput text: String) -> URL? {
        for token in text.split(whereSeparator: { $0.isWhitespace }) {
            let trimmed = token.trimmingCharacters(in: CharacterSet(charactersIn: "\t \n\r"))
            if trimmed.hasPrefix("https://"), let url = URL(string: trimmed) {
                return url
            }
        }
        return nil
    }

    // Runs a short-lived `tailscale --socket=… <args>` and returns stdout, or nil
    // on a non-zero exit / launch failure.
    nonisolated private static func runTailscale(socket: String, _ args: [String]) -> String? {
        guard let result = runCommand(tailscaleExecutable, ["--socket=\(socket)"] + args, captureStderr: false),
              result.succeeded else { return nil }
        return result.output
    }
}
