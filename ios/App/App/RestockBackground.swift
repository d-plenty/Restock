// Restock on iPhone and iPad: a short sync now and then while the app isn't on screen (0.14.0).
// iOS decides when, and whether, to wake an app for this ("Background App Refresh"): usually a few
// times a day for an app that's opened often, never for one that was swiped away or when Low Power
// Mode or the person's settings say no. So it's a bonus: Restock still syncs every time it's opened.
//
// When iOS wakes the app, the app's own code is told ("backgroundRefresh"), does one sync, and says
// when it's done. iOS allows about half a minute.

import BackgroundTasks
import Capacitor
import Foundation

enum RestockBackground {
    /// Also listed in Info.plist (BGTaskSchedulerPermittedIdentifiers); iOS refuses any other name.
    static let taskId = "family.plenty.restock.refresh"
    static weak var plugin: RestockApplePlugin?
    private static var current: BGTask?
    private static var registered = false

    /// Once, while the app is starting (iOS requires it before launch finishes).
    static func register() {
        if registered {
            return
        }
        registered = true
        _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: DispatchQueue.main) { task in
            handle(task)
        }
    }

    /// Asks iOS for a wake-up, no sooner than 15 minutes from now.
    static func schedule() {
        if !registered {
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func handle(_ task: BGTask) {
        // The next one is asked for straight away, so they keep coming.
        schedule()
        current = task
        task.expirationHandler = {
            finish(false)
        }
        tell(task, triesLeft: 10)
        // If the app's code never answers, the task is still closed in time.
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
            if current === task {
                finish(false)
            }
        }
    }

    /// Tells the app's code. Woken from cold, the app is still starting: wait for it, a second at a time.
    private static func tell(_ task: BGTask, triesLeft: Int) {
        if current !== task {
            return
        }
        if let plugin = plugin {
            plugin.notifyListeners("backgroundRefresh", data: [:], retainUntilConsumed: true)
            return
        }
        if triesLeft <= 0 {
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            tell(task, triesLeft: triesLeft - 1)
        }
    }

    static func finish(_ worked: Bool) {
        current?.setTaskCompleted(success: worked)
        current = nil
    }
}

extension RestockApplePlugin {
    /// Restock is leaving the screen: ask iOS for a wake-up later.
    @objc func backgroundSchedule(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            RestockBackground.plugin = self
            RestockBackground.schedule()
            call.resolve()
        }
    }

    /// The app's code has finished its background sync.
    @objc func backgroundDone(_ call: CAPPluginCall) {
        let worked = call.getBool("ok") ?? true
        DispatchQueue.main.async {
            RestockBackground.finish(worked)
            call.resolve()
        }
    }
}
