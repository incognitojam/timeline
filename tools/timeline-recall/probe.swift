// timeline-recall-probe — exploration tool for per-window capture sizing.
//
// Subcommands:
//   windows [--quality Q] [--scale S]
//       Enumerate on-screen windows + per-window HEIC/PNG sizes; compare the
//       sum of per-window HEICs against a single whole-display HEIC.
//   dedup <iterations> <intervalSeconds> [--quality Q] [--scale S]
//       Capture every on-screen window repeatedly; report how many captures
//       were pixel-identical to that window's previous frame (dedup hits) and
//       the bytes we'd actually store vs. naively storing every frame.
//
// Measures only: prints sizes/stats, never writes images to disk, no OCR.
// Needs Screen Recording permission (attributed per-binary; grant THIS binary
// in System Settings -> Privacy & Security -> Screen & System Audio Recording).

import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import AVFoundation

func eprint(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }
func die(_ code: Int32, _ msg: String) -> Never { eprint("timeline-recall-probe: \(msg)"); exit(code) }

// --- encoding + hashing helpers ---
func encode(_ image: CGImage, as type: UTType, quality: Double?) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, type.identifier as CFString, 1, nil) else { return nil }
    var opts: [CFString: Any] = [:]
    if let q = quality { opts[kCGImageDestinationLossyCompressionQuality] = q }
    CGImageDestinationAddImage(dest, image, opts as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return data as Data
}

func rawBGRA(_ image: CGImage) -> Data? {
    let w = image.width, h = image.height
    guard w > 0, h > 0 else { return nil }
    let bytesPerRow = w * 4
    var data = Data(count: bytesPerRow * h)
    let ok = data.withUnsafeMutableBytes { (ptr: UnsafeMutableRawBufferPointer) -> Bool in
        guard let base = ptr.baseAddress,
              let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: bytesPerRow, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    return ok ? data : nil
}

func sha(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func fmtBytes(_ n: Int) -> String {
    if n >= 1_048_576 { return String(format: "%.1f MB", Double(n) / 1_048_576) }
    if n >= 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
    return "\(n) B"
}

func flagValue(_ name: String, _ def: Double) -> Double {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count, let v = Double(a[i + 1]) { return v }
    return def
}

let quality = flagValue("--quality", 0.6)
let scale = flagValue("--scale", 2.0)

// Unbuffered stdout so output ordering stays faithful through `tee`, and so we
// can see exactly which line precedes a crash if capture dies.
setbuf(stdout, nil)

// NOTE: deliberately NO CGPreflightScreenCaptureAccess() — that call reaches the
// CGS window-server connection and trips the "CGS_REQUIRE_INIT" assertion from a
// plain CLI context. The known-good main.swift omits it; we just let capture
// return nil if permission is genuinely missing.

func shareable() async -> SCShareableContent {
    do { return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    catch { die(4, "SCShareableContent failed (permission?): \(error.localizedDescription)") }
}

func captureFilter(_ filter: SCContentFilter, _ pw: Int, _ ph: Int, cursor: Bool) async -> CGImage? {
    let config = SCStreamConfiguration()
    config.width = max(1, pw)
    config.height = max(1, ph)
    config.showsCursor = cursor
    return try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

func capture(_ w: SCWindow) async -> CGImage? {
    await captureFilter(SCContentFilter(desktopIndependentWindow: w),
                        Int(w.frame.width * scale), Int(w.frame.height * scale), cursor: false)
}

func onScreenWindows(_ c: SCShareableContent) -> [SCWindow] {
    c.windows.filter { $0.isOnScreen && $0.frame.width >= 40 && $0.frame.height >= 40 }
}

func isSystemWindow(_ w: SCWindow) -> Bool {
    let bundle = w.owningApplication?.bundleIdentifier ?? ""
    let system: Set<String> = ["com.apple.dock", "com.apple.WindowManager",
        "com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.finder"]
    if system.contains(bundle) { return true }
    let title = w.title ?? ""
    if title.contains("Backstop") || title.contains("Wallpaper") { return true }
    return (w.owningApplication?.applicationName ?? "").isEmpty
}

func makePixelBuffer(_ image: CGImage, _ width: Int, _ height: Int) -> CVPixelBuffer? {
    var pb: CVPixelBuffer?
    let attrs: [String: Any] = [
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb) == kCVReturnSuccess,
          let buffer = pb else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
                              bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return buffer
}

// Encode a sequence of window frames as one HEVC track; returns file byte size.
func encodeHEVC(_ frames: [CGImage], fps: Int, quality: Double) async -> Int? {
    guard let first = frames.first else { return nil }
    let w = first.width - (first.width % 2)
    let h = first.height - (first.height % 2)
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("recall-probe-hevc.mov")
    try? FileManager.default.removeItem(at: url)
    guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return nil }
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.hevc,
        AVVideoWidthKey: w,
        AVVideoHeightKey: h,
        AVVideoCompressionPropertiesKey: [AVVideoQualityKey: quality],
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferWidthKey as String: w,
        kCVPixelBufferHeightKey as String: h,
    ])
    guard writer.canAdd(input) else { return nil }
    writer.add(input)
    guard writer.startWriting() else { return nil }
    writer.startSession(atSourceTime: .zero)
    for (i, img) in frames.enumerated() {
        while !input.isReadyForMoreMediaData { try? await Task.sleep(for: .milliseconds(2)) }
        guard let pb = makePixelBuffer(img, w, h) else { continue }
        adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps)))
    }
    input.markAsFinished()
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
        writer.finishWriting { cont.resume() }
    }
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int
    try? FileManager.default.removeItem(at: url)
    return size
}

