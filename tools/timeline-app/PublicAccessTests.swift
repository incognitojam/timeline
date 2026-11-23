import Foundation

// Public access must fail closed: only a well-formed, current record within the
// longest offered duration keeps Funnel on.
@main
struct PublicAccessTests {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let hour = PublicAccess.record(start: now, duration: 3600)

        precondition(PublicAccess.end(of: hour, now: now) == now.addingTimeInterval(3600), "current record")
        precondition(PublicAccess.end(of: hour, now: now.addingTimeInterval(3599)) != nil, "just before the end")
        precondition(PublicAccess.end(of: hour, now: now.addingTimeInterval(3600)) == nil, "at the end")
        precondition(PublicAccess.end(of: hour, now: now.addingTimeInterval(-1)) == nil, "clock moved back")
        precondition(PublicAccess.end(of: nil, now: now) == nil, "missing")
        precondition(PublicAccess.end(of: "", now: now) == nil, "empty")
        precondition(PublicAccess.end(of: "garbage", now: now) == nil, "unreadable")
        precondition(PublicAccess.end(of: "1800000000", now: now) == nil, "truncated")
        let tooLong = PublicAccess.record(start: now, duration: 24 * 3600 + 1)
        precondition(PublicAccess.end(of: tooLong, now: now) == nil, "longer than a day")
        print("PublicAccessTests: ok")
    }
}
