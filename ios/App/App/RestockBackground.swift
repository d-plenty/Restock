// Restock on iPhone and iPad while the app isn't on screen. iOS decides when, and whether, to wake an
// app: never for one that was swiped away, or when Low Power Mode or the person's settings say no. So
// all of this is a bonus: Restock still syncs and checks every time it's opened.
//
// - 0.14.0: a short wake-up now and then ("Background App Refresh", about half a minute): the app's
//   code is told ("backgroundRefresh"), syncs, and (0.15.2) checks as many prices as fit.
// - 0.15.2: a longer one for the price check, no sooner than the set check time, only while the phone
//   is charging and online ("backgroundCheck"; "backgroundStop" when iOS says the time's up).
// - 0.15.2, iOS 26 and later: a Check now that keeps going after Restock leaves the screen, with its
//   progress on the Lock Screen (checkTaskStart / checkTaskProgress / checkTaskEnd).
//
// The check carries on from where it got to whichever way it runs (src/lib/checkProgress.ts).

import BackgroundTasks
import Capacitor
import Foundation

enum RestockBackground {
    /// Also listed in Info.plist (BGTaskSchedulerPermittedIdentifiers); iOS refuses any other name.
    static let taskId = "family.plenty.restock.refresh"
    /// 0.15.2: the longer price check (listed in Info.plist too).
    static let checkId = "family.plenty.restock.check"
    /// 0.15.2: a Check now carrying on (Info.plist lists "family.plenty.restock.checknow.*"; each one
    /// gets a name of its own, registered just before it's asked for, as iOS needs).
    static let checkNowPrefix = "family.plenty.restock.checknow."
    static weak var plugin: RestockApplePlugin?
    private static var current: BGTask?
    private static var currentCheck: BGTask?
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
        _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: checkId, using: DispatchQueue.main) { task in
            handleCheck(task)
        }
    }

    /// Asks iOS for a wake-up, no sooner than 15 minutes from now; and for the longer check, no sooner
    /// than `checkAt` (none: the one asked for before is called off).
    static func schedule(checkAt: Date? = nil) {
        if !registered {
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
        if let at = checkAt {
            let check = BGProcessingTaskRequest(identifier: checkId)
            check.requiresExternalPower = true
            check.requiresNetworkConnectivity = true
            check.earliestBeginDate = at
            try? BGTaskScheduler.shared.submit(check)
        } else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: checkId)
        }
    }

    private static func handle(_ task: BGTask) {
        // The next one is asked for straight away, so they keep coming.
        let request = BGAppRefreshTaskRequest(identifier: taskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
        current = task
        task.expirationHandler = {
            plugin?.notifyListeners("backgroundStop", data: [:])
            finish(false)
        }
        tell("backgroundRefresh", whileOpen: { current === task }, triesLeft: 10)
        // If the app's code never answers, the task is still closed in time.
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
            if current === task {
                finish(false)
            }
        }
    }

    /// 0.15.2: the longer check. It runs until the app says it's done or iOS says stop.
    private static func handleCheck(_ task: BGTask) {
        currentCheck = task
        task.expirationHandler = {
            plugin?.notifyListeners("backgroundStop", data: [:])
            // A moment to save what was found (it's saved every few products anyway).
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                if currentCheck === task {
                    finishCheck(false)
                }
            }
        }
        tell("backgroundCheck", whileOpen: { currentCheck === task }, triesLeft: 20)
    }

    /// Tells the app's code. Woken from cold, the app is still starting: wait for it, a second at a time.
    private static func tell(_ event: String, whileOpen open: @escaping () -> Bool, triesLeft: Int) {
        if !open() {
            return
        }
        if let plugin = plugin {
            plugin.notifyListeners(event, data: [:], retainUntilConsumed: true)
            return
        }
        if triesLeft <= 0 {
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            tell(event, whileOpen: open, triesLeft: triesLeft - 1)
        }
    }

    static func finish(_ worked: Bool) {
        current?.setTaskCompleted(success: worked)
        current = nil
    }

    static func finishCheck(_ worked: Bool) {
        currentCheck?.setTaskCompleted(success: worked)
        currentCheck = nil
    }

    // ---------- 0.15.2: Check now carrying on (iOS 26) ----------

    /// The Check now carrying on, while there is one (a BGContinuedProcessingTask, kept as BGTask so
    /// this builds for older iOS too).
    static var checkNow: BGTask?
    /// Asked for, and not yet started by iOS.
    static var checkNowAsked: String?
    /// The latest progress, for when iOS starts the task after the check has begun.
    static var checkNowDone: Int64 = 0
    static var checkNowTotal: Int64 = 0

    static func setProgress(_ task: BGTask) {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *), let t = task as? BGContinuedProcessingTask {
            t.progress.totalUnitCount = max(1, checkNowTotal)
            t.progress.completedUnitCount = min(checkNowDone, max(1, checkNowTotal))
        }
        #endif
    }

    /// Asks iOS to keep the check going. Says whether it can (iOS 26 and later).
    static func startCheckNow() -> Bool {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            endCheckNow(true)
            let id = checkNowPrefix + UUID().uuidString
            let ok = BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: DispatchQueue.main) { task in
                guard checkNowAsked == id else {
                    task.setTaskCompleted(success: false)
                    return
                }
                checkNow = task
                setProgress(task)
                task.expirationHandler = {
                    plugin?.notifyListeners("backgroundStop", data: [:])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        if checkNow === task {
                            endCheckNow(false)
                        }
                    }
                }
            }
            if !ok {
                return false
            }
            let request = BGContinuedProcessingTaskRequest(identifier: id, title: "Checking prices", subtitle: "Restock")
            // Now or not at all: a check that has to wait is no use to anyone.
            request.strategy = .fail
            checkNowDone = 0
            checkNowTotal = 0
            do {
                try BGTaskScheduler.shared.submit(request)
                checkNowAsked = id
                return true
            } catch {
                return false
            }
        }
        #endif
        return false
    }

    static func progressCheckNow(done: Int64, total: Int64) {
        checkNowDone = done
        checkNowTotal = total
        if let task = checkNow {
            setProgress(task)
        }
    }

    static func endCheckNow(_ worked: Bool) {
        checkNow?.setTaskCompleted(success: worked)
        checkNow = nil
        checkNowAsked = nil
    }
}

