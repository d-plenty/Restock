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
 * 0.9.0:
 * - A delete beats an edit made without knowing about it ("created" says when a record was last
 *   made); only something made again after the delete brings it back.
 * - A list line's tick and quantity are merged one by one (checked_at, qty_at), so a tick in the
 *   shop and a quantity change at home both survive.
 * - A phone whose date is far ahead can't drag every other phone's clock with it, and the Sync
 *   screen says which phone's date looks wrong.
 * - The household's own changes are checked by SyncHousehold (signed by the owner's key).
 * - Messages name the phone they're for and echo a fresh number, so a recorded message can't be
 *   replayed to another phone.
 * - Sample items (ids "demo-…") stay on the phone that added them.
 *
 * No Android classes here, so the same code is tested on a computer (tools/sync-test).
 */
final class SyncEngine {
    /** This sync's version, sent in hello (0.9.0 = 90). */
    static final int VERSION = 90;
    /** How far ahead of this phone's clock another phone's stamp may pull it. */
    static final long CLOCK_SLACK_MS = 24L * 3600 * 1000;
    /** Folder files leave out deletes older than this (phones apart longer catch up on the Wi-Fi). */
    static final long OLD_DELETE_MS = 180L * 24 * 3600 * 1000;
    /** Tables where a delete beats an edit made without knowing about it. */
    static final Set<String> DELETE_WINS = new HashSet<>(java.util.Arrays.asList("items", "list_entries", "products", "categories", "cards"));

    /** 0.9.0: signs this phone's household changes, and decides on other phones' ones (SyncHousehold). */
    interface Household {
        /** A signature for this household change, or null if this phone doesn't sign it. */
        String sign(JSONObject entry) throws Exception;

        /** May this household change be taken in? */
        boolean allowed(String pk, String byDevice, JSONObject entry) throws Exception;
    }

