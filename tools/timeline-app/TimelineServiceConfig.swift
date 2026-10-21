import Foundation

struct TimelineServiceEndpoint: Equatable {
    let host: String
    let port: Int

    var baseURL: URL? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        return components.url
    }
}

private let defaultTimelineServiceHost = "127.0.0.1"
private let defaultTimelineServicePort = 3001
private let defaultTimelineServiceEndpoint = TimelineServiceEndpoint(
    host: defaultTimelineServiceHost,
    port: defaultTimelineServicePort
)

func loadTimelineServiceEndpoint() -> TimelineServiceEndpoint {
    let path = timelineConfigPath()
    let text = try? String(contentsOfFile: path, encoding: .utf8)
    return resolveTimelineServiceEndpoint(parseTimelineServiceEndpoint(toml: text))
}

func parseTimelineServiceEndpoint(toml: String?) -> TimelineServiceEndpoint {
    var host = defaultTimelineServiceHost
    var port = defaultTimelineServicePort
    var inServerSection = false

    for rawLine in toml?.split(separator: "\n", omittingEmptySubsequences: false) ?? [] {
        let line = stripTomlComment(String(rawLine)).trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty else { continue }

        if line.hasPrefix("["), line.hasSuffix("]") {
            let section = line
                .dropFirst()
                .dropLast()
                .trimmingCharacters(in: .whitespaces)
            inServerSection = section == "server"
            continue
        }

        guard inServerSection, let equals = line.firstIndex(of: "=") else { continue }
        let key = line[..<equals].trimmingCharacters(in: .whitespaces)
        let value = line[line.index(after: equals)...].trimmingCharacters(in: .whitespaces)

        switch key {
        case "host":
            if let parsed = parseTomlString(value), !parsed.isEmpty {
                host = parsed
            }
        case "port":
            port = parseTimelineServicePort(value)
        default:
            continue
        }
    }

    if host == "0.0.0.0" || host == "::" {
        host = defaultTimelineServiceHost
    }

    return TimelineServiceEndpoint(host: host, port: port)
}

func resolveTimelineServiceEndpoint(_ endpoint: TimelineServiceEndpoint) -> TimelineServiceEndpoint {
    if endpoint.baseURL != nil {
        return endpoint
    }

    writeError(
        "Timeline service config ignored invalid server endpoint '\(endpoint.host):\(endpoint.port)'; using \(defaultTimelineServiceHost):\(defaultTimelineServicePort)\n"
    )
    return defaultTimelineServiceEndpoint
}

func timelineServiceBaseURL(for endpoint: TimelineServiceEndpoint) -> URL {
    let resolved = resolveTimelineServiceEndpoint(endpoint)
    if let url = resolved.baseURL {
        return url
    }

    preconditionFailure("Invalid default Timeline service URL")
}

private func parseTimelineServicePort(_ value: String) -> Int {
    let portText = parseTomlString(value) ?? value
    if let port = Int(portText), (1...65535).contains(port) {
        return port
    }

    writeError(
        "Timeline service config ignored invalid server.port '\(portText)'; using \(defaultTimelineServicePort)\n"
    )
    return defaultTimelineServicePort
}

private func timelineConfigPath() -> String {
    if let configured = ProcessInfo.processInfo.environment["TIMELINE_CONFIG"],
       !configured.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return NSString(string: configured).expandingTildeInPath
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/timeline/config.toml")
        .path
}

private func stripTomlComment(_ line: String) -> String {
    var result = ""
    var quote: Character?
    var escaped = false

    for character in line {
        if let activeQuote = quote {
            result.append(character)
            if activeQuote == "\"" && character == "\\" && !escaped {
                escaped = true
                continue
            }
            if character == activeQuote && !escaped {
                quote = nil
            }
            escaped = false
            continue
        }

        if character == "#" {
            break
        }
        if character == "\"" || character == "'" {
            quote = character
        }
        result.append(character)
    }

    return result
}

private func parseTomlString(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespaces)
    guard let first = trimmed.first else { return nil }

    if first == "\"" || first == "'" {
        guard trimmed.count >= 2, trimmed.last == first else { return nil }
        let inner = trimmed.dropFirst().dropLast()
        if first == "\"" {
            return inner.replacingOccurrences(of: "\\\"", with: "\"")
        }
        return String(inner)
    }

    return trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
}

// Runs the packaged service's --check-config preflight and returns the reason
// it would refuse to start, or nil when the configuration is valid or the
// check could not complete.
func checkTimelineServiceConfiguration(launcher: String) -> String? {
    guard let result = runCommand(launcher, ["--check-config"], timeout: 60) else { return nil }
    guard !result.succeeded else { return nil }
    let prefix = "Configuration error: "
    guard let line = result.output.split(separator: "\n").last(where: { $0.hasPrefix(prefix) }) else {
        writeError("Timeline service configuration check failed without a reason:\n\(result.output)\n")
        return "Configuration check failed (exit \(result.terminationStatus))"
    }
    return String(line.dropFirst(prefix.count))
}
