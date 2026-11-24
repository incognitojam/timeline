// Remote Access (Tailscale Serve) ownership for the Timeline menu bar app.
//
// A userspace `tailscaled` (run by the dev.incognitojam.timeline-tailscale
// LaunchAgent, see deploy/macos/run-tailscale.sh) serves the local Timeline
// service to the user's tailnet only, via Tailscale Serve. This controller owns
// that agent (reusing ServiceAgentController's SMAppService own/reconcile
// machinery) and drives the tailscale login/serve state through the CLI over
// the node's own socket.
//
// Opt-in: nothing is registered or spawned until the user sets it up (which
// creates the state directory). Turning it off unregisters the agent but keeps
// the state directory, so login/serve state persists for a later re-enable.
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

// Present only while the user has turned public access on; its contents decide
// whether Funnel may stay on (see PublicAccess).
private func publicAccessRecordURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/share/timeline/tailscale-public-access")
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
    // Up and serving to the tailnet; dnsName is the node's DNS name (trailing
    // dot stripped).
    case running(dnsName: String)
    // Up and public on the internet via Funnel until `until`, as the user
    // asked; also served to the tailnet.
    case publicAccess(dnsName: String, until: Date)
    // Up, but the serve config could not be confirmed tailnet-only (the CLI
    // failed, or Funnel would not turn off). Never shown as tailnet only.
    case unconfirmed
}

// Why the last attempt to turn on public access failed, shown until the next
// attempt or until Remote Access is turned off.
enum PublicAccessFailure: Equatable {
    // The node lacks the funnel (or https) capability; enableURL is the link
    // `tailscale funnel` printed for enabling it, if any.
    case funnelNotEnabled(enableURL: URL?)
    case other(reason: String)

    static let funnelNotEnabledText = "Funnel is not allowed for this device."
    static let enableFunnelHint = "Allow it in your tailnet's access controls (the funnel node attribute), then try again."
    static let enableFunnelLabel = "Enable Funnel in Tailscale…"
}

@MainActor
final class RemoteAccessController: ObservableObject {
    @Published private(set) var state: RemoteAccessState = .notSetUp
    // Surfaces the underlying agent ownership issue (approval, failed, …) when set.
    @Published private(set) var agentIssueText: String?
    @Published private(set) var publicAccessFailure: PublicAccessFailure?
    // The record a Make Public click wrote, until a refresh that read it or
    // started after it ends. Display only: what is exposed is still decided
    // by the record and config.
    @Published private var attemptRecord: String?
    var makingPublic: Bool { attemptRecord != nil }

    // The service port is the single source of truth for what to serve.
    private let servicePort: Int
    private var agent: ServiceAgentController?
    private var scheduler: RefreshScheduler?
    private var refreshInFlight = false
    // A refresh asked for while one was in flight, run when it finishes so a
    // change to public access is never left to the next poll.
    private var refreshQueued = false
    private var terminationObserver: NSObjectProtocol?
    // Latched at logIn() and cleared only when the backend reaches Running (or
    // the feature is turned off / the login never started). While latched the
    // poll renders .loggingIn instead of .needsLogin, so the login button can't
    // fire a second `tailscale up` that would regenerate the node key.
    private var loginPendingSince: Date?
    // How long a pending login blocks retries. After this, an explicit
    // "Retry Login…" is offered (retrying invalidates the pending auth URL).
    private let loginRetryCooldown: TimeInterval = 180

