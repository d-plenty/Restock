package family.plenty.restock;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.2: the web app's merge against the phones' own (tools/sync-test/web-parity.test.ts drives
 * this). Two phones make a household and a tangle of changes; their server files (sealed with the
 * serverKey) go to a folder. A stand-in for the web (device "web-parityref", with only the
 * serverKey and the owner's public key, like the browser) reads them with the phones' SyncFolder
 * code, and its rows are written out for the TypeScript side to compare with its own. Then the
 * phones read the web's file (written by the TypeScript side) and the checks say what they got.
 *
 * Talks on stdin/stdout: prints "READY n" when round n's files are written, waits for "GO n".
 * Arguments: the out dir (bridge.py, migrations.json), the work dir, and "e2e" for the browser
 * test (the web app against a real server: there the web ticks Bananas and adds "Bread rolls").
 */
public class SyncWebParity {
    static final String NOW = SyncFamily.NOW;
    static final String WEB = "web-parityref";
    static int fails = 0;
    static File work;
    static byte[] serverKey;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "CHECK ok   " : "CHECK FAIL ") + what);
        if (!ok) fails++;
    }

    static byte[] serverKeyOf(byte[] householdKey) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(householdKey, "HmacSHA256"));
        return mac.doFinal("restock-server-files-v1".getBytes(StandardCharsets.UTF_8));
    }

    /** The server's files folder as the phones see it: sealed with the serverKey there, the household key here. */
    static final class ServerAsPhone implements SyncFolder.Folder {
        final byte[] key;

        ServerAsPhone(byte[] householdKey) {
            key = householdKey;
        }

        File dir() {
            return new File(work, "files");
        }

        public List<String> names() {
            List<String> l = new ArrayList<>();
            String[] n = dir().list();
            if (n != null) for (String s : n) if (s.startsWith("restock-sync-")) l.add(s);
            java.util.Collections.sort(l);
            return l;
        }

        public byte[] read(String name) throws Exception {
            File f = new File(dir(), name);
            if (!f.exists()) return null;
            byte[] b = Files.readAllBytes(f.toPath());
            return SyncFolder.seal(key, SyncFolder.open(serverKey, b));
        }

        public void write(String name, byte[] data) throws Exception {
            Files.write(new File(dir(), name).toPath(), SyncFolder.seal(serverKey, SyncFolder.open(key, data)));
        }
    }

    /**
     * The same folder for the web stand-in, which only has the serverKey (as its "household key").
     * 0.9.3: it reads as a phone on a server does (SyncFolder "server": a file's author is its
     * name), so the files are handed over sealed the way that expects (with the serverKey of its key).
     */
    static final class ServerAsWeb implements SyncFolder.Folder {
        File dir() {
            return new File(work, "files");
        }

        public List<String> names() {
            List<String> l = new ArrayList<>();
            String[] n = dir().list();
            if (n != null) for (String s : n) if (s.startsWith("restock-sync-")) l.add(s);
            java.util.Collections.sort(l);
            return l;
        }

        public byte[] read(String name) throws Exception {
            File f = new File(dir(), name);
            if (!f.exists()) return null;
            byte[] b = Files.readAllBytes(f.toPath());
            if (!name.endsWith(".bin")) return b;
            return SyncFolder.seal(SyncFolder.serverKey(serverKey), SyncFolder.open(serverKey, b));
        }

        public void write(String name, byte[] data) {
            // the stand-in's own file stays here (the TypeScript side writes the real one)
        }
    }

    static void dump(SyncFamily.Phone p, String file) throws Exception {
        JSONObject out = new JSONObject();
        String[][] t = { { "categories", "id" }, { "products", "id" }, { "items", "id" }, { "list_entries", "id" }, { "cards", "id" }, { "prices", "product_id, date" }, { "household", "k" }, { "receipts", "id" },
            { "household_settings", "k" } };
        for (String[] x : t) {
            JSONArray rows = new JSONArray();
            for (JSONObject r : p.db.query("SELECT * FROM " + x[0] + " ORDER BY " + x[1])) rows.put(r);
            out.put(x[0], rows);
        }
        JSONArray log = new JSONArray();
        for (JSONObject r : p.db.query("SELECT tbl, pk, stamp, device, deleted, created FROM sync_log WHERE tbl <> '_seq' ORDER BY tbl, pk")) log.put(r);
        out.put("sync_log", log);
        out.put("owner_pin", p.e.meta("owner_pin"));
        // 0.9.3: the settings as stored (the household's rows applied to them).
        String st = p.one("SELECT value FROM kv WHERE key = 'settings'");
        out.put("settings", st == null ? JSONObject.NULL : new JSONObject(st));
        Files.writeString(new File(work, file).toPath(), out.toString(1));
    }

    static void exec(SyncFamily.Phone p, String sql) throws Exception {
        p.db.exec(sql);
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        work = new File(args[1]);
        boolean e2e = args.length > 2 && "e2e".equals(args[2]);
        new File(work, "files").mkdirs();
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

        SyncFamily.Phone[] ps = SyncFamily.household("a1", "b2");
        SyncFamily.Phone a = ps[0], b = ps[1];
        a.h.setHouseholdReceipts(true);
        a.e.setShareCards(true);
        SyncFamily.sync(b, a);
        serverKey = serverKeyOf(a.h.key());
        // 0.9.3: settings drifted apart (as 0.9.2 left them): the owner's seed the household's.
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", base().put("enabledChains", new JSONArray().put("coles").put("aldi")).put("shopAroundMin", 3).toString());
        b.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", base().put("enabledChains", new JSONArray().put("woolworths")).put("shopAroundMin", 20).put("historyWeeks", 26).toString());
        SyncFamily.sync(b, a);

        // Things both phones have.
        exec(a, "INSERT INTO categories (id, name, ord, section) VALUES ('c-a', 'Pantry', 0, 'pantry'), ('c-k', 'Beer', 0, 'keg')");
        exec(b, "INSERT INTO categories (id, name, ord, section) VALUES ('c-b', ' pantry', 1, 'pantry')"); // same name: tidied to c-a
        exec(a, "INSERT INTO products (id, chain, name, brand, size, created_at, in_stock) VALUES ('p1', 'coles', 'Milk 2L', 'Dairy Farmers', '2L', '2026-11-01', 1), ('p2', 'woolworths', 'Bread', NULL, '650g', '2026-11-01', 0), ('p3', 'custom-xyz', 'Local eggs', NULL, NULL, '2026-11-01', NULL)");
        exec(a, "INSERT INTO items (id, name, category_id, usual_product_id, created_at, section, target_price) VALUES ('i1', 'Milk', 'c-a', 'p1', '2026-11-01', 'pantry', 3.5), ('i2', 'Bread', 'c-a', 'p2', '2026-11-01', 'pantry', NULL), ('i3', 'Lager', 'c-k', NULL, '2026-11-01', 'keg', NULL)");
        exec(a, "INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, promo, source) VALUES ('p1', '2026-11-01T00:00:00Z', 3.1, 3.6, 1, 0, 'Save 50c', 'check'), ('p1', '2026-11-05T00:00:00Z', 3.6, NULL, 0, 0, NULL, 'check'), ('p2', '2026-11-05T00:00:00Z', 4.0, NULL, 0, 0, NULL, 'check')");
        exec(a, "INSERT INTO list_entries (id, text, item_id, chain, checked, created_at, qty, section) VALUES ('l1', 'Milk', 'i1', 'coles', 0, '2026-11-02', 1, NULL), ('l2', 'Bananas', NULL, NULL, 0, '2026-11-02', 1, 'pantry'), ('l3', 'Lager', 'i3', NULL, 0, '2026-11-02', 1, NULL), ('l4', 'Gone soon', NULL, NULL, 0, '2026-11-02', 1, 'pantry')");
        exec(a, "INSERT INTO cards (id, program, label, number, created_at) VALUES ('k1', 'flybuys', 'Flybuys', '6008943212345678', '2026-11-01')");
        exec(a, "INSERT INTO receipts (id, scanned_at, shop, chain, section, total, photo) VALUES ('r1', '2026-11-03T01:00:00Z', 'Coles Bohle Plains', 'coles', 'pantry', 42.5, 'receipts/r1.jpg')");
        exec(b, "INSERT INTO items (id, name, created_at, section) VALUES ('i4', 'Tea', '2026-11-01', 'pantry')");
        SyncFamily.sync(b, a);
        Thread.sleep(3);

        // Apart: a tangle of changes.
        exec(a, "UPDATE list_entries SET checked = 1, checked_at = " + (System.currentTimeMillis() + 5) + " WHERE id = 'l1'");
        Thread.sleep(3);
        exec(b, "UPDATE list_entries SET qty = 3, qty_at = " + (System.currentTimeMillis() + 10) + " WHERE id = 'l1'"); // both survive
        exec(a, "DELETE FROM items WHERE id = 'i4'");
        Thread.sleep(3);
        exec(b, "UPDATE items SET name = 'Green tea' WHERE id = 'i4'"); // made without knowing: the delete wins
        exec(a, "UPDATE items SET name = 'Full cream milk' WHERE id = 'i1'");
        Thread.sleep(3);
        exec(b, "UPDATE items SET name = 'Milk 2L' WHERE id = 'i1'"); // later: wins
        exec(b, "DELETE FROM list_entries WHERE id = 'l4'");
        exec(b, "INSERT OR REPLACE INTO household (k, v) VALUES ('name', 'Forged by b2')"); // not signed by the owner: refused
        a.h.renameHousehold("Plenty house"); // signed: taken
        exec(b, "UPDATE products SET in_stock = 0, name = 'Milk 2 litre' WHERE id = 'p1'");
        // 0.9.3: household settings changed apart: B's alert level, A's own shop (with a search page elsewhere: dropped).
        SharedSettings.set(b.e, "defaultThresholdPct", 25);
        SharedSettings.set(a.e, "shop:custom-xyz", new JSONObject().put("on", true).put("shop", new JSONObject().put("id", "custom-xyz").put("name", "Corner store")
            .put("website", "https://corner.example.com").put("section", "pantry").put("search", "https://other.example.net/?q={q}").put("createdAt", "2026-11-01")));
        SharedSettings.set(a.e, "shop:danmurphys", new JSONObject().put("on", true));

        // The phones write their server files (with the phones' own SyncFolder), and A's gets its
        // prices too (a phone's server file carries recent prices; the folder-sync file doesn't).
        a.f.sync(new ServerAsPhone(a.h.key()), NOW);
        b.f.sync(new ServerAsPhone(b.h.key()), NOW);
        JSONObject c = a.e.collect(0, null, 5_000_000, null, " AND tbl = 'prices'", true, 0);
        File aFile = new File(work, "files/restock-sync-a1.bin");
        JSONObject am = SyncFolder.open(serverKey, Files.readAllBytes(aFile.toPath()));
        for (int i = 0; i < c.getJSONArray("entries").length(); i++) am.getJSONArray("entries").put(c.getJSONArray("entries").get(i));
        Files.write(aFile.toPath(), SyncFolder.seal(serverKey, am));
        // 0.9.3: files whose name and inside disagree (anyone with the serverKey, another browser say,
        // could write them): refused on both sides, as a phone on a server refuses them. And another
        // browser's own file: its list line comes in, its household change and loyalty card don't.
        long t = System.currentTimeMillis();
        forged("restock-sync-z9.bin", "b2", line("forged1", "Posing as b2", t));
        forged("restock-sync-web-evil.bin", "web-other", line("forged2", "Posing as another browser", t));
        JSONObject card = new JSONObject().put("tbl", "cards").put("pk", "k9").put("stamp", t).put("device", "web-other").put("created", t).put("deleted", false)
            .put("row", new JSONObject().put("id", "k9").put("program", "flybuys").put("label", "From a browser").put("number", "").put("created_at", "x"));
        JSONObject hhName = new JSONObject().put("tbl", "household").put("pk", "name").put("stamp", t + 99_000).put("device", "web-other").put("created", t).put("deleted", false)
            .put("row", new JSONObject().put("k", "name").put("v", "Named by a browser"));
        forged("restock-sync-web-other.bin", "web-other", line("webother1", "From another browser", t), card, hhName);
        JSONObject hh = new JSONObject();
        hh.put("keyv", 1);
        hh.put("serverKey", java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(serverKey));
        hh.put("owner_pub", a.e.householdValue("owner_pub"));
        hh.put("name", a.e.householdValue("name"));
        Files.writeString(new File(work, "household.json").toPath(), hh.toString());

        // The web stand-in reads them, as a phone would.
        SyncFamily.Phone ref = new SyncFamily.Phone(WEB, "server");
        ref.e.setMeta("key", SyncWire.encodeKey(serverKey));
        ref.e.setMeta("secret", "not-used");
        ref.e.setMeta("owner_pin", a.e.householdValue("owner_pub"));
        // The web's settings before it takes anything in: the app's defaults (as the TypeScript side has them).
        ref.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", base().toString());
        ref.f.sync(new ServerAsWeb(), NOW);
        dump(ref, "java-1.json");
        check(ref.one("SELECT 1 FROM list_entries WHERE id IN ('forged1', 'forged2')") == null, "the web stand-in refuses files whose name and inside disagree");
        check(ref.one("SELECT 1 FROM list_entries WHERE id = 'webother1'") != null && ref.one("SELECT 1 FROM cards WHERE id = 'k9'") == null,
            "another browser's file: its line comes in, its loyalty card doesn't");
        System.out.println("READY 1");
        System.out.flush();
        expect(in, "GO 1");

        // The phones take in the web's file (the TypeScript side ticked Bananas, set Lager to 6, added Bread rolls).
        a.f.sync(new ServerAsPhone(a.h.key()), NOW);
        b.f.sync(new ServerAsPhone(b.h.key()), NOW);
        ref.f.sync(new ServerAsWeb(), NOW);
        check("1".equals(a.one("SELECT checked FROM list_entries WHERE id = 'l2'")), "a phone takes in the web's tick (l2 checked on a1)");
        check("1".equals(b.one("SELECT checked FROM list_entries WHERE id = 'l2'")), "the other phone too (l2 checked on b2)");
        if (e2e) {
            check(a.one("SELECT id FROM list_entries WHERE text = 'Bread rolls'") != null, "a plain line added on the web reaches the phones");
            check("6008943212345678".equals(a.one("SELECT number FROM cards WHERE id = 'k1'")), "the web's blank card number doesn't overwrite a phone's card");
            check("Plenty house".equals(a.one("SELECT v FROM household WHERE k = 'name'")), "the household's name is untouched by the web");
            check(a.one("SELECT id FROM list_entries WHERE id = 'l1' AND checked = 1 AND qty = 3") != null, "l1's tick and amount both survive on a1");
        } else {
        check("6".equals(b.one("SELECT qty FROM list_entries WHERE id = 'l3'")), "the web's amount (l3 qty 6 on b2)");
        check("Bread rolls".equals(a.one("SELECT text FROM list_entries WHERE id = 'web-l1'")), "a plain line added on the web reaches the phones");
        check(a.one("SELECT id FROM list_entries WHERE id = 'l1' AND checked = 1 AND qty = 3") != null, "l1's tick and amount both survive on a1");
        check("6008943212345678".equals(a.one("SELECT number FROM cards WHERE id = 'k1'")), "the web's blank card number doesn't overwrite a phone's card");
        check("Plenty house".equals(a.one("SELECT v FROM household WHERE k = 'name'")), "the household's name is untouched by the web");
        check(a.one("SELECT 1 FROM items WHERE id = 'i4'") == null, "the deleted item stays deleted on a1");
        // 0.9.3: the web changed household settings (setHouseholdSettings): Shop around 9, Aldi off, Woolworths on.
        for (SyncFamily.Phone x : new SyncFamily.Phone[] { a, b }) {
            JSONObject st = new JSONObject(x.one("SELECT value FROM kv WHERE key = 'settings'"));
            java.util.Set<String> ch = new java.util.TreeSet<>();
            for (int i = 0; i < st.getJSONArray("enabledChains").length(); i++) ch.add(st.getJSONArray("enabledChains").getString(i));
            check(st.optDouble("shopAroundMin") == 9 && ch.equals(new java.util.TreeSet<>(Arrays.asList("coles", "woolworths", "custom-xyz", "danmurphys")))
                && st.optDouble("defaultThresholdPct") == 25, "the web's household settings reach " + x.id + ": " + st.opt("shopAroundMin") + " " + ch);
        }
        check(new JSONObject(b.one("SELECT value FROM kv WHERE key = 'settings'")).optInt("historyWeeks") == 26, "b2's own history setting is untouched");
        check(a.one("SELECT id FROM receipts WHERE id = 'r1' AND note = 'Checked on the web'") != null, "the web's note on a receipt reaches a1");
        }

        // Round 2: more changes on the phones after taking in the web's.
        if (!e2e) exec(a, "UPDATE list_entries SET checked = 0, checked_at = " + (System.currentTimeMillis() + 50) + " WHERE id = 'web-l1'");
        exec(b, "INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('l5', 'Coffee', 0, '2026-11-09', 2, 'pantry')");
        if (!e2e) exec(a, "DELETE FROM receipts WHERE id = 'r1'");
        a.f.sync(new ServerAsPhone(a.h.key()), NOW);
        b.f.sync(new ServerAsPhone(b.h.key()), NOW);
        ref.f.sync(new ServerAsWeb(), NOW);
        dump(ref, "java-2.json");
        System.out.println("READY 2");
        System.out.flush();
        expect(in, "GO 2");
        System.out.println(fails == 0 ? "web parity (Java side): all passed" : "web parity (Java side): " + fails + " failed");
        System.out.println("DONE " + fails);
        System.exit(fails == 0 ? 0 : 1);
    }

    /** The settings fields the household shares, as the app's defaults have them. */
    static JSONObject base() throws Exception {
        return new JSONObject().put("onboarded", true).put("enabledChains", new JSONArray().put("woolworths").put("coles").put("aldi"))
            .put("sections", new JSONObject().put("keg", false).put("pharmacy", false)).put("customShops", new JSONArray()).put("shopAroundMin", 1)
            .put("defaultThresholdPct", 10).put("listCompare", "unit").put("recalls", new JSONObject().put("enabled", true)).put("historyWeeks", 8);
    }

    /** A list line as a change in a file. */
    static JSONObject line(String id, String text, long t) throws Exception {
        return new JSONObject().put("tbl", "list_entries").put("pk", id).put("stamp", t).put("device", "web-other").put("created", t).put("deleted", false)
            .put("row", new JSONObject().put("id", id).put("text", text).put("checked", 0).put("created_at", "x").put("qty", 1).put("section", "pantry"));
    }

    /** A file in the server's folder, sealed with the serverKey, that says it's from `device`. */
    static void forged(String name, String device, JSONObject... entries) throws Exception {
        JSONObject m = new JSONObject().put("format", "restock-sync").put("v", 1).put("device", device).put("name", "Someone").put("keyv", 1).put("at", NOW).put("top", 1)
            .put("entries", new JSONArray(Arrays.asList(entries)));
        Files.write(new File(work, "files/" + name).toPath(), SyncFolder.seal(serverKey, m));
    }

    static void expect(BufferedReader in, String what) throws Exception {
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().equals(what)) return;
        }
        throw new Exception("never got " + what);
    }
}
