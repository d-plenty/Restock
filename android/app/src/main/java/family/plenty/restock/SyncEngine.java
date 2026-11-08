package family.plenty.restock;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Phone-to-phone sync (0.8.0): what changed here, and taking in what changed on another phone.
 *
 * The database notes every change itself (the triggers in src/lib/sql/schema.ts write sync_log):
 * which record, when (stamp, milliseconds), which phone (device), deleted or not, and seq, this
 * phone's own running number. A paired phone asks for "everything after number N".
 *
 * When both phones changed the same record, the later change wins (a tie goes to the larger
 * device id, so both phones pick the same one). Deletes are kept as "deleted" in sync_log, so a
 * deleted thing doesn't come back. Prices are only added: each phone tidies its own old ones.
 *
 * No Android classes here, so the same code is tested on a computer (tools/sync-test).
 */
final class SyncEngine {
    /** The database, as the engine needs it. On the phone: AndroidSyncDb. */
    interface Db {
        List<JSONObject> query(String sql, Object... args) throws Exception;

        void exec(String sql, Object... args) throws Exception;

        void transaction(Body body) throws Exception;

        interface Body {
            void run() throws Exception;
        }
    }

    /** One end of a connection to another phone: send a message, get its answer. */
    interface Transport {
        JSONObject send(JSONObject message) throws Exception;
    }

    /** Synced tables and how a record is named in sync_log. Mirrors SYNCED in schema.ts. */
    static final String[][] TABLES = {
        { "categories", "id" },
        { "products", "id" },
        { "items", "id" },
        { "list_entries", "id" },
        { "cards", "id" },
        { "prices", "product_id || '|' || date" },
    };

    static final int PAGE = 400;

    final Db db;

    SyncEngine(Db db) {
        this.db = db;
    }

    // ---------- this phone ----------

    String meta(String key) throws Exception {
        List<JSONObject> r = db.query("SELECT value FROM sync_meta WHERE key = ?", key);
        return r.isEmpty() ? null : r.get(0).optString("value", null);
    }

