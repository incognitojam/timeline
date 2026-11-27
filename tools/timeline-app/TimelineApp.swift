import Foundation
import SwiftUI
import AppKit
import ServiceManagement

// The same executable runs as the app or, started by the app, as its OCR
// worker, before any app state, UI, updater or service agent is created.
@main
enum TimelineMain {
    @MainActor
    static func main() {
        if CommandLine.arguments.dropFirst().first == RecallOCR.workerFlag { RecallOCR.runWorker() }
        TimelineApp.main()
    }
}

struct TimelineApp: App {
    @StateObject private var recall = RecallController()
    @StateObject private var loginItems = LoginItemController()
    @StateObject private var service = ServiceController()
    @NSApplicationDelegateAdaptor(UpdateController.self) private var updates
    @StateObject private var serviceAgent = ServiceAgentController(config: serviceLaunchAgentConfig)
    @StateObject private var remoteAccess = RemoteAccessController()

    var body: some Scene {
        MenuBarExtra {
            // A menu draws Text as a dimmed, disabled item: status lines
            // are Text so they read differently from the actions.
            menuContent
                // macOS 27 hides menu item symbols unless asked to show them.
                .labelStyle(.titleAndIcon)
        } label: {
            Image(systemName: iconName)
                .onAppear { updates.configure(serviceAgent: serviceAgent) }
        }
        .menuBarExtraStyle(.menu)
    }

    @ViewBuilder private var menuContent: some View {
        if service.status != .running {
            serviceStatusText
            restartServiceButton
        }
        if let issue = serviceAgent.issueText {
            Text(issue)
        }
        if let other = serviceAgent.otherInstalledCopy {
            Text("Timeline is also installed at \((other.path as NSString).abbreviatingWithTildeInPath)")
            Button("Show Other Copy in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([other])
            }
        }
        if serviceAgent.requiresApproval {
            Button("Approve Service in Login Items Settings") {
                SMAppService.openSystemSettingsLoginItems()
            }
        }

        Button("Open Timeline", systemImage: "arrow.up.forward.app") {
            service.openTimeline()
        }

        Divider()

        remoteAccessSection

        Divider()

        Toggle("Record Screen", isOn: Binding(
            get: { recall.isRecordingEnabled },
            set: { recall.setRecording($0) }
        ))

        recallStatusText
        if let age = recall.lastCaptureAgeString {
            Text(age)
        }
        if let issue = recall.issue {
            Text(issue)
        }
        if recall.needsPermission {
            Button("Allow Timeline to Record Screen…") {
                recall.setRecording(true)
            }
            Text("Enable Timeline in Settings, then quit and reopen it.")
        } else if recall.status == .notCapturing && !recall.captureStuck {
            Button("Open Screen Recording Settings…") {
                recall.openPermissionSettings()
            }
        }

        Divider()

        if loginItems.requiresApproval {
            Button("Approve in Login Items Settings") {
                SMAppService.openSystemSettingsLoginItems()
            }
        }
        if updates.updateStaged {
            Button("Install Update and Relaunch…") { updates.checkForUpdates() }
                .disabled(!updates.canInstallStagedUpdate)
        }
        if let issue = updates.issue { Text(issue) }

        Menu("Settings", systemImage: "gearshape") {
            Toggle("Launch at Login", isOn: Binding(
                get: { loginItems.isEnabled },
                set: { loginItems.setEnabled($0) }
            ))
            if service.status == .running {
                restartServiceButton
            }
            Button("Check for Updates…", systemImage: "arrow.down.circle") {
                updates.checkForUpdates()
            }
            .disabled(!updates.canCheck)
            Toggle("Check for Updates Automatically", isOn: Binding(
                get: { updates.automaticallyChecks },
                set: { updates.setAutomaticallyChecks($0) }
            ))
            .disabled(!updates.settingsAvailable)
            Toggle("Download and Install Updates Automatically", isOn: Binding(
                get: { updates.automaticallyDownloads },
                set: { updates.setAutomaticallyDownloads($0) }
            ))
            .disabled(!updates.settingsAvailable || !updates.allowsAutomaticDownloads)
            if let version = service.runningVersion.flatMap({ $0.version ?? $0.commit }) {
                Divider()
                Text("Version \(version)")
            }
        }

        Button("Quit Timeline", systemImage: "xmark.rectangle") {
            remoteAccess.prepareForOwnerQuit()
            NSApplication.shared.terminate(nil)
        }
            .keyboardShortcut("q")
    }

    // Shown only while the service is not healthy.
    @ViewBuilder private var serviceStatusText: some View {
        switch service.status {
        case .checking: Text("Service: checking...")
        case .starting: Text("Service: starting…")
        case .running: EmptyView()
        case .notResponding:
            if let error = service.configurationError {
                Text("Service: configuration error")
                Text(error)
            } else {
                Text("Service: not responding")
            }
        }
    }

    private var restartServiceButton: some View {
        Button("Restart Service", systemImage: "arrow.clockwise") {
            service.restartService()
        }
    }

