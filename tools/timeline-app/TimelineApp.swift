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
            // Status lines are Buttons, not Text: a menu draws Text as a
            // disabled item, which is illegible over a translucent menu.
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
            Button(issue, action: openLogs)
        }
        if let other = serviceAgent.otherInstalledCopy {
            let showOther = { NSWorkspace.shared.activateFileViewerSelecting([other]) }
            Button("Timeline is also installed at \((other.path as NSString).abbreviatingWithTildeInPath)", action: showOther)
            Button("Show Other Copy in Finder", action: showOther)
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
            Button(age, action: openRecallPage)
        }
        if let issue = recall.issue {
            Button(issue, action: openRecallPage)
        }
        if recall.needsPermission {
            Button("Allow Timeline to Record Screen…") {
                recall.setRecording(true)
            }
            Button("Enable Timeline in Settings, then quit and reopen it.") {
                recall.openPermissionSettings()
            }
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
        if let issue = updates.issue { Button(issue, action: openLogs) }

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
            if let version = service.runningVersion.flatMap({ $0.version ?? $0.commit }) {
                Divider()
                Button("Version \(version)") { copyToClipboard(version) }
            }
        }

        Button("Quit Timeline", systemImage: "xmark.rectangle") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }

    // Shown only while the service is not healthy.
    @ViewBuilder private var serviceStatusText: some View {
        switch service.status {
        case .checking: Button("Service: checking...", action: openLogs)
        case .running: EmptyView()
        case .notResponding:
            if let error = service.configurationError {
                Button("Service: configuration error", action: openLogs)
                Button(error, action: openLogs)
            } else {
                Button("Service: not responding", action: openLogs)
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
            Button("Remote Access: off", action: openLogs)
            Button("Set Up Remote Access…") { remoteAccess.setUp() }
        case .notInstalled:
            let installCommand = "brew install tailscale"
            Button("Remote Access: Tailscale not installed", action: openLogs)
            Button("Install with: \(installCommand)") { copyToClipboard(installCommand) }
        case .starting:
            Button("Remote Access: starting…", action: openLogs)
        case .needsLogin:
            Button("Remote Access: needs login", action: openLogs)
            Button("Log In to Tailscale…") { remoteAccess.logIn() }
        case .loggingIn:
            Button("Remote Access: waiting for browser authorization…", action: openLogs)
            if remoteAccess.canRetryLogin {
                // Retrying invalidates the pending auth URL (new node key).
                Button("Retry Login…") { remoteAccess.logIn() }
            }
        case .running:
            Button(remoteAccess.makingPublic ? "Remote Access: making public…" : "Remote Access: tailnet only") {
                remoteAccess.copyURL()
            }
        case .publicAccess(_, let until):
            Button("Remote Access: public until \(until.formatted(date: Calendar.current.isDateInToday(until) ? .omitted : .abbreviated, time: .shortened))") {
                remoteAccess.copyURL()
            }
        case .unconfirmed:
            Button("Remote Access: could not confirm it is tailnet only", action: openLogs)
            Button("Turn Remote Access off if this persists.", action: openLogs)
        }

        switch remoteAccess.publicAccessFailure {
        case .funnelNotEnabled(let enableURL):
            Button("Could not make public: \(PublicAccessFailure.funnelNotEnabledText)", action: openLogs)
            Button(PublicAccessFailure.enableFunnelHint, action: openLogs)
            if let enableURL {
                Button(PublicAccessFailure.enableFunnelLabel) { _ = NSWorkspace.shared.open(enableURL) }
            }
        case .other(let reason):
            Button("Could not make public: \(reason)", action: openLogs)
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
            Button(issue, action: openLogs)
        }
        if remoteAccess.requiresApproval {
            Button("Approve Remote Access in Login Items Settings") {
                SMAppService.openSystemSettingsLoginItems()
            }
        }
    }

    private var copyURLButton: some View {
        Button("Copy URL", systemImage: "doc.on.doc") { remoteAccess.copyURL() }
    }

    private var turnOffRemoteAccessButton: some View {
        Button("Turn Off Remote Access", systemImage: "power") { remoteAccess.turnOff() }
    }

    private func remoteAccessMenu(dnsName: String, offerPublic: Bool) -> some View {
        Menu("Remote Access", systemImage: "network") {
            Button(dnsName) { remoteAccess.copyURL() }
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
        case .notCapturing: Button("Recall: not capturing", action: openRecallPage)
        case .paused: Button("Recall: paused", action: openRecallPage)
        }
    }

    // Click actions for status lines: each only opens something or copies.
    private func openLogs() {
        NSWorkspace.shared.open(timelineLogsDirectory())
    }

    private func openRecallPage() {
        NSWorkspace.shared.open(service.baseURL.appendingPathComponent("sync/recall"))
    }

    private func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
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
