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
        // 0.8.2: the household itself: its name, which phone is the owner, its members.
        { "household", "k" },
    };

    static final int PAGE = 400;

    /** The tabs a household can share (0.8.5): groceries (Pantry and its list), Keg, Pharmacy. */
    static final String[] ALL_TABS = { "pantry", "keg", "pharmacy" };

    /** Products' stock belongs to each phone (it depends on the phone's own store): never synced. */
    static final Set<String> LOCAL_PRODUCT_COLUMNS = new HashSet<>(java.util.Arrays.asList("in_stock", "stock_at", "in_stock_2"));

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

    // ---------- which tabs sync (0.8.5) ----------

    static Set<String> parseTabs(String s) {
        Set<String> out = new java.util.LinkedHashSet<>();
        if (s == null) {
            for (String t : ALL_TABS) out.add(t);
            return out;
        }
        for (String t : s.split(",")) {
            String x = t.trim();
            for (String a : ALL_TABS) if (a.equals(x)) out.add(x);
        }
        return out;
    }

    static Set<String> parseTabs(JSONArray a) {
        if (a == null) return null;
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < a.length(); i++) b.append(i == 0 ? "" : ",").append(a.optString(i));
        return parseTabs(b.toString());
    }

    static String joinTabs(Set<String> tabs) {
        StringBuilder b = new StringBuilder();
        for (String t : ALL_TABS) if (tabs.contains(t)) b.append(b.length() == 0 ? "" : ",").append(t);
        return b.toString();
    }

    static JSONArray tabsJson(Set<String> tabs) {
        JSONArray a = new JSONArray();
        for (String t : ALL_TABS) if (tabs.contains(t)) a.put(t);
        return a;
    }

    /** The tabs the household shares (the owner picks; all three for households from before 0.8.5). */
    Set<String> householdTabs() throws Exception {
        return parseTabs(householdValue("tabs"));
    }

    /** The tabs this phone chose to share (all of the household's, unless it picked fewer). */
    Set<String> myTabs() throws Exception {
        return parseTabs(meta("tabs"));
    }

    /** What this phone actually syncs: what it chose, of what the household shares. */
    Set<String> tabs() throws Exception {
        Set<String> t = myTabs();
        t.retainAll(householdTabs());
        return t;
    }

    /**
     * When this phone starts syncing a tab it didn't before (it picked one more, or the household
     * now shares one more), go through everything again: ask the others for all their changes,
     * and offer them all of this phone's, so the tab's older things come across too.
     */
    void noteTabs() throws Exception {
        Set<String> now = tabs();
        String was = meta("tabs_eff");
        Set<String> before = was == null ? null : parseTabs(was);
        if (before != null && !before.containsAll(now)) {
            db.transaction(() -> {
                db.exec("UPDATE sync_peers SET got = 0");
                db.exec("UPDATE sync_log SET seq = seq + (SELECT COALESCE(MAX(seq), 0) FROM sync_log)");
            });
        }
        String j = joinTabs(now);
        if (!j.equals(was)) setMeta("tabs_eff", j);
    }

    private Map<String, String> customTabs;

    /** Which tab a shop is on: built-in shops from Shops, the ones people added from settings. */
    String chainTab(String chain) throws Exception {
        if (chain == null || chain.isEmpty()) return null;
        if (Shops.known(chain)) return Shops.section(chain);
        if (customTabs == null) {
            customTabs = new HashMap<>();
            try {
                List<JSONObject> r = db.query("SELECT value FROM kv WHERE key = 'settings'");
                JSONArray list = r.isEmpty() ? null : new JSONObject(r.get(0).getString("value")).optJSONArray("customShops");
                if (list != null) for (int i = 0; i < list.length(); i++) {
                    JSONObject c = list.optJSONObject(i);
                    if (c != null) customTabs.put(c.optString("id"), c.optString("section", "pantry"));
                }
            } catch (Exception ignored) {
                // no settings yet
            }
        }
        return customTabs.get(chain);
    }

    private static String str(JSONObject row, String k) {
        if (row == null || row.isNull(k)) return null;
        String v = row.optString(k, null);
        return v == null || v.isEmpty() ? null : v;
    }

    /** The tab a record belongs to, or null when it isn't on a tab (cards, the household) or can't tell. */
    String tabOf(String tbl, JSONObject row) throws Exception {
        switch (tbl) {
            case "categories":
            case "items": {
                String s = str(row, "section");
                return s == null ? "pantry" : s;
            }
            case "list_entries": {
                String s = str(row, "section");
                if (s != null) return s;
                String item = str(row, "item_id");
                if (item != null) {
                    List<JSONObject> r = db.query("SELECT section FROM items WHERE id = ?", item);
                    return r.isEmpty() ? null : str(r.get(0), "section");
                }
                String chain = str(row, "chain");
                return chain != null ? chainTab(chain) : "pantry";
            }
            case "products":
                return chainTab(str(row, "chain"));
            case "prices": {
                List<JSONObject> r = db.query("SELECT chain FROM products WHERE id = ?", str(row, "product_id"));
                return r.isEmpty() ? null : chainTab(str(r.get(0), "chain"));
            }
            default:
                return null;
        }
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
        return collect(since, exclude, limit, null);
    }

    /** As above, only records on `allowed` tabs (null: this phone's own tabs). */
    JSONObject collect(long since, String exclude, int limit, Set<String> allowed) throws Exception {
        if (allowed == null) allowed = tabs();
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
                String tab = tabOf(tbl, data);
                if (tab != null && !allowed.contains(tab)) continue; // a tab this pair doesn't share
                if ("prices".equals(tbl)) data.remove("id");
                if ("products".equals(tbl)) for (String c : LOCAL_PRODUCT_COLUMNS) data.remove(c);
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
        final Set<String> mine = tabs();
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
                if ("household".equals(tbl) && !householdChangeAllowed(pk, e.optString("device", ""), e)) continue;
                long stamp = e.getLong("stamp");
                String device = e.optString("device", "");
                clock = Math.max(clock, stamp);
                List<JSONObject> had = db.query("SELECT stamp, device FROM sync_log WHERE tbl = ? AND pk = ?", tbl, pk);
                if (!had.isEmpty() && !newer(stamp, device, had.get(0).getLong("stamp"), had.get(0).optString("device", ""))) continue;
                boolean deleted = e.optBoolean("deleted", false);
                if (!deleted) {
                    // A tab this phone doesn't sync: leave it out (an older phone may still send it).
                    String tab = tabOf(tbl, e.optJSONObject("row"));
                    if (tab != null && !mine.contains(tab)) continue;
                }
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

    /**
     * Only the owner phone changes the household (its name, members, who's owner), except that a
     * phone may change or remove its own member entry (its name, or leaving). Before this phone
     * knows an owner (just joined), it takes what comes.
     */
    boolean householdChangeAllowed(String pk, String byDevice) throws Exception {
        return householdChangeAllowed(pk, byDevice, null);
    }

    /**
     * 0.8.5: also, a phone the owner asked to take over may make itself the owner (and clear the
     * request), while that request is here.
     */
    boolean householdChangeAllowed(String pk, String byDevice, JSONObject entry) throws Exception {
        String owner = householdValue("owner");
        if (owner == null || owner.equals(byDevice) || pk.equals("member:" + byDevice)) return true;
        if (householdValue("handover:" + byDevice) == null) return false;
        if (pk.equals("handover:" + byDevice)) return true;
        if (!"owner".equals(pk) || entry == null || entry.optBoolean("deleted", false)) return false;
        JSONObject row = entry.optJSONObject("row");
        return row != null && byDevice.equals(row.optString("v"));
    }

    String householdValue(String k) throws Exception {
        List<JSONObject> r = db.query("SELECT v FROM household WHERE k = ?", k);
        return r.isEmpty() ? null : r.get(0).optString("v", null);
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
        } else if ("products".equals(tbl)) {
            // Update in place, so this phone's own stock columns stay.
            List<String> sets = new ArrayList<>();
            List<Object> vals = new ArrayList<>();
            for (int i = 0; i < names.size(); i++) {
                if (LOCAL_PRODUCT_COLUMNS.contains(names.get(i)) || "id".equals(names.get(i))) continue;
                sets.add(names.get(i) + " = ?");
                vals.add(values.get(i));
            }
            String id = row.optString("id");
            if (!db.query("SELECT 1 FROM products WHERE id = ?", id).isEmpty()) {
                if (!sets.isEmpty()) {
                    vals.add(id);
                    db.exec("UPDATE products SET " + String.join(", ", sets) + " WHERE id = ?", vals.toArray());
                }
            } else {
                List<String> n2 = new ArrayList<>();
                List<Object> v2 = new ArrayList<>();
                for (int i = 0; i < names.size(); i++) {
                    if (LOCAL_PRODUCT_COLUMNS.contains(names.get(i))) continue;
                    n2.add(names.get(i));
                    v2.add(values.get(i));
                }
                StringBuilder q2 = new StringBuilder();
                for (int i = 0; i < n2.size(); i++) q2.append(i == 0 ? "?" : ", ?");
                db.exec("INSERT INTO products (" + String.join(", ", n2) + ") VALUES (" + q2 + ")", v2.toArray());
            }
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
     * Joining a household with "use the household's things": empty this phone's records on the
     * tabs it will share, without noting them as deletes (so nothing is deleted on the other
     * phones); the first sync fills them. Tabs it won't share, and its loyalty cards, stay.
     * The household record goes too: the new one comes with the first sync.
     */
    void clearForJoin(Set<String> tabs) throws Exception {
        final List<String> goneProducts = new ArrayList<>();
        for (JSONObject r : db.query("SELECT id, chain FROM products")) {
            String t = chainTab(str(r, "chain"));
            if (tabs.contains(t == null ? "pantry" : t)) goneProducts.add(r.getString("id"));
        }
        StringBuilder in = new StringBuilder();
        List<Object> args = new ArrayList<>();
        for (String t : tabs) {
            in.append(in.length() == 0 ? "?" : ", ?");
            args.add(t);
        }
        final String inList = in.length() == 0 ? "NULL" : in.toString();
        final Object[] a = args.toArray();
        db.transaction(() -> {
            db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
            db.exec("DELETE FROM list_entries WHERE COALESCE(section, (SELECT section FROM items WHERE items.id = list_entries.item_id), 'pantry') IN (" + inList + ")", a);
            db.exec("DELETE FROM items WHERE section IN (" + inList + ")", a);
            db.exec("DELETE FROM categories WHERE section IN (" + inList + ")", a);
            for (String id : goneProducts) db.exec("DELETE FROM products WHERE id = ?", id);
            db.exec("DELETE FROM prices WHERE product_id NOT IN (SELECT id FROM products)");
            db.exec("DELETE FROM household");
            db.exec("DELETE FROM sync_log");
            db.exec("DELETE FROM sync_peers");
            // What's left counts as this phone's own, changed now, so it can still be shared later.
            long now = System.currentTimeMillis();
            String me = device();
            for (String[] t : TABLES) {
                if ("household".equals(t[0])) continue;
                db.exec("INSERT OR IGNORE INTO sync_log (tbl, pk, stamp, device, deleted, seq) SELECT ?, " + t[1]
                    + ", ?, ?, 0, (SELECT COALESCE(MAX(seq), 0) FROM sync_log) + rowid FROM " + t[0], t[0], now, me);
            }
            db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
    }

    /** A new name for this phone in sync (rejoining after clearing, so the others don't skip its records). */
    void newDevice() throws Exception {
        byte[] b = new byte[8];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder h = new StringBuilder();
        for (byte x : b) h.append(String.format("%02x", x));
        setMeta("device", h.toString());
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
                noteTabs();
                notePeer(peer, req.optString("name", null), fromHost, req.optInt("port", 0));
                res.put("household", meta("household"));
                res.put("got", gotFrom(peer));
                res.put("tabs", tabsJson(tabs()));
                return res;
            case "pull": {
                Set<String> allowed = tabs();
                Set<String> theirs = parseTabs(req.optJSONArray("tabs"));
                if (theirs != null) allowed.retainAll(theirs);
                JSONObject c = collect(req.optLong("since", 0), peer, PAGE, allowed);
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
        String household;
        /** The other phone (the owner) says this one was removed from the household. */
        boolean removed;
        /** The household's key changed; this is the new one, sealed with this phone's own secret. */
        String rekey;
        int received;
        int sent;
    }

    /**
     * Syncs with one other phone: takes in what it has that this one hasn't, then sends what this
     * one has that it hasn't. Safe to stop at any point: the next sync carries on.
     */
    Result syncWith(Transport t, String now, int myPort) throws Exception {
        noteTabs();
        String me = device();
        Set<String> mine = tabs();
        JSONObject hello = new JSONObject();
        hello.put("op", "hello");
        hello.put("device", me);
        hello.put("name", name());
        hello.put("port", myPort);
        JSONObject h = t.send(hello);
        Result r = new Result();
        r.peer = h.optString("device");
        r.peerName = h.optString("name", null);
        r.household = h.isNull("household") ? null : h.optString("household", null);
        if (h.optBoolean("removed", false)) {
            r.removed = true;
            return r;
        }
        if (h.has("rekey")) {
            r.rekey = h.getString("rekey");
            return r;
        }
        if (r.peer.isEmpty() || r.peer.equals(me)) return r;
        notePeer(r.peer, r.peerName, null, 0);

        long since = gotFrom(r.peer);
        for (int guard = 0; guard < 10000; guard++) {
            JSONObject pull = new JSONObject();
            pull.put("op", "pull");
            pull.put("device", me);
            pull.put("since", since);
            pull.put("tabs", tabsJson(mine));
            JSONObject got = t.send(pull);
            r.received += apply(got.optJSONArray("entries"));
            long top = got.optLong("top", since);
            if (top > since) setGot(r.peer, top);
            since = Math.max(since, top);
            if (!got.optBoolean("more", false)) break;
        }

        if (r.received > 0) tidyCategories();

        long theirs = h.optLong("got", 0);
        Set<String> allowed = tabs();
        Set<String> peerTabs = parseTabs(h.optJSONArray("tabs"));
        if (peerTabs != null) allowed.retainAll(peerTabs);
        for (int guard = 0; guard < 10000; guard++) {
            JSONObject c = collect(theirs, r.peer, PAGE, allowed);
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
