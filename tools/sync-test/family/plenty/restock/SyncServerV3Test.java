package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.4: phones and a real Restock server in v3, where the server is the household's owner
 * (docs/server-v3-design.md, docs/server-protocol.md "v3"), with the phones' own code (ServerSync,
 * ServerFolder, SyncFolder, SyncHousehold, ServerOffload, ServerLink). The server's web page is
 * tools/sync-test/server-v3.mjs, with the server repo's own test clients.
 *
 * Arguments: out dir, then three servers: a fresh one (made a house here), one in v2 mode (a 0.9.3
 * household handed over), and another fresh one (a Wi-Fi household brought onto it); then a state
 * folder for the stand-in browser.
 */
public class SyncServerV3Test {
    static int fails = 0;
    static String house, v2, fresh, stateDir;
    static final long DAY = 86_400_000L;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    /** The stand-in web page (server-v3.mjs): one line of output. */
    static String web(String url, String cmd, String... more) throws Exception {
        List<String> c = new ArrayList<>(Arrays.asList("node", "tools/sync-test/server-v3.mjs", cmd, url, stateDir + "/" + url.replaceAll("[^0-9]", "") + ".json"));
        c.addAll(Arrays.asList(more));
        Process p = new ProcessBuilder(c).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        if (p.waitFor() != 0) throw new Exception("server-v3.mjs " + cmd + " failed");
        return out;
    }

    static SyncFamily.Phone phone(String id) throws Exception {
        SyncFamily.Phone p = new SyncFamily.Phone(id, "server");
        p.e.photos = new SyncTest091.MapPhotos();
        p.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", new JSONObject().put("historyWeeks", 4).put("enabledChains", new JSONArray().put("coles").put("woolworths")).toString());
        return p;
    }

    static ServerSync s(SyncFamily.Phone p) {
        return new ServerSync(p.e, p.h);
    }

    /** A round, then a moment for the server to merge what came in (it waits a second after a file). */
    static ServerSync.Round round(SyncFamily.Phone p) throws Exception {
        ServerSync.Round r = s(p).round(SyncFamily.NOW, System.currentTimeMillis());
        Thread.sleep(1600);
        return r;
    }

    static void rounds(SyncFamily.Phone... ps) throws Exception {
        for (SyncFamily.Phone p : ps) s(p).round(SyncFamily.NOW, System.currentTimeMillis());
        Thread.sleep(1600);
        for (SyncFamily.Phone p : ps) s(p).round(SyncFamily.NOW, System.currentTimeMillis());
    }

    static void item(SyncFamily.Phone p, String id, String name, String section) throws Exception {
        p.db.exec("INSERT OR REPLACE INTO items (id, name, created_at, section) VALUES (?, ?, 'x', ?)", id, name, section);
    }