    init(endpoint: TimelineServiceEndpoint = loadTimelineServiceEndpoint()) {
        servicePort = endpoint.port
        adoptAgentIfEnabled()
        scheduler = RefreshScheduler { [weak self] in Task { @MainActor in self?.refresh() } }
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.endPublicAccessOnQuit() }
        }
        refresh()
    }

    var requiresApproval: Bool {
        agent?.requiresApproval ?? false
    }

    // https URL for the running node, or nil when not running.
    var nodeURL: URL? {
        switch state {
        case .running(let dnsName), .publicAccess(let dnsName, _):
            return URL(string: "https://\(dnsName)")
        default:
            return nil
        }
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
        removePublicAccessRecord()
        publicAccessFailure = nil
        attemptRecord = nil
        agent = nil
        loginPendingSince = nil
        agentIssueText = nil
        apply(.notSetUp)

        let socket = tailscaleSocketPath()
        Task.detached(priority: .utility) {
            // In case unregistering fails and tailscaled keeps running.
            _ = Self.runTailscale(socket: socket, ["serve", "reset"])
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

    func copyURL() {
        guard let url = nodeURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }

    // Records when public access ends, then lets refresh turn Funnel on.
    func makePublic(for duration: TimeInterval) {
        guard case .running = state, !makingPublic else { return }
        publicAccessFailure = nil
        let record = PublicAccess.record(start: Date(), duration: duration)
        do {
            try record.write(to: publicAccessRecordURL(), atomically: true, encoding: .utf8)
            attemptRecord = record
        } catch {
            writeError("Timeline remote access: could not record public access: \(error)\n")
            let failure = PublicAccessFailure.other(reason: "could not record when it ends.")
            publicAccessFailure = failure
            showMakePublicFailure(failure)
        }
        refresh()
    }

    // An alert, so a failed click is answered even with the menu closed.
    private func showMakePublicFailure(_ failure: PublicAccessFailure) {
        // Shown after the caller returns: runModal blocks until dismissed.
        Task { @MainActor in
            let alert = NSAlert()
            alert.messageText = "Could not make Timeline public"
            var enableURL: URL?
            switch failure {
            case .funnelNotEnabled(let url):
                alert.informativeText = "\(PublicAccessFailure.funnelNotEnabledText) \(PublicAccessFailure.enableFunnelHint)"
                enableURL = url
            case .other(let reason):
                alert.informativeText = reason
            }
            if enableURL != nil { alert.addButton(withTitle: PublicAccessFailure.enableFunnelLabel) }
            alert.addButton(withTitle: "OK")
            NSApp.activate()
            if alert.runModal() == .alertFirstButtonReturn, let enableURL {
                _ = NSWorkspace.shared.open(enableURL)
            }
        }
    }

    func endPublicAccess() {
        removePublicAccessRecord()
        refresh()
    }

    // Public access needs the app to watch its expiry, so it ends when the app
    // quits. This blocks the quit for as long as one CLI call takes.
    private func endPublicAccessOnQuit() {
        guard removePublicAccessRecord() else { return }
        _ = Self.runTailscale(socket: tailscaleSocketPath(), ["serve", "reset"])
    }

    // Returns whether there was a record to remove.
    @discardableResult
    private func removePublicAccessRecord() -> Bool {
        (try? FileManager.default.removeItem(at: publicAccessRecordURL())) != nil
    }

    // Register (own) the agent only while the user's opt-in is active.
    private func adoptAgentIfEnabled() {
        guard agent == nil, isRemoteAccessEnabled() else { return }
        agent = ServiceAgentController(config: tailscaleLaunchAgentConfig)
    }

    func refresh() {
        agentIssueText = agent?.issueText

        guard !refreshInFlight else {
            refreshQueued = true
            return
        }
        refreshInFlight = true

        let enabled = isRemoteAccessEnabled()
        let socket = tailscaleSocketPath()
        let loginPending = loginPendingSince != nil
        let port = servicePort
        let attemptAtStart = attemptRecord

        Task.detached(priority: .utility) {
            // Fail closed: any record that doesn't allow public access now is
            // removed, and the node goes back to tailnet only.
            let record = try? String(contentsOf: publicAccessRecordURL(), encoding: .utf8)
            let publicUntil = enabled ? PublicAccess.end(of: record, now: Date()) : nil
            if record != nil, publicUntil == nil {
                try? FileManager.default.removeItem(at: publicAccessRecordURL())
            }
            var failure: PublicAccessFailure?
            var next = Self.computeState(
                enabled: enabled,
                socket: socket,
                loginPending: loginPending
            )
            if case .running(let dnsName) = next {
                (next, failure) = Self.enforceExposure(
                    publicUntil: publicUntil, socket: socket, port: port, dnsName: dnsName)
            } else if enabled, publicUntil == nil,
                      let config = Self.serveConfig(socket: socket), Self.isFunnelOn(config) {
                // Not Running yet (e.g. just after wake) but already carrying
                // Funnel: end it now rather than at the first Running poll.
                _ = Self.runTailscale(socket: socket, ["serve", "reset"])
            }
            let shown = next
            let failed = failure
            await MainActor.run {
                self.refreshInFlight = false
                self.apply(shown)
                if let failed { self.publicAccessFailure = failed }
                switch shown {
                case .starting, .needsLogin, .loggingIn:
                    // The record is kept, so a later refresh answers a click.
                    break
                default:
                    // Reaching Running resolves any pending login; so does
                    // the feature being off or uninstalled.
                    self.loginPendingSince = nil
                    // Answers the click if this refresh read its record or
                    // started after it (the record may be gone by then).
                    if let attempt = self.attemptRecord, record == attempt || attemptAtStart == attempt {
                        self.attemptRecord = nil
                        if let failed { self.showMakePublicFailure(failed) }
                    }
                }
                if case .publicAccess(_, let until) = shown, until.timeIntervalSinceNow < 30 {
                    self.scheduler?.scheduleNextPoll(at: until)
                }
                if self.refreshQueued {
                    self.refreshQueued = false
                    self.refresh()
                }
            }
        }
    }

    private func apply(_ next: RemoteAccessState) {
        guard next != state else { return }
        state = next
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

    // Makes the node public until `publicUntil` if it is set, else tailnet
    // only, and returns the state that the resulting config confirms. A failed
    // attempt at public access ends it, and is returned with why.
    nonisolated private static func enforceExposure(
        publicUntil: Date?, socket: String, port: Int, dnsName: String
    ) -> (RemoteAccessState, PublicAccessFailure?) {
        var failure: PublicAccessFailure?
        if let until = publicUntil {
            failure = enforcePublic(socket: socket, port: port, dnsName: dnsName)
            if failure == nil {
                return (.publicAccess(dnsName: dnsName, until: until), nil)
            }
            try? FileManager.default.removeItem(at: publicAccessRecordURL())
        }
        let state: RemoteAccessState = enforceTailnetOnly(socket: socket, port: port, dnsName: dnsName)
            ? .running(dnsName: dnsName) : .unconfirmed
        return (state, failure)
    }

    // Funnel on for the service's :443 proxy and for nothing else, so no other
    // port (such as a raw TCP forward without Tailscale's headers) is public.
    // Returns nil once the config confirms it, else why not.
    nonisolated private static func enforcePublic(
        socket: String, port: Int, dnsName: String
    ) -> PublicAccessFailure? {
        func confirmed(_ config: [String: Any]) -> Bool {
            let allow = config["AllowFunnel"] as? [String: Any] ?? [:]
            return allow.count == 1 && allow["\(dnsName):443"] as? Bool == true
                && (config["Foreground"] as? [String: Any] ?? [:]).isEmpty
                && isServing(config, port: port, dnsName: dnsName)
        }
        guard let config = serveConfig(socket: socket) else {
            return .other(reason: "could not read the serve config.")
        }
        if confirmed(config) { return nil }
        if isFunnelOn(config) {
            guard runTailscale(socket: socket, ["serve", "reset"]) != nil else {
                return .other(reason: "could not reset the serve config.")
            }
        }
        writeError("Timeline remote access: turning on public access for port \(port).\n")
        // Without Funnel enabled for the node, `funnel` prints how to enable it
        // and then either exits or waits until it is enabled; the timeout ends
        // that wait, keeping what it printed.
        let result = runCommand(
            tailscaleExecutable,
            ["--socket=\(socket)", "funnel", "--bg", "--https=443", proxyTarget(port)],
            timeout: 10,
            returnTerminatedResult: true)
        if serveConfig(socket: socket).map(confirmed) == true { return nil }

        let output = result?.output ?? ""
        writeError("Timeline remote access: could not turn on public access: \(output)\n")
        if let capabilities = selfCapabilities(socket: socket),
           !(capabilities.contains("funnel") && capabilities.contains("https")) {
            return .funnelNotEnabled(enableURL: firstURL(in: output))
        }
        let lastLine = output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty })
        guard let lastLine else {
            return .other(reason: result?.terminationStatus == 0
                ? "Funnel did not turn on." : "tailscale funnel did not finish.")
        }
        return .other(reason: lastLine.count > 100 ? String(lastLine.prefix(100)) + "…" : lastLine)
    }

    // The node's own capabilities from `status --json`, or nil if unreadable.
    nonisolated private static func selfCapabilities(socket: String) -> Set<String>? {
        guard let status = runTailscale(socket: socket, ["status", "--json"]),
              let json = try? JSONSerialization.jsonObject(with: Data(status.utf8)) as? [String: Any],
              let selfNode = json["Self"] as? [String: Any] else { return nil }
        return Set((selfNode["CapMap"] as? [String: Any] ?? [:]).keys)
    }

    // Makes the node serve the service to the tailnet and nothing to the
    // internet, and reports whether the resulting config confirms it. Checked
    // on every poll, so a Funnel config left in the state directory by an
    // earlier version of the app, or added by hand, is removed.
    nonisolated private static func enforceTailnetOnly(socket: String, port: Int, dnsName: String) -> Bool {
        func confirmed(_ config: [String: Any]) -> Bool {
            !isFunnelOn(config) && isServing(config, port: port, dnsName: dnsName)
        }
        guard let config = serveConfig(socket: socket) else { return false }
        if confirmed(config) { return true }
        if isFunnelOn(config) {
            // reset clears every handler and Funnel flag in one write; the
            // serve below then adds back the tailnet-only proxy.
            writeError("Timeline remote access: Funnel was on; resetting to tailnet only.\n")
            guard runTailscale(socket: socket, ["serve", "reset"]) != nil else { return false }
        }
        writeError("Timeline remote access: serving port \(port) to the tailnet.\n")
        // The HTTPS reverse-proxy form: tailscaled adds Tailscale-User-Login for
        // tailnet users, which the service relies on. `serve` also clears Funnel
        // for this port in the same write.
        _ = runTailscale(socket: socket, ["serve", "--bg", "--https=443", proxyTarget(port)])
        return serveConfig(socket: socket).map(confirmed) ?? false
    }

    nonisolated private static func proxyTarget(_ port: Int) -> String {
        "http://127.0.0.1:\(port)"
    }

    // The node's serve config from `serve status --json`, or nil if it can't
    // be read. No config prints `null`, which is an empty config.
    nonisolated private static func serveConfig(socket: String) -> [String: Any]? {
        guard let output = runTailscale(socket: socket, ["serve", "status", "--json"]),
              let json = try? JSONSerialization.jsonObject(
                with: Data(output.utf8), options: .fragmentsAllowed) else { return nil }
        if json is NSNull { return [:] }
        return json as? [String: Any]
    }

    // True if any port is open to the internet, in the background config or
    // in a foreground session nested under it.
    nonisolated private static func isFunnelOn(_ config: [String: Any]) -> Bool {
        if let allow = config["AllowFunnel"] as? [String: Any],
           allow.values.contains(where: { $0 as? Bool == true }) {
            return true
        }
        let foreground = config["Foreground"] as? [String: Any] ?? [:]
        return foreground.values.contains { session in
            guard let session = session as? [String: Any] else { return false }
            return isFunnelOn(session)
        }
    }

    // True if :443 terminates HTTPS and proxies / to the service.
    nonisolated private static func isServing(_ config: [String: Any], port: Int, dnsName: String) -> Bool {
        let tcp = config["TCP"] as? [String: Any]
        let web = config["Web"] as? [String: Any]
        let site = web?["\(dnsName):443"] as? [String: Any]
        let root = (site?["Handlers"] as? [String: Any])?["/"] as? [String: Any]
        return (tcp?["443"] as? [String: Any])?["HTTPS"] as? Bool == true
            && root?["Proxy"] as? String == proxyTarget(port)
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
            if let url = firstURL(in: String(decoding: buffer, as: UTF8.self)) {
                return url
            }
        }

        return firstURL(in: String(decoding: buffer, as: UTF8.self))
    }

    nonisolated private static func firstURL(in text: String) -> URL? {
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
