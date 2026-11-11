package family.plenty.restock;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.3: household-wide settings, the synced household_settings table (one row per setting, k and
 * a JSON v). The phones' twin of src/lib/sharedSettings.ts, which says what each row is; change
 * both together (tools/sync-test web-parity checks they agree).
 *
 * - Which shops each shared tab uses (shop:&lt;chain&gt; and, for shops people added, their name and
 *   website), the tab switched on (tab:keg, tab:pharmacy), Shop around, the alert level, recalls,
 *   the list's cheapest and the order of products. The branches and store numbers stay each phone's.
 * - The later change wins per row (SyncEngine's usual rule). Anyone in the household may change one.
 * - Applied to the phone's stored settings (kv "settings") as they arrive, for the tabs this phone
 *   syncs only, so the background price check and the screens both follow.
 * - The owner phone seeds them from its own settings once per setting (rows that aren't there
 *   yet), as the oldest possible change (stamp 1): any real change, on any phone, wins over it,
 *   and the other phones' own (drifted) settings never seed anything.
 * - The same table carries the shopping list's own rows, which aren't settings (src/lib/listPicks.ts,
 *   checked by sharedSettings.ts checkListRow): alias:&lt;words&gt; ("Always use this for milk"),
 *   keep:&lt;line id&gt; ("Keep it as just milk") and ha:phone (the one phone that syncs with Home
 *   Assistant). They sync like any row; apply passes over them (checkValue says no), so they never
 *   change the settings. A phone that leaves keeps its alias: and keep: rows (they're about its own
 *   items and lines). Phones on 0.9.2 or older never see the table at all. Another device's change
 *   to the table is only taken in when it's right (acceptable below, the same as sharedSettings.ts
 *   settingChangeOk): those rows exactly as Restock writes them, nothing huge, and no flood.
 *
 * No Android classes here, so it's tested on a computer (tools/sync-test).
 */
final class SharedSettings {
    static final String TABLE = "household_settings";
    /** The rows a phone keeps when it leaves the household (see above): SQL for them. */
    static final String KEPT_ON_LEAVING = "(k LIKE 'alias:%' OR k LIKE 'keep:%')";
    static final String[] SCALARS = { "shopAroundMin", "defaultThresholdPct", "listCompare", "productOrder", "recalls.enabled" };
    static final List<String> DEFAULT_CHAINS = Arrays.asList("woolworths", "coles", "aldi");
    private static final Pattern CUSTOM_ID = Pattern.compile("custom-[A-Za-z0-9_-]{1,40}");
    private static final Pattern ORIGIN = Pattern.compile("^https?://[^\\s/?#]+", Pattern.CASE_INSENSITIVE);
    private static final Set<String> TABS = new HashSet<>(Arrays.asList(SyncEngine.ALL_TABS));

    private SharedSettings() {}

    /** A built-in shop (not one people added). */
    static boolean builtIn(String id) {
        // 0.9.6: Costco is one phone's own (shops.ts LOCAL_ONLY_SHOPS), never a household shop.
        return id != null && !id.startsWith("custom-") && Shops.known(id) && !"costco".equals(id);
    }

    /** The built-in shops on a tab, sorted. */
    static List<String> builtInsOn(String tab) {
        List<String> out = new ArrayList<>();
        for (String id : Shops.ids()) if (builtIn(id) && tab.equals(Shops.section(id))) out.add(id);
        return out;
    }

