import Foundation

// Timed public access (Tailscale Funnel) for Remote Access. Funnel may be on
// only while a record on disk says so. The record is "<start> <end>" in Unix
// seconds, written when the user turns public access on. Anything else means
// tailnet only: no record, an unreadable one, one that has ended, one that
// starts in the future (the clock moved back), or one longer than the longest
// duration offered.
//
// An update relaunch is the one exception to public access ending when the
// app quits: the quit turns Funnel off and leaves a paused record, which the
// relaunched app consumes and may resume (see paused and resumable).
enum PublicAccess {
    static let durations: [(label: String, seconds: TimeInterval)] = [
        ("5 Minutes", 5 * 60),
        ("1 Hour", 60 * 60),
        ("1 Day", 24 * 60 * 60),
    ]

    static func record(start: Date, duration: TimeInterval) -> String {
        "\(Int(start.timeIntervalSince1970)) \(Int(start.addingTimeInterval(duration).timeIntervalSince1970))"
    }

    // When public access ends, if the record allows it at `now`; nil otherwise.
    static func end(of record: String?, now: Date) -> Date? {
        guard let parts = record?.split(separator: " "), parts.count == 2,
              let start = Int(parts[0]).map({ Date(timeIntervalSince1970: TimeInterval($0)) }),
              let end = Int(parts[1]).map({ Date(timeIntervalSince1970: TimeInterval($0)) }),
              let longest = durations.map(\.seconds).max(),
              start <= now, now < end, end.timeIntervalSince(start) <= longest
        else { return nil }
        return end
    }

    // How long after an update quit the relaunched app may resume.
    static let resumeWindow: TimeInterval = 5 * 60

    // What an app quit leaves for the next launch: "<boot> <uptime> <record>"
    // when the quit is for an update and `record` allows public access now,
    // else nil. `boot` identifies this boot of the Mac and `uptime` is
    // seconds on a clock that counts sleep and is never set.
    static func paused(record: String?, forUpdate: Bool, boot: String?, uptime: Int, now: Date) -> String? {
        guard forUpdate, let record, let boot, !boot.isEmpty, !boot.contains(" "),
              end(of: record, now: now) != nil else { return nil }
        return "\(boot) \(uptime) \(record)"
    }

    // The record to resume at launch, and the uptime by which it must
    // resume: only one paused in this boot of the Mac, within resumeWindow
    // of the quit, that still allows public access.
    static func resumable(_ paused: String?, boot: String?, uptime: Int, now: Date) -> (record: String, deadline: Int)? {
        guard let parts = paused?.split(separator: " "), parts.count == 4, let boot,
              parts[0] == boot, let quit = Int(parts[1]),
              quit >= 0, quit <= uptime, uptime - quit <= Int(resumeWindow)
        else { return nil }
        let record = "\(parts[2]) \(parts[3])"
        return end(of: record, now: now) == nil ? nil : (record, quit + Int(resumeWindow))
    }
}
