import Foundation

// Sparkle can finish a check while its installer still waits for app termination.
// Keep that staged installation distinct from the lifetime of the check cycle.
struct UpdateInstallation {
    enum TerminationDecision { case allow, prepare, wait }
    private(set) var staged = false
    private(set) var preparing = false
    private(set) var prepared = false

    mutating func stage() { staged = true }
    mutating func discard() { staged = false }

    mutating func recordChoice(skipped: Bool, installerRunning: Bool) {
        if skipped || !installerRunning { discard() }
    }

    mutating func finishCycle(failed: Bool) {
        if failed { discard() }
    }

    var terminationDecision: TerminationDecision {
        if preparing { return .wait }
        if prepared || !staged { return .allow }
        return .prepare
    }

    mutating func beginPreparation() { preparing = true }

    // An abort can arrive while the asynchronous service stop is in flight.
    // The caller must recover the hold and cancel termination in that case.
    mutating func completePreparation() -> Bool {
        preparing = false
        prepared = staged
        return prepared
    }

    mutating func resetPreparation() {
        preparing = false
        prepared = false
    }
}
