// Shared capture implementation. The app calls this in-process; the CLI is a diagnostic tool.
// Text recognition runs in an OCR worker process (RecallOCR.swift).
import Foundation
import AppKit
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import CoreGraphics
import IOKit.pwr_mgt

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
        let visible = content.windows.filter { !isSystemWindow($0) && $0.frame.width >= 40 && $0.frame.height >= 40 }
        let wins = visible.filter { !isExcluded($0, excluded: excluded) }

        // Shared per-tick metadata.
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let capturedAt = iso.string(from: Date())
        let hostname = ProcessInfo.processInfo.hostName.components(separatedBy: ".").first ?? ProcessInfo.processInfo.hostName
        // Frontmost app by stable bundle id (not display name, which varies by case /
        // localisation). nil if nothing is frontmost (e.g. all apps hidden).
        let frontmostBundleId = frontmost?.bundleIdentifier
        let insets = await MainActor.run { menuBarInsets() }
        let blockers = try displaySleepBlockers()
        let placements = visible.map(placement)

        var written = 0
        for (index, w) in wins.enumerated() {
            try Task.checkCancellation()
            guard !screenLocked else { throw CancellationError() }
            let stem = String(format: "%@-%02d", stamp, index)
            let app = w.owningApplication?.applicationName ?? ""
            let bundleId = w.owningApplication?.bundleIdentifier
            var payload: [String: Any] = [
                "schema_version": 2,
                "captured_at": capturedAt,
                "hostname": hostname,
                "app": app,
                "bundle_id": bundleId ?? "",
                "window_title": w.title ?? "",
                "is_frontmost": bundleId != nil && bundleId == frontmostBundleId,
                "window_id": Int(w.windowID),
                "window_index": index,
                "frame": rectDict(w.frame),
                "window_layer": w.windowLayer,
            ]
            let display = displayFor(w, in: content.displays)
            if let display {
                payload["display_id"] = Int(display.displayID)
                payload["display_frame"] = rectDict(display.frame)
            }

            if let reason = try imageOmission(for: w, on: display, insets: insets,
                                              among: placements, displaySleepBlockers: blockers) {
                payload["image"] = false
                payload["image_omitted"] = reason
            } else {
                guard let capture = await captureWindow(w) else {
                    warn("capture failed for window \(index) (\(app.isEmpty ? "?" : app))")
                    continue
                }
                try Task.checkCancellation()
                let image = capture.image
                let png = "\(outputDir)/\(stem).png"
                guard writePNG(image, to: png) else {
                    throw RecallError("PNG encode failed for \(stem)")
                }
                let lines: [String]
                do {
                    lines = try await RecallOCR.shared.recognize(path: png)
                } catch {
                    try Task.checkCancellation()  // Pausing stops the worker mid-recognition.
                    throw error
                }
                try Task.checkCancellation()
                payload["image"] = true
                payload["ocr_text"] = lines.joined(separator: "\n")
                payload["ocr_line_count"] = lines.count
                payload["width"] = image.width
                payload["height"] = image.height
                payload["point_pixel_scale"] = capture.pixelScale
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

    struct WindowPlacement {
        let windowID: CGWindowID
        let pid: pid_t?
        let frame: CGRect
        let layer: Int
    }

    struct DisplayArea {
        let frame: CGRect
        // Points at the top of the display a fullscreen window may leave
        // uncovered: apps that avoid the camera housing stop below the menu bar.
        let topInset: CGFloat
    }

    static func placement(_ w: SCWindow) -> WindowPlacement {
        WindowPlacement(windowID: w.windowID, pid: w.owningApplication?.processID, frame: w.frame, layer: w.windowLayer)
    }

    // Why a window is recorded without an image, or nil to capture it.
    static func imageOmission(for w: SCWindow, on display: SCDisplay?, insets: [CGDirectDisplayID: CGFloat],
                              among windows: [WindowPlacement], displaySleepBlockers: Set<pid_t>) throws -> String? {
        guard let display else { return nil }
        guard let inset = insets[display.displayID] else {
            throw RecallError("No screen matches display \(display.displayID).")
        }
        let area = DisplayArea(frame: display.frame, topInset: inset)
        return isFullscreenVideo(placement(w), on: area, among: windows, displaySleepBlockers: displaySleepBlockers)
            ? "fullscreen_video" : nil
    }

    // Video players and browsers keep the display awake only while playing,
    // windowed or fullscreen, so coverage tells fullscreen playback apart.
    // A window over the menu bar row is fullscreen (VLC's default fullscreen
    // stays in the current Space). A window that stops below it (native
    // fullscreen on a display with a camera housing) has a maximised window's
    // frame; only a fullscreen Space hides every other window, apart from a
    // toolbar strip along the fullscreen window's top edge.
    static func isFullscreenVideo(_ window: WindowPlacement, on display: DisplayArea,
                                  among windows: [WindowPlacement], displaySleepBlockers: Set<pid_t>) -> Bool {
        guard let pid = window.pid, displaySleepBlockers.contains(pid) else { return false }
        let d = display.frame
        let slack: CGFloat = 1
        let f = window.frame
        guard f.minX <= d.minX + slack, f.maxX >= d.maxX - slack, f.maxY >= d.maxY - slack else { return false }
        if f.minY <= d.minY + slack { return true }
        guard f.minY <= d.minY + display.topInset + slack else { return false }
        return !windows.contains { other in
            guard other.windowID != window.windowID, other.layer == 0, overlapArea(other.frame, d) > 0 else { return false }
            let toolbar = other.pid == pid && other.frame.minY == f.minY && other.frame.minX == f.minX
                && other.frame.width == f.width && other.frame.height < f.height
            return !toolbar
        }
    }

    // Processes holding an assertion that keeps the display awake.
    static func displaySleepBlockers() throws -> Set<pid_t> {
        var out: Unmanaged<CFDictionary>?
        guard IOPMCopyAssertionsByProcess(&out) == kIOReturnSuccess,
              let byProcess = out?.takeRetainedValue() as? [NSNumber: [[String: Any]]] else {
            throw RecallError("Could not read power assertions.")
        }
        let displayTypes: Set<String> = [kIOPMAssertionTypePreventUserIdleDisplaySleep, kIOPMAssertionTypeNoDisplaySleep]
        var pids = Set<pid_t>()
        for (pid, assertions) in byProcess {
            for assertion in assertions {
                guard let type = assertion[kIOPMAssertionTypeKey] as? String, displayTypes.contains(type) else { continue }
                pids.insert(pid.int32Value)
            }
        }
        return pids
    }

    // Menu bar height per display (the gap above NSScreen.visibleFrame), or the
    // camera housing's safe-area inset if that is larger.
    @MainActor
    static func menuBarInsets() -> [CGDirectDisplayID: CGFloat] {
        var insets: [CGDirectDisplayID: CGFloat] = [:]
        for screen in NSScreen.screens {
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            insets[id.uint32Value] = max(screen.frame.maxY - screen.visibleFrame.maxY, screen.safeAreaInsets.top)
        }
        return insets
    }

    static func rectDict(_ r: CGRect) -> [String: Double] {
        ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.width), "h": Double(r.height)]
    }

}