extension RestockApplePlugin {
    /// Restock is leaving the screen: ask iOS for a wake-up later (0.15.2: and for the longer check at `checkAt`, ms).
    @objc func backgroundSchedule(_ call: CAPPluginCall) {
        let checkAt = call.getDouble("checkAt").map { Date(timeIntervalSince1970: $0 / 1000) }
        DispatchQueue.main.async {
            RestockBackground.plugin = self
            RestockBackground.schedule(checkAt: checkAt)
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

    /// 0.15.2: the app's code has finished (or stopped) the longer check.
    @objc func backgroundCheckDone(_ call: CAPPluginCall) {
        let worked = call.getBool("ok") ?? true
        DispatchQueue.main.async {
            RestockBackground.finishCheck(worked)
            call.resolve()
        }
    }

    /// 0.15.2: a Check now has started: keep it going after Restock leaves the screen, where iOS can.
    @objc func checkTaskStart(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            RestockBackground.plugin = self
            call.resolve(["started": RestockBackground.startCheckNow()])
        }
    }

    @objc func checkTaskProgress(_ call: CAPPluginCall) {
        let done = Int64(call.getInt("done") ?? 0)
        let total = Int64(call.getInt("total") ?? 0)
        DispatchQueue.main.async {
            RestockBackground.progressCheckNow(done: done, total: total)
            call.resolve()
        }
    }

    @objc func checkTaskEnd(_ call: CAPPluginCall) {
        let worked = call.getBool("ok") ?? true
        DispatchQueue.main.async {
            RestockBackground.endCheckNow(worked)
            call.resolve()
        }
    }
}
