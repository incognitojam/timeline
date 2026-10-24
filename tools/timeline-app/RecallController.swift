import Foundation
import SwiftUI
import AppKit
import Darwin
import CoreGraphics

// Observes and controls the recall pause flag and capture health.
@MainActor
final class RecallController: ObservableObject {
    @Published private(set) var issue: String?
    @Published private(set) var needsPermission = !CGPreflightScreenCaptureAccess()
    private var captureTask: Task<Void, Never>?
    // Uptime excludes sleep, which cancels a tick that then finishes on wake.
    private var captureStarted: (date: Date, uptime: TimeInterval)?
    @Published private(set) var captureStuck = false
    // One notification per outage; a successful tick re-arms it.
    private var outageNotified = false
    private var failures = CaptureFailureStreak()
    private var migrationComplete = false
    private var migrationInFlight = false
    private var lastCaptureAttempt: Date?
    private var screensSleeping = false
    private var sleepObservers: [NSObjectProtocol] = []
    private let pipeline = RecallPipeline(home: FileManager.default.homeDirectoryForCurrentUser)

    var isRecordingEnabled: Bool { !isPaused && !needsPermission }
    // true when capture is paused (i.e. the pause flag exists on disk).
    @Published private(set) var isPaused: Bool
    // Timestamp of the most recent successful capture (nil if none seen yet).
    @Published private(set) var lastCapture: Date?
    // Re-stamped on each poll so age/staleness derive from the current time.
    @Published private(set) var now: Date = Date()

    // When recording last (re)started — see captureStatus()'s grace handling.
    private var recordingSince: Date?

    private let flagURL: URL
    private let watchDirURL: URL
    private let logURL: URL
    private var watch: DispatchSourceFileSystemObject?
    private var scheduler: RefreshScheduler?

