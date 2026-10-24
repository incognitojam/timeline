// Pure logic for deriving recall capture health from the capture log + pause
// flag. Kept free of SwiftUI/AppKit so it can be exercised directly (see the
// "Verifying" section of README.md) — RecallController.swift owns the file IO.
//
// Successful in-app capture ticks append timestamped "wrote N window(s) for"
// lines to capture.log, preserving the historical health-log format.

import Foundation

enum CaptureStatus: Equatable {
    case recording      // pause flag absent and a capture is recent (or expected soon)
    case notCapturing   // pause flag absent but no capture for staleAfter+ seconds
    case paused         // pause flag present
}

// How long without a successful capture before capture is treated as broken.
// Captures happen every 30s, so this is ~20 missed ticks — past the gaps from an
// excluded app being frontmost or a brief display sleep, while still surfacing a
// real outage (e.g. the revoked Screen Recording grant that silently stopped
// capture for 15h) the next time the menu bar is glanced at.
let recallStaleAfter: TimeInterval = 10 * 60

// Capture log timestamps use an RFC-822 zone, e.g.
// 2026-06-04T11:48:25+0100 — note the RFC-822 zone (no colon), which the `Z`
// pattern parses but ISO8601DateFormatter (which wants +01:00) rejects.
private let recallLogDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
    return f
}()

// Timestamp of the most recent successful capture in a chunk of capture.log
// (read from the end of the file). Only success lines contain "window(s) for ";
// per-window "capture failed for window N" warnings and fatal errors are
// ignored, so a partial tick (6 of 7 windows) still counts as a live capture.
// Returns nil when no parseable success line is present in the chunk.
func lastCaptureDate(inLogTail text: String) -> Date? {
    for line in text.split(separator: "\n").reversed() {
        guard line.contains("window(s) for ") else { continue }
        let stamp = line.prefix { $0 != " " }
        if let date = recallLogDateFormatter.date(from: String(stamp)) {
            return date
        }
    }
    return nil
}

// Derive capture health. `recordingSince` is when recording last (re)started —
// launch-while-recording, or un-pausing. The first capture after that only
// lands within ~one interval, so health is measured from whichever of the last
// capture and recordingSince is more recent: that grace stops a stale prior
// capture from flashing a false warning the instant you un-pause or wake.
func captureStatus(isPaused: Bool, lastCapture: Date?, recordingSince: Date?,
                   now: Date, staleAfter: TimeInterval = recallStaleAfter) -> CaptureStatus {
    if isPaused { return .paused }
    // No information at all → assume on rather than cry wolf.
    guard let baseline = [lastCapture, recordingSince].compactMap({ $0 }).max() else {
        return .recording
    }
    return now.timeIntervalSince(baseline) >= staleAfter ? .notCapturing : .recording
}

// Consecutive failed capture ticks. A lone failure usually recovers on the next
// tick (a window can close between listing and capture), so an error is only
// reported once it repeats.
struct CaptureFailureStreak {
    static let reportAfter = 3
    private(set) var count = 0

    // Returns true when the failure should be reported.
    mutating func recordFailure() -> Bool {
        count += 1
        return count >= Self.reportAfter
    }

    mutating func recordSuccess() { count = 0 }
}
