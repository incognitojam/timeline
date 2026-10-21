import Foundation
import CoreGraphics

@main
struct RecallTests {
    static func main() async throws {
        guard CommandLine.arguments.count >= 2 else { throw RecallError("Pass a scratch directory.") }
        let fm = FileManager.default
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("recall-tests-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let home = root.appendingPathComponent("fixture-home")
        let pipeline = RecallPipeline(home: home)
        try fm.createDirectory(at: pipeline.pauseFlag.deletingLastPathComponent(), withIntermediateDirectories: true)

        let exclusions = root.appendingPathComponent("exclusions.txt")
        try "# comment\n Example App \ncom.example.private\n\n".write(to: exclusions, atomically: true, encoding: .utf8)
        let loaded = try RecallCapture.loadExclusions(exclusions.path)
        precondition(loaded == ["Example App", "com.example.private"])
        let absent = try RecallCapture.loadExclusions(root.appendingPathComponent("absent").path)
        precondition(absent.isEmpty)
        do {
            _ = try RecallCapture.loadExclusions(root.path)
            preconditionFailure("An unreadable exclusion file must fail closed")
        } catch {}

        let blocked = DispatchSemaphore(value: 0)
        var timedOut = false
        do {
            _ = try RecallCapture.withTimeout(0.05, onTimeout: { timedOut = true }) { blocked.wait() }
            preconditionFailure("Work that never returns must time out")
        } catch {}
        precondition(timedOut)
        blocked.signal()
        let answer = try RecallCapture.withTimeout(5) { 42 }
        precondition(answer == 42)

        let work = root.appendingPathComponent("work")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        guard let context = CGContext(data: nil, width: 4, height: 4, bitsPerComponent: 8,
                                      bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let image = context.makeImage() else { throw RecallError("Could not create synthetic image.") }
        precondition(RecallCapture.writePNG(image, to: work.appendingPathComponent("120000-00.png").path))
        let sidecar = Data("{\"app\":\"Example App\",\"ocr_text\":\"Synthetic text\"}".utf8)
        try sidecar.write(to: work.appendingPathComponent("120000-00.json"))

        // The fixture encoder isolates publication from an optional Homebrew
        // dependency. Pass cwebp as argv[2] to exercise real encoding as well.
        let encoder = root.appendingPathComponent("encoder.sh")
        try "#!/bin/sh\nfor output do :; done\nprintf 'synthetic webp' > \"$output\"\n".write(to: encoder, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: encoder.path)
        let directory = pipeline.root.appendingPathComponent("2025-01-01")

        do {
            _ = try pipeline.publish(work: work, to: directory, encoder: "/usr/bin/false")
            preconditionFailure("Encoding failure must not publish a pair")
        } catch {}
        precondition(!fm.fileExists(atPath: directory.appendingPathComponent("120000-00.webp").path))
        precondition(!fm.fileExists(atPath: directory.appendingPathComponent("120000-00.json").path))

        try Data().write(to: pipeline.pauseFlag)
        do {
            _ = try pipeline.publish(work: work, to: directory, encoder: encoder.path)
            preconditionFailure("Paused capture must not publish")
        } catch is CancellationError {}
        try fm.removeItem(at: pipeline.pauseFlag)

        let cancelEncoder = root.appendingPathComponent("cancel-encoder.sh")
        try "#!/bin/sh\ntouch \"$(dirname \"$0\")/fixture-home/.local/share/timeline/recall.pause\"\nfor output do :; done\nprintf 'synthetic webp' > \"$output\"\n".write(to: cancelEncoder, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cancelEncoder.path)
        do {
            _ = try pipeline.publish(work: work, to: directory, encoder: cancelEncoder.path)
            preconditionFailure("Pausing during encoding must prevent publication")
        } catch is CancellationError {}
        precondition(!fm.fileExists(atPath: directory.appendingPathComponent("120000-00.webp").path))
        try fm.removeItem(at: pipeline.pauseFlag)

        let written = try pipeline.publish(work: work, to: directory, encoder: encoder.path)
        precondition(written == 1)
        let publishedJSON = try Data(contentsOf: directory.appendingPathComponent("120000-00.json"))
        precondition(publishedJSON == sidecar)
        let publishedImage = try Data(contentsOf: directory.appendingPathComponent("120000-00.webp"))
        precondition(!publishedImage.isEmpty)
        try sidecar.write(to: work.appendingPathComponent("120000-00.json"))
        do {
            _ = try pipeline.publish(work: work, to: directory, encoder: encoder.path)
            preconditionFailure("A timestamp collision must preserve the first pair")
        } catch {}
        let unchanged = try Data(contentsOf: directory.appendingPathComponent("120000-00.webp"))
        precondition(unchanged == publishedImage)

        if CommandLine.arguments.count > 2 {
            let realOutput = root.appendingPathComponent("real-encoder-output")
            let written = try pipeline.publish(work: work, to: realOutput, encoder: CommandLine.arguments[2])
            precondition(written == 1)
            let webp = try Data(contentsOf: realOutput.appendingPathComponent("120000-00.webp"))
            precondition(webp.starts(with: Data("RIFF".utf8)) && webp.dropFirst(8).starts(with: Data("WEBP".utf8)))
            let json = try Data(contentsOf: realOutput.appendingPathComponent("120000-00.json"))
            precondition(json == sidecar)
            print("OK: Real WebP encoding and publication.")
        }

        try pipeline.appendLog("wrote 1 window(s) for app capture")
        let log = try String(contentsOf: pipeline.logURL, encoding: .utf8)
        precondition(lastCaptureDate(inLogTail: log) != nil)

        let keep = directory.appendingPathComponent("notes.txt")
        try Data("keep".utf8).write(to: keep)
        let external = root.appendingPathComponent("external.json")
        try Data("keep".utf8).write(to: external)
        try fm.createSymbolicLink(at: directory.appendingPathComponent("linked.json"), withDestinationURL: external)
        try pipeline.prune(before: Date().addingTimeInterval(1))
        precondition(fm.fileExists(atPath: keep.path) && fm.fileExists(atPath: external.path))
        precondition(!fm.fileExists(atPath: directory.appendingPathComponent("120000-00.webp").path))

        let abandoned = pipeline.workRoot.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: abandoned, withIntermediateDirectories: true)
        let unfinished = abandoned.appendingPathComponent("120000-00.png")
        try Data("synthetic image".utf8).write(to: unfinished)
        let unrelated = abandoned.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: unrelated)
        let linked = pipeline.workRoot.appendingPathComponent(UUID().uuidString)
        try fm.createSymbolicLink(at: linked, withDestinationURL: directory)
        try pipeline.cleanAbandonedWork()
        precondition(!fm.fileExists(atPath: unfinished.path))
        precondition(fm.fileExists(atPath: unrelated.path) && fm.fileExists(atPath: keep.path))

        let cancelled = Task {
            while !Task.isCancelled { await Task.yield() }
            do {
                try pipeline.checkRecording()
                preconditionFailure("Cancelled ticks must stop")
            } catch is CancellationError {}
        }
        cancelled.cancel()
        try await cancelled.value
        try migrationTests(home: home)
        print("OK: Recall OCR timeout, publication, cancellation, retention, and migration.")
    }