    void setMeta(String key, String value) throws Exception {
        if (value == null) db.exec("DELETE FROM sync_meta WHERE key = ?", key);
        else db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)", key, value);
    }

    String device() throws Exception {
        String d = meta("device");
        return d == null ? "" : d;
    }

    String name() throws Exception {
        String n = meta("name");
        return n == null ? "Phone" : n;
    }

    /** Whether this phone sends its loyalty cards to the others (asked when pairing). */
    boolean shareCards() throws Exception {
        return "1".equals(meta("share_cards"));
    }

    /** Turn sending loyalty cards on or off. Turning it on sends the cards already here, too. */
    void setShareCards(boolean on) throws Exception {
        boolean was = shareCards();
        setMeta("share_cards", on ? "1" : "0");
        if (on && !was) {
            db.transaction(() -> {
                for (JSONObject r : db.query("SELECT pk FROM sync_log WHERE tbl = 'cards'"))
                    db.exec("UPDATE sync_log SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log) WHERE tbl = 'cards' AND pk = ?", r.getString("pk"));
            });
        }
    }

    private static String keyOf(String table) {
        for (String[] t : TABLES) if (t[0].equals(table)) return t[1];
        return null;
    }

    // ---------- other phones ----------

    /** How far through that phone's changes this one has got (its seq). */
    long gotFrom(String peer) throws Exception {
        List<JSONObject> r = db.query("SELECT got FROM sync_peers WHERE device = ?", peer);
        return r.isEmpty() ? 0 : r.get(0).optLong("got", 0);
    }

    void notePeer(String peer, String name, String host, int port) throws Exception {
        if (peer == null || peer.isEmpty()) return;
        db.exec("INSERT OR IGNORE INTO sync_peers (device, got) VALUES (?, 0)", peer);
        if (name != null) db.exec("UPDATE sync_peers SET name = ? WHERE device = ?", name, peer);
        if (host != null) db.exec("UPDATE sync_peers SET host = ?, port = ? WHERE device = ?", host, (long) port, peer);
    }

    private void setGot(String peer, long got) throws Exception {
        db.exec("INSERT OR IGNORE INTO sync_peers (device, got) VALUES (?, 0)", peer);
        db.exec("UPDATE sync_peers SET got = ? WHERE device = ? AND got < ?", got, peer, got);
    }

    void markSynced(String peer, String when) throws Exception {
        db.exec("UPDATE sync_peers SET synced_at = ? WHERE device = ?", when, peer);
    }

    // ---------- what changed here ----------

    /**
     * Changes after this phone's number `since`, at most `limit`, leaving out ones made by
     * `exclude` (the phone asking: it already has those, or something newer).
     * Answers {entries, top, more}: top is the last number looked at.
     */
    JSONObject collect(long since, String exclude, int limit) throws Exception {
        List<JSONObject> rows = db.query(
            "SELECT tbl, pk, stamp, device, deleted, seq FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?", since, (long) limit + 1);
        boolean more = rows.size() > limit;
        if (more) rows = rows.subList(0, limit);
        boolean cards = shareCards();
        JSONArray entries = new JSONArray();
        long top = since;
        for (JSONObject r : rows) {
            top = Math.max(top, r.getLong("seq"));
            String tbl = r.getString("tbl");
            String key = keyOf(tbl);
            if (key == null || (exclude != null && exclude.equals(r.getString("device")))) continue;
            if ("cards".equals(tbl) && !cards) continue;
            JSONObject e = new JSONObject();
            e.put("tbl", tbl);
            e.put("pk", r.getString("pk"));
            e.put("stamp", r.getLong("stamp"));
            e.put("device", r.getString("device"));
            boolean deleted = r.getLong("deleted") != 0;
            e.put("deleted", deleted);
            if (!deleted) {
                List<JSONObject> row = db.query("SELECT * FROM " + tbl + " WHERE " + key + " = ?", r.getString("pk"));
                if (row.isEmpty()) continue; // tidied away since (old prices)
                JSONObject data = row.get(0);
                if ("prices".equals(tbl)) data.remove("id");
                e.put("row", data);
            }
            entries.put(e);
        }
        JSONObject out = new JSONObject();
        out.put("entries", entries);
        out.put("top", top);
        out.put("more", more);
        return out;
    }

    // ---------- taking in another phone's changes ----------

    /** Applies another phone's changes. Returns how many records changed here. */
    int apply(final JSONArray entries) throws Exception {
        final int[] changed = { 0 };
        if (entries == null || entries.length() == 0) return 0;
        final Map<String, Set<String>> columns = new HashMap<>();
        db.transaction(() -> {
            // While this is set, the triggers don't note these as this phone's own changes.
            db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
            long clock = 0;
            for (int i = 0; i < entries.length(); i++) {
                JSONObject e = entries.getJSONObject(i);
                String tbl = e.optString("tbl");
                String key = keyOf(tbl);
                if (key == null) continue;
                String pk = e.getString("pk");
                long stamp = e.getLong("stamp");
                String device = e.optString("device", "");
                clock = Math.max(clock, stamp);
                List<JSONObject> mine = db.query("SELECT stamp, device FROM sync_log WHERE tbl = ? AND pk = ?", tbl, pk);
                if (!mine.isEmpty() && !newer(stamp, device, mine.get(0).getLong("stamp"), mine.get(0).optString("device", ""))) continue;
                boolean deleted = e.optBoolean("deleted", false);
                if (deleted) {
                    db.exec("DELETE FROM " + tbl + " WHERE " + key + " = ?", pk);
                } else {
                    JSONObject row = e.optJSONObject("row");
                    if (row == null) continue;
                    Set<String> cols = columns.get(tbl);
                    if (cols == null) {
                        cols = new HashSet<>();
                        for (JSONObject c : db.query("PRAGMA table_info(" + tbl + ")")) cols.add(c.getString("name"));
                        columns.put(tbl, cols);
                    }
                    writeRow(tbl, row, cols);
                }
                db.exec(
                    "INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log))",
                    tbl, pk, stamp, device, deleted ? 1L : 0L);
                changed[0]++;
            }
            // This phone's next changes are stamped after anything it has seen (clocks differ).
            String was = meta("clock");
            long now = was == null ? 0 : Long.parseLong(was);
            if (clock > now) setMeta("clock", String.valueOf(clock));
            db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
        return changed[0];
    }

    static boolean newer(long stamp, String device, long mineStamp, String mineDevice) {
        return stamp > mineStamp || (stamp == mineStamp && device.compareTo(mineDevice) > 0);
    }

    private void writeRow(String tbl, JSONObject row, Set<String> cols) throws Exception {
        List<String> names = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        for (Iterator<String> it = row.keys(); it.hasNext(); ) {
            String c = it.next();
            if (!cols.contains(c) || ("prices".equals(tbl) && "id".equals(c))) continue;
            names.add(c);
            Object v = row.opt(c);
            values.add(v == JSONObject.NULL ? null : v);
        }
        if (names.isEmpty()) return;
        StringBuilder q = new StringBuilder();
        for (int i = 0; i < names.size(); i++) q.append(i == 0 ? "?" : ", ?");
        String list = String.join(", ", names);
        if ("prices".equals(tbl)) {
            // Prices are only added, once per product and time.
            values.add(row.optString("product_id"));
            values.add(row.optString("date"));
            db.exec("INSERT INTO prices (" + list + ") SELECT " + q + " WHERE NOT EXISTS (SELECT 1 FROM prices WHERE product_id = ? AND date = ?)",
                values.toArray());
        } else {
            db.exec("INSERT OR REPLACE INTO " + tbl + " (" + list + ") VALUES (" + q + ")", values.toArray());
        }
    }

    /**
     * Each phone starts with its own "Pantry", "Fridge & freezer" and so on. After taking in
     * another phone's, keep one of each name per tab: the one with the smaller id, so every phone
     * keeps the same one. Items and list lines move to it. These are ordinary changes (noted in
     * sync_log), so the other phones tidy up the same way.
     */
    int tidyCategories() throws Exception {
        final int[] merged = { 0 };
        db.transaction(() -> {
            List<JSONObject> rows = db.query("SELECT id, name, section FROM categories ORDER BY section, lower(trim(name)), id");
            String lastKey = null;
            String keep = null;
            for (JSONObject r : rows) {
                String key = r.optString("section") + "|" + r.optString("name").trim().toLowerCase(java.util.Locale.ROOT);
                if (!key.equals(lastKey)) {
                    lastKey = key;
                    keep = r.getString("id");
                    continue;
                }
                String gone = r.getString("id");
                db.exec("UPDATE items SET category_id = ? WHERE category_id = ?", keep, gone);
                db.exec("UPDATE list_entries SET category_id = ? WHERE category_id = ?", keep, gone);
                db.exec("DELETE FROM categories WHERE id = ?", gone);
                merged[0]++;
            }
        });
        return merged[0];
    }

    /**
     * Joining a household with "use the other phone's things": empty this phone's synced tables
     * without noting them as deletes (so nothing is deleted on the other phone), then the first
     * sync fills them.
     */
    void clearForJoin() throws Exception {
        db.transaction(() -> {
            db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
            for (String[] t : TABLES) db.exec("DELETE FROM " + t[0]);
            db.exec("DELETE FROM sync_log");
            db.exec("DELETE FROM sync_peers");
            db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
    }

    // ---------- talking to another phone ----------

    /** Answers a message from another phone (SyncServer). */
    JSONObject handle(JSONObject req, String fromHost) throws Exception {
        String op = req.optString("op");
        String peer = req.optString("device");
        JSONObject res = new JSONObject();
        res.put("device", device());
        res.put("name", name());
        switch (op) {
            case "hello":
                notePeer(peer, req.optString("name", null), fromHost, req.optInt("port", 0));
                res.put("got", gotFrom(peer));
                return res;
            case "pull": {
                JSONObject c = collect(req.optLong("since", 0), peer, PAGE);
                for (Iterator<String> it = c.keys(); it.hasNext(); ) {
                    String k = it.next();
                    res.put(k, c.get(k));
                }
                return res;
            }
            case "push": {
                int n = apply(req.optJSONArray("entries"));
                if (n > 0) tidyCategories();
                setGot(peer, req.optLong("top", 0));
                markSynced(peer, req.optString("at", null));
                res.put("changed", n);
                return res;
            }
            default:
                res.put("error", "unknown");
                return res;
        }
    }

    /** What one sync with another phone did. */
    static final class Result {
        String peer;
        String peerName;
        int received;
        int sent;
    }

    /**
     * Syncs with one other phone: takes in what it has that this one hasn't, then sends what this
     * one has that it hasn't. Safe to stop at any point: the next sync carries on.
     */
    Result syncWith(Transport t, String now, int myPort) throws Exception {
        String me = device();
        JSONObject hello = new JSONObject();
        hello.put("op", "hello");
        hello.put("device", me);
        hello.put("name", name());
        hello.put("port", myPort);
        JSONObject h = t.send(hello);
        Result r = new Result();
        r.peer = h.optString("device");
        r.peerName = h.optString("name", null);
        if (r.peer.isEmpty() || r.peer.equals(me)) return r;
        notePeer(r.peer, r.peerName, null, 0);

        long since = gotFrom(r.peer);
        for (int guard = 0; guard < 10000; guard++) {
            JSONObject pull = new JSONObject();
            pull.put("op", "pull");
            pull.put("device", me);
            pull.put("since", since);
            JSONObject got = t.send(pull);
            r.received += apply(got.optJSONArray("entries"));
            long top = got.optLong("top", since);
            if (top > since) setGot(r.peer, top);
            since = Math.max(since, top);
            if (!got.optBoolean("more", false)) break;
        }

        if (r.received > 0) tidyCategories();

        long theirs = h.optLong("got", 0);
        for (int guard = 0; guard < 10000; guard++) {
            JSONObject c = collect(theirs, r.peer, PAGE);
            long top = c.getLong("top");
            if (top <= theirs) break;
            JSONObject push = new JSONObject();
            push.put("op", "push");
            push.put("device", me);
            push.put("entries", c.getJSONArray("entries"));
            push.put("top", top);
            push.put("at", now);
            t.send(push);
            r.sent += c.getJSONArray("entries").length();
            theirs = top;
            if (!c.getBoolean("more")) break;
        }
        markSynced(r.peer, now);
        return r;
    }
}
