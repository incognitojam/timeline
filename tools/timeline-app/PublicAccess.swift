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

// Whether the public address answers from the internet. Funnel being on in
// the serve config does not mean it does: Tailscale's public DNS record for
// the node can take minutes to appear. The app checks from its own end by
// asking ts.net's authoritative name servers for the node's public address
// (the node name never goes to a shared recursive resolver, whose negative
// cache would then hold "no such name" for other clients), then making an HTTPS request with
// no credentials to that address. Only a Funnel relay answers there for the
// node's name, with a certificate only the node holds, so an answer proves
// the path a hosted client takes. These helpers are the pure parts.
enum PublicReachability: Equatable {
    case checking
    case reachable
    // The last check's reason, once every check has failed.
    case unconfirmed(reason: String)

    // Seconds after Funnel came on at which to check, stopping at the first
    // answer. Tailscale says the public record can take up to 10 minutes.
    static let checkTimes: [TimeInterval] = [5, 15, 30, 60, 120, 240, 420, 600, 900]

    // Only a node name under ts.net, in characters a DNS name can hold, is
    // looked up, so the name can never be read as a dig or curl option.
    static func isCheckable(_ name: String) -> Bool {
        name.hasSuffix(".ts.net") && isHostName(name)
    }

    // Name servers from `dig +short NS <zone>`: host names only.
    static func nameServers(inShortOutput output: String) -> [String] {
        output.split(whereSeparator: \.isNewline).compactMap { line in
            var host = line.trimmingCharacters(in: .whitespaces).lowercased()
            if host.hasSuffix(".") { host.removeLast() }
            return isHostName(host) ? host : nil
        }
    }

    enum Answer: Equatable {
        case addresses([String])
        // The name's zone is delegated to these servers.
        case referral([String])
        case alias(String)
        // No such name, or no address for it, yet.
        case missing
    }

    // Reads `dig +norecurse +noall +answer +authority <name> A` from an
    // authoritative server. Only public IPv4 addresses count: a tailnet or
    // private address would not leave the Mac's networks.
    static func answer(for name: String, inDigOutput output: String) -> Answer {
        var addresses: [String] = []
        var alias: String?
        var servers: [String] = []
        for line in output.split(whereSeparator: \.isNewline) where !line.hasPrefix(";") {
            let fields = line.split(whereSeparator: \.isWhitespace).map(String.init)
            guard fields.count >= 5, fields[2] == "IN" else { continue }
            let owner = trimmedName(fields[0])
            let value = trimmedName(fields[4])
            switch fields[3] {
            case "A" where owner == name || owner == alias:
                if isPublicIPv4(value) { addresses.append(value) }
            case "CNAME" where owner == name && isHostName(value):
                alias = value
            case "NS" where name.hasSuffix("." + owner) && owner.hasSuffix(".ts.net") && isHostName(value):
                servers.append(value)
            default:
                break
            }
        }
        if !addresses.isEmpty { return .addresses(addresses) }
        if let alias { return .alias(alias) }
        if !servers.isEmpty { return .referral(servers) }
        return .missing
    }

    // From `dig +short <name> A`.
    static func addresses(inShortOutput output: String) -> [String] {
        output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter(isPublicIPv4)
    }

    // curl's `%{http_code}`: any answer below 500 came from the service
    // (MCP without a token is 401). 5xx means the service is not answering
    // MCP: tailscaled could not reach it, or no MCP token exists (503).
    static func isAnswered(httpCode: String) -> Bool {
        guard let code = Int(httpCode.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        return (200..<500).contains(code)
    }

    static func isPublicIPv4(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        var octets: [Int] = []
        for part in parts {
            guard (1...3).contains(part.count), part.allSatisfy({ ("0"..."9").contains($0) }), let value = Int(part),
                  (0...255).contains(value) else { return false }
            octets.append(value)
        }
        let (a, b) = (octets[0], octets[1])
        return !(a == 0 || a == 10 || a == 127 || a >= 224
            || (a == 100 && (64...127).contains(b))
            || (a == 169 && b == 254)
            || (a == 172 && (16...31).contains(b))
            || (a == 192 && b == 168))
    }

    private static func trimmedName(_ text: String) -> String {
        let lower = text.lowercased()
        return lower.hasSuffix(".") ? String(lower.dropLast()) : lower
    }

    private static func isHostName(_ text: String) -> Bool {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-.")
        return text.contains(".") && !text.hasPrefix("-") && !text.hasPrefix(".")
            && text.allSatisfy { allowed.contains($0) }
    }
}
