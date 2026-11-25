// The app's own files and its icon.
//
// - The database file (src/ios/store.ts): whole files in Application Support/Restock, read and
//   written as base64. A write goes to a new file beside the old one and is swapped in, so a save
//   that is cut short never leaves half a file. The folder is part of the device's backups.
// - The app icon's colour (Settings, Look and colours): one of the alternate icons in the asset
//   catalogue ("Icon-teal" and so on), or the main one.

import Capacitor
import Foundation
import Network
import UIKit

enum RestockStore {
    /// One at a time, off the main thread.
    static let queue = DispatchQueue(label: "family.plenty.restock.store")

    static func folder() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("Restock", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
        return dir
    }

    /// Only plain file names the app itself uses: never a path.
    static func file(_ name: String) throws -> URL {
        let plain = name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$", options: .regularExpression) != nil
        guard plain, !name.contains("..") else {
            throw NSError(domain: "RestockStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not a file name Restock uses"])
        }
        return try folder().appendingPathComponent(name, isDirectory: false)
    }

    static let icons: Set<String> = [
        "gold", "navy", "red", "forest", "teal", "sky", "indigo", "purple", "pink", "orange", "amber", "brown", "slate", "black", "white"
    ]
}

extension RestockApplePlugin {
    @objc func storeRead(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        RestockStore.queue.async {
            do {
                let url = try RestockStore.file(name)
                guard FileManager.default.fileExists(atPath: url.path) else {
                    call.resolve(["found": false])
                    return
                }
                let data = try Data(contentsOf: url)
                call.resolve(["found": true, "data": data.base64EncodedString(), "bytes": data.count])
            } catch {
                call.reject("Couldn't read \(name): \(error.localizedDescription)")
            }
        }
    }

    @objc func storeWrite(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        guard let text = call.getString("data"), let data = Data(base64Encoded: text) else {
            call.reject("Nothing to write")
            return
        }
        // Finish the write even if the app goes to the background meanwhile.
        var task: UIBackgroundTaskIdentifier = .invalid
        DispatchQueue.main.async {
            task = UIApplication.shared.beginBackgroundTask(withName: "restock-save") {
                UIApplication.shared.endBackgroundTask(task)
                task = .invalid
            }
            RestockStore.queue.async {
                defer {
                    DispatchQueue.main.async {
                        if task != .invalid {
                            UIApplication.shared.endBackgroundTask(task)
                            task = .invalid
                        }
                    }
                }
                do {
                    let url = try RestockStore.file(name)
                    try data.write(to: url, options: [.atomic])
                    call.resolve(["bytes": data.count])
                } catch {
                    call.reject("Couldn't save \(name): \(error.localizedDescription)")
                }
            }
        }
    }

    @objc func storeDelete(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        RestockStore.queue.async {
            do {
                let url = try RestockStore.file(name)
                if FileManager.default.fileExists(atPath: url.path) {
                    try FileManager.default.removeItem(at: url)
                }
                call.resolve()
            } catch {
                call.reject("Couldn't delete \(name): \(error.localizedDescription)")
            }
        }
    }

    /// Whether the connection is one iOS calls expensive (mobile data, a personal hotspot).
    @objc func netInfo(_ call: CAPPluginCall) {
        let monitor = NWPathMonitor()
        var answered = false
        monitor.pathUpdateHandler = { path in
            if answered {
                return
            }
            answered = true
            call.resolve(["online": path.status == .satisfied, "expensive": path.isExpensive])
            monitor.cancel()
        }
        monitor.start(queue: RestockStore.queue)
    }

    @objc func iconGet(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let current = UIApplication.shared.alternateIconName ?? ""
            let name = current.hasPrefix("Icon-") ? String(current.dropFirst(5)) : ""
            call.resolve(["name": name, "supported": UIApplication.shared.supportsAlternateIcons])
        }
    }

    @objc func iconSet(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        guard name.isEmpty || RestockStore.icons.contains(name) else {
            call.resolve(["ok": false])
            return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.supportsAlternateIcons else {
                call.resolve(["ok": false])
                return
            }
            let wanted: String? = name.isEmpty ? nil : "Icon-" + name
            if UIApplication.shared.alternateIconName == wanted {
                call.resolve(["ok": true])
                return
            }
            UIApplication.shared.setAlternateIconName(wanted) { error in
                call.resolve(["ok": error == nil])
            }
        }
    }
}
