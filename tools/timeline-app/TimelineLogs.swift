import Foundation

// Where TimelineAgent writes the service and Tailscale logs; the menu opens it.
func timelineLogsDirectory() -> URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/timeline")
}
