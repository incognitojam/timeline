// Shared subprocess plumbing for the menu bar app. Every short-lived command
// the app runs (launchctl, git, tailscale, the update script) goes through
// runCommand; only RemoteAccess's interactive `tailscale up` (which streams
// output and abandons the process) has its own spawn path.

import Foundation
import Darwin

func writeError(_ message: String) {
    FileHandle.standardError.write(Data(message.utf8))
}

struct CommandResult {
    let terminationStatus: Int32
    let output: String

    var succeeded: Bool { terminationStatus == 0 }
}

// Thread-safe accumulator for pipe output — the readability handler runs
// on its own dispatch queue.
private final class OutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private var reachedEOF = false

    func append(_ chunk: Data) { lock.withLock { data.append(chunk) } }
    func markEOF() { lock.withLock { reachedEOF = true } }
    var eof: Bool { lock.withLock { reachedEOF } }
    var snapshot: Data { lock.withLock { data } }
}

// Runs a command and captures stdout (stderr merged in unless captureStderr
// is false), killing it at the timeout. Returns nil when the command could
// not run to completion, unless returnTerminatedResult asks to retain a
// watchdog- or signal-terminated child's output for diagnostics.
func runCommand(
    _ executable: String,
    _ arguments: [String],
    environmentOverrides: [String: String] = [:],
    captureStderr: Bool = true,
    timeout: TimeInterval = 30,
    onTimeout: (@Sendable () -> Void)? = nil,
    returnTerminatedResult: Bool = false
) -> CommandResult? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if !environmentOverrides.isEmpty {
        process.environment = ProcessInfo.processInfo.environment
            .merging(environmentOverrides) { _, override in override }
    }
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = captureStderr ? pipe : FileHandle.nullDevice

    // Collect output with a readability handler instead of a blocking
    // read-to-EOF: grandchildren (bun/vite workers) inherit the pipe's
    // write end, so EOF can arrive long after the direct child exits — or
    // never, if one hangs. The wall-clock bound must come from
    // waitUntilExit on the direct child, not from pipe EOF.
    let output = OutputBuffer()
    pipe.fileHandleForReading.readabilityHandler = { handle in
        let chunk = handle.availableData
        if chunk.isEmpty {
            output.markEOF()
            handle.readabilityHandler = nil
        } else {
            output.append(chunk)
        }
    }

    do {
        try process.run()
    } catch {
        pipe.fileHandleForReading.readabilityHandler = nil
        writeError("Timeline: failed to launch \(executable): \(error)\n")
        return nil
    }

    // TERM at the deadline, then KILL shortly after in case TERM is
    // caught or ignored, so waitUntilExit is genuinely bounded.
    let terminate = DispatchWorkItem {
        if process.isRunning {
            onTimeout?()
            process.terminate()
        }
    }
    let killHard = DispatchWorkItem {
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
    let watchdogQueue = DispatchQueue.global(qos: .utility)
    watchdogQueue.asyncAfter(deadline: .now() + timeout, execute: terminate)
    watchdogQueue.asyncAfter(deadline: .now() + timeout + 10, execute: killHard)

    process.waitUntilExit()
    terminate.cancel()
    killHard.cancel()

    // Give the handler a moment to drain what the child wrote just before
    // exiting; with no grandchild holding the write end this ends at EOF.
    // Output is only used for error logging and parsing on success, so a
    // lost tail is tolerable.
    let drainDeadline = Date().addingTimeInterval(1)
    while !output.eof, Date() < drainDeadline {
        Thread.sleep(forTimeInterval: 0.05)
    }
    pipe.fileHandleForReading.readabilityHandler = nil

    let result = CommandResult(
        terminationStatus: process.terminationReason == .exit ? process.terminationStatus : -1,
        output: String(decoding: output.snapshot, as: UTF8.self)
    )
    guard process.terminationReason == .exit || returnTerminatedResult else {
        writeError("Timeline: \(executable) \(arguments.joined(separator: " ")) timed out or was killed.\n")
        return nil
    }
    return result
}