    static Object decode(String v) {
        if (v == null) return null;
        try {
            return new JSONArray("[" + v + "]").get(0);
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isNumber(Object v) {
        return v instanceof Number && !Double.isNaN(((Number) v).doubleValue()) && !Double.isInfinite(((Number) v).doubleValue());
    }

    /** Endings where the site's name is the part before them (src/lib/site.ts TWO_PART_ENDINGS). */
    private static final Set<String> TWO_PART_ENDINGS = new HashSet<>(Arrays.asList(
        "com.au", "net.au", "org.au", "asn.au", "id.au", "edu.au", "gov.au", "co.nz", "net.nz", "org.nz", "co.uk", "org.uk", "ac.uk", "com.sg", "com.hk", "co.jp"));

    /** The registrable domain of a host (src/lib/site.ts siteOf): "shop.example.com.au" is "example.com.au". */
    static String siteOf(String host) {
        String h = host.toLowerCase(java.util.Locale.ROOT).replaceFirst("\\.$", "");
        if (h.matches("[\\d.]+") || h.contains(":") || !h.contains(".")) return h;
        String[] parts = h.split("\\.", -1);
        int n = parts.length;
        if (n <= 2) return h;
        String two = parts[n - 2] + "." + parts[n - 1];
        return TWO_PART_ENDINGS.contains(two) ? parts[n - 3] + "." + two : two;
    }

    /**
     * The host of an address a shop row may carry (lower case, without its port), or null: not
     * http(s), a sign-in part (user@), or no dot in it (sharedSettings.ts hostOf).
     */
    static String hostOf(String url) {
        Matcher m = ORIGIN.matcher(url);
        if (!m.find()) return null;
        String auth = m.group().replaceFirst("(?i)^https?://", "");
        if (auth.indexOf('@') >= 0) return null;
        String host = auth.replaceFirst(":\\d*$", "").toLowerCase(java.util.Locale.ROOT);
        return host.contains(".") ? host : null;
    }

    /** A shop someone added, as a row carries it, checked (sharedSettings.ts checkShop), or null. */
    static JSONObject checkShop(Object v, String id) {
        if (!(v instanceof JSONObject) || id == null || !CUSTOM_ID.matcher(id).matches()) return null;
        JSONObject o = (JSONObject) v;
        if (!id.equals(o.opt("id"))) return null;
        String name = o.opt("name") instanceof String ? ((String) o.opt("name")).trim() : "";
        String website = o.opt("website") instanceof String ? ((String) o.opt("website")).trim() : "";
        Object sec = o.opt("section");
        String host = hostOf(website);
        if (name.isEmpty() || name.length() > 80 || website.isEmpty() || website.length() > 500 || host == null || !(sec instanceof String) || !TABS.contains(sec)) return null;
        if (website.regionMatches(true, 0, "http://", 0, 7)) website = "https://" + website.substring(7);
        // Its search page only on its own site (the same site, so www. or search. of it too), with {q}.
        String search = null;
        if (o.opt("search") instanceof String) {
            String s = ((String) o.opt("search")).trim();
            String sh = s.length() <= 500 && s.contains("{q}") ? hostOf(s) : null;
            if (sh != null && siteOf(sh).equals(siteOf(host))) search = s.regionMatches(true, 0, "http://", 0, 7) ? "https://" + s.substring(7) : s;
        }
        Object c = o.opt("createdAt");
        String createdAt = c instanceof String && ((String) c).length() <= 40 ? (String) c : "";
        try {
            JSONObject out = new JSONObject();
            out.put("id", id);
            out.put("name", name);
            out.put("website", website);
            out.put("section", sec);
            if (search != null) out.put("search", search);
            out.put("createdAt", createdAt);
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    static boolean sameShop(JSONObject a, JSONObject b) {
        for (String f : new String[] { "id", "name", "website", "section", "search", "createdAt" }) {
            Object x = a.isNull(f) ? null : a.opt(f), y = b.isNull(f) ? null : b.opt(f);
            if (x == null ? y != null : !x.equals(y)) return false;
        }
        return true;
    }

    static final String BRANCH_PREFIX = "branch:";
    private static final Pattern STORE_NO = Pattern.compile("[A-Za-z0-9 _-]{1,16}");

    /** 0.9.4: a branch:<chain> row's value (the household's default branch), checked (sharedSettings.ts checkBranch), or null. */
    static JSONObject checkBranch(String k, Object v) {
        if (k == null || !k.startsWith(BRANCH_PREFIX)) return null;
        String id = k.substring(BRANCH_PREFIX.length());
        if (!builtIn(id) && !CUSTOM_ID.matcher(id).matches()) return null;
        if (!(v instanceof JSONObject) || !(((JSONObject) v).opt("name") instanceof String)) return null;
        JSONObject o = (JSONObject) v;
        String name = o.optString("name").trim();
        if (name.isEmpty() || name.length() > 80 || name.matches("(?s).*[\\u0000-\\u001f\\u007f].*")) return null;
        try {
            Object no = o.isNull("storeNo") ? null : o.opt("storeNo");
            if (no == null) return new JSONObject().put("name", name);
            return no instanceof String && STORE_NO.matcher((String) no).matches() ? new JSONObject().put("name", name).put("storeNo", no) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** A setting's value as it may be applied (sharedSettings.ts checkValue), or null. */
    static Object checkValue(String k, Object v) {
        switch (k) {
            case "shopAroundMin":
                return isNumber(v) && ((Number) v).doubleValue() >= 0 && ((Number) v).doubleValue() <= 1000 ? v : null;
            case "defaultThresholdPct":
                return isNumber(v) && ((Number) v).doubleValue() >= 1 && ((Number) v).doubleValue() <= 90 ? v : null;
            case "listCompare":
                return "unit".equals(v) || "price".equals(v) ? v : null;
            case "productOrder":
                return "size".equals(v) || "cheapest".equals(v) || "name".equals(v) ? v : null;
            case "recalls.enabled":
            case "tab:keg":
            case "tab:pharmacy":
                return v instanceof Boolean ? v : null;
            default:
                break;
        }
        if (k.startsWith(BRANCH_PREFIX)) return checkBranch(k, v);
        if (!k.startsWith("shop:") || !(v instanceof JSONObject) || !(((JSONObject) v).opt("on") instanceof Boolean)) return null;
        JSONObject o = (JSONObject) v;
        String id = k.substring(5);
        boolean on = o.optBoolean("on");
        try {
            if (builtIn(id)) return new JSONObject().put("on", on);
            JSONObject shop = checkShop(o.opt("shop"), id);
            if (shop == null) return null;
            if (Boolean.TRUE.equals(o.opt("removed"))) return new JSONObject().put("on", false).put("removed", true).put("shop", shop);
            return new JSONObject().put("on", on).put("shop", shop);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------- the shopping list's rows, and what another device's change may be ----------

    static final String ALIAS_PREFIX = "alias:";
    static final String KEEP_PREFIX = "keep:";
    static final String HA_PHONE = "ha:phone";
    private static final Pattern ROW_ID = Pattern.compile("[A-Za-z0-9_-]{1,80}");
    private static final Pattern WORDS = Pattern.compile("[\\p{L}\\p{N}\\p{M}]+(?: [\\p{L}\\p{N}\\p{M}]+)*");
    /** The longest key, and value (its JSON text), a row may have (sharedSettings.ts ROW_KEY_MAX, ROW_VALUE_MAX). */
    static final int ROW_KEY_MAX = 200;
    static final int ROW_VALUE_MAX = 4000;
    /** How many alias: rows, and keep: rows, a phone takes in; and rows in all (sharedSettings.ts). */
    static final int LIST_ROWS_MAX = 2000;
    static final int ROWS_MAX = 5000;

    static boolean isListRow(String k) {
        return k.startsWith(ALIAS_PREFIX) || k.startsWith(KEEP_PREFIX) || k.equals(HA_PHONE);
    }

    /** A shopping-list row's value as it may be used (sharedSettings.ts checkListRow): a String, TRUE, or null. */
    static Object checkListRow(String k, Object v) {
        if (k.startsWith(ALIAS_PREFIX)) {
            String words = k.substring(ALIAS_PREFIX.length());
            if (words.isEmpty() || words.length() > 80 || !WORDS.matcher(words).matches() || !words.equals(words.toLowerCase(java.util.Locale.ROOT))) return null;
            return v instanceof String && ROW_ID.matcher((String) v).matches() && !((String) v).startsWith("demo-") ? v : null;
        }
        if (k.startsWith(KEEP_PREFIX)) {
            String id = k.substring(KEEP_PREFIX.length());
            return ROW_ID.matcher(id).matches() && !id.startsWith("demo-") && Boolean.TRUE.equals(v) ? Boolean.TRUE : null;
        }
        if (k.equals(HA_PHONE)) return v instanceof String && ROW_ID.matcher((String) v).matches() && !((String) v).startsWith("web-") ? v : null;
        return null;
    }

    /** The table as it is during one apply, counted once (sharedSettings.ts SettingsRoom). */
    static final class Room {
        private final SyncEngine e;
        private final java.util.Map<String, Integer> counts = new java.util.HashMap<>();

        Room(SyncEngine e) {
            this.e = e;
        }

        boolean has(String k) throws Exception {
            return !e.db.query("SELECT 1 FROM " + TABLE + " WHERE k = ?", k).isEmpty();
        }

        int count(String prefix) throws Exception {
            Integer n = counts.get(prefix);
            if (n == null) {
                n = e.db.query("SELECT COUNT(*) AS n FROM " + TABLE + " WHERE substr(k, 1, ?) = ?", prefix.length(), prefix).get(0).optInt("n", 0);
                counts.put(prefix, n);
            }
            return n;
        }

        void added(String k) {
            for (java.util.Map.Entry<String, Integer> c : counts.entrySet()) if (k.startsWith(c.getKey())) c.setValue(c.getValue() + 1);
        }
    }

    /**
     * 0.9.3: whether a change to the table from another device is taken in (sharedSettings.ts
     * settingChangeOk, line by line): sensible sizes; the shopping list's rows only exactly as
     * Restock writes them; and new rows only up to the limits (a row already there can always
     * change, and a delete always goes). Rows this version doesn't know still come across.
     */
    static boolean acceptable(Room room, String pk, JSONObject row, boolean deleted) throws Exception {
        if (pk == null || pk.isEmpty() || pk.length() > ROW_KEY_MAX) return false;
        boolean list = isListRow(pk);
        if (list && !pk.equals(HA_PHONE) && checkListRow(pk, pk.startsWith(KEEP_PREFIX) ? Boolean.TRUE : "x") == null) return false;
        if (deleted) return true;
        if (row == null || !pk.equals(row.opt("k")) || !(row.opt("v") instanceof String)) return false;
        String v = (String) row.opt("v");
        if (v.length() > ROW_VALUE_MAX) return false;
        if (list) {
            Object ok = checkListRow(pk, decode(v));
            if (ok == null || !v.equals(ok instanceof String ? JSONObject.quote((String) ok) : "true")) return false;
        }
        // 0.9.4: a default branch only of the right shape.
        if (pk.startsWith(BRANCH_PREFIX) && checkBranch(pk, decode(v)) == null) return false;
        if (room.has(pk)) return true;
        String kind = pk.startsWith(ALIAS_PREFIX) ? ALIAS_PREFIX : pk.startsWith(KEEP_PREFIX) ? KEEP_PREFIX : "";
        if ((!kind.isEmpty() && room.count(kind) >= LIST_ROWS_MAX) || room.count("") >= ROWS_MAX) return false;
        room.added(pk);
        return true;
    }

    /** Which tab a row is about (tab: and shop: rows), or null when it's the whole household's. */
    static String tabOf(String k, String v) {
        if (k == null) return null;
        if (k.startsWith("tab:")) return k.substring(4);
        // 0.9.4: a default branch is about its shop's tab (a shop someone added: left alone).
        if (k.startsWith(BRANCH_PREFIX)) {
            String b = k.substring(BRANCH_PREFIX.length());
            return builtIn(b) ? Shops.section(b) : "unknown";
        }
        if (!k.startsWith("shop:")) return null;
        String id = k.substring(5);
        if (builtIn(id)) return Shops.section(id);
        Object d = decode(v);
        Object shop = d instanceof JSONObject ? ((JSONObject) d).opt("shop") : null;
        Object sec = shop instanceof JSONObject ? ((JSONObject) shop).opt("section") : null;
        return sec instanceof String ? (String) sec : "unknown";
    }

    private static boolean sameNumber(Object a, Object b) {
        if (!isNumber(a) || !isNumber(b)) return a == null ? b == null : a.equals(b);
        return ((Number) a).doubleValue() == ((Number) b).doubleValue();
    }

    /**
     * Applies the rows (sorted by k) to a settings object, for these tabs (sharedSettings.ts
     * applyRows, line by line). Changes it; true when something changed. The Keg tab is only
     * switched on where the phone has said it's 18 or over (adultConfirmed).
     */
    static boolean apply(JSONObject s, List<String[]> rows, Set<String> tabs) throws Exception {
        boolean changed = false;
        List<String[]> sorted = new ArrayList<>(rows);
        sorted.sort((a, b) -> a[0].compareTo(b[0]));
        for (String[] row : sorted) {
            String k = row[0];
            Object val = checkValue(k, decode(row[1]));
            if (val == null) continue;
            String tab = tabOf(k, row[1]);
            if (tab != null && !tabs.contains(tab)) continue;
            if ("recalls.enabled".equals(k)) {
                JSONObject r = s.optJSONObject("recalls");
                boolean now = r != null && r.opt("enabled") instanceof Boolean ? r.getBoolean("enabled") : true;
                if (now != (Boolean) val) {
                    JSONObject next = r == null ? new JSONObject() : new JSONObject(r.toString());
                    next.put("enabled", val);
                    s.put("recalls", next);
                    changed = true;
                }
            } else if (Arrays.asList(SCALARS).contains(k)) {
                Object now = s.isNull(k) ? defaultOf(k) : s.opt(k);
                if (!sameNumber(now, val)) {
                    s.put(k, val);
                    changed = true;
                }
            } else if (k.startsWith("tab:")) {
                // 18+: Keg isn't shown on a phone that hasn't confirmed it (switching it off always applies).
                if ("tab:keg".equals(k) && Boolean.TRUE.equals(val) && !Boolean.TRUE.equals(s.opt("adultConfirmed"))) continue;
                JSONObject sec = s.optJSONObject("sections");
                boolean now = sec != null && Boolean.TRUE.equals(sec.opt(tab));
                if (now != (Boolean) val) {
                    JSONObject next = new JSONObject();
                    next.put("keg", sec != null && Boolean.TRUE.equals(sec.opt("keg")));
                    next.put("pharmacy", sec != null && Boolean.TRUE.equals(sec.opt("pharmacy")));
                    next.put(tab, val);
                    s.put("sections", next);
                    changed = true;
                }
            } else if (k.startsWith(BRANCH_PREFIX)) {
                // 0.9.4: the household's default branch, only where this phone hasn't picked its own.
                String id = k.substring(BRANCH_PREFIX.length());
                JSONObject b = (JSONObject) val;
                JSONObject stores = s.optJSONObject("stores");
                JSONObject cur = stores == null ? null : stores.optJSONObject(id);
                if (cur == null) cur = new JSONObject();
                String primary = cur.isNull("primary") ? "" : cur.optString("primary", "");
                if (primary.isEmpty() || primary.equals(cur.optString("householdBranch", "\u0000"))) {
                    JSONObject next = new JSONObject(cur.toString());
                    next.put("primary", b.getString("name"));
                    next.put("householdBranch", b.getString("name"));
                    String no = b.optString("storeNo", "");
                    String had = cur.isNull("branchStoreNo") ? "" : cur.optString("branchStoreNo", "");
                    if ("coles".equals(id) && !no.isEmpty() && (had.isEmpty() || had.equals(cur.optString("householdStoreNo", "\u0000")))) {
                        next.put("branchStoreNo", no);
                        next.put("householdStoreNo", no);
                    }
                    if (!sameFields(cur, next)) {
                        JSONObject all = stores == null ? new JSONObject() : new JSONObject(stores.toString());
                        all.put(id, next);
                        s.put("stores", all);
                        changed = true;
                    }
                }
            } else {
                String id = k.substring(5);
                JSONObject x = (JSONObject) val;
                boolean on = x.getBoolean("on");
                JSONArray had = s.optJSONArray("enabledChains");
                List<String> chains = new ArrayList<>();
                if (had != null) {
                    for (int i = 0; i < had.length(); i++) if (had.opt(i) instanceof String) chains.add(had.getString(i));
                } else chains.addAll(DEFAULT_CHAINS);
                if (on && !chains.contains(id)) {
                    chains.add(id);
                    s.put("enabledChains", new JSONArray(chains));
                    changed = true;
                } else if (!on && chains.contains(id)) {
                    chains.remove(id);
                    s.put("enabledChains", new JSONArray(chains));
                    changed = true;
                }
                JSONObject shop = x.optJSONObject("shop");
                if (shop != null) {
                    JSONArray list0 = s.optJSONArray("customShops");
                    List<JSONObject> list = new ArrayList<>();
                    if (list0 != null) for (int i = 0; i < list0.length(); i++) if (list0.opt(i) instanceof JSONObject) list.add(list0.getJSONObject(i));
                    int at = -1;
                    for (int i = 0; i < list.size(); i++) if (id.equals(list.get(i).opt("id"))) {
                        at = i;
                        break;
                    }
                    boolean moved = false;
                    if (x.optBoolean("removed", false)) {
                        if (at >= 0) {
                            list.remove(at);
                            moved = true;
                        }
                    } else if (at < 0) {
                        list.add(shop);
                        moved = true;
                    } else if (!sameShop(list.get(at), shop)) {
                        list.set(at, shop);
                        moved = true;
                    }
                    if (moved) {
                        s.put("customShops", new JSONArray(list));
                        changed = true;
                    }
                }
            }
        }
        return changed;
    }

    /** Two flat objects with the same fields and values (as text). */
    private static boolean sameFields(JSONObject a, JSONObject b) {
        if (a.length() != b.length()) return false;
        for (java.util.Iterator<String> i = a.keys(); i.hasNext(); ) {
            String k = i.next();
            if (!b.has(k) || !String.valueOf(a.opt(k)).equals(String.valueOf(b.opt(k)))) return false;
        }
        return true;
    }

    private static Object defaultOf(String k) {
        switch (k) {
            case "shopAroundMin":
                return 1;
            case "defaultThresholdPct":
                return 10;
            case "listCompare":
                return "unit";
            case "productOrder":
                return "size";
            default:
                return null;
        }
    }

    // ---------- on the phone ----------

    /** Whether this database has the table yet (the app makes it when 0.9.3 first opens). */
    static boolean hasTable(SyncEngine e) {
        try {
            return !e.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", TABLE).isEmpty();
        } catch (Exception ex) {
            return false;
        }
    }

    static JSONObject settings(SyncEngine e) {
        try {
            List<JSONObject> r = e.db.query("SELECT value FROM kv WHERE key = 'settings'");
            return r.isEmpty() ? null : new JSONObject(r.get(0).getString("value"));
        } catch (Exception ex) {
            return null;
        }
    }

    static List<String[]> rows(SyncEngine e) throws Exception {
        List<String[]> out = new ArrayList<>();
        for (JSONObject r : e.db.query("SELECT k, v FROM " + TABLE + " ORDER BY k")) out.add(new String[] { r.getString("k"), r.getString("v") });
        return out;
    }

    /** The household's rows applied to this phone's stored settings, for the tabs it syncs. True when they changed. */
    static boolean applyTo(SyncEngine e) throws Exception {
        if (!hasTable(e)) return false;
        JSONObject s = settings(e);
        if (s == null) return false;
        List<String[]> rows = rows(e);
        if (rows.isEmpty() || !apply(s, rows, e.tabs())) return false;
        e.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", s.toString());
        e.forgetCustomTabs();
        return true;
    }

    /** What a row would say for this setting, from this phone's settings (for seeding), or null. */
    static Object valueOf(JSONObject s, String k) throws Exception {
        if ("recalls.enabled".equals(k)) {
            JSONObject r = s.optJSONObject("recalls");
            return r != null && r.opt("enabled") instanceof Boolean ? r.get("enabled") : Boolean.TRUE;
        }
        if (Arrays.asList(SCALARS).contains(k)) return s.isNull(k) ? defaultOf(k) : s.opt(k);
        if (k.startsWith("tab:")) {
            JSONObject sec = s.optJSONObject("sections");
            return sec != null && Boolean.TRUE.equals(sec.opt(k.substring(4)));
        }
        String id = k.substring(5);
        JSONArray chains = s.optJSONArray("enabledChains");
        boolean on = false;
        if (chains == null) on = DEFAULT_CHAINS.contains(id);
        else for (int i = 0; i < chains.length(); i++) if (id.equals(chains.opt(i))) on = true;
        if (builtIn(id)) return new JSONObject().put("on", on);
        JSONArray list = s.optJSONArray("customShops");
        if (list != null) for (int i = 0; i < list.length(); i++) {
            JSONObject c = list.optJSONObject(i);
            if (c != null && id.equals(c.opt("id"))) {
                JSONObject shop = checkShop(c, id);
                return shop == null ? null : new JSONObject().put("on", on).put("shop", shop);
            }
        }
        return null;
    }

    /** Every household setting this phone's settings have, for the tabs it syncs. */
    static List<String> keysFor(JSONObject s, Set<String> tabs) {
        List<String> out = new ArrayList<>(Arrays.asList(SCALARS));
        for (String t : new String[] { "keg", "pharmacy" }) if (tabs.contains(t)) out.add("tab:" + t);
        for (String t : SyncEngine.ALL_TABS) if (tabs.contains(t)) for (String id : builtInsOn(t)) out.add("shop:" + id);
        JSONArray list = s.optJSONArray("customShops");
        if (list != null) for (int i = 0; i < list.length(); i++) {
            JSONObject c = list.optJSONObject(i);
            if (c == null || !(c.opt("id") instanceof String)) continue;
            String id = c.optString("id");
            if (tabs.contains(c.optString("section")) && checkShop(c, id) != null) out.add("shop:" + id);
        }
        return out;
    }

    /**
     * On the owner phone: every household setting that has no row yet gets one from this phone's
     * settings, as the oldest possible change (stamp 1), so a real change anywhere still wins. Not
     * noted as a change by the triggers ("applying"). Nothing before the app has saved settings.
     * Answers how many rows it wrote.
     */
    static int seed(SyncEngine e) throws Exception {
        String owner = e.householdValue("owner");
        // 0.9.4: in a server's house no phone is the owner; the first phone in a fresh house seeds
        // instead (its join said seed: true, kept as sync_meta seed_settings).
        boolean seeder = owner != null && owner.equals(e.device()) || "1".equals(e.meta("seed_settings"));
        if (!seeder || !hasTable(e)) return 0;
        JSONObject s = settings(e);
        if (s == null) return 0;
        Set<String> have = new HashSet<>();
        for (JSONObject r : e.db.query("SELECT k FROM " + TABLE)) have.add(r.getString("k"));
        // Rows already noted (another phone's, or a delete) count as there too.
        for (JSONObject r : e.db.query("SELECT pk FROM sync_log WHERE tbl = ?", TABLE)) have.add(r.getString("pk"));
        final List<String[]> add = new ArrayList<>();
        for (String k : keysFor(s, e.tabs())) {
            if (have.contains(k)) continue;
            Object v = valueOf(s, k);
            if (v == null || checkValue(k, v) == null) continue;
            add.add(new String[] { k, v instanceof String ? JSONObject.quote((String) v) : String.valueOf(v) });
        }
        if (add.isEmpty()) return 0;
        final String me = e.device();
        e.db.transaction(() -> {
            e.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
            for (String[] r : add) {
                e.db.exec("INSERT OR IGNORE INTO " + TABLE + " (k, v) VALUES (?, ?)", r[0], r[1]);
                e.logEntry(TABLE, r[0], 1, me, false, null, 1);
            }
            e.db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
        return add.size();
    }

    /**
     * A change made on this phone (the Settings screens write rows through the app; the tests and
     * tools use this): the row, noted for sync like any change of this phone's.
     */
    static void set(SyncEngine e, String k, Object v) throws Exception {
        if (checkValue(k, v) == null) throw new IllegalArgumentException("not a value for " + k);
        e.db.exec("INSERT OR REPLACE INTO " + TABLE + " (k, v) VALUES (?, ?)", k, v instanceof String ? JSONObject.quote((String) v) : String.valueOf(v));
        applyTo(e);
    }
}
