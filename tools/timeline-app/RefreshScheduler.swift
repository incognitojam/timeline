import Foundation
import AppKit

// Shared poll/wake/activation refresh plumbing for the menu bar controllers.
//
// Every controller re-checks its state on the same triggers: a periodic timer
// (added to RunLoop.main in .common mode, so it keeps firing while the menu is
// open — event-tracking mode would otherwise starve it), system/display wake,
// and app activation. This owns the Timer and notification tokens and tears
// them down on deinit. Controller-specific triggers (RecallController's
// file-system watch, ServiceAgentController's reconcile-request notification,
// ServiceController's restart probes) stay in their controllers.
final class RefreshScheduler {
    private var timer: Timer?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    // onPoll fires on the interval; onWake on system/display wake (both
    // NSWorkspace.didWake and screensDidWake, which post separately); and
    // onActivation when the app becomes active. Pass nil to skip a trigger.
    init(
        interval: TimeInterval = 30,
        onPoll: @escaping () -> Void,
        onWake: (() -> Void)?,
        onActivation: (() -> Void)?
    ) {
        let timer = Timer(timeInterval: interval, repeats: true) { _ in onPoll() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer

        if let onWake {
            let workspaceCenter = NSWorkspace.shared.notificationCenter
            for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
                let token = workspaceCenter.addObserver(forName: name, object: nil, queue: .main) { _ in
                    onWake()
                }
                observers.append((workspaceCenter, token))
            }
        }

        if let onActivation {
            let appCenter = NotificationCenter.default
            let token = appCenter.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
                onActivation()
            }
            observers.append((appCenter, token))
        }
    }

    // Most controllers re-check the same way on every trigger.
    convenience init(interval: TimeInterval = 30, onRefresh: @escaping () -> Void) {
        self.init(interval: interval, onPoll: onRefresh, onWake: onRefresh, onActivation: onRefresh)
    }

    func scheduleNextPoll(at date: Date) {
        timer?.fireDate = date
    }

    deinit {
        timer?.invalidate()
        for (center, token) in observers { center.removeObserver(token) }
    }
}
