import Foundation
import UserNotifications

// Recording stays off until someone notices, so failures need more than the
// menu bar icon.
final class RecallNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = RecallNotifier()

    func post(_ body: String) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            guard granted else {
                writeError("Timeline notifications not allowed: \(error?.localizedDescription ?? "denied")\n")
                return
            }
            let content = UNMutableNotificationContent()
            content.title = "Timeline stopped recording your screen"
            content.body = body
            center.add(UNNotificationRequest(identifier: "recall-outage", content: content, trigger: nil)) { error in
                if let error { writeError("Timeline notification failed: \(error.localizedDescription)\n") }
            }
        }
    }

    // Show the banner even while Timeline's menu is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
