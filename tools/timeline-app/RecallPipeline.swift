import Foundation
import Darwin

struct RecallPipeline {
    static let interval: TimeInterval = 30
    // A tick still running after this long is reported as stuck. It exceeds
    // RecallCapture.ocrTimeout so a stuck recognition reports its own error first.
    static let stuckAfter: TimeInterval = 5 * 60
    let home: URL

    var root: URL { home.appendingPathComponent(".local/share/timeline/recall") }
    var pauseFlag: URL { home.appendingPathComponent(".local/share/timeline/recall.pause") }
    var logURL: URL { home.appendingPathComponent(".local/share/timeline-recall/capture.log") }
    var workRoot: URL { root.deletingLastPathComponent().appendingPathComponent("recall-work") }

    static func encoder() throws -> String {
        for path in ["/opt/homebrew/bin/cwebp", "/usr/local/bin/cwebp"] {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        throw RecallError("Install WebP with brew install webp, then enable Record Screen again.")
    }

    func run() async throws -> Int? {
        try checkRecording()
        guard !RecallCapture.screenLocked, try RecallCapture.displayAwake() else { return nil }
        let excluded = try RecallCapture.loadExclusions(home.appendingPathComponent(".config/timeline/recall-exclude.txt").path)
        let encoder = try Self.encoder()
        let now = Date()
        let date = Self.format(now, "yyyy-MM-dd")
        let stamp = Self.format(now, "HHmmss")
        let directory = root.appendingPathComponent(date)
        // Keep unfinished images outside the import tree, on the same filesystem
        // as the published pairs so rename is atomic.
        try cleanAbandonedWork()
        let work = workRoot.appendingPathComponent(UUID().uuidString)
        let fm = FileManager.default
        try fm.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: work) }
        guard try await RecallCapture.capture(outputDir: work.path, stamp: stamp, excluded: excluded) != nil else { return nil }
        try checkRecording()
        let written = try publish(work: work, to: directory, encoder: encoder)
        try prune(before: now.addingTimeInterval(-90 * 24 * 60 * 60))
        return written
    }

    func checkRecording() throws {
        try Task.checkCancellation()
        if FileManager.default.fileExists(atPath: pauseFlag.path) { throw CancellationError() }
    }

    // A quit or crash can interrupt a tick before its defer runs. There is only
    // one capture task, so previous staging directories are safe to retire.
    func cleanAbandonedWork() throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: workRoot.path) else { return }
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        for directory in try fm.contentsOfDirectory(at: workRoot, includingPropertiesForKeys: Array(keys)) {
            guard UUID(uuidString: directory.lastPathComponent) != nil else { continue }
            let info = try directory.resourceValues(forKeys: keys)
            guard info.isDirectory == true, info.isSymbolicLink != true else { continue }
            for file in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys)) {
                let info = try file.resourceValues(forKeys: keys)
                if info.isRegularFile == true, info.isSymbolicLink != true,
                   ["png", "json", "webp"].contains(file.pathExtension) {
                    try fm.removeItem(at: file)
                }
            }
            _ = rmdir(directory.path)
        }
    }

    func publish(work: URL, to directory: URL, encoder: String) throws -> Int {
        let fm = FileManager.default
        let files = try fm.contentsOfDirectory(at: work, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "png" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        if files.isEmpty { return 0 }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        var written = 0
        for png in files {
            try checkRecording()
            let stem = png.deletingPathExtension()
            let json = stem.appendingPathExtension("json")
            let webp = stem.appendingPathExtension("webp")
            guard fm.fileExists(atPath: json.path) else { throw RecallError("Capture sidecar is missing.") }
            guard let result = runCommand(encoder, ["-quiet", "-q", "80", "-mt", png.path, "-o", webp.path]), result.succeeded else {
                throw RecallError("WebP encoding failed.")
            }
            try checkRecording()
            let targetJSON = directory.appendingPathComponent(json.lastPathComponent)
            let targetWebP = directory.appendingPathComponent(webp.lastPathComponent)
            // The importer discovers WebP files; publish the sidecar first.
            // Never overwrite an existing pair (including rapid restart ticks).
            guard !fm.fileExists(atPath: targetJSON.path), !fm.fileExists(atPath: targetWebP.path) else {
                throw RecallError("A capture already exists for this timestamp.")
            }
            try fm.moveItem(at: json, to: targetJSON)
            do {
                try fm.moveItem(at: webp, to: targetWebP)
            } catch {
                try? fm.removeItem(at: targetJSON)
                throw error
            }
            written += 1
        }
        return written
    }

    func appendLog(_ message: String) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) {
            guard fm.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw RecallError("Could not create Recall's capture log.")
            }
        }
        let handle = try FileHandle(forWritingTo: logURL)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("\(Self.format(Date(), "yyyy-MM-dd'T'HH:mm:ssZ")) timeline-recall: \(message)\n".utf8))
    }

    // Only prune dated capture directories and known pair files, never follow
    // symlinks or touch unrelated files in the user's data directory.
    func prune(before cutoff: Date) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: root.path) else { return }
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .contentModificationDateKey]
        for directory in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: Array(keys)) {
            guard directory.lastPathComponent.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { continue }
            let info = try directory.resourceValues(forKeys: keys)
            guard info.isDirectory == true, info.isSymbolicLink != true else { continue }
            for file in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys)) {
                guard ["webp", "json"].contains(file.pathExtension) else { continue }
                do {
                    let info = try file.resourceValues(forKeys: keys)
                    if info.isRegularFile == true, info.isSymbolicLink != true,
                       let modified = info.contentModificationDate, modified < cutoff {
                        try fm.removeItem(at: file)
                    }
                } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
                    // The importer consumed it between enumeration and deletion.
                }
            }
            // The importer can concurrently remove pairs; leave directory cleanup
            // to the next tick if anything changes during this check.
            _ = rmdir(directory.path)
        }
    }

    private static func format(_ date: Date, _ pattern: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
}
