// Shared capture and OCR implementation. The app calls this in-process; the CLI is a diagnostic tool.
import Foundation
import AppKit
import Vision
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import CoreGraphics


struct RecallError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum RecallCapture {
    static func loadExclusions(_ path: String) throws -> Set<String> {
        guard FileManager.default.fileExists(atPath: path) else { return [] }
        let text = try String(contentsOfFile: path, encoding: .utf8)
        return Set(text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") })
    }

    static var screenLocked: Bool {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return session?["CGSSessionScreenIsLocked"] as? Bool == true
    }

    static func displayAwake() throws -> Bool {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success else {
            throw RecallError("Could not check connected displays.")
        }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetOnlineDisplayList(count, &displays, &count) == .success else {
            throw RecallError("Could not check connected displays.")
        }
        return displays.prefix(Int(count)).contains { CGDisplayIsAsleep($0) == 0 }
    }

    static func warn(_ message: String) {
        FileHandle.standardError.write(Data("timeline-recall: \(message)\n".utf8))
    }

    static func capture(outputDir: String, stamp: String, excluded: Set<String>,
                        primeWindowServer: Bool = false) async throws -> Int? {
        try Task.checkCancellation()
        guard !screenLocked else { return nil }
        let frontmost = await MainActor.run { NSWorkspace.shared.frontmostApplication }
        if let frontmost, excluded.contains(frontmost.bundleIdentifier ?? "") || excluded.contains(frontmost.localizedName ?? "") {
            return nil
        }
        let content = try await getContent()
        if primeWindowServer { await primeCGS(content.displays.first) }
        let wins = content.windows.filter { !isSystemWindow($0) && !isExcluded($0, excluded: excluded) && $0.frame.width >= 40 && $0.frame.height >= 40 }

        // Shared per-tick metadata.
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let capturedAt = iso.string(from: Date())
        let hostname = ProcessInfo.processInfo.hostName.components(separatedBy: ".").first ?? ProcessInfo.processInfo.hostName
        // Frontmost app by stable bundle id (not display name, which varies by case /
        // localisation). nil if nothing is frontmost (e.g. all apps hidden).
        let frontmostBundleId = frontmost?.bundleIdentifier

        var written = 0
        for (index, w) in wins.enumerated() {
            try Task.checkCancellation()
            guard !screenLocked else { throw CancellationError() }
            guard let capture = await captureWindow(w) else {
                warn("capture failed for window \(index) (\(w.owningApplication?.applicationName ?? "?"))")
                continue
            }
            try Task.checkCancellation()
            let image = capture.image
            let (text, lineCount) = try ocr(image)
            try Task.checkCancellation()
            let stem = String(format: "%@-%02d", stamp, index)

            guard writePNG(image, to: "\(outputDir)/\(stem).png") else {
                throw RecallError("PNG encode failed for \(stem)")
            }

            let app = w.owningApplication?.applicationName ?? ""
            let bundleId = w.owningApplication?.bundleIdentifier
            var payload: [String: Any] = [
                "schema_version": 1,
                "captured_at": capturedAt,
                "hostname": hostname,
                "app": app,
                "bundle_id": bundleId ?? "",
                "window_title": w.title ?? "",
                "is_frontmost": bundleId != nil && bundleId == frontmostBundleId,
                "ocr_text": text,
                "ocr_line_count": lineCount,
                "width": image.width,
                "height": image.height,
                "point_pixel_scale": capture.pixelScale,
                "window_id": Int(w.windowID),
                "window_index": index,
                "frame": rectDict(w.frame),
                "window_layer": w.windowLayer,
            ]
            if let display = displayFor(w, in: content.displays) {
                payload["display_id"] = Int(display.displayID)
                payload["display_frame"] = rectDict(display.frame)
            }
            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
                  let json = String(data: data, encoding: .utf8) else {
                throw RecallError("could not serialize JSON for \(stem)")
            }
            try json.write(toFile: "\(outputDir)/\(stem).json", atomically: true, encoding: .utf8)
            written += 1
        }

        if !wins.isEmpty && written == 0 { throw RecallError("No windows could be captured. Check Screen Recording permission and restart Timeline.") }
        return written
    }

    static func isExcluded(_ w: SCWindow, excluded: Set<String>) -> Bool {
        guard !excluded.isEmpty else { return false }
        if let name = w.owningApplication?.applicationName, excluded.contains(name) { return true }
        if let bundle = w.owningApplication?.bundleIdentifier, excluded.contains(bundle) { return true }
        return false
    }

    // Desktop wallpaper, Dock, Control Centre, notifications, the lock screen, the
    // window-server backstop — captured as "windows" but pure noise. Drop them so
    // we only store real application windows. loginwindow is listed even though the
    // locked-screen check above exits early — it also surfaces windows outside the
    // locked state (lock/unlock transitions, fast user switching).
    static func isSystemWindow(_ w: SCWindow) -> Bool {
        let bundle = w.owningApplication?.bundleIdentifier ?? ""
        let name = w.owningApplication?.applicationName ?? ""
        let title = w.title ?? ""
        if name.isEmpty { return true }
        let alwaysSystem: Set<String> = [
            "com.apple.dock", "com.apple.WindowManager", "com.apple.controlcenter",
            "com.apple.notificationcenterui", "com.apple.systemuiserver",
            "com.apple.loginwindow",
        ]
        if alwaysSystem.contains(bundle) { return true }
        if bundle == "com.apple.finder" && title.isEmpty { return true }  // the desktop, not a window
        if title.contains("Backstop") { return true }
        return false
    }

    static func captureWindow(_ w: SCWindow) async -> (image: CGImage, pixelScale: Double)? {
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let config = SCStreamConfiguration()
        // Size the buffer from the filter's own content geometry, not w.frame. A
        // window's enumeration-time frame can disagree with the surface
        // ScreenCaptureKit actually renders — some Chromium helper windows report a
        // full-width thin strip while their real content is a normal browser window.
        // preservesAspectRatio is on by default (macOS 14+), so a mismatched buffer
        // scales the content to fit and letterboxes it into an illegible sliver.
        // contentRect x pointPixelScale always matches the captured pixels, and uses
        // the window's real display scale (not a hardcoded 2x, which over-captures on
        // non-retina external displays).
        let pixelScale = Double(filter.pointPixelScale)
        config.width = max(1, Int(filter.contentRect.width * pixelScale))
        config.height = max(1, Int(filter.contentRect.height * pixelScale))
        config.showsCursor = false
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else {
            return nil
        }
        return (image, pixelScale)
    }

    // Vision can block indefinitely inside text recognition, and capture ticks
    // never overlap, so one stuck request would stop all later captures. The
    // first recognition by a newly built ad-hoc binary took about 33 seconds.
    static let ocrTimeout: TimeInterval = 120

    static func ocr(_ image: CGImage) throws -> (text: String, lines: Int) {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        let lines = try withTimeout(ocrTimeout, onTimeout: req.cancel) { () -> [String] in
            do {
                try VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
                return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            } catch {
                warn("OCR failed for a window: \(error.localizedDescription)")
                return []
            }
        }
        return (lines.joined(separator: "\n"), lines.count)
    }

    // Runs blocking work on another thread and stops waiting after `seconds`.
    // Work that never returns keeps its thread; the caller still moves on.
    static func withTimeout<T>(_ seconds: TimeInterval, onTimeout: @escaping () -> Void = {},
                               _ work: @escaping () -> T) throws -> T {
        var result: T?
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            result = work()
            done.signal()
        }
        guard done.wait(timeout: .now() + seconds) == .success, let value = result else {
            onTimeout()
            throw RecallError("Text recognition did not finish within \(Int(seconds)) seconds, so this capture was skipped. Restart Timeline if this repeats.")
        }
        return value
    }

