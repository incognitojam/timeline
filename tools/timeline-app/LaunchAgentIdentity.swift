import Foundation
import Darwin

struct LaunchCtlLoadedJob: Equatable {
    let plistPath: String?
    let programPath: String?
    var bundleProgram: LaunchCtlBundleProgram? = nil
}

struct LaunchCtlBundleProgram: Equatable {
    let relativePath: String
    let parentIdentifier: String
    let parentVersion: String
}

enum LaunchAgentIdentity {
    static func loadedJob(from launchctlOutput: String) -> LaunchCtlLoadedJob {
        LaunchCtlLoadedJob(
            plistPath: scalarValue(named: "path", in: launchctlOutput),
            programPath: programPath(from: launchctlOutput),
            bundleProgram: bundleProgram(from: launchctlOutput)
        )
    }

    static func isBundledAgentLoaded(
        _ loadedJob: LaunchCtlLoadedJob,
        bundledAgentPlist: URL
    ) -> Bool {
        if pathMatches(loadedJob.plistPath, bundledAgentPlist.path) {
            return true
        }

        guard isSMAppServiceSubmissionPath(loadedJob.plistPath) else {
            return false
        }

        guard let expectedProgramPath = bundledAgentProgramPath(from: bundledAgentPlist) else {
            return true
        }

        if let program = loadedJob.bundleProgram {
            let bundle = bundleURL(for: bundledAgentPlist)
            guard let info = plistDictionary(at: bundle.appendingPathComponent("Contents/Info.plist")),
                  info["CFBundleIdentifier"] as? String == program.parentIdentifier,
                  info["CFBundleVersion"] as? String == program.parentVersion else {
                return false
            }
            return pathMatches(bundle.appendingPathComponent(program.relativePath).path, expectedProgramPath)
        }

        guard let loadedProgramPath = loadedJob.programPath else {
            return false
        }

        return pathMatches(loadedProgramPath, expectedProgramPath)
    }

    static func isSMAppServiceSubmissionPath(_ path: String?) -> Bool {
        guard let path else { return false }
        let value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.hasPrefix("(submitted by smd") && value.hasSuffix(")")
    }

    private static func bundleProgram(from output: String) -> LaunchCtlBundleProgram? {
        let suffix = " (mode: 2)"
        guard let identifier = scalarValue(named: "program identifier", in: output),
              identifier.hasSuffix(suffix),
              let parentIdentifier = scalarValue(named: "parent bundle identifier", in: output),
              let parentVersion = scalarValue(named: "parent bundle version", in: output) else {
            return nil
        }
        let relativePath = String(identifier.dropLast(suffix.count))
        guard !relativePath.isEmpty, !relativePath.hasPrefix("/") else { return nil }
        return LaunchCtlBundleProgram(
            relativePath: relativePath, parentIdentifier: parentIdentifier, parentVersion: parentVersion
        )
    }

    private static func programPath(from launchctlOutput: String) -> String? {
        let lines = launchctlOutput.split(separator: "\n", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespaces) }

        for line in lines {
            guard line.hasPrefix("program = ") else { continue }
            return parseLaunchctlValue(String(line.dropFirst("program = ".count)))
        }

        for (index, line) in lines.enumerated() {
            guard line == "ProgramArguments = {" || line == "ProgramArguments = (" || line == "arguments = {" else {
                continue
            }

            for argumentLine in lines.dropFirst(index + 1) {
                if argumentLine == "}" || argumentLine == ")" {
                    break
                }
                if let equals = argumentLine.range(of: " = ") {
                    let value = String(argumentLine[equals.upperBound...])
                    if let parsed = parseLaunchctlValue(value) {
                        return parsed
                    }
                    continue
                }
                if let parsed = parseLaunchctlValue(argumentLine) {
                    return parsed
                }
            }
        }

        return nil
    }

    private static func scalarValue(named name: String, in launchctlOutput: String) -> String? {
        let prefix = "\(name) = "
        for line in launchctlOutput.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = String(line).trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(prefix) else { continue }
            return parseLaunchctlValue(String(trimmed.dropFirst(prefix.count)))
        }
        return nil
    }

    private static func parseLaunchctlValue(_ value: String) -> String? {
        var parsed = value.trimmingCharacters(in: .whitespaces)
        if parsed.hasPrefix("\""), parsed.hasSuffix("\""), parsed.count >= 2 {
            parsed.removeFirst()
            parsed.removeLast()
        }
        return parsed.isEmpty ? nil : parsed
    }

    private static func plistDictionary(at plistURL: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) else {
            return nil
        }
        return plist as? [String: Any]
    }

    private static func bundleURL(for plistURL: URL) -> URL {
        plistURL.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private static func bundledAgentProgramPath(from plistURL: URL) -> String? {
        guard let dictionary = plistDictionary(at: plistURL) else { return nil }

        if let program = dictionary["BundleProgram"] as? String, !program.isEmpty {
            return bundleURL(for: plistURL).appendingPathComponent(program).path
        }

        if let program = dictionary["Program"] as? String, !program.isEmpty {
            return program
        }

        guard let arguments = dictionary["ProgramArguments"] as? [String],
              let program = arguments.first,
              !program.isEmpty else {
            return nil
        }

        return program
    }

    private static func pathMatches(_ actualPath: String?, _ expectedPath: String) -> Bool {
        guard let actualPath else { return false }

        let actualURL = URL(fileURLWithPath: actualPath)
        let expectedURL = URL(fileURLWithPath: expectedPath)
        if let actualRealPath = realPath(actualURL),
           let expectedRealPath = realPath(expectedURL) {
            return actualRealPath == expectedRealPath
        }
        return actualURL.standardizedFileURL.path == expectedURL.standardizedFileURL.path
    }

    static func realPath(_ url: URL) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        return url.path.withCString { path in
            guard let resolved = realpath(path, &buffer) else { return nil }
            return String(cString: resolved)
        }
    }
}
