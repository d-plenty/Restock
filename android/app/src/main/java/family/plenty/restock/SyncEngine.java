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
 * 0.9.1:
 * - Receipts sync when the owner turns on "Share receipts with the household" (off by default).
 *   Their rows go everywhere sync goes; their photos only over the Wi-Fi ("photo", fetched after
 *   each sync), and only real receipt photo paths of receipts this pair shares.
 * - Secrets in sync_meta (keys, secrets, signing keys, the recovery key, the WebDAV password) go
 *   through Secrets: on the phone, sealed with a key in Android's key store (SyncKeystore). An old
 *   plain value is sealed the first time it's read. A value that can't be opened any more (restored
 *   onto another phone) reads as missing, so the phone counts as not in a household.
 * - Each phone notes how far the others have got through its own changes (sync_peers.seen), and
 *   compact() removes deletes older than 90 days that every phone in the household has seen.
 *
 * 0.9.3:
 * - Household-wide settings (household_settings, SharedSettings): which shops each shared tab uses,
 *   Shop around, alert level, recalls and so on, one row per setting, the later change winning per
 *   row, from any phone in the household or the web app. Applied to this phone's settings as they
 *   arrive (only for the tabs it syncs); the owner phone seeds them once from its own settings.
 *   A phone on 0.9.2 or older passes over the table (it isn't in its TABLES).
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
    static final Set<String> DELETE_WINS = new HashSet<>(java.util.Arrays.asList("items", "list_entries", "products", "categories", "cards", "receipts"));
    /** 0.9.1: deletes older than this go from sync_log once every phone in the household has seen them. */
    static final long COMPACT_AFTER_MS = 90L * 24 * 3600 * 1000;
    /** 0.9.1: the biggest receipt photo that goes to another phone. */
    static final int MAX_PHOTO = 8 * 1024 * 1024;
    /** 0.9.1: at most this many photos fetched from one phone in one sync (the rest come next time). */
    static final int PHOTOS_PER_SYNC = 30;
    /** The only paths a receipt photo can have (mirrors src/lib/receiptPaths.ts). */
    private static final java.util.regex.Pattern PHOTO_PATH = java.util.regex.Pattern.compile("receipts/[A-Za-z0-9_-]{1,80}\\.jpg");

    static boolean isPhotoPath(String p) {
        return p != null && PHOTO_PATH.matcher(p).matches();
    }

    /**
     * 0.9.1: how secrets in sync_meta are kept. On the phone, sealed with a key in Android's key
     * store (SyncKeystore); on a computer (tools/sync-test), as they are.
     */
    interface Secrets {
        /** The stored form of a secret. */
        String seal(String plain) throws Exception;

        /** The secret from its stored form (an old plain value comes back as it is). Throws if it can't be opened. */
        String open(String stored) throws Exception;

        /** Whether the stored form is already sealed (false: an old plain value, to seal again). */
        boolean sealed(String stored);
    }

    /**
     * Thrown by Secrets.open when a value can never be opened on this phone again (the key that
     * sealed it is gone, or it was sealed with another one). Any other failure is taken as passing
     * (the key store busy, say): nothing is forgotten over it.
     */
    static final class SecretLost extends Exception {
        SecretLost(String why, Throwable cause) {
            super(why, cause);
        }
    }

    static final Secrets PLAIN = new Secrets() {
        public String seal(String plain) {
            return plain;
        }

        public String open(String stored) {
            return stored;
        }

        public boolean sealed(String stored) {
            return true;
        }
    };

    /** The sync_meta values that are secrets: never shown, never synced, sealed on the phone. */
    static final Set<String> SECRET_KEYS = new HashSet<>(java.util.Arrays.asList(
        "key", "oldkey", "secret", "owner_secrets", "owner_priv", "my_priv", "recovery", "pair_token", "dav_pass",
        // 0.9.2: the phone's own key for the Restock server, and the serverKeys it has known.
        "server_dev_priv", "server_filekeys",
        // 0.9.4: the phone's ECDH key for a v3 server (keys reach it sealed to this key).
        "server_kex_priv"));

    Secrets secrets = PLAIN;
    /** Set when a secret couldn't be opened (the key store's key is gone): SyncHub treats the phone as not paired. */
    volatile boolean secretsLost;
    private final Map<String, String> opened = new java.util.concurrent.ConcurrentHashMap<>();

    /** 0.9.1: receipt photos in the phone's own storage. Null: photos don't travel (tests that don't need them). */
    interface Photos {
        /** The photo's size in bytes, or -1 if it isn't on this phone. */
        long size(String path) throws Exception;

        byte[] read(String path) throws Exception;

        void write(String path, byte[] data) throws Exception;

        void delete(String path) throws Exception;
    }

    Photos photos;

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
        // 0.9.1: receipts, when the household shares them.
        { "receipts", "id" },
        // 0.9.3: household-wide settings (SharedSettings).
        { "household_settings", "k" },
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
        String v = r.isEmpty() ? null : r.get(0).optString("value", null);
        if (v == null || !SECRET_KEYS.contains(key)) return v;
        String plain = secrets.sealed(v) ? opened.get(v) : null;
        if (plain != null) return plain;
        try {
            plain = secrets.open(v);
        } catch (SecretLost lost) {
            // 0.9.1: sealed with a key this phone doesn't have any more (restored onto another phone,
            // or Android's key store was reset): as if it weren't there.
            secretsLost = true;
            return null;
        }
        if (!secrets.sealed(v)) {
            // An old plain value (0.9.0): seal it now.
            String sealed = secrets.seal(plain);
            db.exec("UPDATE sync_meta SET value = ? WHERE key = ? AND value = ?", sealed, key, v);
            opened.put(sealed, plain);
        } else {
            opened.put(v, plain);
        }
        return plain;
    }

    void setMeta(String key, String value) throws Exception {
        if (value == null) db.exec("DELETE FROM sync_meta WHERE key = ?", key);
        else if (SECRET_KEYS.contains(key)) {
            String sealed = secrets.seal(value);
            opened.put(sealed, value);
            db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)", key, sealed);
        } else db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)", key, value);
    }

    /**
     * 0.9.1: reads every secret once, sealing old plain ones. True when one couldn't be opened
     * (the phone's key store lost its key): those are removed (they're no use to anyone now), and
     * the caller forgets the household on this phone.
     */
    boolean checkSecrets() throws Exception {
        boolean lost = false;
        for (String k : SECRET_KEYS) {
            secretsLost = false;
            meta(k);
            if (secretsLost) {
                lost = true;
                db.exec("DELETE FROM sync_meta WHERE key = ?", k);
            }
        }
        secretsLost = false;
        return lost;
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

    /**
     * 0.9.1: whether the household shares receipts (the owner turns it on; off by default). 0.9.4:
     * and this phone hasn't turned them off (share_receipts "0"; unset is on, so phone households are
     * as 0.9.3; a phone joining a server's house writes "0", engine.ts the same).
     */
    boolean shareReceipts() throws Exception {
        return "1".equals(householdValue("receipts")) && !"0".equals(meta("share_receipts"));
    }

    /** 0.9.4: this phone's own choice of sharing receipts. Turning it on sends the receipts already here, too. */
    void setShareReceipts(boolean on) throws Exception {
        boolean was = shareReceipts();
        setMeta("share_receipts", on ? "1" : "0");
        if (on && !was) {
            db.transaction(() -> {
                for (JSONObject r : db.query("SELECT pk FROM sync_log WHERE tbl = 'receipts'"))
                    db.exec("UPDATE sync_log SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log) WHERE tbl = 'receipts' AND pk = ?", r.getString("pk"));
            });
        }
    }

    // ---------- 0.9.4: "Also take what this phone shared off the server" ----------

    /** What can be taken back off a server when this phone stops sharing it: a tab, receipts or cards. */
    static final Set<String> TAKE_BACK = new HashSet<>(java.util.Arrays.asList("keg", "pharmacy", "receipts", "cards"));
    /** The tables a tab's records are in. */
    private static final String[] TAB_TABLES = { "categories", "products", "items", "list_entries", "receipts", "prices" };

    /** sync_meta server_takeback: { kind: when it was ticked (ms) }. */
    JSONObject takeBackKinds() {
        try {
            String v = meta("server_takeback");
            return v == null ? new JSONObject() : new JSONObject(v);
        } catch (Exception ex) {
            return new JSONObject();
        }
    }

    /** Ticked (or, on: no longer): this phone's own records of `kind` go off the server in its next file. */
    void setTakeBack(String kind, boolean on) throws Exception {
        if (!TAKE_BACK.contains(kind)) throw new IllegalArgumentException("not something to take back: " + kind);
        JSONObject k = takeBackKinds();
        if (on) {
            if (!k.has(kind)) k.put(kind, System.currentTimeMillis());
        } else if (k.has(kind)) {
            // Shared again: the deletes this phone sent are on the server (and the phones that took them),
            // stamped after its own copies, so those copies would lose to them and go here too. They
            // count as made again now instead (like a restore), so they win there and come back.
            final List<JSONObject> back = takeBackEntries(new JSONObject().put(kind, k.get(kind)));
            final long now = System.currentTimeMillis();
            db.transaction(() -> {
                for (JSONObject x : back) {
                    long st = Math.max(now, x.getLong("stamp") + 1);
                    db.exec("UPDATE sync_log SET stamp = ?, created = ?, seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log) WHERE tbl = ? AND pk = ? AND deleted = 0",
                        st, st, x.getString("tbl"), x.getString("pk"));
                }
            });
            k.remove(kind);
        }
        setMeta("server_takeback", k.length() == 0 ? null : k.toString());
    }

    /**
     * The plain deletes that take this phone's own records of the ticked kinds off the server (docs/
     * server-v3-design.md 14): one per record this phone made (sync_log.origin, 0.9.4 review: not
     * every record it was the last to change, which took other people's things too), stamped after
     * both its last change and the moment it was ticked. A record whose maker isn't known stays.
     * Only ever in its file; nothing is deleted here.
     */
    List<JSONObject> takeBackEntries() throws Exception {
        return takeBackEntries(takeBackKinds());
    }

    private List<JSONObject> takeBackEntries(JSONObject kinds) throws Exception {
        List<JSONObject> out = new ArrayList<>();
        if (kinds.length() == 0 || !hasOrigin()) return out;
        String me = device();
        if (me.isEmpty()) return out;
        for (Iterator<String> it = kinds.keys(); it.hasNext(); ) {
            String kind = it.next();
            long at = kinds.optLong(kind, 0);
            boolean tab = !"receipts".equals(kind) && !"cards".equals(kind);
            String[] tables = tab ? TAB_TABLES : new String[] { kind };
            for (String tbl : tables) {
                // One query a table (0.9.4 review: not one a record, which was slow on years of prices),
                // with what tabOf needs joined in.
                for (JSONObject r : db.query(TAKE_BACK_SQL.get(tbl), me)) {
                    String pk = r.getString("pk");
                    if (pk.startsWith("demo-")) continue;
                    if (tab && !kind.equals(takeBackTab(tbl, r))) continue;
                    JSONObject e = new JSONObject();
                    e.put("tbl", tbl);
                    e.put("pk", pk);
                    e.put("stamp", Math.max(at, r.getLong("stamp") + 1));
                    e.put("device", me);
                    e.put("created", 0);
                    e.put("deleted", true);
                    out.add(e);
                }
            }
        }
        return out;
    }

    /**
     * For takeBackEntries: this phone's records of a table that it made (origin = this phone) and that
     * are still here, each with the columns its tab comes from (tabOf's rules, joined in).
     */
    private static final Map<String, String> TAKE_BACK_SQL = new HashMap<>();
    static {
        String log = "SELECT l.pk AS pk, l.stamp AS stamp";
        String mine = " WHERE l.tbl = '%s' AND l.origin = ? AND l.deleted = 0";
        for (String t : new String[] { "categories", "items", "receipts" })
            TAKE_BACK_SQL.put(t, log + ", t.section AS section FROM sync_log l JOIN " + t + " t ON t.id = l.pk" + String.format(mine, t));
        TAKE_BACK_SQL.put("cards", log + " FROM sync_log l JOIN cards t ON t.id = l.pk" + String.format(mine, "cards"));
        TAKE_BACK_SQL.put("products", log + ", t.chain AS chain FROM sync_log l JOIN products t ON t.id = l.pk" + String.format(mine, "products"));
        TAKE_BACK_SQL.put("list_entries", log + ", t.section AS section, t.item_id AS item_id, t.chain AS chain, i.id AS item_here, i.section AS item_section"
            + " FROM sync_log l JOIN list_entries t ON t.id = l.pk LEFT JOIN items i ON i.id = t.item_id" + String.format(mine, "list_entries"));
        TAKE_BACK_SQL.put("prices", log + ", pr.id AS product_here, pr.chain AS chain FROM sync_log l JOIN prices t ON t.product_id || '|' || t.date = l.pk"
            + " LEFT JOIN products pr ON pr.id = t.product_id" + String.format(mine, "prices"));
    }

    /** tabOf for a TAKE_BACK_SQL row. */
    private String takeBackTab(String tbl, JSONObject r) throws Exception {
        return shared(takeBackTabRaw(tbl, r));
    }

    /** 0.10.3: Baby and Pets records are shared with Groceries (shops.ts shareTab): the three tabs stay as they were. */
    static String shared(String tab) {
        return "baby".equals(tab) || "pets".equals(tab) ? "pantry" : tab;
    }

    private String takeBackTabRaw(String tbl, JSONObject r) throws Exception {
        switch (tbl) {
            case "categories":
            case "items":
            case "receipts": {
                String s = str(r, "section");
                return s == null ? "pantry" : s;
            }
            case "list_entries": {
                String s = str(r, "section");
                if (s != null) return listTab(s);
                if (str(r, "item_id") != null) return str(r, "item_here") == null ? null : str(r, "item_section");
                String chain = str(r, "chain");
                return chain != null ? chainTab(chain) : "pantry";
            }
            case "products":
                return chainTab(str(r, "chain"));
            case "prices":
                return str(r, "product_here") == null ? null : chainTab(str(r, "chain"));
            default:
                return null;
        }
    }

    // ---------- 0.9.4: who made a record (sync_log.origin) ----------

    /** What a device id in an entry's `origin` can look like (engine.ts ORIGIN). */
    private static final java.util.regex.Pattern ORIGIN = java.util.regex.Pattern.compile("[A-Za-z0-9._-]{1,80}");
    private volatile boolean originColumn;

    /**
     * Whether sync_log has `origin` yet (schema.ts SYNC_094). The app adds it when it opens after the
     * update; until then (the background job running first) nothing is noted or taken back by it.
     */
    boolean hasOrigin() {
        if (originColumn) return true;
        try {
            for (JSONObject c : db.query("PRAGMA table_info(sync_log)")) if ("origin".equals(c.optString("name"))) return originColumn = true;
        } catch (Exception ignored) {
            // not there
        }
        return false;
    }

    /**
     * Who made a record, as noted when a change to it comes in (engine.ts originOf). A record that's
     * here (and not deleted) keeps its own, unless the change made it again (a newer `created`); a new
     * one, or one made again, takes the entry's `origin`, or, from a phone that doesn't send one, the
     * entry's own device when that change was the one that made it (stamp = created). Never filled in
     * later, so nobody can claim a record they didn't make.
     */
    static String originOf(JSONObject e, long stamp, String device, boolean deleted, long created, JSONObject had) {
        String hadOrigin = had == null || had.isNull("origin") ? null : had.optString("origin", null);
        if (hadOrigin != null && hadOrigin.isEmpty()) hadOrigin = null;
        if (had != null && had.optLong("deleted", 0) == 0 && (deleted || created <= had.optLong("created", 0))) return hadOrigin;
        if (deleted) return hadOrigin;
        String claim = e.isNull("origin") ? null : e.optString("origin", null);
        if (claim != null && ORIGIN.matcher(claim).matches()) return claim;
        return created > 0 && stamp == created && ORIGIN.matcher(device).matches() ? device : null;
    }

    /**
     * 0.9.4: leaving the server with "Also take what this phone shared off the server" ticked for some
     * kinds: each one this phone shares now is turned off and taken back, exactly as turning it off
     * with the box ticked (the caller then syncs once, so the deletes reach the server, and leaves).
     * Groceries are never taken back. Returns the kinds it took back.
     */
    Set<String> stopSharingAndTakeBack(Set<String> kinds) throws Exception {
        Set<String> out = new java.util.LinkedHashSet<>();
        if (kinds == null) return out;
        Set<String> mine = myTabs();
        Set<String> shared = tabs();
        boolean changedTabs = false;
        for (String t : new String[] { "keg", "pharmacy" }) {
            if (!kinds.contains(t) || !shared.contains(t)) continue;
            mine.remove(t);
            changedTabs = true;
            out.add(t);
        }
        if (changedTabs) setMeta("tabs", joinTabs(mine));
        if (kinds.contains("receipts") && shareReceipts()) {
            setShareReceipts(false);
            out.add("receipts");
        }
        if (kinds.contains("cards") && shareCards()) {
            setShareCards(false);
            out.add("cards");
        }
        for (String k : out) setTakeBack(k, true);
        if (!out.isEmpty()) noteTabs();
        return out;
    }

    /** "tbl|pk" of every record takeBackEntries() names: their deletes, coming back, are never taken in here. */
    Set<String> takeBackKeys() throws Exception {
        Set<String> out = new HashSet<>();
        for (JSONObject e : takeBackEntries()) out.add(e.getString("tbl") + "|" + e.getString("pk"));
        return out;
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
     * 0.9.1: true when it did that.
     */
    boolean noteTabs() throws Exception {
        resendCostcoLines();
        // 0.9.3: on the owner phone, the household settings that have no row yet (once each).
        try {
            SharedSettings.seed(this);
        } catch (Exception ex) {
            // next time
        }
        boolean caught = catchUpLists();
        Set<String> now = tabs();
        String was = meta("tabs_eff");
        Set<String> before = was == null ? null : parseTabs(was);
        // 0.9.1: the household starting to share receipts goes through everything again too (and
        // so does a phone that was still on 0.9.0 when the owner turned them on: it passed them over).
        boolean receipts = shareReceipts();
        String rwas = meta("receipts_eff");
        boolean receiptsOn = receipts && !"1".equals(rwas);
        boolean again = (before != null && !before.containsAll(now)) || receiptsOn;
        if (again) {
            db.transaction(() -> {
                db.exec("UPDATE sync_peers SET got = 0");
                db.exec("UPDATE sync_log SET seq = seq + (SELECT COALESCE(MAX(seq), 0) FROM sync_log)");
                // And the folder's files are read again, for what this phone left out before (all of
                // them, so no catch-up read either: 0.9.5 review).
                db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%' OR key LIKE 'server_seen:%' OR key LIKE 'server_ver:%' OR key LIKE 'catchup:%' OR key LIKE 'catchup_peer:%'");
            });
            releaseHeld();
        }
        String j = joinTabs(now);
        if (!j.equals(was)) {
            setMeta("tabs_eff", j);
            // 0.9.3: syncing another tab (or one fewer): its household settings apply from now.
            SharedSettings.applyTo(this);
        }
        String r = receipts ? "1" : "0";
        if (!r.equals(rwas)) setMeta("receipts_eff", r);
        return again || caught;
    }

    /** 0.9.5: what catchUpLists notes once it has read everything again (sync_meta lists_v). */
    static final String LISTS_V = "95";

    /**
     * 0.9.5: the first sync on this version reads everything the others have again (Wi-Fi: from the
     * start; a folder's or the server's files: again), once. A phone on 0.9.4 or older passed over
     * what it didn't know: General list lines (list_entries.section 'general', which it takes for a
     * tab it doesn't share, so it neither keeps nor logs them). Read again, they come in now. Only
     * what comes in: nothing of this phone's is sent again. True when there was anything to read again.
     */
    boolean catchUpLists() throws Exception {
        if (LISTS_V.equals(meta("lists_v"))) return false;
        boolean any = !db.query("SELECT 1 FROM sync_peers WHERE got > 0 LIMIT 1").isEmpty()
            || !db.query("SELECT 1 FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'server_seen:%' LIMIT 1").isEmpty();
        if (any) {
            // 0.9.5 (review): what's read again unchanged (a file with the sum it had, a Wi-Fi phone up to
            // where this one had got) only brings General lines this phone never had (catchUpEntries):
            // an old file still holds records deleted so long ago that the delete was tidied away.
            db.transaction(() -> {
                db.exec("INSERT OR REPLACE INTO sync_meta (key, value) SELECT 'catchup:' || key, value FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'server_seen:%'");
                db.exec("INSERT OR REPLACE INTO sync_meta (key, value) SELECT 'catchup_peer:' || device, got FROM sync_peers WHERE got > 0");
                db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%' OR key LIKE 'server_seen:%' OR key LIKE 'server_ver:%'");
            });
        }
        setMeta("lists_v", LISTS_V);
        return any;
    }

    /**
     * 0.9.5 (review): what a catch-up read (catchUpLists) takes in: only General list lines (section
     * 'general') this phone has never had (no row, no change noted). Nothing else.
     */
    JSONArray catchUpEntries(JSONArray entries) throws Exception {
        JSONArray out = new JSONArray();
        if (entries == null) return out;
        for (int i = 0; i < entries.length(); i++) {
            JSONObject x = entries.optJSONObject(i);
            if (x == null || !"list_entries".equals(x.optString("tbl")) || x.optBoolean("deleted", false)) continue;
            String pk = x.optString("pk", "");
            JSONObject row = x.optJSONObject("row");
            if (pk.isEmpty() || row == null || !"general".equals(str(row, "section")) || !pk.equals(row.optString("id", ""))) continue;
            if (!db.query("SELECT 1 FROM list_entries WHERE id = ?", pk).isEmpty()) continue;
            if (!db.query("SELECT 1 FROM sync_log WHERE tbl = 'list_entries' AND pk = ?", pk).isEmpty()) continue;
            out.put(x);
        }
        return out;
    }

    /** 0.9.5: the tab a list line's own section is shared with: General goes with the groceries (shops.ts listShareTab). */
    static String listTab(String section) {
        return "general".equals(section) ? "pantry" : section;
    }

    /**
     * 0.9.4 review: the plain deletes held back (apply) for records on a tab this phone didn't sync,
     * taken in now for the ones whose tab it syncs (or that are gone here). The rest stay held.
     * Returns how many records changed.
     */
    int releaseHeld() throws Exception {
        if (!hasOrigin()) return 0;
        Set<String> mine = tabs();
        JSONArray go = new JSONArray();
        List<String[]> done = new ArrayList<>();
        for (JSONObject r : db.query("SELECT tbl, pk, entry FROM sync_held")) {
            String tbl = r.getString("tbl"), pk = r.getString("pk");
            String key = keyOf(tbl);
            JSONObject e;
            try {
                e = new JSONObject(r.getString("entry"));
            } catch (Exception bad) {
                e = null;
            }
            if (key != null && e != null) {
                List<JSONObject> cur = db.query("SELECT * FROM " + tbl + " WHERE " + key + " = ?", pk);
                String tab = cur.isEmpty() ? null : tabOf(tbl, cur.get(0));
                if (tab != null && !mine.contains(tab)) continue;
                go.put(e);
            }
            done.add(new String[] { tbl, pk });
        }
        int n = go.length() == 0 ? 0 : apply(go);
        for (String[] d : done) db.exec("DELETE FROM sync_held WHERE tbl = ? AND pk = ?", d[0], d[1]);
        return n;
    }

    /** 0.9.6: the pseudo tab of records that never leave this phone (Costco's products and prices). Never in any shared set. */
    static final String LOCAL_TAB = "local";
    /** 0.9.7: no shop stays on one phone any more (shops.ts LOCAL_ONLY_SHOPS is empty). */
    static final boolean LOCAL_ONLY = false;

    private Map<String, String> customTabs;

    /** 0.9.3: the settings' own shops changed (household settings): look them up again. */
    void forgetCustomTabs() {
        customTabs = null;
    }

    /** Which tab a shop is on: built-in shops from Shops, the ones people added from settings. */
    String chainTab(String chain) throws Exception {
        if (chain == null || chain.isEmpty()) return null;
        // 0.9.7: Costco is shared like any shop (0.9.6 kept it on one phone, LOCAL_TAB).
        if (Shops.known(chain)) return shared(Shops.section(chain));
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
        return shared(customTabs.get(chain));
    }

    private static String str(JSONObject row, String k) {
        if (row == null || row.isNull(k)) return null;
        String v = row.optString(k, null);
        return v == null || v.isEmpty() ? null : v;
    }

    /** The tab a record belongs to, or null when it isn't on a tab (cards, the household) or can't tell. */
    String tabOf(String tbl, JSONObject row) throws Exception {
        return shared(tabOfRaw(tbl, row));
    }

    private String tabOfRaw(String tbl, JSONObject row) throws Exception {
        switch (tbl) {
            case "categories":
            case "items": {
                String s = str(row, "section");
                return s == null ? "pantry" : s;
            }
            case "list_entries": {
                // 0.9.6 (review H1): a line an earlier build put at Costco is an ordinary line, shared as
                // "Any shop" (stripCostcoLine), never on Costco's own tab: ticks and deletes still reach everyone.
                // 0.9.5: a General line (section 'general') is shared with the groceries.
                String s = str(row, "section");
                if (s != null) return listTab(s);
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
            case "receipts": {
                String s = str(row, "section");
                return s == null ? "pantry" : s;
            }
            case "prices": {
                List<JSONObject> r = db.query("SELECT chain FROM products WHERE id = ?", str(row, "product_id"));
                return r.isEmpty() ? null : chainTab(str(r.get(0), "chain"));
            }
            case "household_settings":
                return SharedSettings.tabOf(str(row, "k"), str(row, "v"));
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

    /** 0.9.1: how far that phone has got through this phone's own changes (its claim, or what it was sent). */
    long seenBy(String peer) throws Exception {
        List<JSONObject> r = db.query("SELECT seen FROM sync_peers WHERE device = ?", peer);
        return r.isEmpty() ? 0 : r.get(0).optLong("seen", 0);
    }

    void setSeen(String peer, long seen) throws Exception {
        if (peer == null || peer.isEmpty() || seen <= 0) return;
        List<JSONObject> top = db.query("SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log");
        long max = top.get(0).optLong("top", 0);
        db.exec("INSERT OR IGNORE INTO sync_peers (device, got) VALUES (?, 0)", peer);
        db.exec("UPDATE sync_peers SET seen = ? WHERE device = ? AND seen < ?", Math.min(seen, max), peer, Math.min(seen, max));
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
            "SELECT tbl, pk, stamp, device, deleted, seq, sig, created" + (hasOrigin() ? ", origin" : "") + " FROM sync_log WHERE seq > ?" + where + " ORDER BY seq LIMIT ?", since, (long) limit + 1);
        boolean more = rows.size() > limit;
        if (more) rows = rows.subList(0, limit);
        boolean cards = shareCards();
        boolean receipts = shareReceipts();
        JSONArray entries = new JSONArray();
        long top = since;
        for (JSONObject r : rows) {
            top = Math.max(top, r.getLong("seq"));
            String tbl = r.getString("tbl");
            String key = keyOf(tbl);
            String pk = r.getString("pk");
            if (key == null || (exclude != null && exclude.equals(r.getString("device")))) continue;
            if ("cards".equals(tbl) && !cards) continue;
            if ("receipts".equals(tbl) && !receipts) continue;
            if (pk.startsWith("demo-")) continue; // sample items stay on this phone
            JSONObject e = new JSONObject();
            e.put("tbl", tbl);
            e.put("pk", pk);
            e.put("stamp", r.getLong("stamp"));
            e.put("device", r.getString("device"));
            e.put("created", r.optLong("created", 0));
            String origin = r.isNull("origin") ? null : r.optString("origin", null);
            if (origin != null && !origin.isEmpty()) e.put("origin", origin);
            boolean deleted = r.getLong("deleted") != 0;
            if (deleted && oldestDelete > 0 && r.getLong("stamp") < oldestDelete) continue;
            e.put("deleted", deleted);
            if (!deleted) {
                List<JSONObject> row = db.query("SELECT * FROM " + tbl + " WHERE " + key + " = ?", pk);
                if (row.isEmpty()) continue; // tidied away since (old prices)
                JSONObject data = row.get(0);
                String tab = tabOf(tbl, data);
                if (LOCAL_TAB.equals(tab)) continue; // 0.9.6: Costco stays on this phone, not even as a "moved" record
                if (tab != null && !allowed.contains(tab)) {
                    // A tab this pair doesn't share.
                    // 0.9.3: a household setting of a tab this pair doesn't share is left out, never sent as moved.
                    if (!moves || "prices".equals(tbl) || SharedSettings.TABLE.equals(tbl)) continue;
                    e.put("deleted", true);
                    e.put("moved", true);
                    entries.put(e);
                    continue;
                }
                if ("prices".equals(tbl)) data.remove("id");
                if ("products".equals(tbl)) for (String c : LOCAL_PRODUCT_COLUMNS) data.remove(c);
                if ("items".equals(tbl)) stripCostcoPicks(data);
                if ("list_entries".equals(tbl)) stripCostcoLine(data);
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
    void logEntry(String tbl, String pk, long stamp, String device, boolean deleted, String sig, long created) throws Exception {
        logEntry(tbl, pk, stamp, device, deleted, sig, created, null);
    }

    /** 0.9.4: with who made the record (origin), where sync_log has it. */
    void logEntry(String tbl, String pk, long stamp, String device, boolean deleted, String sig, long created, String origin) throws Exception {
        if (!hasOrigin()) {
            db.exec(
                "INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log), ?, ?)",
                tbl, pk, stamp, device, deleted ? 1L : 0L, sig, created);
            return;
        }
        db.exec(
            "INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created, origin) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log), ?, ?, ?)",
            tbl, pk, stamp, device, deleted ? 1L : 0L, sig, created, origin);
    }

    // ---------- taking in another phone's changes ----------

    /** Applies another phone's changes. Returns how many records changed here. */
    int apply(final JSONArray entries) throws Exception {
        final int[] changed = { 0 };
        if (entries == null || entries.length() == 0) return 0;
        final Map<String, Set<String>> columns = new HashMap<>();
        final Set<String> mine = tabs();
        final long now = System.currentTimeMillis();
        final boolean receipts = shareReceipts();
        // 0.9.1: receipt photos on this phone that a change made unused (a receipt deleted on another phone).
        final List<String> unused = new ArrayList<>();
        // 0.9.3: household settings came in (applied to the settings after), and whether this phone
        // has their table yet (updated, not opened since: they come again once it has).
        final boolean[] settings = { false };
        final boolean hasSettings = SharedSettings.hasTable(this);
        final SharedSettings.Room room = new SharedSettings.Room(this);
        // 0.9.4: this phone's own "take it off the server" deletes, passed back by the server: never here.
        final Set<String> takenBack = takeBackKinds().length() == 0 ? java.util.Collections.emptySet() : takeBackKeys();
        final String me = device();
        final String hadCols = hasOrigin() ? "stamp, device, deleted, created, origin" : "stamp, device, deleted, created";
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
                if (deleted && me.equals(device) && takenBack.contains(tbl + "|" + pk)) continue;
                if ("household".equals(tbl) && !householdChangeAllowed(pk, device, e)) continue;
                if ("receipts".equals(tbl) && !receipts) continue;
                if (SharedSettings.TABLE.equals(tbl) && !hasSettings) continue;
                // 0.9.3: household settings only of a sensible size and shape, and not without end.
                if (SharedSettings.TABLE.equals(tbl) && !SharedSettings.acceptable(room, pk, deleted ? null : e.optJSONObject("row"), deleted)) continue;
                // A phone whose date is far ahead: take its change, but don't let it drag this
                // phone's clock along (and say so on the Sync screen).
                if (stamp > now + CLOCK_SLACK_MS) setMeta("clock_warn", device);
                else clock = Math.max(clock, stamp);
                List<JSONObject> hadRows = db.query("SELECT " + hadCols + " FROM sync_log WHERE tbl = ? AND pk = ?", tbl, pk);
                JSONObject had = hadRows.isEmpty() ? null : hadRows.get(0);
                boolean wins = had == null || newer(stamp, device, had.getLong("stamp"), had.optString("device", ""));
                long created = e.optLong("created", 0);
                boolean hadDeleted = had != null && had.getLong("deleted") != 0;
                if (had != null && DELETE_WINS.contains(tbl)) {
                    // A delete beats edits; 0.9.4: not a "moved" one, which carries the record's own stamp
                    // (a tab this phone's pair stopped sharing): only if it's newer than the copy here, so
                    // turning a tab off on one phone never deletes the others' copies it last changed.
                    if (deleted && !hadDeleted) wins = (!e.optBoolean("moved", false) || wins) && stamp > had.optLong("created", 0);
                    else if (!deleted && hadDeleted) wins = created > had.getLong("stamp"); // only made again after it
                }
                if ("list_entries".equals(tbl) && !deleted && had != null && !hadDeleted) {
                    // The tick and the quantity are merged one by one.
                    if (mergeListLine(e, wins, had, mine, columns)) changed[0]++;
                    continue;
                }
                if (!wins) continue;
                if (deleted && e.optBoolean("moved", false)) {
                    if (SharedSettings.TABLE.equals(tbl)) continue;
                    // Moved to a tab the other phone doesn't share: goes only if it's on one this phone shares.
                    List<JSONObject> cur = db.query("SELECT * FROM " + tbl + " WHERE " + key + " = ?", pk);
                    if (cur.isEmpty()) continue;
                    String tab = tabOf(tbl, cur.get(0));
                    if (tab == null || !mine.contains(tab)) continue;
                } else if (deleted) {
                    // 0.9.4: a plain delete of a record here on a tab this phone doesn't sync stays out,
                    // like the tab's changes: what someone took off the server is only for the phones
                    // sharing that tab (and their own copies stay on the others).
                    List<JSONObject> cur = db.query("SELECT * FROM " + tbl + " WHERE " + key + " = ?", pk);
                    String tab = cur.isEmpty() ? null : tabOf(tbl, cur.get(0));
                    if (LOCAL_TAB.equals(tab)) continue; // 0.9.6: nobody else has Costco's records to delete
                    if (tab != null && !mine.contains(tab)) {
                        // Held until this phone syncs that tab again (releaseHeld), so it still goes then,
                        // even if the others have tidied the delete away by then (review fix).
                        if (hasOrigin()) db.exec("INSERT OR REPLACE INTO sync_held (tbl, pk, entry) VALUES (?, ?, ?)", tbl, pk, e.toString());
                        continue;
                    }
                }
                if (!deleted) {
                    // A tab this phone doesn't sync: leave it out (an older phone may still send it).
                    String tab = tabOf(tbl, e.optJSONObject("row"));
                    if (tab != null && !mine.contains(tab)) continue;
                }
                if ("receipts".equals(tbl) && photos != null) {
                    List<String> before = new ArrayList<>();
                    for (JSONObject cur : db.query("SELECT photo, pages FROM receipts WHERE id = ?", pk)) before.addAll(photoPaths(cur));
                    if (!deleted) before.removeAll(photoPaths(e.optJSONObject("row")));
                    unused.addAll(before);
                }
                if (deleted) {
                    db.exec("DELETE FROM " + tbl + " WHERE " + key + " = ?", pk);
                } else {
                    JSONObject row = e.optJSONObject("row");
                    if (row == null) continue;
                    if ("items".equals(tbl)) keepLocalCostcoPicks(pk, row);
                    writeRow(tbl, row, columnsOf(tbl, columns));
                }
                logEntry(tbl, pk, stamp, device, deleted, e.isNull("sig") ? null : e.optString("sig", null), created, originOf(e, stamp, device, deleted, created, had));
                if (SharedSettings.TABLE.equals(tbl)) settings[0] = true;
                changed[0]++;
            }
            // This phone's next changes are stamped after anything it has seen (clocks differ), but
            // never more than a day ahead (a clock dragged far ahead before 0.9.0 comes back too;
            // each record's own stamp still keeps its next change newer).
            String was = meta("clock");
            long cur = was == null ? 0 : Long.parseLong(was);
            if (cur > now + CLOCK_SLACK_MS) cur = 0;
            setMeta("clock", String.valueOf(Math.min(Math.max(clock, cur), now + CLOCK_SLACK_MS)));
            // 0.9.3: household settings that came in change this phone's settings (the screens refresh).
            if (settings[0]) SharedSettings.applyTo(this);
            db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
        for (String p : unused) {
            try {
                // Still used by another receipt here? Then it stays.
                if (db.query("SELECT 1 FROM receipts WHERE photo = ? OR pages LIKE ?", p, "%\"" + p + "\"%").isEmpty()) photos.delete(p);
            } catch (Exception ignored) {
                // gone already
            }
        }
        return changed[0];
    }

    // ---------- 0.9.6: picks at Costco stay on their phone (the products never leave it) ----------

    private Set<String> costcoIds() throws Exception {
        // 0.9.7: Costco's products are shared like any shop's: nothing is kept back.
        return new HashSet<>();
    }

    private static JSONArray idList(String s) {
        try {
            return new JSONArray(s == null ? "[]" : s);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** An item sent to another phone goes without its Costco picks (server engine.ts stripCostcoPicks). */
    void stripCostcoPicks(JSONObject data) throws Exception {
        Set<String> gone = costcoIds();
        if (gone.isEmpty()) return;
        // 0.9.6 (review L2): only the Costco part goes. A usual pick at Costco is left out of the record
        // altogether (items are updated in place), so every other phone keeps its own usual pick; lists
        // without a Costco product in them go as they are (null stays null).
        String usual = str(data, "usual_product_id");
        if (usual != null && gone.contains(usual)) data.remove("usual_product_id");
        for (String col : new String[] { "same_product_ids", "alt_product_ids" }) {
            JSONArray a = idList(str(data, col));
            JSONArray out = new JSONArray();
            for (int i = 0; i < a.length(); i++) if (!gone.contains(a.optString(i))) out.put(a.optString(i));
            if (out.length() != a.length()) data.put(col, out.toString());
        }
    }

    /** An item that came in keeps this phone's own Costco picks (what the sender has never had). */
    void keepLocalCostcoPicks(String pk, JSONObject row) throws Exception {
        Set<String> mine = costcoIds();
        if (mine.isEmpty()) return;
        List<JSONObject> cur = db.query("SELECT usual_product_id, same_product_ids, alt_product_ids FROM items WHERE id = ?", pk);
        if (cur.isEmpty()) return;
        JSONObject c = cur.get(0);
        String usual = str(c, "usual_product_id");
        if (usual != null && mine.contains(usual) && str(row, "usual_product_id") == null) row.put("usual_product_id", usual);
        for (String col : new String[] { "same_product_ids", "alt_product_ids" }) {
            if (!row.has(col)) continue; // not sent: what is here stays (items are updated in place)
            JSONArray theirs = idList(str(row, col));
            Set<String> have = new HashSet<>();
            for (int i = 0; i < theirs.length(); i++) have.add(theirs.optString(i));
            JSONArray local = idList(str(c, col));
            for (int i = 0; i < local.length(); i++) {
                String id = local.optString(i);
                if (mine.contains(id) && !have.contains(id)) theirs.put(id);
            }
            row.put(col, theirs.toString());
        }
    }

    /** 0.9.1: a receipt row's photo paths (its photo, then its pages), only real receipt photo paths. */
    static List<String> photoPaths(JSONObject row) {
        List<String> out = new ArrayList<>();
        if (row == null) return out;
        String p = str(row, "photo");
        if (isPhotoPath(p)) out.add(p);
        String pages = str(row, "pages");
        if (pages != null) {
            try {
                JSONArray a = new JSONArray(pages);
                for (int i = 0; i < a.length(); i++) {
                    String x = a.optString(i, null);
                    if (isPhotoPath(x) && !out.contains(x)) out.add(x);
                }
            } catch (Exception ignored) {
                // not a list
            }
        }
        return out;
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
    /**
     * 0.9.6 (review H1), engine.ts resendCostcoLines: once, list lines an earlier 0.9.6 build kept back
     * because they were at Costco go out again (as "Any shop", stripCostcoLine), with the change that
     * was kept back, so the others catch up with ticks and edits made since.
     */
    void resendCostcoLines() throws Exception {
        if (meta("costco_lines") != null) return;
        db.transaction(() -> {
            for (JSONObject r : db.query("SELECT id FROM list_entries WHERE chain = 'costco' OR product LIKE '%\"chain\":\"costco\"%'"))
                db.exec("UPDATE sync_log SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log) WHERE tbl = 'list_entries' AND pk = ? AND deleted = 0", r.getString("id"));
            setMeta("costco_lines", "1");
        });
    }

    /** 0.9.6 (review H1): a list line at Costco, or with a Costco product behind it (made by an earlier 0.9.6 build). */
    static boolean isCostcoLine(JSONObject row) {
        if (!LOCAL_ONLY) return false; // 0.9.7: a line at Costco is shared as it is
        if (row == null) return false;
        if ("costco".equals(str(row, "chain"))) return true;
        String p = str(row, "product");
        if (p == null) return false;
        try {
            return "costco".equals(new JSONObject(p).optString("chain", ""));
        } catch (Exception ex) {
            return false;
        }
    }

    /** engine.ts stripCostcoLine: a Costco list line goes as "Any shop": no Costco shop, price or product leaves the phone. */
    static void stripCostcoLine(JSONObject data) throws Exception {
        if (!isCostcoLine(data)) return;
        data.put("chain", JSONObject.NULL);
        data.put("price", JSONObject.NULL);
        data.put("product", JSONObject.NULL);
    }

    /**
     * engine.ts keepLocalCostcoLine: a change from another phone to a line this phone has at Costco
     * keeps this phone's own Costco shop, price and product when the other phone left the shop as
     * "Any shop" (all it could see) and the words are the same. A shop they picked, or new words, win.
     */
    static void keepLocalCostcoLine(JSONObject cur, JSONObject merged) throws Exception {
        if (!isCostcoLine(cur)) return;
        if (str(merged, "chain") != null || str(merged, "product") != null || !merged.isNull("price")) return;
        if (!merged.optString("text", "").equals(cur.optString("text", ""))) return;
        for (String k : new String[] { "chain", "price", "product" }) merged.put(k, cur.isNull(k) ? JSONObject.NULL : cur.opt(k));
    }

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
            keepLocalCostcoLine(cur, merged);
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
        String origin = had.isNull("origin") ? null : had.optString("origin", null);
        if (!ours) logEntry("list_entries", pk, stamp, e.optString("device", ""), false, null, e.optLong("created", 0), origin);
        else logEntry("list_entries", pk, Math.max(stamp, had.getLong("stamp")) + 1, device(), false, null, Math.max(e.optLong("created", 0), had.optLong("created", 0)), origin);
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
        // 0.9.5: the General list goes with the groceries.
        if (tabs.contains("pantry")) {
            in.append(in.length() == 0 ? "?" : ", ?");
            args.add("general");
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
            // 0.9.3: and the household's settings (the new household's come with the first sync).
            if (SharedSettings.hasTable(this)) db.exec("DELETE FROM " + SharedSettings.TABLE);
            db.exec("DELETE FROM sync_log");
            db.exec("DELETE FROM sync_peers");
            if (hasOrigin()) db.exec("DELETE FROM sync_held");
            // What's left counts as this phone's own, changed now, so it can still be shared later.
            long now = System.currentTimeMillis();
            String me = device();
            for (String[] t : TABLES) {
                if ("household".equals(t[0]) || SharedSettings.TABLE.equals(t[0])) continue;
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
                // 0.9.1: asking for what's after N means it has everything up to N.
                setSeen(peer, req.optLong("since", 0));
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
                setSeen(peer, req.optLong("seen", 0));
                res.put("changed", n);
                return res;
            }
            case "seen":
                // 0.9.1: how far the other phone got through this one's changes, after it pulled.
                setSeen(peer, req.optLong("seen", 0));
                return res;
            case "photo":
                return photoFor(req, res);
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
        /** 0.9.1: receipt photos that came across. */
        int photos;
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
        // 0.9.1: how far it has got through this phone's changes.
        setSeen(peer, h.optLong("got", 0));

        // 0.9.0: just updated: look at the whole household record afresh (once).
        if (modern && "1".equals(meta("rehousehold"))) {
            JSONObject all = new JSONObject();
            all.put("op", "household");
            all.put("device", me);
            all.put("to", peer);
            r.received += apply(send(t, all, true).optJSONArray("entries"));
            setMeta("rehousehold", null);
        }

        // 0.9.5 (review): read again once after the update (catchUpLists), up to where this phone had
        // got: only the General lines it never had (catchUpEntries). Where it had got stays, so what's
        // newer comes in below as always.
        String catchUp = meta("catchup_peer:" + peer);
        if (catchUp != null) {
            long upTo = Long.parseLong(catchUp.matches("\\d{1,18}") ? catchUp : "0");
            long at = 0;
            for (int guard = 0; guard < 10000 && at < upTo; guard++) {
                JSONObject pull = new JSONObject();
                pull.put("op", "pull");
                pull.put("device", me);
                pull.put("since", at);
                pull.put("tabs", tabsJson(mine));
                if (modern) pull.put("to", peer);
                JSONObject got = send(t, pull, modern);
                r.received += apply(catchUpEntries(got.optJSONArray("entries")));
                long top = got.optLong("top", at);
                if (top <= at || !got.optBoolean("more", false)) break;
                at = top;
            }
            setMeta("catchup_peer:" + peer, null);
        }

        long since = 0;
        for (int round = 0; round < 2; round++) {
            since = gotFrom(r.peer);
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
            // 0.9.1: what just came in made the household share more (a tab, or receipts): what was
            // passed over a moment ago comes across now, rather than at the next sync.
            if (round > 0 || !noteTabs()) break;
            mine = tabs();
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
            push.put("seen", since);
            if (modern) push.put("to", peer);
            send(t, push, modern);
            r.sent += c.getJSONArray("entries").length();
            theirs = top;
            setSeen(peer, top);
            if (!c.getBoolean("more")) break;
        }
        markSynced(r.peer, now);
        if (modern) {
            // 0.9.1: tell it how far this phone got (an older phone doesn't know "seen": that's fine).
            try {
                JSONObject seen = new JSONObject();
                seen.put("op", "seen");
                seen.put("device", me);
                seen.put("to", peer);
                seen.put("seen", since);
                send(t, seen, true);
            } catch (Exception older) {
                // a phone on 0.9.0
            }
            r.photos = fetchPhotos(t, peer, mine);
        }
        return r;
    }

    // ---------- 0.9.1: receipt photos, over the Wi-Fi only ----------

    /** The receipt that has this photo, if this phone shares it with a phone sharing `allowed` tabs. */
    private JSONObject receiptWith(String path, Set<String> allowed) throws Exception {
        if (!isPhotoPath(path) || !shareReceipts()) return null;
        String id = path.substring("receipts/".length(), path.length() - ".jpg".length()).replaceFirst("-[0-9]+$", "");
        // The photo's own receipt first (receipts/<id>.jpg, receipts/<id>-2.jpg), then any other that lists it.
        List<JSONObject> rows = new ArrayList<>(db.query("SELECT * FROM receipts WHERE id = ?", id));
        rows.addAll(db.query("SELECT * FROM receipts WHERE photo = ? OR pages LIKE ?", path, "%\"" + path + "\"%"));
        for (JSONObject row : rows) {
            if (row.optString("id").startsWith("demo-") || !photoPaths(row).contains(path)) continue;
            String tab = tabOf("receipts", row);
            if (tab != null && !allowed.contains(tab)) continue;
            return row;
        }
        return null;
    }

    /** Answers "photo": a receipt photo this pair shares, at most MAX_PHOTO bytes. */
    private JSONObject photoFor(JSONObject req, JSONObject res) throws Exception {
        String path = req.optString("path", "");
        Set<String> allowed = tabs();
        Set<String> theirs = parseTabs(req.optJSONArray("tabs"));
        if (theirs != null) allowed.retainAll(theirs);
        if (photos == null || receiptWith(path, allowed) == null) return res.put("error", "That photo isn't shared.");
        long size = photos.size(path);
        if (size < 0) return res.put("missing", true);
        if (size > MAX_PHOTO) return res.put("tooBig", true);
        byte[] data = photos.read(path);
        if (data == null) return res.put("missing", true);
        if (data.length > MAX_PHOTO) return res.put("tooBig", true);
        res.put("path", path);
        res.put("data", java.util.Base64.getEncoder().encodeToString(data));
        return res;
    }

    /** Is this a JPEG (what Restock saves receipt photos as)? */
    static boolean jpeg(byte[] b) {
        return b != null && b.length > 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff;
    }

    /**
     * After a Wi-Fi sync: the photos of shared receipts that aren't on this phone yet, from the
     * other phone (a few at a time). A receipt shows without its photo until it's here.
     */
    int fetchPhotos(Transport t, String peer, Set<String> mine) throws Exception {
        if (photos == null || !shareReceipts()) return 0;
        int got = 0, asked = 0;
        for (JSONObject row : db.query("SELECT * FROM receipts ORDER BY scanned_at DESC")) {
            String tab = tabOf("receipts", row);
            if (tab != null && !mine.contains(tab)) continue;
            for (String path : photoPaths(row)) {
                if (photos.size(path) >= 0) continue;
                // 0.9.2: moved to the Restock server on purpose (ServerOffload): not fetched back.
                if (meta("photo_off:" + path) != null) continue;
                if (asked++ >= PHOTOS_PER_SYNC) return got;
                JSONObject m = new JSONObject();
                m.put("op", "photo");
                m.put("device", device());
                m.put("to", peer);
                m.put("path", path);
                m.put("tabs", tabsJson(mine));
                JSONObject res;
                try {
                    res = send(t, m, true);
                } catch (Exception no) {
                    // An older phone, or not shared there: try the next one.
                    if (String.valueOf(no.getMessage()).contains("unknown")) return got;
                    continue;
                }
                if (res.has("error") || !path.equals(res.optString("path", ""))) {
                    if ("unknown".equals(res.optString("error"))) return got;
                    continue;
                }
                String data = res.optString("data", "");
                if (data.isEmpty() || data.length() > (MAX_PHOTO / 3 + 1) * 4) continue;
                byte[] b;
                try {
                    b = java.util.Base64.getDecoder().decode(data);
                } catch (IllegalArgumentException bad) {
                    continue;
                }
                if (b.length > MAX_PHOTO || !jpeg(b)) continue;
                photos.write(path, b);
                got++;
            }
        }
        return got;
    }

    // ---------- 0.9.1: tidying sync_log ----------

    /**
     * Removes deletes (tombstones) older than 90 days that every other phone in the household has
     * seen, so sync_log doesn't keep growing. Never one a phone in the household hasn't seen; never
     * the household's own (few, and they decide who's in it); cards and receipts only while they're
     * shared (turning sharing on sends them all again). The highest change number stays, so it never
     * goes back down. Returns how many went.
     */
    int compact(long now) throws Exception {
        String me = device();
        long top = db.query("SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log").get(0).optLong("top", 0);
        long upTo = top;
        for (JSONObject m : db.query("SELECT k FROM household WHERE k LIKE 'member:%'")) {
            String d = m.getString("k").substring("member:".length());
            if (d.equals(me)) continue;
            upTo = Math.min(upTo, seenBy(d));
        }
        if (upTo <= 0) return 0;
        final long limit = upTo;
        StringBuilder skip = new StringBuilder("'_seq', 'household'");
        if (!shareCards()) skip.append(", 'cards'");
        if (!shareReceipts()) skip.append(", 'receipts'");
        final String where = "deleted = 1 AND tbl NOT IN (" + skip + ") AND stamp < ? AND seq <= ?";
        final long before = now - COMPACT_AFTER_MS;
        final int[] gone = { 0 };
        db.transaction(() -> {
            gone[0] = db.query("SELECT COUNT(*) AS n FROM sync_log WHERE " + where, before, limit).get(0).optInt("n", 0);
            if (gone[0] == 0) return;
            // A marker that keeps the highest number (as forget() does), in case the newest note goes.
            db.exec("INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq) VALUES ('_seq', 'floor', 0, '', 1, ?)", top);
            db.exec("DELETE FROM sync_log WHERE " + where, before, limit);
        });
        return gone[0];
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