// Prime the window-server (CGS) connection before any per-window capture. The
// FIRST SCScreenshotManager call from a CLI context must be a whole-display
// capture; a desktopIndependentWindow capture as the very first call aborts the
// process with "CGS_REQUIRE_INIT". One throwaway low-res display capture inits it.
func primeCGS() async {
    let c = await shareable()
    if let d = c.displays.first {
        _ = await captureFilter(SCContentFilter(display: d, excludingWindows: []), 256, 256, cursor: false)
    }
}

let argv = CommandLine.arguments
let cmd = (argv.count > 1 && !argv[1].hasPrefix("--")) ? argv[1] : "windows"

await primeCGS()

switch cmd {
case "windows":
    let c = await shareable()
    print("Displays:")
    for d in c.displays {
        print("  display \(d.displayID): \(d.width)x\(d.height) pt")
    }
    // Whole-display capture FIRST — identical call path to the known-good
    // main.swift. If this aborts, the problem is environmental, not the
    // per-window (desktopIndependentWindow) filter.
    if let d = c.displays.first {
        print("Capturing whole display…")
        let filter = SCContentFilter(display: d, excludingWindows: [])
        if let full = await captureFilter(filter, Int(Double(d.width) * scale), Int(Double(d.height) * scale), cursor: true) {
            let fheic = encode(full, as: .heic, quality: quality)?.count ?? 0
            let fpng = encode(full, as: .png, quality: nil)?.count ?? 0
            print("Whole display:      PNG \(fmtBytes(fpng))   HEIC \(fmtBytes(fheic))   (\(full.width)x\(full.height))")
        } else {
            print("Whole display: capture returned nil")
        }
    }

    let wins = onScreenWindows(c)
    print("\nOn-screen windows: \(wins.count)  (quality=\(quality), scale=\(scale)x)\n")
    var sumHeic = 0, sumPng = 0
    for w in wins {
        let app = w.owningApplication?.applicationName ?? "?"
        let title = String((w.title ?? "").prefix(44))
        guard let img = await capture(w) else { print("  [capture failed] \(app)"); continue }
        let heic = encode(img, as: .heic, quality: quality)?.count ?? 0
        let png = encode(img, as: .png, quality: nil)?.count ?? 0
        sumHeic += heic; sumPng += png
        print("  \(app) | \(title) | \(img.width)x\(img.height) | png \(fmtBytes(png)) | heic \(fmtBytes(heic))")
    }
    print("\nSum of per-window:  PNG \(fmtBytes(sumPng))   HEIC \(fmtBytes(sumHeic))")

case "dedup":
    let iters = argv.count > 2 ? (Int(argv[2]) ?? 10) : 10
    let interval = argv.count > 3 ? (Double(argv[3]) ?? 3.0) : 3.0
    print("dedup probe: \(iters) iterations, \(interval)s apart  (quality=\(quality), scale=\(scale)x)\n")
    var last: [CGWindowID: String] = [:]
    var naive = 0, stored = 0, caps = 0, identical = 0
    for i in 0..<iters {
        let c = await shareable()
        let wins = onScreenWindows(c)
        var iterBytes = 0, iterStored = 0
        for w in wins {
            guard let img = await capture(w), let raw = rawBGRA(img) else { continue }
            let heic = encode(img, as: .heic, quality: quality)?.count ?? 0
            let h = sha(raw)
            caps += 1; naive += heic; iterBytes += heic
            if last[w.windowID] == h {
                identical += 1
            } else {
                stored += heic; iterStored += heic; last[w.windowID] = h
            }
        }
        print("  iter \(i + 1)/\(iters): \(wins.count) windows, \(fmtBytes(iterBytes)) captured, \(fmtBytes(iterStored)) new")
        if i < iters - 1 { try? await Task.sleep(for: .seconds(interval)) }
    }
    let pct = caps > 0 ? Double(identical) / Double(caps) * 100 : 0
    print("\nTotal window-captures: \(caps)")
    print(String(format: "Pixel-identical to previous frame: %d (%.1f%%)", identical, pct))
    print("Naive bytes (store every frame):     \(fmtBytes(naive))")
    print("Deduped bytes (store changed only):  \(fmtBytes(stored))")
    if naive > 0 { print(String(format: "Savings from per-window dedup: %.1f%%", (1 - Double(stored) / Double(naive)) * 100)) }

case "hevc":
    let sub = (argv.count > 2 && !argv[2].hasPrefix("--")) ? argv[2] : ""
    let seconds = flagValue("--seconds", 10)
    let fps = max(1, Int(flagValue("--fps", 5)))
    let c0 = await shareable()
    let cands = onScreenWindows(c0).filter { !isSystemWindow($0) }
    let target: SCWindow? = sub.isEmpty
        ? cands.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        : cands.first { (($0.owningApplication?.applicationName ?? "") + " " + ($0.title ?? "")).localizedCaseInsensitiveContains(sub) }
    guard let win = target else { die(1, "no matching non-system window for '\(sub)'") }
    let wid = win.windowID
    let label = "\(win.owningApplication?.applicationName ?? "?") — \(win.title ?? "")"
    let nframes = Int(seconds) * fps
    print("hevc probe: [\(label)]  \(Int(seconds))s @ \(fps)fps = \(nframes) frames\n")
    var frames: [CGImage] = []
    var stillsAll = 0, stillsChanged = 0, changed = 0
    var lastHash: String?
    for i in 0..<nframes {
        let cc = await shareable()
        guard let w = cc.windows.first(where: { $0.windowID == wid }) else { break }
        guard let img = await capture(w) else { continue }
        frames.append(img)
        let heic = encode(img, as: .heic, quality: quality)?.count ?? 0
        stillsAll += heic
        if let raw = rawBGRA(img) {
            let hh = sha(raw)
            if hh != lastHash { changed += 1; stillsChanged += heic; lastHash = hh }
        }
        if (i + 1) % fps == 0 { print("  \(i + 1)/\(nframes)…") }
        try? await Task.sleep(for: .milliseconds(Int(1000.0 / Double(fps))))
    }
    print("\nFrames captured: \(frames.count)")
    let chPct = frames.isEmpty ? 0 : Double(changed) / Double(frames.count) * 100
    print(String(format: "Changed frames: %d (%.0f%%)", changed, chPct))
    print("HEIC stills, every frame:    \(fmtBytes(stillsAll))")
    print("HEIC stills, changed only:   \(fmtBytes(stillsChanged))")
    if let hevc = await encodeHEVC(frames, fps: fps, quality: quality) {
        print("HEVC track (all frames):     \(fmtBytes(hevc))")
        if stillsAll > 0 {
            print(String(format: "  vs every-frame HEIC stills:  %.0f%% smaller", (1 - Double(hevc) / Double(stillsAll)) * 100))
        }
        if stillsChanged > 0 {
            let rel = (1 - Double(hevc) / Double(stillsChanged)) * 100
            if rel >= 0 { print(String(format: "  vs changed-only HEIC stills: %.0f%% smaller", rel)) }
            else { print(String(format: "  vs changed-only HEIC stills: %.0f%% LARGER", -rel)) }
        }
    } else {
        print("HEVC encode failed")
    }

default:
    die(1, "unknown command '\(cmd)'; use 'windows', 'dedup <iters> <interval>', or 'hevc [window] [--seconds N] [--fps N]'")
}
