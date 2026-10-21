// Standalone diagnostic capture tool; normal recording runs inside Timeline.app.
import Foundation
import Darwin

@main
struct RecallCLI {
    static func main() async {
        do {
            guard CommandLine.arguments.count >= 3 else {
                throw RecallError("usage: timeline-recall <output-dir> <stamp> [exclude-file]")
            }
            let excluded = try CommandLine.arguments.count >= 4
                ? RecallCapture.loadExclusions(CommandLine.arguments[3]) : []
            let written = try await RecallCapture.capture(
                outputDir: CommandLine.arguments[1], stamp: CommandLine.arguments[2],
                excluded: excluded, primeWindowServer: true)
            if let written { print("timeline-recall: wrote \(written) window(s) for \(CommandLine.arguments[2])") }
        } catch {
            FileHandle.standardError.write(Data("timeline-recall: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }
}
