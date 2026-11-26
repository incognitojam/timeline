// Text recognition runs in a child process so the app can kill it when Vision
// hangs. One request at a time: the app writes an image path and a newline,
// and the worker answers with one JSON line, {"lines": [...]} or {"error": ...}.
import Foundation
import Darwin

final class OCRWorker: @unchecked Sendable {
    private struct Child {
        let process: Process
        let input: FileHandle
        let output: FileHandle
    }

    let executable: URL
    let arguments: [String]
    let timeout: TimeInterval
    // Requests, and every close of a worker's pipes, run one at a time on the
    // queue; the lock guards `child` against stop(), which runs on the main actor.
    private let queue = DispatchQueue(label: "dev.incognitojam.timeline.ocr")
    private let lock = NSLock()
    private var child: Child?

    init(executable: URL, arguments: [String], timeout: TimeInterval) {
        self.executable = executable
        self.arguments = arguments
        self.timeout = timeout
    }

    // Recognised lines of the image at `path`. A worker that misses the
    // timeout, dies or answers garbage is killed; the next call starts another.
    func recognize(path: String) async throws -> [String] {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try self.request(path) }) }
        }
    }

    // Ends the worker, if one is running, without waiting for it to exit.
    // KILL fails a request in flight with EOF; its pipes close on the queue
    // after that request, never under it.
    func stop() {
        let stopped: Child? = lock.withLock {
            defer { child = nil }
            return child
        }
        guard let stopped else { return }
        if stopped.process.isRunning { kill(stopped.process.processIdentifier, SIGKILL) }
        queue.async { Self.end(stopped) }
    }

    private func request(_ path: String) throws -> [String] {
        // A newline would split the request in two.
        guard !path.contains("\n") else { throw RecallError("Text recognition cannot read an image path containing a newline.") }
        let worker = try current()
        let reply: [String: Any]
        do {
            do {
                try worker.input.write(contentsOf: Data((path + "\n").utf8))
            } catch {
                throw Self.stoppedError
            }
            let line = try Self.readReply(worker.output.fileDescriptor, timeout: timeout)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  object["lines"] is [String] || object["error"] is String else {
                throw Self.unreadableReply
            }
            reply = object
        } catch {
            discard(worker)
            throw error
        }
        guard let lines = reply["lines"] as? [String] else {
            throw RecallError("Text recognition could not read a captured image, so this capture was skipped.")
        }
        return lines
    }

    // The running worker, or a new one if there is none or it has exited.
    private func current() throws -> Child {
        try lock.withLock {
            if let child {
                if child.process.isRunning { return child }
                Self.end(child)
                self.child = nil
            }
            let started = try spawn()
            child = started
            return started
        }
    }

    private func discard(_ worker: Child) {
        let owned = lock.withLock {
            guard child?.process === worker.process else { return false }
            child = nil
            return true
        }
        // stop() already took it otherwise, and ends it itself.
        if owned { Self.end(worker) }
    }

    private func spawn() throws -> Child {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        // A worker that exits between requests makes the write fail with
        // EPIPE instead of killing the app with SIGPIPE.
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            throw RecallError("Text recognition could not start (error \(errno)), so this capture was skipped. Timeline tries again on the next capture.")
        }
        do {
            try process.run()
        } catch {
            throw RecallError("Text recognition could not start (error \((error as NSError).code)), so this capture was skipped. Timeline tries again on the next capture.")
        }
        return Child(process: process, input: input.fileHandleForWriting, output: output.fileHandleForReading)
    }

    // Closing the input ends an idle worker; TERM ends a busy one, and KILL one
    // that ignores TERM. A worker stuck where even KILL cannot reach it is
    // abandoned rather than waited for, so recall carries on with a new one.
    private static func end(_ worker: Child) {
        try? worker.input.close()
        if worker.process.isRunning { worker.process.terminate() }
        if !exits(worker.process, within: 2) {
            kill(worker.process.processIdentifier, SIGKILL)
            if !exits(worker.process, within: 2) {
                RecallCapture.warn("an OCR worker did not exit after KILL and was abandoned")
            }
        }
        try? worker.output.close()
    }

    // Foundation reaps the process before isRunning turns false.
    private static func exits(_ process: Process, within seconds: TimeInterval) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        while process.isRunning, ProcessInfo.processInfo.systemUptime < deadline { usleep(20_000) }
        return !process.isRunning
    }

    private static let stoppedError = RecallError("Text recognition stopped unexpectedly, so this capture was skipped. Timeline restarts it for the next capture.")

    private static let unreadableReply = RecallError("Text recognition sent an unreadable reply, so this capture was skipped. Timeline restarts it for the next capture.")

    // One newline-terminated reply, without the newline.
    private static func readReply(_ fd: Int32, timeout: TimeInterval) throws -> Data {
        // Uptime, so a clock change cannot move the deadline.
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var reply = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else {
                throw RecallError("Text recognition did not finish within \(Int(timeout)) seconds, so this capture was skipped. Timeline restarts text recognition for the next capture.")
            }
            var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let polled = poll(&ready, 1, Int32((remaining * 1000).rounded(.up)))
            if polled < 0 && errno != EINTR { throw stoppedError }
            guard polled > 0 else { continue }
            let count = read(fd, &chunk, chunk.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw stoppedError }
            reply.append(contentsOf: chunk[0..<count])
            if let end = reply.firstIndex(of: UInt8(ascii: "\n")) {
                guard end == reply.index(before: reply.endIndex) else { throw unreadableReply }
                return reply.prefix(upTo: end)
            }
        }
    }

    // Worker mode: answers each input line until the input closes or the app
    // exits. The main thread keeps reading while a recognition runs, so the
    // worker ends even if Vision never returns.
    static func serve(_ recognize: @escaping @Sendable (String) -> [String]?) -> Never {
        // The app spawns from a dispatch thread, whose blocked signals the
        // worker inherits; unblock them so TERM ends it.
        var unblocked = sigset_t()
        sigemptyset(&unblocked)
        pthread_sigmask(SIG_SETMASK, &unblocked, nil)
        // Replies get stdout to themselves; anything else printed goes to stderr.
        let replies = FileHandle(fileDescriptor: dup(STDOUT_FILENO))
        dup2(STDERR_FILENO, STDOUT_FILENO)
        let parent = getppid()
        let parentExit = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .global())
        parentExit.setEventHandler { _exit(0) }
        parentExit.resume()
        if parent == 1 || getppid() != parent { _exit(0) }
        let queue = DispatchQueue(label: "dev.incognitojam.timeline.ocr-worker")
        withExtendedLifetime(parentExit) {
            while let path = readLine() {
                queue.async {
                    let reply: [String: Any] = recognize(path).map { ["lines": $0] } ?? ["error": "unreadable image"]
                    guard let data = try? JSONSerialization.data(withJSONObject: reply),
                          (try? replies.write(contentsOf: data + Data("\n".utf8))) != nil else { _exit(1) }
                }
            }
        }
        _exit(0)
    }
}
