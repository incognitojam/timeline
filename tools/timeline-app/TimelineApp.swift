import Foundation
import SwiftUI
import AppKit
import ServiceManagement

@main
struct TimelineApp: App {
    @StateObject private var recall = RecallController()
    @StateObject private var loginItems = LoginItemController()
    @StateObject private var service = ServiceController()
    @NSApplicationDelegateAdaptor(UpdateController.self) private var updates
    @StateObject private var serviceAgent = ServiceAgentController(config: serviceLaunchAgentConfig)
    @StateObject private var remoteAccess = RemoteAccessController()

    var body: some Scene {
        MenuBarExtra {
            serviceStatusText
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

            Button("Open Timeline") {
                service.openTimeline()
            }

            Button("Restart Service") {
                service.restartService()
            }

            Divider()

            remoteAccessSection

            Divider()

            statusText

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

            Toggle("Record Screen", isOn: Binding(
                get: { recall.isRecordingEnabled },
                set: { recall.setRecording($0) }
            ))

            Toggle("Launch at Login", isOn: Binding(
                get: { loginItems.isEnabled },
                set: { loginItems.setEnabled($0) }
            ))

            if loginItems.requiresApproval {
                Button("Approve in Login Items Settings") {
                    SMAppService.openSystemSettingsLoginItems()
                }
            }

            Divider()

            Button("Check for Updates…") {
                updates.checkForUpdates()
            }
            .disabled(!updates.canCheck)
            if updates.updateStaged {
                Button("Install Update and Relaunch…") { updates.checkForUpdates() }
                    .disabled(!updates.canInstallStagedUpdate)
            }
            if let issue = updates.issue { Text(issue) }

            Button("Quit Timeline") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        } label: {
            Image(systemName: iconName)
                .onAppear { updates.configure(serviceAgent: serviceAgent) }
        }
        .menuBarExtraStyle(.menu)
    }

    @ViewBuilder private var serviceStatusText: some View {
        switch service.status {
        case .checking: Text("Service: checking...")
        case .running: Text(runningStatusLabel)
        case .notResponding:
            if let error = service.configurationError {
                Text("Service: configuration error")
                Text(error)
            } else {
                Text("Service: not responding")
            }
        }
    }

    private var runningStatusLabel: String {
        if let version = service.runningVersion?.version {
            return "Service: running (\(version))"
        }
        if let commit = service.runningVersion?.commit {
            return "Service: running (\(commit))"
        }
        return "Service: running"
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
        case .running(let dnsName):
            Text(remoteAccess.makingPublic ? "Remote Access: making public…" : "Remote Access: tailnet only")
            Text(dnsName)
            Button("Copy URL") { remoteAccess.copyURL() }
            if !remoteAccess.makingPublic {
                Menu("Make Public on the Internet") {
                    ForEach(PublicAccess.durations.indices, id: \.self) { index in
                        let duration = PublicAccess.durations[index]
                        Button("For \(duration.label)") { remoteAccess.makePublic(for: duration.seconds) }
                    }
                }
            }
        case .publicAccess(let dnsName, let until):
            Text("Remote Access: PUBLIC on the internet")
            Text("Until \(until.formatted(date: Calendar.current.isDateInToday(until) ? .omitted : .abbreviated, time: .shortened))")
            Text(dnsName)
            Button("Copy URL") { remoteAccess.copyURL() }
            Button("Turn Off Public Access Now") { remoteAccess.endPublicAccess() }
        case .unconfirmed:
            Text("Remote Access: could not confirm it is tailnet only")
            Text("Turn Remote Access off if this persists.")
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

        if remoteAccess.state != .notSetUp {
            Button("Turn Off Remote Access") { remoteAccess.turnOff() }
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

    @ViewBuilder private var statusText: some View {
        switch recall.status {
        case .recording: Text("Recall: recording")
        case .notCapturing: Text("Recall: not capturing")
        case .paused: Text("Recall: paused")
        }
    }

    private var iconName: String {
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