    static String has(SyncFamily.Phone p, String id) throws Exception {
        return p.one("SELECT name FROM items WHERE id = '" + id + "'");
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        house = args[1];
        v2 = args[2];
        fresh = args[3];
        stateDir = args[4];
        String only = args.length > 5 ? args[5] : "";
        if (only.isEmpty() || only.contains("H")) {
            houseScenarios();
            generalScenarios();
        }
        if (only.isEmpty() || only.contains("O")) handoverScenarios();
        if (only.isEmpty() || only.contains("B")) bringScenarios();
        System.out.println(fails == 0 ? "server v3 scenarios: all passed" : "server v3 scenarios: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    // ---------- a fresh server set up as a house: joining, sharing, rekeys, leaving, Keep data for ----------

    static void houseScenarios() throws Exception {
        web(house, "setup", "Declan and Sarah");
        SyncFamily.Phone a = phone("a1"), b = phone("b2"), c = phone("c3");
        item(a, "a-own", "Vegemite", "pantry");

        String code = web(house, "invite", "Declan's phone");
        JSONObject check = s(a).check(code);
        JSONObject gift = s(a).join3(code, false);
        report("W1 a phone joins with an Add a phone code: its label, and the house's name, from the sealed answer",
            !"Declan's phone".equals(gift.optString("label")) || !"Declan and Sarah".equals(gift.getJSONObject("household").optString("name")) || check.optInt("v") != 3 || !"3".equals(a.e.meta("server_api")),
            "label " + gift.optString("label") + ", house " + gift.getJSONObject("household").optString("name") + ", check " + check);
        report("W2 what it shares starts as groceries only: no Keg or Pharmacy, no receipts, no cards; Wi-Fi sync off",
            !"pantry".equals(a.e.meta("tabs")) || !"0".equals(a.e.meta("share_receipts")) || a.e.shareCards() || !"0".equals(a.e.meta("wifi_sync")) || !"Home".equals(a.e.meta("server_label")),
            "tabs " + a.e.meta("tabs") + ", receipts " + a.e.meta("share_receipts") + ", cards " + a.e.shareCards() + ", wifi " + a.e.meta("wifi_sync"));
        String reuse = null;
        try {
            s(b).join3(code, false);
        } catch (Exception e) {
            reuse = e.getMessage();
        }
        report("W3 the same code can't add a second phone", reuse == null, String.valueOf(reuse));
        round(a);
        JSONObject row = a.h.serverRow();
        report("W4 after a round the household is a house: the server is the signed owner, and its server row is there",
            !a.h.isHouse() || row == null || !house.equals(row.optString("home")) || !a.h.paired(), "owner " + a.h.owner() + ", row " + row);

        s(b).join3(web(house, "invite", "Sarah's phone"), false);
        s(c).join3(web(house, "invite", "Spare phone"), false);
        rounds(a, b, c);
        report("W5 a phone's things reach the others through the server", !"Vegemite".equals(has(b, "a-own")) || !"Vegemite".equals(has(c, "a-own")), "b " + has(b, "a-own") + ", c " + has(c, "a-own"));
        report("W6 only the first phone seeds the household settings", !"1".equals(a.e.meta("seed_settings")) || b.e.meta("seed_settings") != null, "a " + a.e.meta("seed_settings") + ", b " + b.e.meta("seed_settings"));

        // ---------- what this phone shares, both directions ----------
        item(a, "a-keg", "Pale ale", "keg");
        item(b, "b-keg", "Cider", "keg");
        rounds(a, b, c);
        report("W7 a tab a phone doesn't share stays on it (Keg off on both)", has(c, "a-keg") != null || has(c, "b-keg") != null, "c has " + has(c, "a-keg") + "/" + has(c, "b-keg"));
        a.e.setMeta("tabs", "pantry,keg");
        a.e.noteTabs();
        c.e.setMeta("tabs", "pantry,keg");
        c.e.noteTabs();
        rounds(a, b, c);
        report("W8 Keg turned on: the house gets it, and phones sharing Keg see it; one that doesn't, doesn't",
            !"Pale ale".equals(has(c, "a-keg")) || has(b, "a-keg") != null, "c " + has(c, "a-keg") + ", b " + has(b, "a-keg"));
        JSONObject file = SyncFolder.open(SyncFolder.serverKey(a.h.key()), listed(a).read(SyncFolder.fileFor("a1")));
        report("W9 the phone's file says what it shares", file.optJSONObject("shares") == null || !file.getJSONObject("shares").getJSONArray("tabs").toString().contains("keg"), String.valueOf(file.opt("shares")));

        // 0.9.4 final fixes: c makes a Keg item and a changes it (so a is the last to change it); b
        // shares Keg for a while (so it has a's), then stops, keeping its copies.
        item(c, "c-keg2", "Porter", "keg");
        rounds(c, a);
        a.db.exec("UPDATE items SET name = 'Porter (dark)' WHERE id = 'c-keg2'");
        b.e.setMeta("tabs", "pantry,keg");
        b.e.noteTabs();
        rounds(a, b, c);
        rounds(a, b, c);
        boolean bHad = "Pale ale".equals(has(b, "a-keg")) && "Porter (dark)".equals(has(b, "c-keg2"));
        String madeBy = a.one("SELECT origin FROM sync_log WHERE tbl = 'items' AND pk = 'c-keg2'") + "/" + a.one("SELECT origin FROM sync_log WHERE tbl = 'items' AND pk = 'a-keg'");
        report("W9b who made a record travels with it, and stays through someone else's change",
            !"c3/a1".equals(madeBy) || !bHad || !"Porter (dark)".equals(has(c, "c-keg2")), "made by " + madeBy + ", b had them " + bHad + ", c " + has(c, "c-keg2"));
        b.e.setMeta("tabs", "pantry");
        b.e.noteTabs();
        rounds(b);

        // a's own Keg product, its price and a Keg list line (and a pantry price, which stays out of it).
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('dm-1', 'danmurphys', 'Pale ale 6 pack', 'x')");
        a.db.exec("INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, source) VALUES ('dm-1', '2026-11-01T00:00:00.000Z', 21.5, NULL, 0, 0, 'check')");
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('co-1', 'coles', 'Bread', 'x')");
        a.db.exec("INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, source) VALUES ('co-1', '2026-11-01T00:00:00.000Z', 3.5, NULL, 0, 0, 'check')");
        a.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('a-line', 'Ice', 0, 1, 'x', 'keg')");
        rounds(a, c);

        // Keg off with "Also take what this phone shared off the server".
        a.e.setMeta("tabs", "pantry");
        a.e.setTakeBack("keg", true);
        a.e.noteTabs();
        List<JSONObject> back = a.e.takeBackEntries();
        StringBuilder backPks = new StringBuilder();
        StringBuilder backAll = new StringBuilder();
        for (JSONObject x : back) {
            if ("items".equals(x.optString("tbl"))) backPks.append(x.optString("pk")).append(' ');
            backAll.append(x.optString("tbl")).append(':').append(x.optString("pk")).append(' ');
        }
        String ba = backAll.toString();
        report("W10e what's taken back is this phone's own Keg items, products, prices and list lines (found a table at a time), nothing on another tab",
            !ba.contains("products:dm-1 ") || !ba.contains("prices:dm-1|2026-11-01") || !ba.contains("list_entries:a-line ") || ba.contains("co-1") || ba.contains("a-own"), ba);
        rounds(a, b, c);
        rounds(a, b, c);
        report("W10 turned off with \"Also take it off the server\": it goes from the house, and this phone keeps its own",
            has(c, "a-keg") != null || !"Pale ale".equals(has(a, "a-keg")), "c " + has(c, "a-keg") + ", a " + has(a, "a-keg"));
        report("W10c only what this phone made goes: another phone's record it changed last stays, on the house and on the phone that made it (its \"moved\" deletes don't take it either)",
            !backPks.toString().trim().equals("a-keg") || !"Porter (dark)".equals(has(c, "c-keg2")) || !"Porter (dark)".equals(has(a, "c-keg2")),
            "taken back: " + backPks + "; c " + has(c, "c-keg2") + ", a " + has(a, "c-keg2"));
        report("W10d the deletes don't reach a phone that doesn't share Keg: its own copy stays",
            !"Pale ale".equals(has(b, "a-keg")), "b " + has(b, "a-keg"));
        // Review fix: held there, and taken in once it shares Keg again, without the others sending the
        // delete again (they may have tidied it away by then, and its copy would bring it back).
        String held = b.one("SELECT COUNT(*) FROM sync_held WHERE tbl = 'items' AND pk = 'a-keg'");
        b.e.setMeta("tabs", "pantry,keg");
        b.e.noteTabs();
        String bAfter = has(b, "a-keg"), heldAfter = b.one("SELECT COUNT(*) FROM sync_held");
        b.e.setMeta("tabs", "pantry");
        b.e.noteTabs();
        report("W10f held on the phone that doesn't share Keg, and taken in when it shares Keg again",
            !"1".equals(held) || bAfter != null || !"0".equals(heldAfter), "held " + held + ", then b " + bAfter + ", held " + heldAfter);
        // Shared again: the deletes it sent are newer than its own copies, which must not lose to them.
        a.e.setMeta("tabs", "pantry,keg");
        a.e.setTakeBack("keg", false);
        a.e.noteTabs();
        rounds(a, c);
        rounds(a, c);
        report("W10b shared again after taking it back: this phone keeps its own, and the house gets it back",
            !"Pale ale".equals(has(a, "a-keg")) || !"Pale ale".equals(has(c, "a-keg")), "a " + has(a, "a-keg") + ", c " + has(c, "a-keg"));
        item(c, "c-keg", "Stout", "keg");
        c.e.setMeta("tabs", "pantry");
        c.e.noteTabs();
        rounds(a, c);
        c.e.setMeta("tabs", "pantry,keg");
        c.e.noteTabs();
        rounds(c);
        report("W11 turned off without it: what it shared stays on the server", !"Stout".equals(has(c, "c-keg")), "c " + has(c, "c-keg"));

        // ---------- removed: the server rekeys; the others get the key in keys/<device>.bin ----------
        int before = a.h.keyv();
        web(house, "remove", "b2");
        Thread.sleep(500);
        ServerSync.Round ra = round(a);
        ServerSync.Round rb = s(b).round(SyncFamily.NOW, System.currentTimeMillis());
        round(c);
        report("W12 a phone removed on the server's page: the others take the new key from keys/<device>.bin",
            a.h.keyv() <= before || c.h.keyv() != a.h.keyv() || !Arrays.equals(a.h.key(), c.h.key()) || !ra.rekeyed, "keyv " + before + " → a " + a.h.keyv() + ", c " + c.h.keyv());
        report("W13 the removed phone is told (401 removed), and keeps everything it had", !rb.removed || !"Vegemite".equals(has(b, "a-own")), "removed " + rb.removed + " (" + rb.error + ")");
        item(a, "a-after", "Bread", "pantry");
        rounds(a, c);
        report("W14 the others carry on with the new key", !"Bread".equals(has(c, "a-after")), "c " + has(c, "a-after"));
        // Wi-Fi between two v3 phones after the rekey: the same new key, so they find each other.
        item(c, "c-wifi", "Eggs", "pantry");
        String wifi = null;
        try {
            SyncFamily.sync(a, c);
        } catch (Exception e) {
            wifi = e.getMessage();
        }
        report("W15 Wi-Fi sync between two v3 phones after a rekey", wifi != null || !"Eggs".equals(has(a, "c-wifi")), wifi == null ? "a has " + has(a, "c-wifi") : wifi);

        // ---------- Keep data for: what's older than the house keeps isn't moved up ----------
        web(house, "keep", "3");
        Thread.sleep(500);
        long now = System.currentTimeMillis();
        a.db.exec("INSERT OR REPLACE INTO products (id, chain, name, created_at) VALUES ('p1', 'coles', 'Beans 420g', 'x')");
        for (long ago : new long[] { 150, 40, 1 })
            a.db.exec("INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, source) VALUES ('p1', ?, 2.10, 3.50, 0, 0, 'check')", ServerOffload.iso(now - ago * DAY));
        round(a);
        ServerSync.Round off = round(a);
        String m150 = ServerOffload.month(ServerOffload.iso(now - 150 * DAY)), m40 = ServerOffload.month(ServerOffload.iso(now - 40 * DAY));
        boolean in40 = archiveHas(a, m40, ServerOffload.iso(now - 40 * DAY)), in150 = archiveHas(a, m150, ServerOffload.iso(now - 150 * DAY));
        String left = a.one("SELECT COUNT(*) FROM prices WHERE product_id = 'p1'");
        report("W16 with Keep data for 3 months: a 40-day-old price moves to the server, a 150-day-old one is tidied here",
            a.h.serverRow() == null || !Integer.valueOf(3).equals(a.h.serverRow().opt("keepMonths")) || !in40 || in150 || !"1".equals(left),
            "keep " + (a.h.serverRow() == null ? null : a.h.serverRow().opt("keepMonths")) + ", archive 40 " + in40 + ", archive 150 " + in150 + ", left here " + left + (off.error != null ? " (" + off.error + ")" : ""));

        // ---------- 0.9.5: Auto delete takes any whole number of months (0.9.4 took 3, 6, 9 or 12) ----------
        web(house, "keep", "2");
        Thread.sleep(500);
        a.db.exec("INSERT OR REPLACE INTO products (id, chain, name, created_at) VALUES ('p2', 'coles', 'Oats 750g', 'x')");
        for (long ago : new long[] { 75, 40, 1 })
            a.db.exec("INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, source) VALUES ('p2', ?, 4.10, NULL, 0, 0, 'check')", ServerOffload.iso(now - ago * DAY));
        round(a);
        ServerSync.Round off2 = round(a);
        boolean in40b = archiveHas(a, ServerOffload.month(ServerOffload.iso(now - 40 * DAY)), ServerOffload.iso(now - 40 * DAY));
        boolean in75 = archiveHas(a, ServerOffload.month(ServerOffload.iso(now - 75 * DAY)), ServerOffload.iso(now - 75 * DAY));
        String left2 = a.one("SELECT COUNT(*) FROM prices WHERE product_id = 'p2'");
        Object km2 = a.h.serverRow() == null ? null : a.h.serverRow().opt("keepMonths");
        report("W16a with Auto delete after 2 months: the phone reads 2, a 40-day-old price moves to the server, a 75-day-old one is tidied here",
            !Integer.valueOf(2).equals(km2) || !in40b || in75 || !"1".equals(left2),
            "keep " + km2 + ", archive 40 " + in40b + ", archive 75 " + in75 + ", left here " + left2 + (off2.error != null ? " (" + off2.error + ")" : ""));

        // ---------- 0.9.5: Ask phones to resend: the phone's whole file once more, every price in it ----------
        // A price whose change is older than the file's 60 days (so it never went up), dated recently (so it isn't offloaded).
        a.db.exec("INSERT OR REPLACE INTO products (id, chain, name, created_at) VALUES ('p9', 'coles', 'Rice 1kg', 'x')");
        a.db.exec("INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, source) VALUES ('p9', ?, 3.20, NULL, 0, 0, 'check')", ServerOffload.iso(now - 10 * DAY));
        a.db.exec("UPDATE sync_log SET stamp = ? WHERE tbl = 'prices' AND pk LIKE 'p9%'", now - 70 * DAY);
        round(a);
        int pBefore = new JSONObject(web(house, "history", "p9")).getJSONArray("prices").length();
        JSONObject asked = new JSONObject(web(house, "resend"));
        round(a);
        int after = new JSONObject(web(house, "history", "p9")).getJSONArray("prices").length();
        String resent = a.e.meta("server_resent");
        round(a);
        int again = new JSONObject(web(house, "history", "p9")).getJSONArray("prices").length();
        JSONObject twice = new JSONObject(web(house, "resend"));
        report("W16b Ask phones to resend: the phone sends every price it has once (nothing doubles); asking again the same day is refused",
            pBefore != 0 || asked.optInt("status") != 200 || after != 1 || again != 1 || resent == null || !resent.equals(String.valueOf(s(a).resendAsked(System.currentTimeMillis()))) || twice.optInt("status") != 429,
            "before " + pBefore + ", asked " + asked + ", after " + after + ", again " + again + ", resent " + resent + ", twice " + twice.optInt("status"));
        // 0.9.5 (review): a resend that fails isn't tried every round (it sends everything): a day later once, a size refusal not again.
        {
            long rAt = s(a).resendAsked(System.currentTimeMillis()), tNow = System.currentTimeMillis();
            a.e.setMeta("server_resent", null);
            s(a).resendFailed(rAt, tNow, new Exception("Can't reach your Restock server."));
            String w1 = a.e.meta("server_resend_wait"), r1 = a.e.meta("server_resent");
            s(a).resendFailed(rAt, tNow, new Exception("Can't reach your Restock server."));
            String r2 = a.e.meta("server_resent");
            a.e.setMeta("server_resent", null);
            s(a).resendFailed(rAt, tNow, new Exception("The server says a file is too big, or it's full."));
            String r3 = a.e.meta("server_resent");
            a.e.setMeta("server_resent", resent);
            report("W16c a resend that fails waits a day, then is answered; one too big for the server is answered at once",
                w1 == null || r1 != null || !String.valueOf(rAt).equals(r2) || !String.valueOf(rAt).equals(r3), "wait " + w1 + ", then " + r1 + "/" + r2 + ", too big " + r3);
        }

        // ---------- leaving: nothing is deleted on the server, unless it takes back what it shared ----------
        rounds(a, c);
        boolean aHadStout = "Stout".equals(has(a, "c-keg"));
        // Leaving with Keg ticked in the Leave sheet (and receipts, which it doesn't share: nothing to do there).
        // Review fix: a first try that couldn't reach the server already turned Keg off and is taking
        // it back; trying again must still reach the server before leaving.
        c.e.stopSharingAndTakeBack(new java.util.HashSet<>(Arrays.asList("keg")));
        s(c).takeBackBeforeLeaving(new java.util.HashSet<>(Arrays.asList("keg", "receipts")), SyncFamily.NOW, System.currentTimeMillis());
        String cTabs = c.e.meta("tabs");
        s(c).leave3();
        c.h.forget();
        Thread.sleep(1600);
        String phones = web(house, "phones");
        rounds(a);
        report("W17 a phone that leaves shows as Left; what it shared stays", !phones.contains("\"left\"") || !"Eggs".equals(has(a, "c-wifi")),
            phones.length() > 200 ? phones.substring(0, 200) + "…" : phones);
        report("W17b leaving with Keg ticked takes back its own Keg things first (it keeps them); its groceries and other people's Keg things stay",
            !aHadStout || has(a, "c-keg") != null || !"Stout".equals(has(c, "c-keg")) || !"Pale ale".equals(has(a, "a-keg")) || !"pantry".equals(cTabs),
            "a had Stout " + aHadStout + ", a now " + has(a, "c-keg") + ", c " + has(c, "c-keg") + ", a's own " + has(a, "a-keg") + ", c tabs " + cTabs);

        // ---------- a phone leaving its household to join (combine) ----------
        SyncFamily.Phone e = phone("e5"), f = phone("f6");
        e.h.create("Flat", "E");
        SyncFamily.join(e, f);
        item(e, "a-own", "Marmite", "pantry"); // the same record as the house's, older here
        e.db.exec("UPDATE sync_log SET stamp = 1 WHERE pk = 'a-own'");
        item(e, "e-own", "Rice", "pantry");
        e.db.exec("INSERT OR REPLACE INTO products (id, chain, name, created_at) VALUES ('e-prod', 'coles', 'Oats 1kg', 'x')");
        e.db.exec("INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, source) VALUES ('e-prod', ?, 3.10, 3.10, 0, 0, 'check')", ServerOffload.iso(System.currentTimeMillis() - DAY));
        e.h.startLeaving();
        e.h.forget();
        s(e).join3(web(house, "invite", "E's phone"), false);
        rounds(e, a);
        rounds(e, a);
        report("W18 a phone that left its household joins and combines: the house's copy wins, its own things go up",
            !"Vegemite".equals(has(e, "a-own")) || !"Rice".equals(has(a, "e-own")), "e has " + has(e, "a-own") + ", a has " + has(a, "e-own") + "; e log " + e.db.query("SELECT stamp, device FROM sync_log WHERE pk = 'a-own'") + ", a log " + a.db.query("SELECT stamp, device FROM sync_log WHERE pk = 'a-own'"));
        String ePrices = a.one("SELECT COUNT(*) FROM prices WHERE product_id = 'e-prod'");
        report("W18b its recent prices go up too (they don't give way: a server file carries only recently stamped prices)", !"1".equals(ePrices), "a has " + ePrices + " of e's prices");

        // ---------- what a v3 file carries besides: specials the phone fetched ----------
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('specials', ?)", new JSONArray().put(new JSONObject().put("chain", "coles").put("at", "2026-11-09T00:00:00Z").put("items",
            new JSONArray().put(new JSONObject().put("storeProductId", "1").put("name", "Tim Tam 200g").put("price", 2.75).put("wasPrice", 5.5).put("promo", "1/2 price").put("isSpecial", true).put("secret", "x")))).toString());
        round(a);
        JSONObject f2 = SyncFolder.open(SyncFolder.serverKey(a.h.key()), listed(a).read(SyncFolder.fileFor("a1")));
        JSONObject sp = f2.optJSONObject("specials");
        report("W19 the phone's server file carries the specials it fetched (only the listed fields)",
            sp == null || !sp.toString().contains("Tim Tam") || sp.toString().contains("secret"), String.valueOf(sp));
        // A shop on a tab it doesn't share (Pharmacy): neither its specials nor its catalogue go up.
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", new JSONObject().put("historyWeeks", 4).put("enabledChains", new JSONArray().put("coles").put("chemistwarehouse")).toString());
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('catalogue:coles', ?)", new JSONObject().put("url", "https://www.coles.com.au/catalogues").toString());
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('catalogue:chemistwarehouse', ?)", new JSONObject().put("url", "https://www.chemistwarehouse.com.au/catalogue").toString());
        a.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('specials', ?)", new JSONArray()
            .put(new JSONObject().put("chain", "coles").put("at", "2026-11-09T00:00:00Z").put("items", new JSONArray().put(new JSONObject().put("name", "Tim Tam 200g").put("price", 2.75))))
            .put(new JSONObject().put("chain", "chemistwarehouse").put("at", "2026-11-09T00:00:00Z").put("items", new JSONArray().put(new JSONObject().put("name", "Sunscreen 200ml").put("price", 9.99)))).toString());
        round(a);
        JSONObject f3 = SyncFolder.open(SyncFolder.serverKey(a.h.key()), listed(a).read(SyncFolder.fileFor("a1")));
        String sp3 = String.valueOf(f3.opt("specials")), ca3 = String.valueOf(f3.opt("catalogues"));
        report("W19b a Pharmacy tab it keeps to itself: no Pharmacy specials or catalogue in its file (the groceries' still go)",
            sp3.contains("Sunscreen") || ca3.contains("chemistwarehouse") || !sp3.contains("Tim Tam") || !ca3.contains("coles"), sp3 + " " + ca3);
    }

    // ---------- 0.9.5: the General list through the house, with a phone still on 0.9.4 ----------

    static void generalScenarios() throws Exception {
        SyncFamily.Phone g = phone("g7"), r = phone("r8");
        s(g).join3(web(house, "invite", "G's phone"), false);
        s(r).join3(web(house, "invite", "R's phone"), false);
        rounds(g, r);
        SyncTest095.line(g, "gs-chop", "Chopsticks", "general");
        SyncTest095.line(g, "gs-tea", "Tea", "pantry");
        rounds(g, r);
        rounds(g, r);
        report("GV1 a General line goes through the house to a phone sharing groceries, as General",
            !"general".equals(SyncTest095.sectionOf(r, "gs-chop")) || !"pantry".equals(SyncTest095.sectionOf(r, "gs-tea")), "r " + SyncTest095.sectionOf(r, "gs-chop"));
        String old = System.getenv("RESTOCK_OLD094");
        if (old == null || old.isEmpty()) {
            System.out.println("  (the 0.9.4 phone on the house skipped: no v094 tag here)");
            return;
        }
        String[] op = old.split(";");
        String dbFile = op[1] + "/old094-server.db";
        new java.io.File(dbFile).delete();
        try (SyncTest095.Old q = new SyncTest095.Old(op[0], op[1], dbFile, "q9srv")) {
            JSONObject j = q.send("join3 " + web(house, "invite", "Old phone"));
            JSONObject r1 = q.send("round");
            Thread.sleep(1600);
            JSONObject r2 = q.send("round");
            JSONObject l = q.lines();
            report("GV2 a 0.9.4 phone on the house: no problem, it gets the groceries, the General line isn't on any of its lists",
                j.has("problem") || !r2.isNull("error") || !l.has("gs-tea") || l.has("gs-chop"), j + " " + r1 + " " + r2 + " " + l.keySet());
            q.send("line qs-own - Bread");
            q.send("tick gs-tea");
            q.send("round");
            Thread.sleep(1600);
            rounds(g, r);
            SyncTest095.line(g, "gs-late", "Tape", "general");
            rounds(g, r);
            q.send("round");
            Thread.sleep(1600);
            q.send("round");
            JSONObject l2 = q.lines();
            report("GV3 its changes come through the house, the General lines stay as they were (on the house too), and still none reach it",
                !"Bread".equals(g.one("SELECT text FROM list_entries WHERE id = 'qs-own'")) || !"1".equals(g.one("SELECT checked FROM list_entries WHERE id = 'gs-tea'"))
                    || !"general".equals(SyncTest095.sectionOf(g, "gs-chop")) || !"general".equals(SyncTest095.sectionOf(r, "gs-late")) || l2.has("gs-chop") || l2.has("gs-late"),
                "g qs-own " + SyncTest095.sectionOf(g, "qs-own") + ", r gs-late " + SyncTest095.sectionOf(r, "gs-late") + ", old " + l2.keySet());
            q.quit();
        }
        // The old phone updates: its database, opened by this version. Its first round reads the house's file again.
        SyncFamily.Phone b = new SyncFamily.Phone("q9srv", new TestDb(SyncFamily.dir, dbFile, true), "server");
        b.e.photos = new SyncTest091.MapPhotos();
        ServerSync.Round rb = round(b);
        round(b);
        report("GV4 updated, it reads the house's file again once: the General lines come in, on General",
            rb.error != null || !"general".equals(SyncTest095.sectionOf(b, "gs-chop")) || !"general".equals(SyncTest095.sectionOf(b, "gs-late")) || !"1".equals(b.one("SELECT checked FROM list_entries WHERE id = 'gs-tea'")),
            "error " + rb.error + ", gs-chop " + SyncTest095.sectionOf(b, "gs-chop") + ", gs-late " + SyncTest095.sectionOf(b, "gs-late"));
        b.db.exec("UPDATE list_entries SET checked = 1, checked_at = 11 WHERE id = 'gs-chop'");
        round(b);
        rounds(g);
        report("GV5 and its ticks on General go through the house", !"1".equals(g.one("SELECT checked FROM list_entries WHERE id = 'gs-chop'")), "g gs-chop " + g.one("SELECT checked FROM list_entries WHERE id = 'gs-chop'"));
        b.db.close();
    }

    static ServerFolder listed(SyncFamily.Phone p) throws Exception {
        ServerFolder f = s(p).open();
        f.names();
        return f;
    }

    static boolean archiveHas(SyncFamily.Phone p, String month, String date) throws Exception {
        ServerFolder f = listed(p);
        byte[] b = f.read(ServerOffload.archiveName(p.e.device(), month));
        if (b == null) return false;
        for (byte[] k : s(p).fileKeys()) {
            try {
                JSONObject a = SyncFolder.open(k, b);
                return a.optJSONArray("prices") != null && a.getJSONArray("prices").toString().contains(date);
            } catch (Exception wrongKey) {
                // the next one
            }
        }
        return false;
    }

    /** A phone on 0.9.3 (tools/sync-test/old/OldServerPhone.java, compiled against the v093 tag), driven over stdin. */
    static final class Old implements AutoCloseable {
        final Process p;
        final java.io.BufferedReader r;
        final java.io.Writer w;

        Old(String classes, String dir) throws Exception {
            p = new ProcessBuilder("java", "-cp", classes, "family.plenty.restock.OldServerPhone", dir).redirectError(ProcessBuilder.Redirect.INHERIT).start();
            r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            w = new java.io.OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8);
        }

        JSONObject send(String cmd) throws Exception {
            w.write(cmd + "\n");
            w.flush();
            String line;
            while ((line = r.readLine()) != null) if (line.startsWith("{")) return new JSONObject(line);
            throw new Exception("the old phone stopped");
        }

        public void close() {
            p.destroy();
        }
    }

    /** A phone's Wi-Fi listener, as SyncHub runs it (on this computer's own address). */
    static SyncWire.Server listen(SyncFamily.Phone p) throws Exception {
        return new SyncWire.Server(p.h::serverKeys, (m, host, which) -> p.h.handle(m, host, which), java.net.InetAddress.getLoopbackAddress());
    }

    // ---------- a 0.9.3 household on a server in v2 mode, handed over ----------

    static void handoverScenarios() throws Exception {
        web(v2, "setup2");
        SyncFamily.Phone o = phone("o1"), m = phone("m2");
        o.h.create("The Plenty house", "Declan");
        o.h.setHouseholdTabs(new java.util.LinkedHashSet<>(Arrays.asList("pantry")));
        SyncFamily.join(o, m);
        s(o).join(web(v2, "invite2"));
        s(m).join(web(v2, "invite2"));
        // 0.9.3: a phone still on 0.9.3 in the same household and on the same server (when it's been built).
        String oldPath = System.getenv("RESTOCK_OLD093");
        Old q = null;
        if (oldPath != null && !oldPath.isEmpty()) {
            String[] op = oldPath.split(";");
            q = new Old(op[0], op[1]);
            SyncWire.Server lo = listen(o);
            JSONObject paired = q.send("pair " + o.h.invite("127.0.0.1", lo.port()));
            JSONObject joined = q.send("server " + web(v2, "invite2"));
            q.send("item q-own Honey");
            JSONObject qr = q.send("round");
            lo.stop();
            report("O1 a phone on 0.9.3 joins the household and the v2 server", !paired.optBoolean("paired") || joined.has("problem") || !qr.isNull("error"), paired + " " + joined + " " + qr);
        }
        item(m, "m-own", "Milk", "pantry");
        // m runs the household's Home Assistant (0.9.3's ha:phone row names it): only that phone's
        // upgrade may hand Home Assistant to the server (H9).
        m.e.db.exec("INSERT OR REPLACE INTO household_settings (k, v) VALUES ('ha:phone', ?)", JSONObject.quote(m.e.device()));
        rounds(o, m);
        report("H1 a 0.9.3-style household syncs through the v2 server", !"Milk".equals(has(o, "m-own")), "o has " + has(o, "m-own"));
        JSONObject hl = s(o).health();
        report("H2 the owner phone sees a 0.9.4 server waiting for its household (mode v2)", hl == null || !"v2".equals(hl.optString("mode")), String.valueOf(hl));

        String wrong = null;
        try {
            s(o).handOver(web(v2, "handover").replace("t=", "t=AAAA"));
        } catch (Exception e) {
            wrong = e.getMessage();
        }
        report("H3 a damaged code: nothing changes, this phone is still the owner", wrong == null || !o.h.isOwner() || o.e.meta("owner_secrets") == null, String.valueOf(wrong));

        s(o).handOver(web(v2, "handover"));
        report("H4 after the server's 200 the phone is still the owner (it lets go only on the server's signed change)", !o.h.isOwner() || o.e.meta("owner_priv") == null, "owner " + o.h.owner());
        ServerSync.Round r = round(o);
        report("H5 the owner phone upgrades to v3, reads the server's owner change and lets go of the owner's secrets",
            !r.upgraded || !o.h.isHouse() || o.e.meta("owner_secrets") != null || o.e.meta("owner_priv") != null || !"3".equals(o.e.meta("server_api")),
            "upgraded " + r.upgraded + ", owner " + o.h.owner() + ", secrets " + (o.e.meta("owner_secrets") != null) + (r.error != null ? " (" + r.error + ")" : ""));
        // m is the household's Home Assistant phone (what HomeAssistant.java would hand over), and never scanned a v3 code.
        ServerSync.haSource = () -> new JSONObject().put("address", "http://127.0.0.1:9").put("entity", "todo.shopping_list").put("enabled", true)
            .put("token", "abcdefghijklmnopqrstuvwxyz0123456789").put("state", new JSONObject().put("pairs", new JSONArray()));
        ServerSync.Round rm;
        try {
            rm = round(m);
        } finally {
            ServerSync.haSource = null;
        }
        report("H6 another phone already on the server upgrades without a code, and keeps sharing what it shared",
            !rm.upgraded || !"3".equals(m.e.meta("server_api")) || !m.h.isHouse() || !"Milk".equals(has(m, "m-own")) || !"0".equals(m.e.meta("share_receipts")),
            "upgraded " + rm.upgraded + ", api " + m.e.meta("server_api") + ", receipts " + m.e.meta("share_receipts") + (rm.error != null ? " (" + rm.error + ")" : ""));
        report("H8 a phone that carried on keeps sharing only what the household shared (so widening later adds nothing by itself)",
            !"pantry".equals(m.e.meta("tabs")) || !"pantry".equals(o.e.meta("tabs")), "m " + m.e.meta("tabs") + ", o " + o.e.meta("tabs"));
        item(o, "o-after", "Bread", "pantry");
        rounds(o, m);
        report("H7 after the handover the phones sync through the house", !"Bread".equals(has(m, "o-after")), "m has " + has(m, "o-after"));
        String haRow = m.one("SELECT v FROM household_settings WHERE k = 'ha:phone'");
        report("H9 the Home Assistant phone's upgrade hands it to the server (sealed, once the server's key is shown to be the house's)",
            haRow == null || !haRow.contains("srv-"), "ha:phone " + haRow);
        if (q != null) {
            JSONObject qr = q.send("round");
            String err = qr.optString("error", "");
            report("O2 the 0.9.3 phone is paused with the update words, and nothing is forgotten",
                !err.contains("Update Restock to keep syncing with your server") || !qr.optBoolean("on") || !qr.optBoolean("paired"), qr.toString());
            SyncWire.Server lm = listen(m);
            item(m, "m-wifi", "Tea", "pantry");
            JSONObject wq = q.send("wifi 127.0.0.1 " + lm.port());
            String got = q.send("has m-wifi").optString("name", null);
            lm.stop();
            report("O3 it still syncs over the Wi-Fi with a 0.9.4 phone (same key, same SyncWire)", wq.has("problem") || !"Tea".equals(got) || !"Honey".equals(has(m, "q-own")),
                wq + "; old phone has " + got + ", m has " + has(m, "q-own"));
            q.close();
        }
    }

    // ---------- a Wi-Fi household brought onto a new, empty server; its other phone joins through the household ----------

    static void bringScenarios() throws Exception {
        web(fresh, "setup", "Our flat");
        SyncFamily.Phone w = phone("w1"), x = phone("x2"), v = phone("v5");
        w.h.create("Flatmates", "W");
        SyncFamily.join(w, x);
        SyncFamily.join(w, v);
        item(x, "x-own", "Coffee", "pantry");
        SyncFamily.sync(x, w);
        item(v, "v-own", "Tea", "pantry");
        SyncFamily.sync(v, w);
        String hid = w.h.hid();
        byte[] key = w.h.key();
        JSONObject gift = s(w).join3(web(fresh, "invite", "W's phone"), true);
        report("B1 the owner phone brings its Wi-Fi household onto an empty server: the same household and key",
            !hid.equals(gift.getJSONObject("household").optString("hid")) || !Arrays.equals(key, w.h.key()), "hid " + gift.getJSONObject("household").optString("hid") + " (" + hid + ")");
        round(w);
        report("B2 the owner lets go once it reads the server's signed owner change", !w.h.isHouse() || w.e.meta("owner_secrets") != null, "owner " + w.h.owner());
        SyncFamily.sync(x, w);
        report("B3 the other phone learns over the Wi-Fi that the household now lives on the server", x.h.serverRow() == null || s(x).on(), "row " + x.h.serverRow());
        s(x).joinAsMember();
        rounds(x, w);
        report("B4 it joins through the household (signed with its own key, no code) and syncs through the server",
            !"3".equals(x.e.meta("server_api")) || !"Coffee".equals(has(w, "x-own")), "api " + x.e.meta("server_api") + ", w has " + has(w, "x-own"));
        // A second bring onto a house that isn't empty is turned down, and the code still works for a plain join.
        SyncFamily.Phone y = phone("y3"), z = phone("z4");
        y.h.create("Another", "Y");
        SyncFamily.join(y, z);
        String code = web(fresh, "invite", "Y's phone");
        boolean refused = false;
        try {
            s(y).join3(code, true);
        } catch (ServerFolder.NotEmptyException e) {
            refused = true;
        }
        report("B5 bringing a household onto a server that already has one is turned down; nothing changes", !refused || !y.h.isOwner() || s(y).on(), "refused " + refused);

        // A phone of the brought household that hasn't heard yet (no server row here) is given an Add a
        // phone code: it connects as the member it is (SyncHub.joinServer3 "leave" tries this first),
        // keeping its key and what it changed since its last sync, rather than leaving and giving way.
        item(v, "v-own", "Green tea", "pantry");
        boolean noRow = v.h.serverRow() == null;
        s(v).joinAsMember(web(fresh, "invite", "V's phone"));
        rounds(v, w);
        rounds(v, w);
        report("B6 a member that scans a code for its own household's server connects as a member: same key, its newer change kept",
            !noRow || !"3".equals(v.e.meta("server_api")) || !Arrays.equals(v.h.key(), w.h.key()) || !"Green tea".equals(has(v, "v-own")) || !"Green tea".equals(has(w, "v-own")),
            "api " + v.e.meta("server_api") + ", v " + has(v, "v-own") + ", w " + has(w, "v-own"));
        String other = null;
        try {
            s(y).joinAsMember(web(fresh, "invite", "Y again"));
        } catch (ServerFolder.NotMember nm) {
            other = nm.getMessage();
        }
        report("B7 a phone of another household is told it isn't a member (it then leaves and joins); nothing changes on it", other == null || s(y).on() || !y.h.isOwner(), String.valueOf(other));
    }
}