    @ViewBuilder private var remoteAccessSection: some View {
        switch remoteAccess.state {
        case .notSetUp:
            Text("Remote Access: off")
            Button("Set Up Remote Access…") { remoteAccess.setUp() }
        case .notInstalled:
            Text("Remote Access: Tailscale not installed")
            Text("Install with: brew install tailscale")
        case .starting:
            Text("Remote Access: starting…")
        case .needsLogin:
            Text("Remote Access: needs login")
            Button("Log In to Tailscale…") { remoteAccess.logIn() }
        case .loggingIn:
            Text("Remote Access: waiting for browser authorization…")
            if remoteAccess.canRetryLogin {
                // Retrying invalidates the pending auth URL (new node key).
                Button("Retry Login…") { remoteAccess.logIn() }
            }
        case .running:
            Text(remoteAccess.makingPublic ? "Remote Access: making public…" : "Remote Access: tailnet only")
        case .publicAccess(_, let until):
            let end = until.formatted(date: Calendar.current.isDateInToday(until) ? .omitted : .abbreviated, time: .shortened)
            switch remoteAccess.reachability {
            case .reachable:
                Text("Remote Access: public until \(end)")
            case .unconfirmed(let reason):
                Text("Remote Access: public until \(end), not confirmed reachable")
                Text("Last check: \(reason)")
                Button("Check Again", systemImage: "arrow.clockwise") { remoteAccess.checkReachabilityAgain() }
            case .checking, nil:
                Text("Remote Access: public until \(end), checking…")
                Text("Checking that it answers from the internet…")
            }
        case .unconfirmed:
            Text("Remote Access: could not confirm it is tailnet only")
            Text("Turn Remote Access off if this persists.")
        }

        if remoteAccess.resumingPublicAccess {
            Text("Public access resumes after the update")
            Button("Stop Public Access", systemImage: "stop.circle") { remoteAccess.endPublicAccess() }
        }

        switch remoteAccess.publicAccessFailure {
        case .funnelNotEnabled(let enableURL):
            Text("Could not make public: \(PublicAccessFailure.funnelNotEnabledText)")
            Text(PublicAccessFailure.enableFunnelHint)
            if let enableURL {
                Button(PublicAccessFailure.enableFunnelLabel) { _ = NSWorkspace.shared.open(enableURL) }
            }
        case .other(let reason):
            Text("Could not make public: \(reason)")
        case nil:
            EmptyView()
        }

        switch remoteAccess.state {
        case .notSetUp:
            EmptyView()
        case .running(let dnsName):
            copyURLButton
            remoteAccessMenu(dnsName: dnsName, offerPublic: !remoteAccess.makingPublic)
        case .publicAccess(let dnsName, _):
            Button("Stop Public Access", systemImage: "stop.circle") { remoteAccess.endPublicAccess() }
            copyURLButton
            remoteAccessMenu(dnsName: dnsName, offerPublic: false)
        case .notInstalled, .starting, .needsLogin, .loggingIn, .unconfirmed:
            turnOffRemoteAccessButton
        }

        if let issue = remoteAccess.agentIssueText {
            Text(issue)
        }
        if remoteAccess.requiresApproval {
            Button("Approve Remote Access in Login Items Settings") {
                SMAppService.openSystemSettingsLoginItems()
            }
        }
    }

    private var copyURLButton: some View {
        let label: String
        switch (remoteAccess.state, remoteAccess.reachability) {
        case (.publicAccess, .reachable?), (.running, _):
            label = "Copy URL"
        default:
            label = "Copy URL (not confirmed reachable)"
        }
        return Button(label, systemImage: "doc.on.doc") { remoteAccess.copyURL() }
    }

    private var turnOffRemoteAccessButton: some View {
        Button("Turn Off Remote Access", systemImage: "power") { remoteAccess.turnOff() }
    }

    private func remoteAccessMenu(dnsName: String, offerPublic: Bool) -> some View {
        Menu("Remote Access", systemImage: "network") {
            Text(dnsName)
            if offerPublic {
                Menu("Make Public on the Internet", systemImage: "globe") {
                    ForEach(PublicAccess.durations.indices, id: \.self) { index in
                        let duration = PublicAccess.durations[index]
                        Button("For \(duration.label)") { remoteAccess.makePublic(for: duration.seconds) }
                    }
                }
            }
            Divider()
            turnOffRemoteAccessButton
        }
    }

    // Only states the ticked Record Screen toggle does not already say.
    @ViewBuilder private var recallStatusText: some View {
        switch recall.status {
        case .recording: EmptyView()
        case .notCapturing: Text("Recall: not capturing")
        case .paused: Text("Recall: paused")
        }
    }

    private var iconName: String {
        if case .publicAccess = remoteAccess.state {
            return "globe"
        }
        if service.status == .notResponding {
            return "exclamationmark.triangle.fill"
        }

        switch recall.status {
        case .recording: return "eye"
        case .notCapturing: return "exclamationmark.triangle.fill"
        case .paused: return "eye.slash"
        }
    }
}
