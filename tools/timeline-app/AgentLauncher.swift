import Foundation
import Darwin
import MachO

// launchd resolves BundleProgram; user paths and logs are resolved only at runtime.
@main
struct AgentLauncher {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            throw NSError(domain: "TimelineAgent", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected service, recall, or tailscale"])
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        var size: UInt32 = 0
        _ = _NSGetExecutablePath(nil, &size)
        var path = [CChar](repeating: 0, count: Int(size))
        guard _NSGetExecutablePath(&path, &size) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL))
        }
        let resources = URL(fileURLWithPath: String(cString: path))
            .resolvingSymlinksInPath().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Resources")
        let script: URL
        let logs: URL
        let stdoutName: String
        let stderrName: String
        switch CommandLine.arguments[1] {
        case "service":
            script = resources.appendingPathComponent("timeline-service/bin/timeline-service")
            logs = home.appendingPathComponent("Library/Logs/timeline")
            stdoutName = "service.log"
            stderrName = "service.error.log"
        case "recall":
            // Old launchd registrations may fire during an app replacement.
            // Capture now runs inside Timeline; this migration entry is inert.
            return
        case "tailscale":
            script = resources.appendingPathComponent("run-tailscale.sh")
            logs = home.appendingPathComponent("Library/Logs/timeline")
            stdoutName = "tailscale.log"
            stderrName = "tailscale.error.log"
        default:
            throw NSError(domain: "TimelineAgent", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown agent"])
        }
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        for (name, target) in [(stdoutName, STDOUT_FILENO), (stderrName, STDERR_FILENO)] {
            let fd = open(logs.appendingPathComponent(name).path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
            guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            guard dup2(fd, target) >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            if fd != target { close(fd) }
        }
        let args = ["/bin/bash", script.path].map { argument in
            argument.withCString { strdup($0) }
        }
        defer { args.forEach { free($0) } }
        guard args.allSatisfy({ $0 != nil }) else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOMEM)) }
        var argv = args + [nil]
        execv("/bin/bash", &argv)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
}
