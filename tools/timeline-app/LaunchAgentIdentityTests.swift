import Foundation

@main
struct LaunchAgentIdentityTests {
    static func main() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("timeline-launch-agent-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: root) }

        let expectedProgram = root.appendingPathComponent("timeline-service").path
        let plistURL = root.appendingPathComponent("service.plist")
        let plist: [String: Any] = ["ProgramArguments": [expectedProgram]]
        let plistData = try PropertyListSerialization.data(
            fromPropertyList: plist,
            format: .xml,
            options: 0
        )
        try plistData.write(to: plistURL)

        let submissionPath = "(submitted by smd.501)"
        let current = LaunchCtlLoadedJob(
            plistPath: submissionPath,
            programPath: expectedProgram
        )
        precondition(
            LaunchAgentIdentity.isBundledAgentLoaded(current, bundledAgentPlist: plistURL),
            "matching submitted program should be accepted"
        )

        let stale = LaunchCtlLoadedJob(
            plistPath: submissionPath,
            programPath: "/tmp/old-checkout/deploy/macos/run-service.sh"
        )
        precondition(
            !LaunchAgentIdentity.isBundledAgentLoaded(stale, bundledAgentPlist: plistURL),
            "stale checkout program should require registration reload"
        )

        let directlyLoaded = LaunchCtlLoadedJob(
            plistPath: plistURL.path,
            programPath: nil
        )
        precondition(
            LaunchAgentIdentity.isBundledAgentLoaded(directlyLoaded, bundledAgentPlist: plistURL),
            "direct bundled plist path should be accepted"
        )

        let app = root.appendingPathComponent("Moved App/Timeline.app")
        let agent = app.appendingPathComponent("Contents/Library/LaunchAgents/service.plist")
        try fileManager.createDirectory(at: agent.deletingLastPathComponent(), withIntermediateDirectories: true)
        let relative: [String: Any] = [
            "BundleProgram": "Contents/MacOS/TimelineAgent",
            "ProgramArguments": ["TimelineAgent", "service"]
        ]
        try PropertyListSerialization.data(fromPropertyList: relative, format: .xml, options: 0).write(to: agent)
        precondition(LaunchAgentIdentity.isBundledAgentLoaded(
            LaunchCtlLoadedJob(plistPath: submissionPath, programPath: app.appendingPathComponent("Contents/MacOS/TimelineAgent").path),
            bundledAgentPlist: agent
        ), "BundleProgram must resolve against the current app location")
        precondition(!LaunchAgentIdentity.isBundledAgentLoaded(stale, bundledAgentPlist: agent),
            "BundleProgram must reject the previous program")

        let info: [String: Any] = [
            "CFBundleIdentifier": "com.example.timeline",
            "CFBundleVersion": "42"
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: app.appendingPathComponent("Contents/Info.plist"))
        let bundledSubmission = """
        gui/501/dev.example.service = {
            path = (submitted by smd.123)
            program identifier = Contents/MacOS/TimelineAgent (mode: 2)
            parent bundle identifier = com.example.timeline
            parent bundle version = 42
            arguments = {
                TimelineAgent
                service
            }
        }
        """
        let cases: [(String, String, Bool)] = [
            ("current bundle-relative program", bundledSubmission, true),
            ("stale bundle version", bundledSubmission.replacingOccurrences(of: "version = 42", with: "version = 41"), false),
            ("different parent bundle", bundledSubmission.replacingOccurrences(of: "com.example.timeline", with: "com.example.other"), false),
            ("different bundled executable", bundledSubmission.replacingOccurrences(of: "Contents/MacOS/TimelineAgent", with: "Contents/MacOS/OtherAgent"), false),
            ("missing parent identity", bundledSubmission.replacingOccurrences(of: "parent bundle identifier = com.example.timeline", with: ""), false),
            ("unknown program mode", bundledSubmission.replacingOccurrences(of: "(mode: 2)", with: "(mode: 9)"), false)
        ]
        for (name, output, expected) in cases {
            let actual = LaunchAgentIdentity.isBundledAgentLoaded(
                LaunchAgentIdentity.loadedJob(from: output), bundledAgentPlist: agent
            )
            if actual != expected {
                FileHandle.standardError.write(Data("Failed: \(name)\n".utf8))
                exit(1)
            }
        }
    }
}
