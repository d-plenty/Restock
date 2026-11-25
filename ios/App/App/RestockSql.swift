// 0.15.1: the app's database, in the system's own SQLite (nothing added to the app for it).
//
// - The files are the same ones the app kept before (Application Support/Restock: restock.sqlite and
//   the price history's file): a SQLite file is a SQLite file, so they open as they are. Before the
//   first open this way, a copy of each is kept beside it (src/ios/nativeDb.ts asks for it).
// - One connection per file, used one call at a time on its own queue, off the main thread.
// - sqlBatch is one transaction. sqlRun with BEGIN, COMMIT or ROLLBACK is how the sync engine holds
//   the database for a while (the app's side makes sure nothing else is written meanwhile).
// - Written with WAL, so a change is on the disk once its call answers, and a cut-off write is rolled
//   back the next time the file opens.

import Capacitor
import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum RestockSql {
    static let queue = DispatchQueue(label: "family.plenty.restock.sql")
    /// Open files, by name (only touched on `queue`).
    static var open: [String: OpaquePointer] = [:]

    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func connection(_ name: String) throws -> OpaquePointer {
        if let db = open[name] { return db }
        let url = try RestockStore.file(name)
        var db: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(url.path, &db, flags, nil) == SQLITE_OK, let ok = db else {
            let why = db.map { String(cString: sqlite3_errmsg($0)) } ?? "can't open"
            if let d = db { sqlite3_close(d) }
            throw Failure(message: "Couldn't open \(name): \(why)")
        }
        sqlite3_busy_timeout(ok, 5000)
        try exec(ok, "PRAGMA journal_mode = WAL")
        try exec(ok, "PRAGMA synchronous = NORMAL")
        try exec(ok, "PRAGMA foreign_keys = ON")
        open[name] = ok
        return ok
    }

    static func exec(_ db: OpaquePointer, _ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let message = err.map { String(cString: $0) } ?? "failed"
            sqlite3_free(err)
            throw Failure(message: message)
        }
    }

    static func prepare(_ db: OpaquePointer, _ sql: String, _ values: [Any]) throws -> OpaquePointer {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK, let ok = st else {
            throw Failure(message: String(cString: sqlite3_errmsg(db)))
        }
        for (i, v) in values.enumerated() {
            let at = Int32(i + 1)
            switch v {
            case is NSNull:
                sqlite3_bind_null(ok, at)
            case let n as NSNumber:
                if CFGetTypeID(n) == CFBooleanGetTypeID() {
                    sqlite3_bind_int64(ok, at, n.boolValue ? 1 : 0)
                } else if CFNumberIsFloatType(n) {
                    let d = n.doubleValue
                    // A whole number sent as a double (JavaScript has one kind of number) is stored as an integer, as on Android.
                    if d.rounded() == d && abs(d) < 9_007_199_254_740_992 { sqlite3_bind_int64(ok, at, Int64(d)) } else { sqlite3_bind_double(ok, at, d) }
                } else {
                    sqlite3_bind_int64(ok, at, n.int64Value)
                }
            case let s as String:
                sqlite3_bind_text(ok, at, s, -1, SQLITE_TRANSIENT)
            default:
                sqlite3_bind_text(ok, at, String(describing: v), -1, SQLITE_TRANSIENT)
            }
        }
        return ok
    }

    static func rows(_ db: OpaquePointer, _ sql: String, _ values: [Any]) throws -> [[String: Any]] {
        let st = try prepare(db, sql, values)
        defer { sqlite3_finalize(st) }
        var out: [[String: Any]] = []
        let n = sqlite3_column_count(st)
        while true {
            let r = sqlite3_step(st)
            if r == SQLITE_DONE { break }
            guard r == SQLITE_ROW else { throw Failure(message: String(cString: sqlite3_errmsg(db))) }
            var row: [String: Any] = [:]
            for i in 0..<n {
                let name = sqlite3_column_name(st, i).map { String(cString: $0) } ?? "column\(i)"
                switch sqlite3_column_type(st, i) {
                case SQLITE_NULL: row[name] = NSNull()
                case SQLITE_INTEGER: row[name] = Int(sqlite3_column_int64(st, i))
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(st, i)
                case SQLITE_BLOB:
                    let bytes = sqlite3_column_bytes(st, i)
                    if let p = sqlite3_column_blob(st, i), bytes > 0 { row[name] = Data(bytes: p, count: Int(bytes)).base64EncodedString() } else { row[name] = "" }
                default:
                    row[name] = sqlite3_column_text(st, i).map { String(cString: $0) } ?? ""
                }
            }
            out.append(row)
        }
        return out
    }

    static func run(_ db: OpaquePointer, _ sql: String, _ values: [Any]) throws -> (changes: Int, lastId: Int64) {
        let st = try prepare(db, sql, values)
        defer { sqlite3_finalize(st) }
        var r = sqlite3_step(st)
        while r == SQLITE_ROW { r = sqlite3_step(st) }
        guard r == SQLITE_DONE else { throw Failure(message: String(cString: sqlite3_errmsg(db))) }
        return (Int(sqlite3_changes(db)), sqlite3_last_insert_rowid(db))
    }

    static func name(_ call: CAPPluginCall) -> String { call.getString("db") ?? "restock.sqlite" }
    static func values(_ v: Any?) -> [Any] { (v as? [Any]) ?? [] }
}

