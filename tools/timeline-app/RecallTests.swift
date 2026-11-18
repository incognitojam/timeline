import Foundation
import CoreGraphics
import AppKit

@main
struct RecallTests {
    static func main() async throws {
        guard CommandLine.arguments.count >= 2 else { throw RecallError("Pass a scratch directory.") }
        ageTests()
        menuTests()
        fullscreenVideoTests()
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

        // The fixture encoder isolates publication checks from encoding.
        // The required cwebp argv[2] exercises real encoding separately.
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

        // A metadata-only record publishes its sidecar alone; a sidecar that
        // declares an image never publishes without one.
        let metadataWork = root.appendingPathComponent("metadata-work")
        let metadataOutput = root.appendingPathComponent("metadata-output")
        try fm.createDirectory(at: metadataWork, withIntermediateDirectories: true)
        let metadataOnly = Data("{\"app\":\"Example Player\",\"image\":false,\"image_omitted\":\"fullscreen_video\"}".utf8)
        try metadataOnly.write(to: metadataWork.appendingPathComponent("120000-01.json"))
        let metadataWritten = try pipeline.publish(work: metadataWork, to: metadataOutput, encoder: "/usr/bin/false")
        precondition(metadataWritten == 1)
        let publishedMetadata = try Data(contentsOf: metadataOutput.appendingPathComponent("120000-01.json"))
        precondition(publishedMetadata == metadataOnly)
        precondition(!fm.fileExists(atPath: metadataOutput.appendingPathComponent("120000-01.webp").path))
        try Data("{\"app\":\"Example App\",\"image\":true}".utf8).write(to: metadataWork.appendingPathComponent("120000-02.json"))
        do {
            _ = try pipeline.publish(work: metadataWork, to: metadataOutput, encoder: encoder.path)
            preconditionFailure("A sidecar that declares an image must not publish without one")
        } catch {}
        precondition(!fm.fileExists(atPath: metadataOutput.appendingPathComponent("120000-02.json").path))
        try fm.removeItem(at: metadataWork.appendingPathComponent("120000-02.json"))
        precondition(RecallCapture.writePNG(image, to: metadataWork.appendingPathComponent("120000-03.png").path))
        do {
            _ = try pipeline.publish(work: metadataWork, to: metadataOutput, encoder: encoder.path)
            preconditionFailure("An image without a sidecar must fail the tick")
        } catch {}

        precondition(CommandLine.arguments.count > 2, "Missing required tool: cwebp. Install with brew install webp and pass its path.")
        do {
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
        var streak = CaptureFailureStreak()
        for _ in 1..<CaptureFailureStreak.reportAfter { precondition(!streak.recordFailure()) }
        streak.recordSuccess()
        for _ in 1..<CaptureFailureStreak.reportAfter { precondition(!streak.recordFailure()) }
        precondition(streak.recordFailure())
        precondition(streak.recordFailure())

        try migrationTests(home: home)
        print("OK: Recall OCR timeout, failure streak, publication, cancellation, retention, and migration.")
    }

    static func fullscreenVideoTests() {
        typealias W = RecallCapture.WindowPlacement
        let built = RecallCapture.DisplayArea(frame: CGRect(x: 0, y: 0, width: 1800, height: 1169), topInset: 39)
        let external = RecallCapture.DisplayArea(frame: CGRect(x: 1800, y: 0, width: 2560, height: 1440), topInset: 25)
        let player: pid_t = 100, other: pid_t = 200
        var lastID: CGWindowID = 0
        func next() -> CGWindowID { lastID += 1; return lastID }
        func check(_ w: W, on d: RecallCapture.DisplayArea = built, among extra: [W] = [], blockers: Set<pid_t> = [player]) -> Bool {
            RecallCapture.isFullscreenVideo(w, on: d, among: [w] + extra, displaySleepBlockers: blockers)
        }
        // Fullscreen over the whole display, or stopping below the camera housing.
        let whole = W(windowID: next(), pid: player, frame: built.frame, layer: 0)
        let belowNotch = W(windowID: next(), pid: player, frame: CGRect(x: 0, y: 39, width: 1800, height: 1130), layer: 0)
        precondition(check(whole))
        precondition(check(belowNotch))
        // The player's own controls and another display's windows don't count.
        let controls = W(windowID: next(), pid: player, frame: CGRect(x: 658, y: 936, width: 483, height: 84), layer: 8)
        let elsewhere = W(windowID: next(), pid: other, frame: CGRect(x: 1900, y: 100, width: 800, height: 600), layer: 0)
        precondition(check(belowNotch, among: [controls, elsewhere]))
        // A floating window from another app sits above a fullscreen Space.
        precondition(check(belowNotch, among: [W(windowID: next(), pid: other, frame: CGRect(x: 1400, y: 900, width: 320, height: 180), layer: 3)]))
        // Fullscreen over the menu bar row in the current Space, other apps' windows behind it.
        let behind = W(windowID: next(), pid: other, frame: CGRect(x: 131, y: 47, width: 1631, height: 1050), layer: 0)
        precondition(check(whole, among: [behind]))
        // Paused: no display-sleep assertion.
        precondition(!check(whole, blockers: []))
        precondition(!check(whole, blockers: [other]))
        // Windowed playback.
        precondition(!check(W(windowID: next(), pid: player, frame: CGRect(x: 131, y: 47, width: 1631, height: 1050), layer: 0)))
        // Maximised in a normal Space: other apps' windows are listed behind it.
        precondition(!check(belowNotch, among: [W(windowID: next(), pid: other, frame: CGRect(x: 0, y: 39, width: 1443, height: 1068), layer: 0)]))
        // Maximised with only the same browser's other windows behind it.
        precondition(!check(belowNotch, among: [W(windowID: next(), pid: player, frame: CGRect(x: 131, y: 47, width: 1631, height: 1050), layer: 0)]))
        precondition(!check(belowNotch, among: [W(windowID: next(), pid: player, frame: belowNotch.frame, layer: 0)]))
        // A browser's fullscreen Space keeps its toolbar strip on screen.
        precondition(check(belowNotch, among: [W(windowID: next(), pid: player, frame: CGRect(x: 0, y: 39, width: 1800, height: 68), layer: 0)]))
        // Too far below the top edge to be fullscreen.
        precondition(!check(W(windowID: next(), pid: player, frame: CGRect(x: 0, y: 98, width: 1800, height: 1071), layer: 0)))
        // Coverage is checked against the window's own display.
        let externalWhole = W(windowID: next(), pid: player, frame: external.frame, layer: 0)
        precondition(check(externalWhole, on: external, among: [W(windowID: next(), pid: other, frame: CGRect(x: 0, y: 39, width: 1443, height: 1068), layer: 0)]))
        precondition(!check(externalWhole, on: built))
        precondition(!check(W(windowID: next(), pid: nil, frame: built.frame, layer: 0), blockers: []))
        print("OK: Fullscreen video needs a display-sleep assertion and display coverage, or a fullscreen Space below the menu bar.")
    }

    static func ageTests() {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.unitsStyle = .abbreviated
        let last = lastCaptureDate(inLogTail: "2026-01-01T12:00:00+0000 wrote 1 window(s) for app capture")!
        precondition(lastCaptureAge(nil, relativeTo: last, formatter: formatter) == nil)
        for age in [-30.0, 0, 0.1, 0.4, 0.6, 0.999] {
            precondition(lastCaptureAge(last, relativeTo: last.addingTimeInterval(age), formatter: formatter)
                         == "Last capture just now")
        }
        for (age, expected) in [(1.0, "1 sec ago"), (5, "5 sec ago"), (30, "30 sec ago"),
                                (780, "13 min ago"), (3600, "1 hr ago")] {
            precondition(lastCaptureAge(last, relativeTo: last.addingTimeInterval(age), formatter: formatter)
                         == "Last capture " + expected)
        }
        let later = last.addingTimeInterval(3600)
        precondition(captureStatus(isPaused: true, lastCapture: last, recordingSince: nil, now: later) == .paused)
        precondition(captureStatus(isPaused: false, lastCapture: last, recordingSince: nil, now: later) == .notCapturing)
        // Wake and resume grant fresh grace without changing the last capture.
        precondition(captureStatus(isPaused: false, lastCapture: last, recordingSince: later, now: later) == .recording)
        print("OK: Capture ages handle subsecond timestamps, elapsed time, clock rollback, pause, and resume grace.")
    }

    @MainActor
    static func menuTests() {
        _ = NSApplication.shared
        let last = Date().addingTimeInterval(-30)
        var updater: RecallAgeMenu? = RecallAgeMenu(lastCapture: { last })
        let menu = NSMenu()
        NotificationCenter.default.post(name: NSMenu.didBeginTrackingNotification, object: menu)
        // A stale SwiftUI snapshot must be reconciled on the first tracking turn.
        let item = NSMenuItem(title: "Last capture just now", action: nil, keyEquivalent: "")
        menu.addItem(item)
        let unrelated = NSMenuItem(title: "Recall: paused", action: nil, keyEquivalent: "")
        menu.addItem(unrelated)
        let deadline = Date().addingTimeInterval(3)
        while item.title == "Last capture just now" && Date() < deadline {
            RunLoop.main.run(mode: .eventTracking, before: Date().addingTimeInterval(0.01))
        }
        precondition(item.title.hasPrefix("Last capture ") && item.title != "Last capture just now")
        precondition(unrelated.title == "Recall: paused")
        item.title = "Last capture stale snapshot"
        let nextDeadline = Date().addingTimeInterval(3)
        while item.title == "Last capture stale snapshot" && Date() < nextDeadline {
            RunLoop.main.run(mode: .eventTracking, before: Date().addingTimeInterval(0.01))
        }
        precondition(item.title != "Last capture stale snapshot", "Open menus must keep refreshing")
        NotificationCenter.default.post(name: NSMenu.didEndTrackingNotification, object: menu)
        item.title = "Last capture closed"
        _ = withExtendedLifetime(updater) {
            RunLoop.main.run(mode: .eventTracking, before: Date().addingTimeInterval(1.1))
        }
        precondition(item.title == "Last capture closed", "Closed menus must stop refreshing")
        updater = nil
        print("OK: Native capture-age item refreshes during tracking and stops when closed.")
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
