package family.plenty.restock;

import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.3: this phone's own settings, in a few words, for the Restock server's web app (Settings →
 * Phones: "Change this on <phone>"). Only in the phone's file on a Restock server (SyncFolder), not a
 * picked folder's or WebDAV's.
 *
 * Built from an allow-list: every field is read on its own and written as a number, a yes/no, or a
 * text that has to be one of a few known kinds (a version, a time of day, an ISO time, a choice, a
 * Home Assistant list id). Nothing is copied over whole, so no address, password, sign-in, email,
 * card number, store number, area, backup folder or token can get in, whatever the settings hold.
 * The web checks it again (src/lib/phoneSummary.ts cleanSummary); docs/server-protocol.md lists it.
 *
 * No Android classes here, so it's tested on a computer (tools/sync-test).
 */
final class PhoneSummary {
    /** This phone's Restock version (SyncHub sets it from the app's package). */
    static volatile String appVersion;

    private static final Pattern VERSION = Pattern.compile("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(-[a-z0-9]{1,12})?");
    private static final Pattern TIME_OF_DAY = Pattern.compile("([01]?\\d|2[0-3]):[0-5]\\d");
    private static final Pattern ISO = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})");
    private static final Pattern ENTITY = Pattern.compile("todo\\.[a-z0-9_]{1,80}");

    private PhoneSummary() {}

    /** This phone's summary, from its database. */
    static JSONObject of(SyncEngine e) throws Exception {
        JSONObject settings = kv(e, "settings");
        JSONObject ha = kv(e, "homeAssistant");
        JSONObject last = kv(e, "lastCheckInfo");
        int cards = 0;
        try {
            cards = e.db.query("SELECT COUNT(*) AS n FROM cards").get(0).optInt("n", 0);
        } catch (Exception ignored) {
            // no cards table yet
        }
        return build(settings, ha, last, cards, e.tabs(), away(e), appVersion);
    }

    /** What sync away from home goes through, besides Wi-Fi: a folder, WebDAV, Nextcloud, only the Restock server, or none. */
    static String away(SyncEngine e) throws Exception {
        String f = e.meta("folder");
        if (f == null) return e.meta("server_dev_priv") != null ? "server" : "none";
        if (!f.startsWith("https://") && !f.startsWith("http://")) return "folder";
        return "nextcloud".equals(e.meta("dav_kind")) ? "nextcloud" : "webdav";
    }

    private static JSONObject kv(SyncEngine e, String key) {
        try {
            List<JSONObject> r = e.db.query("SELECT value FROM kv WHERE key = ?", key);
            return r.isEmpty() ? null : new JSONObject(r.get(0).getString("value"));
        } catch (Exception ex) {
            return null;
        }
    }

    private static JSONObject o(JSONObject s, String k) {
        JSONObject x = s == null ? null : s.optJSONObject(k);
        return x == null ? new JSONObject() : x;
    }

    private static boolean bool(JSONObject s, String k, boolean d) {
        Object v = s == null ? null : s.opt(k);
        return v instanceof Boolean ? (Boolean) v : d;
    }

    private static Integer whole(JSONObject s, String k, int min, int max, Integer d) {
        Object v = s == null ? null : s.opt(k);
        if (!(v instanceof Number)) return d;
        double x = ((Number) v).doubleValue();
        if (x != Math.rint(x) || x < min || x > max) return d;
        return (int) x;
    }

    private static String text(JSONObject s, String k, Pattern p) {
        Object v = s == null ? null : s.opt(k);
        return v instanceof String && ((String) v).length() <= 40 && p.matcher((String) v).matches() ? (String) v : null;
    }

    private static String textLabel(JSONObject a11y) {
        Object v = a11y.opt("text");
        double t = v instanceof Number ? ((Number) v).doubleValue() : 1;
        if (t >= 1.4) return "Largest";
        if (t >= 1.22) return "Larger";
        if (t >= 1.07) return "Large";
        return "Normal";
    }

    /** The summary itself, from the settings and the rest (only these fields, see the top). */
    static JSONObject build(JSONObject s, JSONObject ha, JSONObject last, int cards, java.util.Set<String> tabs, String away, String version) throws Exception {
        if (s == null) s = new JSONObject();
        JSONObject out = new JSONObject();
        out.put("v", 1);
        if (version != null && VERSION.matcher(version).matches()) out.put("version", version);

        JSONObject checks = new JSONObject();
        int every = whole(s, "checkIntervalHours", 1, 24 * 31, 12);
        checks.put("everyHours", every);
        if (every >= 168) checks.put("weekday", whole(s, "checkWeekday", 0, 6, 3));
        checks.put("background", bool(o(s, "sync"), "backgroundActivity", true));
        String lastAt = text(s, "lastCheck", ISO);
        if (lastAt != null) checks.put("lastAt", lastAt);
        Integer items = last == null ? null : whole(last, "checked", 0, 1_000_000, null);
        if (items != null && lastAt != null && lastAt.equals(text(last, "at", ISO))) checks.put("lastItems", items);
        out.put("checks", checks);

        JSONObject al = o(s, "alerts");
        JSONObject n = new JSONObject();
        n.put("catalogueDay", bool(al, "catalogueDay", true));
        n.put("catalogueWeekday", whole(al, "catalogueWeekday", 0, 6, 3));
        n.put("daily", bool(al, "daily", false));
        String daily = text(al, "dailyTime", TIME_OF_DAY);
        if (daily != null) n.put("dailyTime", daily);
        n.put("greatDeals", bool(al, "greatDeals", true));
        n.put("monthly", bool(al, "monthly", false));
        n.put("stockUp", bool(al, "stockUp", false));
        n.put("stockUpTips", bool(al, "stockUpTips", true));
        out.put("notifications", n);

        JSONObject acc = o(s, "accounts");
        out.put("accounts", new JSONObject().put("woolworths", bool(o(acc, "woolworths"), "signedIn", false)).put("coles", bool(o(acc, "coles"), "signedIn", false)));
        out.put("cards", Math.max(0, Math.min(cards, 10_000)));

        JSONObject ab = o(s, "autoBackup");
        JSONObject backups = new JSONObject();
        backups.put("on", bool(ab, "enabled", false));
        backups.put("everyDays", whole(ab, "everyDays", 1, 366, 7));
        backups.put("keep", whole(ab, "keep", 1, 1000, 5));
        String backupAt = text(ab, "lastAt", ISO);
        if (backupAt != null) backups.put("lastAt", backupAt);
        backups.put("photos", bool(ab, "receiptPhotos", true));
        out.put("backups", backups);

        out.put("historyWeeks", whole(s, "historyWeeks", 1, 520, 8));
        JSONArray t = new JSONArray();
        for (String x : SyncEngine.ALL_TABS) if (tabs != null && tabs.contains(x)) t.put(x);
        out.put("tabs", t);
        if (away != null && java.util.Arrays.asList("none", "folder", "webdav", "nextcloud", "server").contains(away)) out.put("away", away);

        JSONObject h = new JSONObject();
        h.put("on", ha != null && bool(ha, "enabled", false));
        String entity = text(ha, "entity", ENTITY);
        if (entity != null) h.put("entity", entity);
        out.put("homeAssistant", h);

        Object theme = s.opt("theme");
        out.put("look", new JSONObject().put("theme", "light".equals(theme) || "dark".equals(theme) ? theme : "system").put("text", textLabel(o(s, "a11y"))));
        out.put("receipts", bool(o(s, "receipts"), "enabled", false));
        out.put("sharedPrices", bool(o(s, "marketData"), "enabled", false));
        JSONObject up = o(s, "updates");
        out.put("updates", new JSONObject().put("on", bool(up, "notify", false)).put("everyDays", whole(up, "everyDays", 7, 7, null) != null ? 7 : 1));
        return out;
    }
}