    Household household;

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
        return collect(since, exclude, limit, allowed, false);
    }

    /** As above; `noPrices` leaves prices out (0.9.0: folder sync, where files stay small). */
    JSONObject collect(long since, String exclude, int limit, Set<String> allowed, boolean noPrices) throws Exception {
        return collect(since, exclude, limit, allowed, noPrices ? " AND tbl <> 'prices'" : "", false, 0);
    }

    /**
     * The full version. `where`: more conditions on sync_log. `moves`: the other phone understands
     * "moved" (0.9.0): a record now on a tab this pair doesn't share is sent as a delete it only
     * applies if its own copy is on a tab it shares (so a line moved off a shared tab goes from the
     * others). `oldestDelete`: leave out deletes stamped before this (0: all).
     */
    JSONObject collect(long since, String exclude, int limit, Set<String> allowed, String where, boolean moves, long oldestDelete) throws Exception {
        if (allowed == null) allowed = tabs();
        List<JSONObject> rows = db.query(
            "SELECT tbl, pk, stamp, device, deleted, seq, sig, created FROM sync_log WHERE seq > ?" + where + " ORDER BY seq LIMIT ?", since, (long) limit + 1);
        boolean more = rows.size() > limit;
        if (more) rows = rows.subList(0, limit);
        boolean cards = shareCards();
        JSONArray entries = new JSONArray();
        long top = since;
        for (JSONObject r : rows) {
            top = Math.max(top, r.getLong("seq"));
            String tbl = r.getString("tbl");
            String key = keyOf(tbl);
            String pk = r.getString("pk");
            if (key == null || (exclude != null && exclude.equals(r.getString("device")))) continue;
            if ("cards".equals(tbl) && !cards) continue;
            if (pk.startsWith("demo-")) continue; // sample items stay on this phone
            JSONObject e = new JSONObject();
            e.put("tbl", tbl);
            e.put("pk", pk);
            e.put("stamp", r.getLong("stamp"));
            e.put("device", r.getString("device"));
            e.put("created", r.optLong("created", 0));
            boolean deleted = r.getLong("deleted") != 0;
            if (deleted && oldestDelete > 0 && r.getLong("stamp") < oldestDelete) continue;
            e.put("deleted", deleted);
            if (!deleted) {
                List<JSONObject> row = db.query("SELECT * FROM " + tbl + " WHERE " + key + " = ?", pk);
                if (row.isEmpty()) continue; // tidied away since (old prices)
                JSONObject data = row.get(0);
                String tab = tabOf(tbl, data);
                if (tab != null && !allowed.contains(tab)) {
                    // A tab this pair doesn't share.
                    if (!moves || "prices".equals(tbl)) continue;
                    e.put("deleted", true);
                    e.put("moved", true);
                    entries.put(e);
                    continue;
                }
                if ("prices".equals(tbl)) data.remove("id");
                if ("products".equals(tbl)) for (String c : LOCAL_PRODUCT_COLUMNS) data.remove(c);
                e.put("row", data);
            }
            if ("household".equals(tbl)) {
                String sig = r.isNull("sig") ? null : r.optString("sig", null);
                if (sig == null && household != null) {
                    sig = household.sign(e);
                    if (sig != null) db.exec("UPDATE sync_log SET sig = ? WHERE tbl = ? AND pk = ? AND stamp = ?", sig, tbl, pk, r.getLong("stamp"));
                }
                if (sig != null) e.put("sig", sig);
            }
            entries.put(e);
        }
        JSONObject out = new JSONObject();
        out.put("entries", entries);
        out.put("top", top);
        out.put("more", more);
        return out;
    }

    /** Notes a change in sync_log as taken in (or made) here: `seq` is this phone's next number. */
    private void logEntry(String tbl, String pk, long stamp, String device, boolean deleted, String sig, long created) throws Exception {
        db.exec(
            "INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log), ?, ?)",
            tbl, pk, stamp, device, deleted ? 1L : 0L, sig, created);
    }

    // ---------- taking in another phone's changes ----------

    /** Applies another phone's changes. Returns how many records changed here. */
    int apply(final JSONArray entries) throws Exception {
        final int[] changed = { 0 };
        if (entries == null || entries.length() == 0) return 0;
        final Map<String, Set<String>> columns = new HashMap<>();
        final Set<String> mine = tabs();
        final long now = System.currentTimeMillis();
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
                if (pk.startsWith("demo-")) continue; // another phone's sample items
                long stamp = e.getLong("stamp");
                String device = e.optString("device", "");
                boolean deleted = e.optBoolean("deleted", false);
                if ("household".equals(tbl) && !householdChangeAllowed(pk, device, e)) continue;
                // A phone whose date is far ahead: take its change, but don't let it drag this
                // phone's clock along (and say so on the Sync screen).
                if (stamp > now + CLOCK_SLACK_MS) setMeta("clock_warn", device);
                else clock = Math.max(clock, stamp);
                List<JSONObject> hadRows = db.query("SELECT stamp, device, deleted, created FROM sync_log WHERE tbl = ? AND pk = ?", tbl, pk);
                JSONObject had = hadRows.isEmpty() ? null : hadRows.get(0);
                boolean wins = had == null || newer(stamp, device, had.getLong("stamp"), had.optString("device", ""));
                long created = e.optLong("created", 0);
                boolean hadDeleted = had != null && had.getLong("deleted") != 0;
                if (had != null && DELETE_WINS.contains(tbl)) {
                    if (deleted && !hadDeleted) wins = stamp > had.optLong("created", 0); // a delete beats edits
                    else if (!deleted && hadDeleted) wins = created > had.getLong("stamp"); // only made again after it
                }
                if ("list_entries".equals(tbl) && !deleted && had != null && !hadDeleted) {
                    // The tick and the quantity are merged one by one.
                    if (mergeListLine(e, wins, had, mine, columns)) changed[0]++;
                    continue;
                }
                if (!wins) continue;
                if (deleted && e.optBoolean("moved", false)) {
                    // Moved to a tab the other phone doesn't share: goes only if it's on one this phone shares.
                    List<JSONObject> cur = db.query("SELECT * FROM " + tbl + " WHERE " + key + " = ?", pk);
                    if (cur.isEmpty()) continue;
                    String tab = tabOf(tbl, cur.get(0));
                    if (tab == null || !mine.contains(tab)) continue;
                }
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
                    writeRow(tbl, row, columnsOf(tbl, columns));
                }
                logEntry(tbl, pk, stamp, device, deleted, e.isNull("sig") ? null : e.optString("sig", null), created);
                changed[0]++;
            }
            // This phone's next changes are stamped after anything it has seen (clocks differ), but
            // never more than a day ahead (a clock dragged far ahead before 0.9.0 comes back too;
            // each record's own stamp still keeps its next change newer).
            String was = meta("clock");
            long cur = was == null ? 0 : Long.parseLong(was);
            if (cur > now + CLOCK_SLACK_MS) cur = 0;
            setMeta("clock", String.valueOf(Math.min(Math.max(clock, cur), now + CLOCK_SLACK_MS)));
            db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
        return changed[0];
    }

    private Set<String> columnsOf(String tbl, Map<String, Set<String>> cache) throws Exception {
        Set<String> cols = cache.get(tbl);
        if (cols == null) {
            cols = new HashSet<>();
            for (JSONObject c : db.query("PRAGMA table_info(" + tbl + ")")) cols.add(c.getString("name"));
            cache.put(tbl, cols);
        }
        return cols;
    }

    private static long at(JSONObject row, String col) {
        return row == null || row.isNull(col) ? 0 : row.optLong(col, 0);
    }

    /**
     * 0.9.0: a list line that's here and in the other phone's change. The newer change wins as
     * before, except the tick and the quantity, which each keep whichever changed last
     * (checked_at, qty_at). If this phone's side added something, the merged line is noted as a
     * new change from this phone, so it goes back to the others too.
     */
    private boolean mergeListLine(JSONObject e, boolean wins, JSONObject had, Set<String> mine, Map<String, Set<String>> columns) throws Exception {
        JSONObject in = e.optJSONObject("row");
        if (in == null) return false;
        String pk = e.getString("pk");
        List<JSONObject> curRows = db.query("SELECT * FROM list_entries WHERE id = ?", pk);
        if (curRows.isEmpty()) return false;
        JSONObject cur = curRows.get(0);
        String tab = tabOf("list_entries", in);
        if (tab != null && !mine.contains(tab)) return false;
        long lc = at(cur, "checked_at"), ic = at(in, "checked_at"), lq = at(cur, "qty_at"), iq = at(in, "qty_at");
        JSONObject merged;
        boolean ours;
        if (wins) {
            merged = new JSONObject(in.toString());
            ours = false;
            if (lc > ic) {
                merged.put("checked", cur.opt("checked"));
                merged.put("checked_at", lc);
                ours = true;
            }
            if (lq > iq) {
                merged.put("qty", cur.opt("qty"));
                merged.put("qty_at", lq);
                ours = true;
            }
        } else {
            merged = new JSONObject(cur.toString());
            boolean any = false;
            if (ic > lc) {
                merged.put("checked", in.opt("checked"));
                merged.put("checked_at", ic);
                any = true;
            }
            if (iq > lq) {
                merged.put("qty", in.opt("qty"));
                merged.put("qty_at", iq);
                any = true;
            }
            if (!any) return false;
            ours = true;
        }
        writeRow("list_entries", merged, columnsOf("list_entries", columns));
        long stamp = e.getLong("stamp");
        if (!ours) logEntry("list_entries", pk, stamp, e.optString("device", ""), false, null, e.optLong("created", 0));
        else logEntry("list_entries", pk, Math.max(stamp, had.getLong("stamp")) + 1, device(), false, null, Math.max(e.optLong("created", 0), had.optLong("created", 0)));
        return true;
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
        // 0.9.0: SyncHousehold checks signatures once the household has an owner key.
        if (household != null && entry != null) return household.allowed(pk, byDevice, entry);
        return legacyHouseholdChangeAllowed(pk, byDevice, entry);
    }

    /** The rules before signed household changes (and for households whose owner is still on 0.8.x). */
    boolean legacyHouseholdChangeAllowed(String pk, String byDevice, JSONObject entry) throws Exception {
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
        } else if ("items".equals(tbl) && !db.query("SELECT 1 FROM items WHERE id = ?", row.optString("id")).isEmpty()) {
            // Update in place (0.8.9): an older Restock on the other phone doesn't send the columns it
            // doesn't know (any_size, not_at), and replacing the row would reset them here.
            List<String> sets = new ArrayList<>();
            List<Object> vals = new ArrayList<>();
            for (int i = 0; i < names.size(); i++) {
                if ("id".equals(names.get(i))) continue;
                sets.add(names.get(i) + " = ?");
                vals.add(values.get(i));
            }
            if (sets.isEmpty()) return;
            vals.add(row.optString("id"));
            db.exec("UPDATE items SET " + String.join(", ", sets) + " WHERE id = ?", vals.toArray());
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

    /**
     * 0.9.0: joining with "Combine": where the household already has a record, its version wins
     * (this phone's copy might be from an old backup). This phone's own records still go to the
     * others, and anything the household deleted goes here too.
     */
    void yieldToHousehold() throws Exception {
        db.exec("UPDATE sync_log SET stamp = 0, created = 0 WHERE tbl <> 'household'");
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
        res.put("v", VERSION);
        // 0.9.0: a message for another phone (recorded on the Wi-Fi and sent here) is turned away,
        // and the answer echoes the asker's number so an old answer can't stand in for a new one.
        String to = req.optString("to", "");
        if (!to.isEmpty() && !to.equals(device())) {
            res.put("error", "That message was for another phone.");
            return res;
        }
        if (req.has("nonce")) res.put("nonce", req.optString("nonce"));
        boolean modern = req.optInt("v", 0) >= VERSION;
        switch (op) {
            case "hello":
                noteTabs();
                notePeer(peer, req.optString("name", null), fromHost, req.optInt("port", 0));
                res.put("household", meta("household"));
                res.put("got", gotFrom(peer));
                res.put("tabs", tabsJson(tabs()));
                return res;
            case "household": {
                // 0.9.0: all of the household record (a phone just updated looks at it afresh).
                JSONObject c = collect(0, null, 100_000, null, " AND tbl = 'household'", false, 0);
                res.put("entries", c.getJSONArray("entries"));
                return res;
            }
            case "pull": {
                Set<String> allowed = tabs();
                Set<String> theirs = parseTabs(req.optJSONArray("tabs"));
                if (theirs != null) allowed.retainAll(theirs);
                JSONObject c = collect(req.optLong("since", 0), peer, PAGE, allowed, "", modern, 0);
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
        JSONObject h = send(t, hello, false);
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
        final boolean modern = h.optInt("v", 0) >= VERSION;
        final String peer = r.peer;

        // 0.9.0: just updated: look at the whole household record afresh (once).
        if (modern && "1".equals(meta("rehousehold"))) {
            JSONObject all = new JSONObject();
            all.put("op", "household");
            all.put("device", me);
            all.put("to", peer);
            r.received += apply(send(t, all, true).optJSONArray("entries"));
            setMeta("rehousehold", null);
        }

        long since = gotFrom(r.peer);
        for (int guard = 0; guard < 10000; guard++) {
            JSONObject pull = new JSONObject();
            pull.put("op", "pull");
            pull.put("device", me);
            pull.put("since", since);
            pull.put("tabs", tabsJson(mine));
            if (modern) pull.put("to", peer);
            JSONObject got = send(t, pull, modern);
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
            JSONObject c = collect(theirs, r.peer, PAGE, allowed, "", modern, 0);
            long top = c.getLong("top");
            if (top <= theirs) break;
            JSONObject push = new JSONObject();
            push.put("op", "push");
            push.put("device", me);
            push.put("entries", c.getJSONArray("entries"));
            push.put("top", top);
            push.put("at", now);
            if (modern) push.put("to", peer);
            send(t, push, modern);
            r.sent += c.getJSONArray("entries").length();
            theirs = top;
            if (!c.getBoolean("more")) break;
        }
        markSynced(r.peer, now);
        return r;
    }

    private static final java.security.SecureRandom NONCES = new java.security.SecureRandom();

    /**
     * Sends a message with a fresh number and the sync version. `strict`: the answer must echo the
     * number (0.9.0 phones always do), or it's an old answer being played back.
     */
    static JSONObject send(Transport t, JSONObject m, boolean strict) throws Exception {
        byte[] b = new byte[12];
        NONCES.nextBytes(b);
        String nonce = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        m.put("nonce", nonce);
        m.put("v", VERSION);
        JSONObject res = t.send(m);
        boolean echoes = res.optInt("v", 0) >= VERSION;
        if ((strict || echoes) && !nonce.equals(res.optString("nonce", ""))) throw new java.io.IOException("The other phone's answer didn't match. Try again.");
        return res;
    }
}
