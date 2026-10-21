import Foundation

// Exercises the app's preflight against the packaged service launcher.
// Usage: service-configuration-check-tests <launcher> <scratch-dir>
func check(_ value: Bool, _ message: String) {
    if !value { fatalError(message) }
}

@main
struct ServiceConfigurationCheckTests {
    static func main() throws {
        let launcher = CommandLine.arguments[1]
        let root = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)

        let missing = root.appendingPathComponent("no-password.env")
        try Data().write(to: missing)
        setenv("TIMELINE_ENV_FILE", missing.path, 1)
        let error = checkTimelineServiceConfiguration(launcher: launcher)
        check(error == "AUTH_PASSWORD must be set outside development. Add it to \(missing.path).",
              "Missing AUTH_PASSWORD must be reported with the env file, got \(error ?? "nil")")

        let configured = root.appendingPathComponent("password.env")
        try Data("AUTH_PASSWORD=smoke-test-password\n".utf8).write(to: configured)
        setenv("TIMELINE_ENV_FILE", configured.path, 1)
        let valid = checkTimelineServiceConfiguration(launcher: launcher)
        check(valid == nil, "A valid configuration must not report an error, got \(valid ?? "nil")")
    }
}
