import Foundation

// Timed public access (Tailscale Funnel) for Remote Access. Funnel may be on
// only while a record on disk says so. The record is "<start> <end>" in Unix
// seconds, written when the user turns public access on. Anything else means
// tailnet only: no record, an unreadable one, one that has ended, one that
// starts in the future (the clock moved back), or one longer than the longest
// duration offered.
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
}
