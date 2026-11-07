import AppKit

// SwiftUI snapshots Text into native menu items; publishing a new date does not
// update their titles during tracking. Refresh only the open menu, without
// polling the capture log or changing the capture scheduler.
@MainActor
final class RecallAgeMenu {
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    private weak var trackedMenu: NSMenu?
    private let lastCapture: () -> Date?

    init(lastCapture: @escaping () -> Date?) {
        self.lastCapture = lastCapture
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let menu = note.object as? NSMenu else { return }
                self?.beginTracking(menu)
            }
        })
        observers.append(center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, let menu = note.object as? NSMenu, menu === self.trackedMenu else { return }
                self.timer?.invalidate()
                self.timer = nil
                self.trackedMenu = nil
            }
        })
    }

    private func beginTracking(_ menu: NSMenu) {
        timer?.invalidate()
        trackedMenu = menu
        // SwiftUI can populate the menu after didBeginTracking. The first
        // common-mode turn finds the item even in that case.
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let menu = self.trackedMenu,
                      let item = menu.items.first(where: { $0.title.hasPrefix(recallCaptureAgePrefix) }),
                      let title = lastCaptureAge(self.lastCapture(), relativeTo: Date()) else { return }
                item.title = title
            }
        }
        timer.fireDate = Date()
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    deinit {
        timer?.invalidate()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }
}
