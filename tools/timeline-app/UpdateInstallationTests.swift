import Foundation

@main
struct UpdateInstallationTests {
    static func main() {
        var update = UpdateInstallation()
        precondition(update.terminationDecision == .allow, "Ordinary quit must leave the service running")
        update.stage()
        precondition(update.staged && update.terminationDecision == .prepare, "Extraction must guard even an ordinary quit")
        update.finishCycle(failed: false)
        precondition(update.staged && update.terminationDecision == .prepare, "Install on Quit ends the check, not the staged install")
        update.beginPreparation()
        precondition(update.terminationDecision == .wait, "Repeated termination must not start a second stop")
        precondition(update.completePreparation(), "Successful stop must permit termination")
        precondition(update.terminationDecision == .allow, "Prepared installation may terminate")
        update.finishCycle(failed: false)
        precondition(update.staged && update.prepared, "A finished check must not release a prepared install-on-quit hold")

        update = UpdateInstallation()
        update.stage() // Also the automatic-download and explicit-install callbacks.
        update.beginPreparation()
        update.resetPreparation() // Manual hold or failed service stop.
        precondition(update.staged && update.terminationDecision == .prepare, "Failed preparation must allow retry")
        update.beginPreparation()
        update.finishCycle(failed: true)
        precondition(update.terminationDecision == .wait, "Abort must not race an unfinished stop")
        precondition(!update.completePreparation(), "Abort during stop must recover the hold and refuse termination")
        precondition(!update.staged && update.terminationDecision == .allow)

        update.stage()
        update.recordChoice(skipped: true, installerRunning: true)
        update.finishCycle(failed: false)
        precondition(!update.staged, "Skipping a resumed installer must clear staging")
        update.stage()
        update.recordChoice(skipped: false, installerRunning: true)
        precondition(update.staged, "Deferring a live installer must preserve staging")
        update.recordChoice(skipped: false, installerRunning: false)
        precondition(!update.staged, "A fresh prompt after an installer died must clear stale staging")
        update.stage() // A fresh Install choice stages again once extraction starts.
        precondition(update.terminationDecision == .prepare)
        update.discard() // Abort before termination.
        update.finishCycle(failed: false)
        precondition(!update.staged && update.terminationDecision == .allow, "Skipped update must not hold the service on quit")
        print("OK: staged quit, finished checks, repeated termination, preparation retry, abort, and skip")
    }
}
