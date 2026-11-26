// Vision text recognition, run in an OCR worker: this executable started
// with workerFlag. Capture asks the worker through `shared`.
import Foundation
import Vision
import ImageIO

enum RecallOCR {
    static let workerFlag = "--ocr-worker"
    // The first recognition by a fresh worker of a newly built ad-hoc binary
    // took about 33 seconds.
    static let timeout: TimeInterval = 120

    static let shared: OCRWorker = {
        guard let executable = Bundle.main.executableURL else { fatalError("Timeline has no executable path to start its OCR worker.") }
        return OCRWorker(executable: executable, arguments: [workerFlag], timeout: timeout)
    }()

    static func runWorker() -> Never {
        OCRWorker.serve { path in
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
            return recognize(image)
        }
    }

    static func recognize(_ image: CGImage) -> [String] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
            return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        } catch {
            // Only the error's domain and code: a description could quote the screen.
            let failure = error as NSError
            RecallCapture.warn("OCR failed for a window: \(failure.domain) \(failure.code)")
            return []
        }
    }
}