    init() {
        watchDirURL = timelineDataDirectory()
        flagURL = pipeline.pauseFlag
        logURL = pipeline.logURL
        // Watch the pause flag even before the first capture lands.
        try? FileManager.default.createDirectory(at: watchDirURL, withIntermediateDirectories: true)
        isPaused = FileManager.default.fileExists(atPath: flagURL.path)
        lastCapture = Self.readLastCapture(from: logURL)
        recordingSince = isPaused ? nil : Date()
        startWatching()
        scheduler = RefreshScheduler(
            interval: RecallPipeline.interval,
            onPoll: { [weak self] in Task { @MainActor in self?.tick() } },
            onWake: { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    self.screensSleeping = false
                    if !self.isPaused { self.recordingSince = Date() }
                    self.tick()
                }
            },
            onActivation: { [weak self] in Task { @MainActor in self?.tick() } }
        )
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification] {
            sleepObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.screensSleeping = true
                    self?.captureTask?.cancel()
                }
            })
        }
        tick()
    }

    private func tick() {
        refreshHealth()
        let hadPermission = !needsPermission
        needsPermission = !CGPreflightScreenCaptureAccess()
        if hadPermission && needsPermission {
            notifyOutage("Screen Recording permission was turned off. Allow Timeline to record from its menu.")
        }
        checkStuckCapture()
        if isPaused || needsPermission { captureTask?.cancel() }
        guard ServiceAgentController.isRunningFromInstalledLocation() else {
            issue = "Recall: run the installed app to record"
            return
        }
        guard migrationComplete else {
            guard !migrationInFlight else { return }
            migrationInFlight = true
            Task.detached(priority: .utility) {
                do {
                    try RecallMigration.retire()
                    await MainActor.run {
                        self.migrationComplete = true
                        self.migrationInFlight = false
                        self.issue = nil
                        self.tick()
                    }
                } catch {
                    await MainActor.run {
                        self.migrationInFlight = false
                        self.issue = "Recall migration failed: \(error.localizedDescription)"
                    }
                }
            }
            return
        }
        guard !isPaused, !needsPermission, !screensSleeping,
              !RecallCapture.screenLocked, captureTask == nil else { return }
        // Activation and wake notifications can arrive together; avoid duplicate
        // ticks and filename collisions within the normal capture interval.
        let now = Date()
        if let lastCaptureAttempt {
            let next = lastCaptureAttempt.addingTimeInterval(RecallPipeline.interval)
            if now < next {
                scheduler?.scheduleNextPoll(at: next)
                return
            }
        }
        lastCaptureAttempt = now
        scheduler?.scheduleNextPoll(at: now.addingTimeInterval(RecallPipeline.interval))
        let pipeline = self.pipeline
        captureStarted = (now, ProcessInfo.processInfo.systemUptime)
        captureTask = Task.detached(priority: .utility) {
            do {
                if let written = try await pipeline.run() {
                    try pipeline.appendLog("wrote \(written) window(s) for app capture")
                }
                await MainActor.run {
                    self.issue = nil
                    self.failures.recordSuccess()
                    if self.outageNotified { RecallNotifier.shared.withdraw() }
                    self.outageNotified = false
                }
            } catch is CancellationError {
                // Pausing or sleeping cancels the current tick before publication.
            } catch {
                do { try pipeline.appendLog(error.localizedDescription) }
                catch { writeError("Timeline Recall logging failed: \(error)\n") }
                await MainActor.run {
                    guard self.failures.recordFailure() else { return }
                    self.issue = "Recall: \(error.localizedDescription)"
                    self.notifyOutage(error.localizedDescription)
                }
            }
            await MainActor.run {
                self.captureTask = nil
                self.captureStarted = nil
                self.captureStuck = false
                self.refreshHealth()
            }
        }
    }

    // Ticks never overlap, so a tick that never returns stops all recording
    // without an error. Report it, and sample the app's stacks for diagnosis.
    private func checkStuckCapture() {
        guard let started = captureStarted, !captureStuck,
              ProcessInfo.processInfo.systemUptime - started.uptime >= RecallPipeline.stuckAfter else { return }
        captureStuck = true
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        let message = "Capture has been stuck since \(formatter.string(from: started.date)). Quit and reopen Timeline."
        issue = "Recall: \(message)"
        notifyOutage(message)
        let pipeline = self.pipeline
        Task.detached(priority: .utility) {
            let report = pipeline.logURL.deletingLastPathComponent()
                .appendingPathComponent("stuck-\(Int(started.date.timeIntervalSince1970)).txt")
            let sampled = runCommand("/usr/bin/sample", ["\(getpid())", "3", "-file", report.path])?.succeeded == true
            do { try pipeline.appendLog(sampled ? "\(message) Stacks: \(report.path)" : message) }
            catch { writeError("Timeline Recall logging failed: \(error)\n") }
        }
    }

    private func notifyOutage(_ body: String) {
        guard !outageNotified else { return }
        outageNotified = true
        RecallNotifier.shared.post(body)
    }

    func requestPermission() {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        needsPermission = !CGPreflightScreenCaptureAccess()
        if needsPermission { openPermissionSettings() }
        tick()
    }

    func openPermissionSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") else { return }
        NSWorkspace.shared.open(url)
    }

    // Derived capture health for the icon and status line.
    var status: CaptureStatus {
        if !isPaused && (needsPermission || issue != nil) { return .notCapturing }
        return captureStatus(isPaused: isPaused, lastCapture: lastCapture,
                             recordingSince: recordingSince, now: now)
    }

    // "Last capture 2 min. ago", or nil when no capture has been seen.
    var lastCaptureAgeString: String? {
        guard let last = lastCapture else { return nil }
        return "Last capture " + Self.ageFormatter.localizedString(for: last, relativeTo: now)
    }

    // Set whether recall is recording. recording == flag absent.
    func setRecording(_ recording: Bool) {
        do {
            if recording {
                _ = try RecallPipeline.encoder()
                if FileManager.default.fileExists(atPath: flagURL.path) {
                    try FileManager.default.removeItem(at: flagURL)
                }
            } else {
                try Data().write(to: flagURL, options: .atomic)
                captureTask?.cancel()
            }
            issue = nil
            refresh()
            if recording { requestPermission() }
        } catch {
            issue = "Recall: \(error.localizedDescription)"
        }
    }

    // Lightweight reconcile of the pause flag only (no log read). Used on the
    // user's own toggle and on external flag changes, where capture health
    // hasn't moved yet — the poll picks that up.
    func refresh() {
        applyPaused(FileManager.default.fileExists(atPath: flagURL.path))
    }

    private func applyPaused(_ paused: Bool) {
        guard paused != isPaused else { return }
        isPaused = paused
        recordingSince = paused ? nil : Date()
        if paused { captureTask?.cancel() }
    }

    // Full reconcile incl. re-reading capture.log; driven by the poll timer.
    private func refreshHealth() {
        now = Date()
        refresh()
        let last = Self.readLastCapture(from: logURL)
        if last != lastCapture { lastCapture = last }
    }

    // Most recent successful-capture timestamp from the tail of capture.log.
    // Reads a bounded window from the end so the (unrotated) log can grow
    // without slowing the poll; a lossy UTF-8 decode keeps a byte split at the
    // window boundary from discarding the chunk.
    private static func readLastCapture(from logURL: URL) -> Date? {
        guard let handle = try? FileHandle(forReadingFrom: logURL) else { return nil }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return nil }
        let window: UInt64 = 64 * 1024
        let start = end > window ? end - window : 0
        guard (try? handle.seek(toOffset: start)) != nil,
              let data = try? handle.readToEnd() else { return nil }
        return lastCaptureDate(inLogTail: String(decoding: data, as: UTF8.self))
    }

    private static let ageFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    // Watch the parent directory so the icon tracks an external touch/rm of the
    // flag (e.g. the documented `touch …/recall.pause` operational command).
    private func startWatching() {
        let fd = open(watchDirURL.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .delete, .rename], queue: .main)
        source.setEventHandler { [weak self] in Task { @MainActor in self?.refresh() } }
        source.setCancelHandler { close(fd) }
        source.resume()
        watch = source
    }

}