    static func migrationTests(home: URL) throws {
        let fm = FileManager.default
        let legacy = home.appendingPathComponent("Library/LaunchAgents/\(RecallMigration.label).plist")
        try fm.createDirectory(at: legacy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("legacy fixture".utf8).write(to: legacy)
        var calls: [[String]] = []
        var unregistered = false
        try RecallMigration.retire(home: home, target: "gui/999/example", unregister: {
            unregistered = true
        }, command: { arguments in
            precondition(unregistered)
            calls.append(arguments)
            return CommandResult(terminationStatus: calls.count == 3 ? 113 : 0, output: "")
        })
        precondition(calls == [["print", "gui/999/example"], ["bootout", "gui/999/example"], ["print", "gui/999/example"]])
        precondition(!fm.fileExists(atPath: legacy.path))
        let backups = try fm.contentsOfDirectory(atPath: legacy.deletingLastPathComponent().path)
        precondition(backups.count == 1)

        try RecallMigration.retire(home: home, target: "gui/999/example", unregister: {}, command: { _ in
            CommandResult(terminationStatus: 113, output: "")
        })
        try Data("legacy fixture".utf8).write(to: legacy)
        for result: CommandResult? in [nil, CommandResult(terminationStatus: 1, output: ""), CommandResult(terminationStatus: 0, output: "")] {
            do {
                try RecallMigration.retire(home: home, target: "gui/999/example", unregister: {}, command: { _ in result })
                preconditionFailure("Uncertain or still-running jobs must block migration")
            } catch {}
            precondition(fm.fileExists(atPath: legacy.path))
        }
        do {
            try RecallMigration.retire(home: home, target: "gui/999/example", unregister: { throw RecallError("failed") }, command: { _ in
                preconditionFailure("Unregister failure must block migration")
            })
            preconditionFailure("Unregister failure must propagate")
        } catch {}
    }
}
