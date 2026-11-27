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
        precondition(PublicAccess.resumable("\(boot) \(Int.min) \(hour)", boot: boot, uptime: quit, now: now) == nil, "forged quit uptime")
        precondition(PublicAccess.resumable("garbage", boot: boot, uptime: quit, now: now) == nil, "malformed")
        precondition(PublicAccess.resumable("\(boot) \(quit) garbage x", boot: boot, uptime: quit + 60, now: now.addingTimeInterval(120)) == nil, "malformed record")
        precondition(PublicAccess.resumable("\(boot) \(quit) \(tooLong)", boot: boot, uptime: quit + 60, now: now.addingTimeInterval(120)) == nil, "paused record longer than a day")
        // Only an update quit of a current record pauses anything.
        precondition(PublicAccess.paused(record: hour, forUpdate: false, boot: boot, uptime: quit, now: now) == nil, "owner Quit")
        precondition(PublicAccess.paused(record: hour, forUpdate: true, boot: boot, uptime: quit, now: now.addingTimeInterval(3600)) == nil, "update quit after the end")
        precondition(PublicAccess.paused(record: nil, forUpdate: true, boot: boot, uptime: quit, now: now) == nil, "update quit while tailnet only")
        precondition(PublicAccess.paused(record: "garbage", forUpdate: true, boot: boot, uptime: quit, now: now) == nil, "update quit with a malformed record")
        precondition(PublicAccess.paused(record: hour, forUpdate: true, boot: nil, uptime: quit, now: now) == nil, "update quit with boot unknown")

        // Reachability: what the check reads from dig and curl.
        let node = "node.example.ts.net"
        precondition(PublicReachability.isCheckable(node), "a ts.net node name")
        precondition(!PublicReachability.isCheckable("node.example.com"), "not under ts.net")
        precondition(!PublicReachability.isCheckable("-p.example.ts.net"), "reads as an option")
        precondition(!PublicReachability.isCheckable("node x.example.ts.net"), "space")
        precondition(PublicReachability.nameServers(inShortOutput: "ns1.example.com.\nns2.example.net.\n;; junk\n")
            == ["ns1.example.com", "ns2.example.net"], "name servers")
        let answered = "\(node).\t300\tIN\tA\t203.0.113.7\n\(node).\t300\tIN\tA\t100.101.102.103\n"
        precondition(PublicReachability.answer(for: node, inDigOutput: answered) == .addresses(["203.0.113.7"]), "public address, tailnet address dropped")
        precondition(PublicReachability.answer(for: node, inDigOutput: "\(node).\t300\tIN\tA\t100.101.102.103\n") == .missing, "tailnet address only")
        let missing = "ts.net.\t300\tIN\tSOA\tns1.example.com. admin.example.com. 1 86400 7200 604800 300\n"
        precondition(PublicReachability.answer(for: node, inDigOutput: missing) == .missing, "no such name yet")
        precondition(PublicReachability.answer(for: node, inDigOutput: "") == .missing, "empty")
        let referral = "example.ts.net.\t300\tIN\tNS\tns.example.org.\n"
        precondition(PublicReachability.answer(for: node, inDigOutput: referral) == .referral(["ns.example.org"]), "delegated zone")
        precondition(PublicReachability.answer(for: node, inDigOutput: "ts.net.\t300\tIN\tNS\tns1.example.com.\n") == .missing, "ts.net itself is not a referral")
        precondition(PublicReachability.answer(for: node, inDigOutput: "other.example.ts.net.\t300\tIN\tA\t203.0.113.7\n") == .missing, "another name's address")
        let alias = "\(node).\t300\tIN\tCNAME\trelay.example.net.\n"
        precondition(PublicReachability.answer(for: node, inDigOutput: alias) == .alias("relay.example.net"), "alias out of zone")
        precondition(PublicReachability.answer(for: node, inDigOutput: alias + "relay.example.net.\t300\tIN\tA\t198.51.100.9\n")
            == .addresses(["198.51.100.9"]), "alias with its address")
        precondition(PublicReachability.addresses(inShortOutput: "relay.example.net.\n198.51.100.9\n10.0.0.1\n") == ["198.51.100.9"], "short addresses")
        for address in ["10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "0.1.2.3", "224.0.0.1", "1.2.3", "1.2.3.256", "01.2.3.4x"] {
            precondition(!PublicReachability.isPublicIPv4(address), "not public: \(address)")
        }
        precondition(PublicReachability.isPublicIPv4("100.128.0.1") && PublicReachability.isPublicIPv4("203.0.113.7"), "public")
        precondition(PublicReachability.isAnswered(httpCode: "401"), "MCP without a token")
        precondition(PublicReachability.isAnswered(httpCode: "403\n"), "forbidden path")
        precondition(!PublicReachability.isAnswered(httpCode: "000"), "no answer")
        precondition(!PublicReachability.isAnswered(httpCode: "502"), "service down behind Funnel")
        precondition(!PublicReachability.isAnswered(httpCode: ""), "curl printed nothing")
        print("PublicAccessTests: ok")
    }
}