    static func writePNG(_ image: CGImage, to path: String) -> Bool {
        let url = URL(fileURLWithPath: path)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            return false
        }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest)
    }

    // excludingDesktopWindows(true) drops the wallpaper / desktop-icon layer at the
    // source; isSystemWindow drops dock, control centre, etc.
    static func getContent() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    }

    // Prime the window-server connection: the first SCScreenshotManager call from a
    // CLI must be a whole-display capture, or per-window capture aborts with
    // CGS_REQUIRE_INIT.
    static func primeCGS(_ display: SCDisplay?) async {
        guard let display else { return }
        let config = SCStreamConfiguration()
        config.width = 256
        config.height = 256
        config.showsCursor = false
        _ = try? await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: display, excludingWindows: []),
            configuration: config)
    }

    static func overlapArea(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let i = a.intersection(b)
        return i.isNull ? 0 : i.width * i.height
    }

    // Which display a window sits on — by center point, falling back to max overlap.
    static func displayFor(_ w: SCWindow, in displays: [SCDisplay]) -> SCDisplay? {
        let center = CGPoint(x: w.frame.midX, y: w.frame.midY)
        if let containing = displays.first(where: { $0.frame.contains(center) }) { return containing }
        return displays.max(by: { overlapArea(w.frame, $0.frame) < overlapArea(w.frame, $1.frame) })
    }

    static func rectDict(_ r: CGRect) -> [String: Double] {
        ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.width), "h": Double(r.height)]
    }

}
