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

        // Quit for an update, then relaunch. Uptime is in seconds.
        let boot = "11111111-2222-3333-4444-555555555555"
        let quit = 5000
        let window = Int(PublicAccess.resumeWindow)
        let paused = PublicAccess.paused(record: hour, forUpdate: true, boot: boot, uptime: quit, now: now.addingTimeInterval(60))
        precondition(paused != nil, "update quit pauses a current record")
        let resumed = PublicAccess.resumable(paused, boot: boot, uptime: quit + 60, now: now.addingTimeInterval(120))
        precondition(resumed?.record == hour, "relaunch before the end resumes the same end")
        precondition(resumed?.deadline == quit + window, "resume deadline counts from the quit")
        precondition(PublicAccess.resumable(paused, boot: boot, uptime: quit + 60, now: now.addingTimeInterval(3600)) == nil, "relaunch after the end")
        precondition(PublicAccess.resumable(paused, boot: "other-boot", uptime: quit + 60, now: now.addingTimeInterval(120)) == nil, "Mac restarted")
        precondition(PublicAccess.resumable(paused, boot: nil, uptime: quit + 60, now: now.addingTimeInterval(120)) == nil, "boot unknown")
        precondition(PublicAccess.resumable(paused, boot: boot, uptime: quit + 60, now: now.addingTimeInterval(-1)) == nil, "clock moved back past the start")
        precondition(PublicAccess.resumable(paused, boot: boot, uptime: quit - 1, now: now.addingTimeInterval(120)) == nil, "uptime before the quit")
        precondition(PublicAccess.resumable(paused, boot: boot, uptime: quit + window + 1, now: now.addingTimeInterval(120)) == nil, "relaunch too long after the quit")
        precondition(PublicAccess.resumable(nil, boot: boot, uptime: quit, now: now) == nil, "nothing paused")
        precondition(PublicAccess.resumable("garbage", boot: boot, uptime: quit, now: now) == nil, "malformed")
        precondition(PublicAccess.resumable("\(boot) \(quit) garbage x", boot: boot, uptime: quit + 60, now: now.addingTimeInterval(120)) == nil, "malformed record")
        precondition(PublicAccess.resumable("\(boot) \(quit) \(tooLong)", boot: boot, uptime: quit + 60, now: now.addingTimeInterval(120)) == nil, "paused record longer than a day")
        // Only an update quit of a current record pauses anything.
        precondition(PublicAccess.paused(record: hour, forUpdate: false, boot: boot, uptime: quit, now: now) == nil, "owner Quit")
        precondition(PublicAccess.paused(record: hour, forUpdate: true, boot: boot, uptime: quit, now: now.addingTimeInterval(3600)) == nil, "update quit after the end")
        precondition(PublicAccess.paused(record: nil, forUpdate: true, boot: boot, uptime: quit, now: now) == nil, "update quit while tailnet only")
        precondition(PublicAccess.paused(record: "garbage", forUpdate: true, boot: boot, uptime: quit, now: now) == nil, "update quit with a malformed record")
        precondition(PublicAccess.paused(record: hour, forUpdate: true, boot: nil, uptime: quit, now: now) == nil, "update quit with boot unknown")
        print("PublicAccessTests: ok")
    }
}