extension RestockApplePlugin {
    @objc func sqlQuery(_ call: CAPPluginCall) {
        let sql = call.getString("sql") ?? ""
        let values = RestockSql.values(call.options["values"])
        let name = RestockSql.name(call)
        RestockSql.queue.async {
            do {
                let db = try RestockSql.connection(name)
                call.resolve(["rows": try RestockSql.rows(db, sql, values)])
            } catch {
                call.reject("SQL query failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func sqlRun(_ call: CAPPluginCall) {
        let sql = call.getString("sql") ?? ""
        let values = RestockSql.values(call.options["values"])
        let name = RestockSql.name(call)
        RestockSql.queue.async {
            do {
                let db = try RestockSql.connection(name)
                let r = try RestockSql.run(db, sql, values)
                call.resolve(["changes": r.changes, "lastId": Int(r.lastId)])
            } catch {
                call.reject("SQL failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func sqlBatch(_ call: CAPPluginCall) {
        let ops = (call.options["ops"] as? [[String: Any]]) ?? []
        let name = RestockSql.name(call)
        RestockSql.queue.async {
            do {
                let db = try RestockSql.connection(name)
                // Inside a transaction already (the sync engine holds the database): part of it.
                let own = sqlite3_get_autocommit(db) != 0
                if own { try RestockSql.exec(db, "BEGIN IMMEDIATE") }
                do {
                    for op in ops {
                        let sql = op["sql"] as? String ?? ""
                        let values = (op["values"] as? [Any]) ?? []
                        _ = try RestockSql.run(db, sql, values)
                    }
                    if own { try RestockSql.exec(db, "COMMIT") }
                } catch {
                    if own { try? RestockSql.exec(db, "ROLLBACK") }
                    throw error
                }
                call.resolve()
            } catch {
                call.reject("SQL batch failed: \(error.localizedDescription)")
            }
        }
    }

    /// Keeps a copy of a file before it's first opened this way (once: an existing copy is kept).
    @objc func sqlKeepCopy(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        let copy = call.getString("copy") ?? ""
        RestockSql.queue.async {
            do {
                let from = try RestockStore.file(name)
                let to = try RestockStore.file(copy)
                let fm = FileManager.default
                guard fm.fileExists(atPath: from.path) else {
                    call.resolve(["copied": false, "found": false])
                    return
                }
                if fm.fileExists(atPath: to.path) {
                    call.resolve(["copied": false, "found": true])
                    return
                }
                try fm.copyItem(at: from, to: to)
                call.resolve(["copied": true, "found": true])
            } catch {
                call.reject("Couldn't keep a copy of \(name): \(error.localizedDescription)")
            }
        }
    }

    /// Closes a file (before it's replaced by a restore, say). The next call opens it again.
    @objc func sqlClose(_ call: CAPPluginCall) {
        let name = RestockSql.name(call)
        RestockSql.queue.async {
            if let db = RestockSql.open.removeValue(forKey: name) {
                _ = try? RestockSql.exec(db, "PRAGMA wal_checkpoint(TRUNCATE)")
                sqlite3_close(db)
            }
            call.resolve()
        }
    }
}
