package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.5: the General shopping list (list_entries.section 'general') between phones.
 *
 * - Between 0.9.5 phones it's shared with the groceries: a phone sharing groceries gets it, one
 *   sharing only Keg doesn't, and joining with "use the household's things" clears it with them.
 * - With a phone still on 0.9.4 (tools/sync-test/old/OldPhone094.java, compiled against the v094 tag,
 *   RESTOCK_OLD094 = "classes;dir"): it doesn't know General, takes a General line for a tab it
 *   doesn't share and passes it over (neither keeps nor logs it). So nothing crashes, nothing is lost
 *   (the line stays on the phones that have it, untouched by the old phone's own changes) and it
 *   never lands on another list. When the old phone updates (the same database opened by this
 *   version), its first sync reads everything again once (SyncEngine.catchUpLists), and the General
 *   lines come in.
 *
 * Arguments: the out dir.
 */
public class SyncTest095 {
    static int fails = 0;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    static void line(SyncFamily.Phone p, String id, String text, String section) throws Exception {
        p.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES (?, ?, 0, 1, 'x', ?)", id, text, section);
    }

    static String sectionOf(SyncFamily.Phone p, String id) throws Exception {
        List<JSONObject> r = p.db.query("SELECT section FROM list_entries WHERE id = ?", id);
        return r.isEmpty() ? null : r.get(0).isNull("section") ? "(none)" : r.get(0).getString("section");
    }

    /** A phone on 0.9.4, in its own process. */
    static final class Old implements AutoCloseable {
        final Process p;
        final java.io.BufferedReader r;
        final java.io.Writer w;

        Old(String classes, String dir, String dbFile, String device) throws Exception {
            p = new ProcessBuilder("java", "-cp", classes, "family.plenty.restock.OldPhone094", dir, dbFile, device).redirectError(ProcessBuilder.Redirect.INHERIT).start();
            r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            w = new java.io.OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8);
        }

        JSONObject send(String cmd) throws Exception {
            w.write(cmd + "\n");
            w.flush();
            String l;
            while ((l = r.readLine()) != null) if (l.startsWith("{")) return new JSONObject(l);
            throw new Exception("the old phone stopped");
        }

        /** Its lines: id → [text, section, checked]. */
        JSONObject lines() throws Exception {
            JSONArray a = send("lines").getJSONArray("lines");
            JSONObject o = new JSONObject();
            for (int i = 0; i < a.length(); i++) o.put(a.getJSONArray(i).getString(0), a.getJSONArray(i));
            return o;
        }

        void quit() throws Exception {
            send("quit");
            p.waitFor();
        }

        public void close() {
            p.destroy();
        }
    }

    static SyncWire.Server listen(SyncFamily.Phone p) throws Exception {
        return new SyncWire.Server(p.h::serverKeys, (m, host, which) -> p.h.handle(m, host, which), java.net.InetAddress.getLoopbackAddress());
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        newPhones();
        String old = System.getenv("RESTOCK_OLD094");
        if (old != null && !old.isEmpty()) oldPhone(old.split(";"));
        else System.out.println("  (the 0.9.4 phone checks skipped: no v094 tag here)");
        System.out.println(fails == 0 ? "0.9.5 General list: all passed" : "0.9.5 General list: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    /** Between 0.9.5 phones: General goes with the groceries. */
    static void newPhones() throws Exception {
        SyncFamily.Phone[] ps = SyncFamily.household("a1", "b2", "c3");
        SyncFamily.Phone a = ps[0], b = ps[1], c = ps[2];
        a.h.setHouseholdTabs(new java.util.LinkedHashSet<>(java.util.Arrays.asList("pantry", "keg", "pharmacy")));
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        // c shares only Keg.
        c.e.setMeta("tabs", "keg");
        c.e.noteTabs();
        line(a, "g-chop", "Chopsticks", "general");
        line(a, "k-ice", "Ice", "keg");
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        report("N1 a General line reaches a phone sharing groceries, as General", !"general".equals(sectionOf(b, "g-chop")), "b " + sectionOf(b, "g-chop"));
        report("N2 not a phone sharing only Keg (it goes with the groceries)", sectionOf(c, "g-chop") != null || !"keg".equals(sectionOf(c, "k-ice")),
            "c " + sectionOf(c, "g-chop") + ", ice " + sectionOf(c, "k-ice"));
        b.db.exec("UPDATE list_entries SET checked = 1, checked_at = 5 WHERE id = 'g-chop'");
        SyncFamily.sync(b, a);
        report("N3 a tick on General goes back", !"1".equals(a.one("SELECT checked FROM list_entries WHERE id = 'g-chop'")), "a checked " + a.one("SELECT checked FROM list_entries WHERE id = 'g-chop'"));
        report("N4 a 0.9.5 phone notes it has read everything again once (lists_v), and doesn't again",
            !SyncEngine.LISTS_V.equals(b.e.meta("lists_v")) || b.e.catchUpLists(), "lists_v " + b.e.meta("lists_v"));
        // Joining with "use the household's things": General goes with the groceries' things.
        SyncFamily.Phone d = new SyncFamily.Phone("d4");
        line(d, "d-gen", "Tape", "general");
        line(d, "d-keg", "Limes", "keg");
        d.e.clearForJoin(new java.util.LinkedHashSet<>(java.util.Arrays.asList("pantry")));
        report("N5 clearing for a join takes General's lines with the groceries, not Keg's", sectionOf(d, "d-gen") != null || !"keg".equals(sectionOf(d, "d-keg")),
            "d-gen " + sectionOf(d, "d-gen") + ", d-keg " + sectionOf(d, "d-keg"));

        // 0.9.5 (review): the one-time read again brings only General lines this phone never had:
        // a record it deleted long ago (the delete tidied away) doesn't come back from the other phone,
        // and what's newer than where it had got comes in as always.
        SyncFamily.Phone[] rs = SyncFamily.household("r1", "r2");
        SyncFamily.Phone r1 = rs[0], r2 = rs[1];
        r1.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('i-r', 'Deleted long ago', 'x', 'pantry')");
        line(r1, "g-r", "Batteries", "general");
        SyncFamily.sync(r2, r1);
        boolean had = "Deleted long ago".equals(r2.one("SELECT name FROM items WHERE id = 'i-r'")) && "general".equals(sectionOf(r2, "g-r"));
        // On r2: i-r gone long ago (no row, no change noted); g-r passed over as a 0.9.4 phone would; then the update.
        r2.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
        r2.db.exec("DELETE FROM items WHERE id = 'i-r'");
        r2.db.exec("DELETE FROM list_entries WHERE id = 'g-r'");
        r2.db.exec("DELETE FROM sync_log WHERE pk IN ('i-r', 'g-r')");
        r2.db.exec("DELETE FROM sync_meta WHERE key IN ('applying', 'lists_v')");
        r1.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('i-new', 'Added since', 'x', 'pantry')");
        SyncFamily.sync(r2, r1);
        report("N6 after the update, reading again brings only General lines never had: nothing deleted long ago comes back; newer changes as always",
            !had || r2.one("SELECT name FROM items WHERE id = 'i-r'") != null || !"general".equals(sectionOf(r2, "g-r")) || !"Added since".equals(r2.one("SELECT name FROM items WHERE id = 'i-new'"))
                || r2.e.meta("catchup_peer:r1") != null,
            "had " + had + ", i-r " + r2.one("SELECT name FROM items WHERE id = 'i-r'") + ", g-r " + sectionOf(r2, "g-r") + ", i-new " + r2.one("SELECT name FROM items WHERE id = 'i-new'"));
    }

    /** A phone still on 0.9.4 over the Wi-Fi, then updated. */
    static void oldPhone(String[] op) throws Exception {
        String dbFile = op[1] + "/old094-wifi.db";
        new java.io.File(dbFile).delete();
        SyncFamily.Phone a = new SyncFamily.Phone("a9");
        a.h.create("House", "Owner");
        SyncWire.Server la = listen(a);
        try (Old q = new Old(op[0], op[1], dbFile, "q9old")) {
            JSONObject paired = q.send("pair " + a.h.invite("127.0.0.1", la.port()));
            line(a, "p-milk", "Milk", "pantry");
            line(a, "g-chop", "Chopsticks", "general");
            line(a, "g-bat", "Batteries", "general");
            q.send("line o-bread - Bread");
            JSONObject w1 = q.send("wifi 127.0.0.1 " + la.port());
            JSONObject l1 = q.lines();
            report("G1 a 0.9.4 phone syncs with a General line about: no problem, it gets the groceries, not the General lines (not on any list)",
                !paired.optBoolean("paired") || w1.has("problem") || !l1.has("p-milk") || l1.has("g-chop") || l1.has("g-bat"), paired + " " + w1 + " " + l1.keySet());
            report("G2 and the 0.9.5 phone gets its line; its General lines are as they were", !"Bread".equals(a.one("SELECT text FROM list_entries WHERE id = 'o-bread'"))
                || !"general".equals(sectionOf(a, "g-chop")) || !"general".equals(sectionOf(a, "g-bat")), "o-bread " + sectionOf(a, "o-bread") + ", g-chop " + sectionOf(a, "g-chop"));
            // The old phone ticks the milk; a General line is ticked on the new one. Both go both ways,
            // and nothing the old phone sends touches the General lines.
            q.send("tick p-milk");
            a.db.exec("UPDATE list_entries SET checked = 1, checked_at = 7 WHERE id = 'g-bat'");
            line(a, "g-late", "Tape", "general");
            JSONObject w2 = q.send("wifi 127.0.0.1 " + la.port());
            JSONObject l2 = q.lines();
            report("G3 later syncs: the old phone's tick comes across, the General lines stay General and as they were, and still none reach the old phone",
                w2.has("problem") || !"1".equals(a.one("SELECT checked FROM list_entries WHERE id = 'p-milk'")) || !"general".equals(sectionOf(a, "g-bat"))
                    || !"1".equals(a.one("SELECT checked FROM list_entries WHERE id = 'g-bat'")) || l2.has("g-late") || l2.has("g-bat"),
                w2 + " " + l2.keySet() + ", a p-milk " + a.one("SELECT checked FROM list_entries WHERE id = 'p-milk'"));
            q.quit();
        }
        la.stop();
        // The old phone updates: its own database, opened by this version.
        SyncFamily.Phone b = new SyncFamily.Phone("q9old", new TestDb(SyncFamily.dir, dbFile, true), "folder");
        boolean before = b.e.meta("lists_v") == null;
        SyncFamily.sync(b, a);
        report("G4 updated, its first sync reads everything again once: the General lines come in, on General, as they are",
            !before || !"general".equals(sectionOf(b, "g-chop")) || !"general".equals(sectionOf(b, "g-bat")) || !"general".equals(sectionOf(b, "g-late"))
                || !"1".equals(b.one("SELECT checked FROM list_entries WHERE id = 'g-bat'")) || !SyncEngine.LISTS_V.equals(b.e.meta("lists_v")),
            "g-chop " + sectionOf(b, "g-chop") + ", g-bat " + sectionOf(b, "g-bat") + ", g-late " + sectionOf(b, "g-late") + ", lists_v " + b.e.meta("lists_v"));
        b.db.exec("UPDATE list_entries SET checked = 1, checked_at = 9 WHERE id = 'g-chop'");
        SyncFamily.sync(b, a);
        report("G5 and from then on General goes both ways", !"1".equals(a.one("SELECT checked FROM list_entries WHERE id = 'g-chop'")) || !"Bread".equals(b.one("SELECT text FROM list_entries WHERE id = 'o-bread'")),
            "a g-chop " + a.one("SELECT checked FROM list_entries WHERE id = 'g-chop'"));
        b.db.close();
    }
}
