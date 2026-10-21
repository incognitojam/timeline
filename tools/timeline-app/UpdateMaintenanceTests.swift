import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let files = FileManager.default

func check(_ value: Bool, _ message: String) {
    if !value { fatalError(message) }
}

func scenario(_ name: String) throws -> (UpdateMaintenance, URL, URL) {
    let directory = root.appendingPathComponent(name, isDirectory: true)
    try files.createDirectory(at: directory, withIntermediateDirectories: true)
    return (UpdateMaintenance(directory: directory),
            directory.appendingPathComponent("service.hold"),
            directory.appendingPathComponent("update.hold"))
}

@main
struct UpdateMaintenanceTests {
    static func main() throws {
        let (normal, normalHold, normalMarker) = try scenario("normal")
        var stopped = false
        try normal.prepare {
            check(files.fileExists(atPath: normalHold.path), "Hold must precede stopping the service")
            check(try Data(contentsOf: normalHold) == Data(contentsOf: normalMarker), "Hold ownership must be durable")
            stopped = true
        }
        check(stopped, "Service must be stopped")
        try normal.recover()
        check(!files.fileExists(atPath: normalHold.path), "Relaunch must remove its update hold")
        check(!files.fileExists(atPath: normalMarker.path), "Relaunch must remove its marker")

        let (manual, manualHold, _) = try scenario("manual")
        let manualData = Data("manual maintenance".utf8)
        try manualData.write(to: manualHold)
        do {
            try manual.prepare { fatalError("Do not stop a service under a manual hold") }
            fatalError("Manual maintenance must reject an update")
        } catch {}
        try manual.recover()
        check(try Data(contentsOf: manualHold) == manualData, "Manual hold must remain unchanged")

        let (failed, failedHold, failedMarker) = try scenario("failed-stop")
        do {
            try failed.prepare { throw NSError(domain: "SyntheticStopFailure", code: 1) }
            fatalError("Stop failure must propagate")
        } catch {}
        check(!files.fileExists(atPath: failedHold.path), "Failed preparation must release its hold")
        check(!files.fileExists(atPath: failedMarker.path), "Failed preparation must release its marker")

        let (changed, changedHold, changedMarker) = try scenario("changed-hold")
        try changed.prepare {}
        try manualData.write(to: changedHold)
        do {
            try changed.recover()
            fatalError("Changed hold must reject recovery")
        } catch {}
        check(try Data(contentsOf: changedHold) == manualData, "Recovery must preserve a replaced hold")
        check(files.fileExists(atPath: changedMarker.path), "Keep the marker when recovery needs attention")

        let (removed, removedHold, removedMarker) = try scenario("removed-hold")
        try removed.prepare {}
        try files.removeItem(at: removedHold)
        try removed.recover()
        check(!files.fileExists(atPath: removedMarker.path), "Recovery must tolerate a manually removed hold")

        print("OK: update preparation, recovery, manual holds, and failed stops")
    }
}
