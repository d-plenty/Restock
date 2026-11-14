package family.plenty.restock;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.3 sync checks: household-wide settings (SharedSettings) and the phone's settings summary for
 * the web (PhoneSummary). Two phones changing different settings apart both keep their change, a
 * tab a phone doesn't sync is left alone, the owner's settings seed the household once (the
 * members' never do), a phone that leaves keeps its settings, Wi-Fi and the folder both carry them,
 * and nothing secret gets into the summary. Also writes the files for the old-phone check
 * (tools/sync-test/old/OldReader.java). Run by run.sh.
 */
public class SyncTest093 {
    static int fails = 0;
    static final String NOW = SyncFamily.NOW;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + what);
        if (!ok) fails++;
    }

    /** Settings as the app saves them (a realistic part: the shops, the household settings, some of the phone's own). */
    static JSONObject settings(String[] chains, int shopAround, int threshold, String listCompare, boolean keg, int historyWeeks) throws Exception {
        JSONObject s = new JSONObject();
        s.put("onboarded", true);
        s.put("enabledChains", new JSONArray(Arrays.asList(chains)));
        s.put("sections", new JSONObject().put("keg", keg).put("pharmacy", false));
        s.put("customShops", new JSONArray());
        s.put("stores", new JSONObject().put("coles", new JSONObject().put("primary", "Coles Kirwan").put("branchStoreNo", "0844")).put("woolworths", new JSONObject()));
        s.put("shopAroundMin", shopAround);
        s.put("defaultThresholdPct", threshold);
        s.put("listCompare", listCompare);
        s.put("recalls", new JSONObject().put("enabled", true).put("lastCheck", "2026-11-08T00:00:00Z"));
        s.put("historyWeeks", historyWeeks);
        s.put("checkIntervalHours", 12);
        s.put("theme", "dark");
        return s;
    }

    static void put(SyncFamily.Phone p, JSONObject s) throws Exception {
        p.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", s.toString());
    }

    static JSONObject got(SyncFamily.Phone p) throws Exception {
        return new JSONObject(p.one("SELECT value FROM kv WHERE key = 'settings'"));
    }

    static List<String> chains(JSONObject s) {
        List<String> l = new ArrayList<>();
        JSONArray a = s.optJSONArray("enabledChains");
        if (a != null) for (int i = 0; i < a.length(); i++) l.add(a.optString(i));
        return l;
    }

    /** Which shops (the order of enabledChains isn't a setting). */
    static java.util.Set<String> set(List<String> l) {
        return new java.util.TreeSet<>(l);
    }

    static java.util.Set<String> set(String... l) {
        return new java.util.TreeSet<>(Arrays.asList(l));
    }

    static double num(JSONObject s, String k) {
        return s.optDouble(k, Double.NaN);
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        File oldWork = new File(args[0], "old-reader");
        oldWork.mkdirs();
        h1ApartBothKeep();
        h2SeedFromOwner();
        h3UnsharedTab();
        h4CustomShopAndFolder(oldWork);
        h5Leaving();
        h6Summary();
        h7ListRows();
        h8BadRows();
        System.out.println(fails == 0 ? "household settings: all passed" : "household settings: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    /** Two phones change different settings while apart; both keep their change. The same one changed on both: the later wins. */
    static void h1ApartBothKeep() throws Exception {
        System.out.println("H1 two phones apart, different settings");
        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2");
        SyncFamily.Phone a = p[0], b = p[1];
        put(a, settings(new String[] { "woolworths", "coles" }, 1, 10, "unit", false, 8));
        put(b, settings(new String[] { "woolworths", "coles" }, 1, 10, "unit", false, 26));
        SyncFamily.sync(b, a);
        // Apart: A raises Shop around and turns Aldi on; B changes the alert level and turns Coles off.
        SharedSettings.set(a.e, "shopAroundMin", 5);
        SharedSettings.set(a.e, "shop:aldi", new JSONObject().put("on", true));
        SharedSettings.set(b.e, "defaultThresholdPct", 25);
        SharedSettings.set(b.e, "shop:coles", new JSONObject().put("on", false));
        Thread.sleep(3);
        SharedSettings.set(a.e, "listCompare", "price");
        Thread.sleep(3);
        SharedSettings.set(b.e, "listCompare", "unit"); // later: wins on both
        SyncFamily.sync(b, a);
        SyncFamily.sync(a, b);
        JSONObject sa = got(a), sb = got(b);
        check(num(sa, "shopAroundMin") == 5 && num(sb, "shopAroundMin") == 5, "A's Shop around reaches B (a=" + sa.opt("shopAroundMin") + " b=" + sb.opt("shopAroundMin") + ")");
        check(num(sa, "defaultThresholdPct") == 25 && num(sb, "defaultThresholdPct") == 25, "B's alert level reaches A (a=" + sa.opt("defaultThresholdPct") + " b=" + sb.opt("defaultThresholdPct") + ")");
        check(chains(sa).equals(chains(sb)) && chains(sa).contains("aldi") && !chains(sa).contains("coles") && chains(sa).contains("woolworths"),
            "both shop changes kept on both: a=" + chains(sa) + " b=" + chains(sb));
        check("unit".equals(sa.optString("listCompare")) && "unit".equals(sb.optString("listCompare")), "the same setting changed on both: the later change wins everywhere");
        check(sb.optInt("historyWeeks") == 26 && sa.optInt("historyWeeks") == 8, "each phone's own settings stay its own (history a=8, b=26)");
        check("0844".equals(sb.getJSONObject("stores").getJSONObject("coles").optString("branchStoreNo")), "a chain turned off keeps the phone's own branch for later");
        // A turns Coles back on: B's own branch is still there for it.
        SharedSettings.set(a.e, "shop:coles", new JSONObject().put("on", true));
        SyncFamily.sync(b, a);
        sb = got(b);
        check(chains(sb).contains("coles") && "Coles Kirwan".equals(sb.getJSONObject("stores").getJSONObject("coles").optString("primary")), "turned on again: B keeps its own Coles branch");
        // Nothing to send back: B's sync_log has no change of its own for what came from A.
        check(b.one("SELECT 1 FROM sync_log WHERE tbl = 'household_settings' AND pk = 'shop:coles' AND device = 'b2'") == null, "a setting that arrived isn't noted as B's own change");
    }

    /** Households from before 0.9.3: the owner's settings seed the household; a member's never do; a member's real change still wins. */
    static void h2SeedFromOwner() throws Exception {
        System.out.println("H2 the first time: seeded from the owner");
        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2", "c3");
        SyncFamily.Phone a = p[0], b = p[1], c = p[2];
        // Drifted apart (as 0.9.2 left them), no household settings yet.
        put(a, settings(new String[] { "coles", "aldi" }, 3, 15, "price", false, 8));
        put(b, settings(new String[] { "woolworths" }, 20, 40, "unit", false, 13));
        put(c, settings(new String[] { "woolworths", "coles", "aldi" }, 7, 30, "unit", false, 52));
        // C (a member, on 0.9.3 already) changes one setting for real before the owner has seeded.
        SharedSettings.set(c.e, "defaultThresholdPct", 33);
        int seededByB = SharedSettings.seed(b.e);
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        JSONObject sb = got(b), sc = got(c), sa = got(a);
        check(seededByB == 0 && b.one("SELECT 1 FROM sync_log WHERE tbl = 'household_settings' AND device = 'b2'") == null, "a member never seeds");
        check(Integer.parseInt(a.one("SELECT COUNT(*) FROM sync_log WHERE tbl = 'household_settings' AND device = 'a1' AND stamp = 1")) > 5, "the owner seeds, as the oldest change");
        check(set(chains(sb)).equals(set("coles", "aldi")) && set(chains(sc)).equals(set("coles", "aldi")), "members take the owner's shops: b=" + chains(sb) + " c=" + chains(sc));
        check(num(sb, "shopAroundMin") == 3 && num(sc, "shopAroundMin") == 3 && "price".equals(sb.optString("listCompare")), "and its Shop around and list setting");
        check(num(sa, "defaultThresholdPct") == 33 && num(sb, "defaultThresholdPct") == 33 && num(sc, "defaultThresholdPct") == 33,
            "a member's real change made before the seed wins over it (a=" + sa.opt("defaultThresholdPct") + " b=" + sb.opt("defaultThresholdPct") + ")");
        check(sb.optInt("historyWeeks") == 13 && sc.optInt("historyWeeks") == 52, "members keep their own history setting");
        int again = SharedSettings.seed(a.e);
        check(again == 0, "seeding happens once per setting (" + again + " more)");
    }

    /** A tab this phone doesn't sync (or the household doesn't share) is never touched. */
    static void h3UnsharedTab() throws Exception {
        System.out.println("H3 a tab not shared");
        SyncFamily.Phone a = new SyncFamily.Phone("a1"), b = new SyncFamily.Phone("b2");
        a.h.create("House", "Owner", new HashSet<>(Arrays.asList("pantry", "keg")));
        SyncFamily.join(a, b);
        b.e.setMeta("tabs", "pantry"); // B doesn't take Keg
        put(a, settings(new String[] { "coles", "danmurphys" }, 1, 10, "unit", true, 8));
        JSONObject bs = settings(new String[] { "coles", "bws", "chemistwarehouse" }, 1, 10, "unit", true, 8);
        bs.getJSONObject("sections").put("pharmacy", true);
        put(b, bs);
        SyncFamily.sync(b, a);
        // A picks a pharmacy too (the household doesn't share Pharmacy) and changes Keg.
        SharedSettings.set(a.e, "shop:priceline", new JSONObject().put("on", true));
        SharedSettings.set(a.e, "shop:bws", new JSONObject().put("on", true));
        SharedSettings.set(a.e, "shop:danmurphys", new JSONObject().put("on", false));
        SharedSettings.set(a.e, "tab:keg", false);
        SyncFamily.sync(b, a);
        SyncFolder.Result fr = null;
        SyncFamily.MapFolder folder = new SyncFamily.MapFolder();
        a.f.sync(folder, NOW);
        fr = b.f.sync(folder, NOW);
        JSONObject sb = got(b);
        check(chains(sb).contains("bws") && chains(sb).contains("chemistwarehouse") && !chains(sb).contains("priceline") && !chains(sb).contains("danmurphys"),
            "B's Keg and Pharmacy shops are its own: " + chains(sb));
        check(sb.getJSONObject("sections").optBoolean("keg") && sb.getJSONObject("sections").optBoolean("pharmacy"), "B's tabs stay switched on");
        check(b.one("SELECT 1 FROM household_settings WHERE k IN ('shop:bws', 'shop:priceline', 'tab:keg', 'shop:danmurphys')") == null, "B doesn't even keep rows for tabs it doesn't sync (folder too: " + (fr == null ? "?" : fr.received) + ")");
        check(chains(sb).contains("coles"), "the shared tab's shops still follow");
    }

    /** A shop someone added comes with its name and website; deleting it takes it off; a folder carries it too. Also the old-phone files. */
    static void h4CustomShopAndFolder(File oldWork) throws Exception {
        System.out.println("H4 a shop someone added, through a folder");
        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2");
        SyncFamily.Phone a = p[0], b = p[1];
        put(a, settings(new String[] { "coles" }, 1, 10, "unit", false, 8));
        put(b, settings(new String[] { "coles" }, 1, 10, "unit", false, 8));
        SyncFamily.MapFolder folder = new SyncFamily.MapFolder();
        a.f.sync(folder, NOW);
        b.f.sync(folder, NOW);
        JSONObject shop = new JSONObject().put("id", "custom-farm").put("name", "Farm gate").put("website", "http://farmgate.example.com").put("section", "pantry")
            .put("search", "https://elsewhere.example.net/?q={q}").put("createdAt", "2026-11-01T00:00:00Z");
        SharedSettings.set(b.e, "shop:custom-farm", new JSONObject().put("on", true).put("shop", shop));
        b.f.sync(folder, NOW);
        a.f.sync(folder, NOW);
        JSONObject sa = got(a);
        JSONArray cs = sa.optJSONArray("customShops");
        JSONObject c0 = cs != null && cs.length() > 0 ? cs.getJSONObject(0) : new JSONObject();
        check(chains(sa).contains("custom-farm") && "Farm gate".equals(c0.optString("name")) && "https://farmgate.example.com".equals(c0.optString("website")) && !c0.has("search"),
            "B's own shop reaches A through the folder (https, and no search page on another site): " + c0);
        check("pantry".equals(a.e.chainTab("custom-farm")), "and A knows its tab now");
        // Files for the old-phone check: A's folder file (household settings in it) and the household key.
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('old1', 'Milk', 0, 'x', 1, 'pantry')");
        // 0.9.3: the shopping list's rows, and a line that came from Home Assistant ("ha-" id).
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('ha-old2', 'oat milk', 0, 'x', 1, 'pantry')");
        a.db.exec("INSERT INTO household_settings (k, v) VALUES ('alias:milk', '\"i-milk\"'), ('keep:ha-old2', 'true'), ('ha:phone', '\"a1\"')");
        a.f.sync(folder, NOW);
        // With a summary too (a server file has one; an old phone reading it must pass over it).
        JSONObject file = SyncFolder.open(a.h.key(), folder.files.get("restock-sync-a1.bin"));
        PhoneSummary.appVersion = "0.9.3";
        file.put("summary", PhoneSummary.of(a.e));
        Files.write(new File(oldWork, "phone.bin").toPath(), SyncFolder.seal(a.h.key(), file));
        Files.writeString(new File(oldWork, "key.txt").toPath(), java.util.Base64.getEncoder().encodeToString(a.h.key()));
        // Deleted on A: gone from B too.
        SharedSettings.set(a.e, "shop:custom-farm", new JSONObject().put("on", false).put("removed", true).put("shop", shop));
        a.f.sync(folder, NOW);
        b.f.sync(folder, NOW);
        JSONObject sb = got(b);
        check(!chains(sb).contains("custom-farm") && (sb.optJSONArray("customShops") == null || sb.getJSONArray("customShops").length() == 0), "deleted on A: gone from B's shops");
        // A forged shop row (search page elsewhere, odd tab) is refused outright.
        check(SharedSettings.checkValue("shop:custom-x", new JSONObject().put("on", true).put("shop", new JSONObject().put("id", "custom-y").put("name", "X").put("website", "https://x.example").put("section", "pantry"))) == null
            && SharedSettings.checkValue("shopAroundMin", -5) == null && SharedSettings.checkValue("listCompare", "cheapest") == null, "rows that aren't right are refused");
        // 0.10.8: custom sections' icons are emoji only and names have no hidden marks (the same as shops.ts)
        {
            boolean ok = true;
            for (String e : new String[] {"🐶", "👨‍👩‍👧", "🇦🇺", "👍🏽", "❤️", "🛠️🚗"}) ok &= SharedSettings.isEmojiIcon(e);
            for (String e : new String[] {"é", "车", "Ω", "\u200d", "\u202e🐶", "🐶 🐱", "🐶🐶🐶🐶🐶🐶🐶🐶🐶"}) ok &= !SharedSettings.isEmojiIcon(e);
            ok &= SharedSettings.checkCustomDef(new JSONObject().put("name", "Car\u202estuff").put("colour", "pink").put("icon", "pack:car")) == null;
            ok &= SharedSettings.checkCustomDef(new JSONObject().put("name", "Café crème").put("colour", "pink").put("icon", "pack:car")) != null;
            check(ok, "custom sections: emoji icons and hidden marks, as on the web");
        }
        // Review: a search page on www. (or another part) of the shop's own site is kept, as the
        // phone's own Settings keep it, so a shop's own row doesn't take its search page away.
        JSONObject www = new JSONObject().put("id", "custom-w").put("name", "W").put("website", "https://farm.example.com.au").put("section", "pantry")
            .put("search", "http://www.farm.example.com.au/s?q={q}");
        JSONObject kept = SharedSettings.checkShop(www, "custom-w");
        check(kept != null && "https://www.farm.example.com.au/s?q={q}".equals(kept.optString("search"))
            && SharedSettings.checkShop(new JSONObject(www.toString()).put("search", "https://farm.example.com.au.evil.net/?q={q}"), "custom-w").optString("search", null) == null
            && SharedSettings.checkShop(new JSONObject(www.toString()).put("website", "https://farm.example.com.au@10.0.0.1"), "custom-w") == null
            && SharedSettings.checkShop(new JSONObject(www.toString()).put("website", "https://localhost:8123"), "custom-w") == null,
            "a search page on the shop's own site (www. too) is kept; a sign-in part or a host without a dot isn't: " + kept);
        // Review: the household switching Keg on doesn't show it on a phone that hasn't said it's 18 or over.
        List<String[]> kegOn = new ArrayList<>();
        kegOn.add(new String[] { "tab:keg", "true" });
        JSONObject minor = new JSONObject().put("sections", new JSONObject().put("keg", false).put("pharmacy", false));
        JSONObject adult = new JSONObject(minor.toString()).put("adultConfirmed", true);
        Set<String> both = new HashSet<>(Arrays.asList("pantry", "keg"));
        boolean minorChanged = SharedSettings.apply(minor, kegOn, both);
        boolean adultChanged = SharedSettings.apply(adult, kegOn, both);
        check(!minorChanged && !minor.getJSONObject("sections").optBoolean("keg") && adultChanged && adult.getJSONObject("sections").optBoolean("keg"),
            "Keg is only switched on where the phone has confirmed 18+ (minor " + minor + ", adult " + adult + ")");
    }

    /** A phone that leaves keeps its settings as they are, and the household's changes stop reaching it. */
    static void h5Leaving() throws Exception {
        System.out.println("H5 leaving");
        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2");
        SyncFamily.Phone a = p[0], b = p[1];
        put(a, settings(new String[] { "coles", "aldi" }, 4, 20, "price", false, 8));
        put(b, settings(new String[] { "woolworths" }, 1, 10, "unit", false, 8));
        // 0.9.3: an alias and a "Keep it as just" row, and the Home Assistant phone (A).
        a.db.exec("INSERT INTO household_settings (k, v) VALUES ('alias:milk', '\"i-milk\"'), ('keep:l9', 'true'), ('ha:phone', '\"a1\"')");
        SyncFamily.sync(b, a);
        JSONObject before = got(b);
        b.h.startLeaving();
        SyncFamily.sync(b, a);
        b.h.forget();
        JSONObject after = got(b);
        check(set(chains(after)).equals(set("coles", "aldi")) && num(after, "shopAroundMin") == 4 && chains(before).equals(chains(after)), "B keeps the household's values as its own: " + chains(after));
        check("0".equals(b.one("SELECT COUNT(*) FROM household_settings WHERE NOT " + SharedSettings.KEPT_ON_LEAVING))
            && "0".equals(b.one("SELECT COUNT(*) FROM sync_log WHERE tbl = 'household_settings' AND pk NOT LIKE 'alias:%' AND pk NOT LIKE 'keep:%'")), "the household's rows are gone from B");
        check("2".equals(b.one("SELECT COUNT(*) FROM household_settings WHERE k IN ('alias:milk', 'keep:l9')")) && b.one("SELECT 1 FROM household_settings WHERE k = 'ha:phone'") == null
            && "2".equals(b.one("SELECT COUNT(*) FROM sync_log WHERE tbl = 'household_settings' AND pk IN ('alias:milk', 'keep:l9')")),
            "B keeps its aliases and \"keep\" rows (about its own things), not which phone syncs with Home Assistant");
        // B changes its own now: nothing to send. A changes the household's: B isn't in it.
        check(SharedSettings.seed(b.e) == 0, "B, on its own, seeds nothing");
        SharedSettings.set(a.e, "shopAroundMin", 9);
        check(num(got(b), "shopAroundMin") == 4, "the household's later changes don't reach B");
    }

    /** The summary for the web: only from the allow-list, on a server only. */
    static void h6Summary() throws Exception {
        System.out.println("H6 the phone's summary for the web");
        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2");
        SyncFamily.Phone a = p[0];
        JSONObject s = settings(new String[] { "coles" }, 1, 10, "unit", false, 13);
        s.put("autoBackup", new JSONObject().put("enabled", true).put("everyDays", 3).put("keep", 4).put("folder", "content://com.android.externalstorage/tree/SECRET-FOLDER")
            .put("folderName", "SECRET-FOLDER-NAME").put("password", "SECRET-PASSWORD").put("lastAt", "2026-11-08T10:00:00.000Z").put("lastError", "SECRET-ERROR"));
        s.put("accounts", new JSONObject().put("woolworths", new JSONObject().put("signedIn", true).put("storeId", "SECRET-STORE").put("storeName", "SECRET-STORE-NAME")));
        s.put("area", new JSONObject().put("label", "SECRET-SUBURB").put("lat", -19.3).put("lon", 146.7));
        s.put("alerts", new JSONObject().put("daily", true).put("dailyTime", "07:30").put("greatDeals", false));
        s.put("a11y", new JSONObject().put("text", 1.3));
        s.put("updates", new JSONObject().put("notify", true).put("everyDays", 7).put("told", "SECRET-TOLD"));
        s.put("household", new JSONObject().put("name", "SECRET-HOUSEHOLD"));
        s.put("lastCheck", "2026-11-09T01:02:03.000Z");
        s.put("theme", "<script>SECRET</script>");
        put(a, s);
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('homeAssistant', ?)", new JSONObject().put("enabled", true).put("address", "http://SECRET-HA:8123").put("entity", "todo.shopping_list").put("token", "SECRET-TOKEN").toString());
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('lastCheckInfo', ?)", new JSONObject().put("at", "2026-11-09T01:02:03.000Z").put("checked", 42).toString());
        a.db.exec("INSERT INTO cards (id, program, label, number, created_at) VALUES ('k1', 'flybuys', 'SECRET-LABEL', '6008943200000000', 'x')");
        a.e.setMeta("folder", "https://SECRET-DAV.example.com/remote.php/dav/files/me/Restock");
        a.e.setMeta("dav_kind", "nextcloud");
        a.e.setMeta("dav_pass", "SECRET-DAV-PASSWORD");
        PhoneSummary.appVersion = "0.9.3";
        JSONObject sum = PhoneSummary.of(a.e);
        String text = sum.toString();
        check(!text.contains("SECRET") && !text.contains("6008943200000000") && !text.contains("0844") && !text.contains("Kirwan") && !text.contains("-19.3"), "nothing secret in it: " + text);
        check("0.9.3".equals(sum.optString("version")) && sum.getJSONObject("backups").optInt("everyDays") == 3 && sum.optInt("cards") == 1 && "nextcloud".equals(sum.optString("away"))
            && "todo.shopping_list".equals(sum.getJSONObject("homeAssistant").optString("entity")) && sum.getJSONObject("checks").optInt("lastItems") == 42
            && "Larger".equals(sum.getJSONObject("look").optString("text")) && "system".equals(sum.getJSONObject("look").optString("theme"))
            && sum.getJSONObject("accounts").optBoolean("woolworths") && sum.getJSONObject("updates").optInt("everyDays") == 7, "and what it should say");
        // Not in a folder's file.
        SyncFamily.MapFolder folder = new SyncFamily.MapFolder();
        a.f.sync(folder, NOW);
        JSONObject file = SyncFolder.open(a.h.key(), folder.files.get("restock-sync-a1.bin"));
        check(!file.has("summary"), "a picked folder's (or WebDAV's) file has no summary");
        // On a server it is, and a change to it writes the file again.
        SyncFolder srv = new SyncFolder(a.e, a.h, "server", ServerSync.PRICES_MS);
        String m1 = srv.ownMark(srv.summary());
        a.db.exec("INSERT INTO cards (id, program, label, number, created_at) VALUES ('k2', 'everyday', 'x', '9355', 'x')");
        check(!m1.equals(srv.ownMark(srv.summary())), "a new summary means the server file is written again");
    }

    /**
     * 0.9.3: the shopping list's rows (alias:, keep:, ha:phone) sync like any other, over the Wi-Fi
     * and through a folder, the later change winning; they never change a phone's settings, and a
     * row this version doesn't know is carried along without a problem.
     */
    static void h7ListRows() throws Exception {
        System.out.println("H7 the shopping list's rows (aliases, Keep it as just, the Home Assistant phone)");
        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2", "c3");
        SyncFamily.Phone a = p[0], b = p[1], c = p[2];
        for (SyncFamily.Phone x : p) put(x, settings(new String[] { "coles" }, 1, 10, "unit", false, 8));
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        JSONObject sb0 = got(b);
        // B (not the Home Assistant phone) saves an alias and keeps a line as words; C claims Home Assistant.
        b.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('ha-l1', 'oat milk', 0, 'x', 1, 'pantry')");
        b.db.exec("INSERT INTO household_settings (k, v) VALUES ('alias:milk', '\"i-milk\"'), ('keep:ha-l1', 'true'), ('future:row', '{\"x\":1}')");
        c.db.exec("INSERT INTO household_settings (k, v) VALUES ('ha:phone', '\"c3\"')");
        Thread.sleep(3);
        a.db.exec("INSERT INTO household_settings (k, v) VALUES ('ha:phone', '\"a1\"')"); // later: A moves it to itself
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        SyncFamily.sync(b, a);
        // C gets the rest through a folder.
        SyncFamily.MapFolder folder = new SyncFamily.MapFolder();
        b.f.sync(folder, NOW);
        c.f.sync(folder, NOW);
        for (SyncFamily.Phone x : p) {
            check("\"i-milk\"".equals(x.one("SELECT v FROM household_settings WHERE k = 'alias:milk'")) && "true".equals(x.one("SELECT v FROM household_settings WHERE k = 'keep:ha-l1'"))
                && "\"a1\"".equals(x.one("SELECT v FROM household_settings WHERE k = 'ha:phone'")) && x.one("SELECT 1 FROM list_entries WHERE id = 'ha-l1'") != null,
                x.id + " has B's alias and keep rows, the line from Home Assistant, and A as the Home Assistant phone (the later claim)");
        }
        check(got(b).similar(sb0) && got(a).optDouble("shopAroundMin") == 1, "the rows change no one's settings");
        check(a.one("SELECT 1 FROM household_settings WHERE k = 'future:row'") != null, "a row this version doesn't know comes across without a problem");
        check(SharedSettings.checkValue("alias:milk", "i-milk") == null && SharedSettings.checkValue("ha:phone", "a1") == null && SharedSettings.tabOf("keep:ha-l1", "true") == null,
            "apply passes over them, and they're the whole household's (no tab)");
    }

    /**
     * 0.9.3 review: what another member (or a browser) can put in the table: the shopping list's rows
     * only as Restock writes them, nothing huge, and a flood stops at the limits (sharedSettings.ts
     * settingChangeOk is the same; householdSettings.test.ts checks the web's side).
     */
    static void h8BadRows() throws Exception {
        System.out.println("H8 odd or too many household settings rows from another member");
        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2");
        SyncFamily.Phone a = p[0];
        long t = System.currentTimeMillis();
        JSONArray in = new JSONArray();
        String[][] good = { { "alias:milk", "\"i-milk\"" }, { "keep:ha-1", "true" }, { "ha:phone", "\"b2\"" }, { "future:thing", "{\"x\":1}" } };
        String[][] bad = { { "alias:__proto__", "\"i-milk\"" }, { "alias:Milk", "\"i-milk\"" }, { "alias:eggs", "\"" + "x".repeat(5000) + "\"" }, { "alias:oats", "i-oats" },
            { "keep:ha-2", "1" }, { "keep:demo-1", "true" }, { "future:big", "\"" + "y".repeat(5000) + "\"" }, { "x".repeat(300), "1" } };
        for (String[] r : good) in.put(settingEntry(r[0], r[1], t));
        for (String[] r : bad) in.put(settingEntry(r[0], r[1], t));
        in.put(settingEntry("ha:phone", "\"web-x\"", t + 5));
        in.put(settingEntry("keep:ha-3", "true", t).put("row", new JSONObject().put("k", "keep:ha-4").put("v", "true")));
        in.put(settingEntry("future:null", "1", t).put("row", new JSONObject().put("k", "future:null").put("v", JSONObject.NULL)));
        int n = a.e.apply(in);
        check(n == 4 && "4".equals(a.one("SELECT COUNT(*) FROM household_settings WHERE k IN ('alias:milk', 'keep:ha-1', 'ha:phone', 'future:thing')"))
            && "\"b2\"".equals(a.one("SELECT v FROM household_settings WHERE k = 'ha:phone'")) && "4".equals(a.one("SELECT COUNT(*) FROM household_settings WHERE k NOT IN ('shopAroundMin', 'defaultThresholdPct', 'listCompare', 'productOrder', 'recalls.enabled') AND k NOT LIKE 'shop:%' AND k NOT LIKE 'tab:%'")),
            "only the rows that are right come in (" + n + "), and a null value doesn't stop the rest");
        JSONArray flood = new JSONArray();
        for (int i = 0; i < SharedSettings.LIST_ROWS_MAX + 50; i++) flood.put(settingEntry("keep:l" + i, "true", t + 10));
        a.e.apply(flood);
        check(String.valueOf(SharedSettings.LIST_ROWS_MAX).equals(a.one("SELECT COUNT(*) FROM household_settings WHERE k LIKE 'keep:%'")), "a flood of keep: rows stops at " + SharedSettings.LIST_ROWS_MAX);
        a.e.apply(new JSONArray().put(settingEntry("alias:milk", "\"i-oat\"", t + 20)).put(settingEntry("keep:ha-1", "true", t + 20).put("deleted", true)));
        check("\"i-oat\"".equals(a.one("SELECT v FROM household_settings WHERE k = 'alias:milk'")) && a.one("SELECT 1 FROM household_settings WHERE k = 'keep:ha-1'") == null,
            "a row already there still changes, and a delete still goes");
    }

    static JSONObject settingEntry(String k, String v, long t) throws Exception {
        return new JSONObject().put("tbl", "household_settings").put("pk", k).put("stamp", t).put("device", "b2").put("created", t).put("deleted", false)
            .put("row", new JSONObject().put("k", k).put("v", v));
    }

    static String b64(byte[] b) {
        return new String(java.util.Base64.getEncoder().encode(b), StandardCharsets.US_ASCII);
    }
}
