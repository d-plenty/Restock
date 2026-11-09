package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.0: family scenarios from the outside review (each was a real problem in the first 0.9.0
 * build). Each must now come out right. Run by run.sh after SyncTest090.
 */
public class SyncFamily {
    static String dir;
    static int n = 0;
    static final String NOW = "2026-11-09T00:00:00Z";

    static int fails = 0;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    static final class Phone {
        final String id;
        final TestDb db;
        final SyncEngine e;
        final SyncHousehold h;
        final SyncFolder f;

        Phone(String id) throws Exception {
            this.id = id;
            db = new TestDb(dir);
            e = new SyncEngine(db);
            e.setMeta("device", id);
            e.setMeta("name", "Phone " + id);
            h = new SyncHousehold(e);
            f = new SyncFolder(e, h);
        }

        SyncEngine.Transport lan(Phone from) {
            return m -> {
                byte[] k = from.h.key();
                byte[] old = h.isOwner() ? h.oldKey() : null;
                int which = java.util.Arrays.equals(k, h.key()) ? SyncHousehold.CURRENT : old != null && java.util.Arrays.equals(k, old) ? SyncHousehold.OLD : -1;
                if (which < 0) throw new Exception("server hung up: key not accepted");
                return h.handle(m, "10.0.0." + id.charAt(0), which);
            };
        }

        SyncEngine.Transport pairing() {
            return m -> h.handle(m, "10.0.0." + id.charAt(0), SyncHousehold.PAIRING);
        }

        String one(String sql) throws Exception {
            List<JSONObject> r = db.query(sql);
            if (r.isEmpty()) return null;
            JSONObject o = r.get(0);
            String k = o.keys().next();
            return o.isNull(k) ? null : String.valueOf(o.get(k));
        }
    }

    static final class MapFolder implements SyncFolder.Folder {
        final Map<String, byte[]> files = new TreeMap<>();

        public List<String> names() {
            return new ArrayList<>(files.keySet());
        }

        public byte[] read(String name) {
            return files.get(name);
        }

        public void write(String name, byte[] data) {
            files.put(name, data);
        }
    }

    static void sync(Phone a, Phone b) throws Exception {
        SyncEngine.Result r = a.e.syncWith(b.lan(a), NOW, 0);
        if (r.rekey != null) {
            a.h.takeRekey(r.rekey);
            a.e.syncWith(b.lan(a), NOW, 0);
        }
        a.h.takeHandover();
        b.h.takeHandover();
    }

    static void join(Phone owner, Phone p) throws Exception {
        owner.h.invite("10.0.0.1", 47461);
        p.h.pairingKeyUsed = owner.h.openPairingKey();
        p.h.join(owner.pairing(), false);
        sync(p, owner);
    }

    static Phone[] household(String... ids) throws Exception {
        Phone[] ps = new Phone[ids.length];
        for (int i = 0; i < ids.length; i++) ps[i] = new Phone(ids[i]);
        ps[0].h.create("House", "Owner");
        for (int i = 1; i < ids.length; i++) join(ps[0], ps[i]);
        for (int i = 1; i < ids.length; i++) sync(ps[i], ps[0]);
        return ps;
    }

    public static void main(String[] args) throws Exception {
        dir = args[0];
        String only = args.length > 1 ? args[1] : "";
        if (only.isEmpty() || only.contains("T1")) t1SameStamp();
        if (only.isEmpty() || only.contains("T2")) t2ForgeOwner();
        if (only.isEmpty() || only.contains("T3")) t3KeysDowngrade();
        if (only.isEmpty() || only.contains("T4")) t4Lagging();
        if (only.isEmpty() || only.contains("T5")) t5TickLost();
        if (only.isEmpty() || only.contains("T6")) t6ReplayPush();
        if (only.isEmpty() || only.contains("T7")) t7RestoreCombine();
        if (only.isEmpty() || only.contains("T8")) t8SeqReuse();
        if (only.isEmpty() || only.contains("TA")) taSharedFolder();
        if (only.isEmpty() || only.contains("TB")) tbFolderSize();
        if (only.isEmpty() || only.contains("TC")) tcConflictCopy();
        if (only.isEmpty() || only.contains("TD")) tdDeleteVsEdit();
        if (only.isEmpty() || only.contains("TE")) teDoubleTakeover();
        System.out.println(fails == 0 ? "family scenarios: all passed" : "family scenarios: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    /** A phone whose clock is behind another's (or that saw a 2030 stamp) edits the same line twice: the second edit never leaves. */
    static void t1SameStamp() throws Exception {
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        // A's clock is 1 hour ahead (simulated: its stamps come out an hour in the future).
        a.e.setMeta("clock", String.valueOf(System.currentTimeMillis() + 3_600_000L));
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('l1', 'Milk', 0, 'x', 1, 'pantry')");
        sync(b, a);
        // B (correct clock) ticks Milk, syncs, then unticks it (wrong item) and syncs again.
        b.db.exec("UPDATE list_entries SET checked = 1 WHERE id = 'l1'");
        sync(b, a);
        String s1 = b.one("SELECT stamp FROM sync_log WHERE pk = 'l1'");
        b.db.exec("UPDATE list_entries SET checked = 0 WHERE id = 'l1'");
        String s2 = b.one("SELECT stamp FROM sync_log WHERE pk = 'l1'");
        sync(b, a);
        sync(a, b);
        String onA = a.one("SELECT checked FROM list_entries WHERE id = 'l1'");
        String onB = b.one("SELECT checked FROM list_entries WHERE id = 'l1'");
        report("T1 a second edit to the same line always reaches the others", !onA.equals(onB), "B stamps " + s1 + " then " + s2 + "; A shows checked=" + onA + ", B shows checked=" + onB);
    }

    /** A member claims the owner's device id on household entries: becomes owner, or kicks another phone out. */
    static void t2ForgeOwner() throws Exception {
        Phone[] p = household("a1", "b2", "c3");
        Phone a = p[0], b = p[1], c = p[2];
        long future = System.currentTimeMillis() + 10_000;
        JSONArray entries = new JSONArray();
        entries.put(new JSONObject().put("tbl", "household").put("pk", "removed:b2").put("stamp", future).put("device", "a1").put("deleted", false)
            .put("row", new JSONObject().put("k", "removed:b2").put("v", "1")));
        entries.put(new JSONObject().put("tbl", "household").put("pk", "member:b2").put("stamp", future).put("device", "a1").put("deleted", true));
        JSONObject push = new JSONObject().put("op", "push").put("device", "c3").put("entries", entries).put("top", 0).put("at", NOW);
        a.lan(c).send(push);
        boolean kicked = a.e.householdValue("removed:b2") != null;
        SyncEngine.Result r = b.e.syncWith(a.lan(b), NOW, 0);
        report("T2a a member can't remove another phone by pretending to be the owner", kicked && r.removed,
            "owner accepted removed:b2 from c3=" + kicked + "; b2 is then told removed=" + r.removed);
        // Now c makes itself the owner.
        Phone[] q = household("d4", "e5", "f6");
        Phone d = q[0], f = q[2];
        JSONArray en2 = new JSONArray();
        en2.put(new JSONObject().put("tbl", "household").put("pk", "owner").put("stamp", future).put("device", "d4").put("deleted", false)
            .put("row", new JSONObject().put("k", "owner").put("v", "f6")));
        d.lan(f).send(new JSONObject().put("op", "push").put("device", "f6").put("entries", en2).put("top", 0).put("at", NOW));
        report("T2b a member can't make itself the owner", "f6".equals(d.e.householdValue("owner")),
            "owner on d4 is now " + d.e.householdValue("owner") + "; d4 isOwner=" + d.h.isOwner());
    }

    /** The keys file's outer keyv isn't sealed: an old keys file with a bumped number sets a phone back to an old key. */
    static void t3KeysDowngrade() throws Exception {
        Phone[] p = household("p1", "q2", "r3", "s4");
        Phone o = p[0], q = p[1], s = p[3];
        MapFolder folder = new MapFolder();
        for (Phone x : p) x.f.sync(folder, NOW);
        o.h.remove("r3"); // keyv 2
        o.f.sync(folder, NOW);
        q.f.sync(folder, NOW);
        s.f.sync(folder, NOW);
        byte[] oldKeys = folder.files.get(o.f.keysFile()).clone();
        String k2 = q.e.meta("key");
        o.h.remove("s4"); // keyv 3; s4 still knows k2
        o.f.sync(folder, NOW);
        q.f.sync(folder, NOW);
        String before = q.e.meta("keyv");
        // Someone with write access to the folder (provider, or s4) puts back the old file with keyv 99.
        JSONObject forged = new JSONObject(new String(oldKeys, StandardCharsets.UTF_8));
        forged.put("keyv", 99);
        folder.files.put(o.f.keysFile(), forged.toString().getBytes(StandardCharsets.UTF_8));
        q.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('secret', 'Pregnancy test', 0, 'x', 1, 'pharmacy')");
        q.f.sync(folder, NOW);
        boolean down = k2.equals(q.e.meta("key"));
        boolean readable = false;
        try {
            JSONObject m = SyncFolder.open(SyncWire.decodeKey(k2), folder.files.get(SyncFolder.fileFor("q2")));
            readable = m.toString().contains("Pregnancy test");
        } catch (Exception ignored) {
        }
        o.f.sync(folder, NOW);
        boolean ownerRewrote = !new String(folder.files.get(o.f.keysFile()), StandardCharsets.UTF_8).contains("\"keyv\":99");
        report("T3 an old keys file put back can't set a phone back to an old key", down || readable || !ownerRewrote,
            "q2 keyv " + before + " -> " + q.e.meta("keyv") + "; removed s4 can read q2's new file=" + readable + "; owner repairs keys file=" + ownerRewrote);
    }

    /** A member away while two phones are removed can't get back in on the Wi-Fi. */
    static void t4Lagging() throws Exception {
        Phone[] p = household("a1", "b2", "c3", "d4");
        Phone a = p[0], c = p[1];
        a.h.remove("c3");
        a.h.remove("d4");
        // b2 was away the whole time (still keyv 1); real wire, real key list.
        SyncWire.Server srv = new SyncWire.Server(a.h::serverKeys, (m, host, which) -> a.h.handle(m, host, which));
        String err = null;
        try (SyncWire.Client cl = new SyncWire.Client(c.h.key(), "127.0.0.1", srv.port(), 2000)) {
            c.e.syncWith(cl, NOW, 0);
        } catch (Exception ex) {
            err = ex.getClass().getSimpleName() + ": " + ex.getMessage();
        }
        // 0.9.0: it asks the owner with its own secret, gets the newest key, and syncs.
        boolean got = false;
        String err2 = null;
        try (SyncWire.Client cl = new SyncWire.Client(java.util.Base64.getUrlDecoder().decode(c.e.meta("secret")), "127.0.0.1", srv.port(), 2000)) {
            got = c.h.askForKey(cl);
        } catch (Exception ex) {
            err2 = ex.toString();
        }
        try (SyncWire.Client cl = new SyncWire.Client(c.h.key(), "127.0.0.1", srv.port(), 2000)) {
            c.e.syncWith(cl, NOW, 0);
        } catch (Exception ex) {
            err2 = ex.toString();
        }
        srv.stop();
        report("T4 member away during two removals gets back in", !got || err2 != null || !"3".equals(c.e.meta("keyv")),
            "first try failed (expected): " + (err != null) + "; asked with its secret: " + got + "; keyv now " + c.e.meta("keyv") + (err2 == null ? "" : "; " + err2));
    }

    /** One person ticks an item while another changes its quantity: the whole row wins, the tick is lost. */
    static void t5TickLost() throws Exception {
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('l1', 'Milk', 0, 'x', 1, 'pantry')");
        sync(b, a);
        // As the app does it (db.ts updateListEntry): the tick and the quantity note when they changed.
        a.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'l1'", System.currentTimeMillis()); // in the shop
        Thread.sleep(5);
        b.db.exec("UPDATE list_entries SET qty = 2, qty_at = ? WHERE id = 'l1'", System.currentTimeMillis()); // at home, apart
        sync(b, a);
        sync(a, b);
        report("T5 a tick in the shop and a quantity change at home both survive", "0".equals(a.one("SELECT checked FROM list_entries WHERE id='l1'")),
            "A: checked=" + a.one("SELECT checked FROM list_entries WHERE id='l1'") + " qty=" + a.one("SELECT qty FROM list_entries WHERE id='l1'")
                + "; B: checked=" + b.one("SELECT checked FROM list_entries WHERE id='l1'"));
    }

    /** A captured push from A to B, replayed to C, moves C's cursor for A past changes C never got. */
    static void t6ReplayPush() throws Exception {
        Phone[] p = household("a1", "b2", "c3");
        Phone a = p[0], b = p[1], c = p[2];
        a.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('i1', 'Bread', 'x', 'pantry')");
        sync(a, b); // b has i1; c doesn't
        a.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('i2', 'Eggs', 'x', 'pantry')");
        final List<JSONObject> captured = new ArrayList<>();
        SyncEngine.Transport toB = b.lan(a);
        a.e.syncWith(m -> {
            if ("push".equals(m.optString("op"))) captured.add(new JSONObject(m.toString()));
            return toB.send(m);
        }, NOW, 0);
        // Attacker on the Wi-Fi replays the sealed push to C (same household key, no binding to B).
        for (JSONObject m : captured) c.lan(a).send(m);
        sync(c, a);
        sync(a, c);
        report("T6 a recorded message played to another phone does nothing", "0".equals(String.valueOf(c.db.query("SELECT 1 FROM items WHERE id='i1'").size())),
            "C has i1=" + c.db.query("SELECT 1 FROM items WHERE id='i1'").size() + " i2=" + c.db.query("SELECT 1 FROM items WHERE id='i2'").size()
                + " after normal syncs; captured " + captured.size() + " push(es)");
    }

    /** Leave, restore an old backup "on this phone only", rejoin with Combine: the household's newer edits are reverted. */
    static void t7RestoreCombine() throws Exception {
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        a.db.exec("INSERT INTO items (id, name, created_at, section, target_price) VALUES ('milk', 'Milk', 'x', 'pantry', 3.0)");
        a.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('gone', 'Old thing', 'x', 'pantry')");
        sync(b, a);
        // B stops syncing to restore on its own (Restore.tsx "Stop syncing and restore").
        b.h.startLeaving();
        sync(b, a);
        b.h.forget();
        // Meanwhile the household moves on.
        a.db.exec("UPDATE items SET target_price = 2.5, name = 'Milk 2L' WHERE id = 'milk'");
        a.db.exec("DELETE FROM items WHERE id = 'gone'");
        Thread.sleep(5);
        // B restores a backup from before (restoreParts: delete the tab's items, insert the backup's).
        b.db.exec("DELETE FROM items");
        b.db.exec("INSERT INTO items (id, name, created_at, section, target_price) VALUES ('milk', 'Milk', 'x', 'pantry', 3.0)");
        b.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('gone', 'Old thing', 'x', 'pantry')");
        // B joins again with Combine (replace = false), as SyncHub.join does.
        a.h.invite("10.0.0.1", 47461);
        b.h.pairingKeyUsed = a.h.openPairingKey();
        b.h.join(a.pairing(), false);
        b.e.yieldToHousehold();
        sync(b, a);
        report("T7 rejoining with Combine after a restore keeps the household's newer edits", "Milk".equals(a.one("SELECT name FROM items WHERE id='milk'")),
            "owner now has milk name=" + a.one("SELECT name FROM items WHERE id='milk'") + " target=" + a.one("SELECT target_price FROM items WHERE id='milk'")
                + ", deleted 'gone' back=" + a.db.query("SELECT 1 FROM items WHERE id='gone'").size());
    }

    /** forget() deletes the household's sync_log rows (the newest seqs): seq numbers are reused and peers skip them. */
    static void t8SeqReuse() throws Exception {
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        b.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('x', 'Rice', 'x', 'pantry')");
        sync(b, a);
        String topBefore = b.one("SELECT MAX(seq) FROM sync_log");
        b.h.startLeaving();
        sync(b, a); // the others see it go
        b.h.forget();
        String topAfter = b.one("SELECT MAX(seq) FROM sync_log");
        b.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('y', 'Pasta', 'x', 'pantry')");
        String ySeq = b.one("SELECT seq FROM sync_log WHERE pk='y'");
        a.h.invite("10.0.0.1", 47461);
        b.h.pairingKeyUsed = a.h.openPairingKey();
        b.h.join(a.pairing(), false); // Combine
        b.e.yieldToHousehold();
        sync(b, a);
        sync(a, b);
        int has = a.db.query("SELECT 1 FROM items WHERE id='y'").size();
        report("T8 a change made while out of the household arrives after rejoining", has == 0,
            "b2 max seq before leaving " + topBefore + "+household, after forget " + topAfter + ", new item seq " + ySeq + "; owner got-from-b2="
                + a.one("SELECT got FROM sync_peers WHERE device='b2'") + "; owner has 'Pasta'=" + has);
    }

    /** Two households pick the same folder: one keys file name, so one household's away phone never gets its new key. */
    static void taSharedFolder() throws Exception {
        Phone[] h1 = household("h1a", "h1b", "h1c");
        Phone[] h2 = household("h2a", "h2b", "h2c");
        MapFolder folder = new MapFolder();
        for (Phone x : h1) x.f.sync(folder, NOW);
        for (Phone x : h2) x.f.sync(folder, NOW);
        h1[0].h.remove("h1c");
        h1[0].f.sync(folder, NOW);
        h2[0].h.remove("h2c");
        h2[0].f.sync(folder, NOW);
        h1[0].f.sync(folder, NOW); // h1's owner doesn't notice its keys file was replaced
        h1[1].f.sync(folder, NOW);
        h2[1].f.sync(folder, NOW);
        report("TA two households in one folder keep their own keys files", !"2".equals(h1[1].e.meta("keyv")) || !"2".equals(h2[1].e.meta("keyv")),
            "h1b keyv=" + h1[1].e.meta("keyv") + ", h2b keyv=" + h2[1].e.meta("keyv") + "; keys files " + folder.files.keySet().stream().filter(n -> n.contains("keys")).count());
    }

    /** How big the full-state file gets after a year of normal use, and that it's rewritten for one tick. */
    static void tbFolderSize() throws Exception {
        Phone[] p = household("a1", "b2");
        Phone a = p[0];
        MapFolder folder = new MapFolder();
        a.db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 800) "
            + "INSERT INTO products (id, chain, name, brand, size, store_product_id, image_url, created_at) SELECT 'p' || lower(hex(randomblob(8))), 'woolworths', "
            + "'Product name number ' || i, 'Brand', '1kg', CAST(100000 + i AS TEXT), 'https://cdn0.woolworths.media/content/wowproductimages/large/' || (100000 + i) || '.jpg', '2026-01-01T00:00:00.000Z' FROM n");
        a.db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) "
            + "INSERT INTO items (id, name, created_at, section, usual_product_id, same_product_ids) SELECT lower(hex(randomblob(16))), 'Item ' || i, '2026-01-01T00:00:00.000Z', 'pantry', "
            + "(SELECT id FROM products WHERE rowid = i), '[\"' || (SELECT id FROM products WHERE rowid = i + 400) || '\"]' FROM n");
        a.db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) "
            + "INSERT INTO list_entries (id, text, checked, created_at, qty, section) SELECT lower(hex(randomblob(16))), 'Line ' || i, 0, '2026-01-01T00:00:00.000Z', 1, 'pantry' FROM n");
        a.f.sync(folder, NOW);
        int fresh = folder.files.get(SyncFolder.fileFor("a1")).length;
        // A year of shopping: about 60 lines a week added, ticked and cleared (deletes stay as tombstones).
        a.db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3120) "
            + "INSERT INTO sync_log (tbl, pk, stamp, device, deleted, seq) SELECT 'list_entries', lower(hex(randomblob(16))), 1760000000000 + i * 10000, 'a1', 1, (SELECT MAX(seq) FROM sync_log) + i FROM n");
        a.f.sync(folder, NOW);
        int year = folder.files.get(SyncFolder.fileFor("a1")).length;
        String logRows = a.one("SELECT COUNT(*) FROM sync_log");
        a.db.exec("UPDATE list_entries SET checked = 1 WHERE rowid = 1");
        SyncFolder.Result r = a.f.sync(folder, NOW);
        report("TB folder file size (information)", false, "fresh " + fresh / 1024 + " KB sealed; after a year of tombstones " + year / 1024 + " KB (" + logRows
            + " sync_log rows); one tick rewrote the whole file=" + r.wrote);
    }

    /** Syncthing/Nextcloud conflict copies match the file pattern: read and applied (old state). */
    static void tcConflictCopy() throws Exception {
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        MapFolder folder = new MapFolder();
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('l1', 'Milk', 0, 'x', 1, 'pantry')");
        a.f.sync(folder, NOW);
        byte[] old = folder.files.get(SyncFolder.fileFor("a1"));
        b.f.sync(folder, NOW);
        a.db.exec("DELETE FROM list_entries WHERE id = 'l1'");
        a.f.sync(folder, NOW);
        folder.files.put("restock-sync-a1.sync-conflict-20261109-101010-ABCDEFG.bin", old);
        b.f.sync(folder, NOW);
        report("TC a sync-conflict copy doesn't bring back a deleted line", b.db.query("SELECT 1 FROM list_entries WHERE id='l1'").size() == 1,
            "b2 has Milk after conflict copy=" + b.db.query("SELECT 1 FROM list_entries WHERE id='l1'").size() + "; seen-marks kept: "
                + b.db.query("SELECT key FROM sync_meta WHERE key LIKE 'folder_seen:%'").size());
    }

    /** A deletes an item (and its product, as the app does); B, apart, changes the item's target price. */
    static void tdDeleteVsEdit() throws Exception {
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('pc', 'coles', 'Coffee 1kg', 'x')");
        a.db.exec("INSERT INTO items (id, name, created_at, section, usual_product_id) VALUES ('coffee', 'Coffee', 'x', 'pantry', 'pc')");
        sync(b, a);
        a.db.exec("DELETE FROM items WHERE id = 'coffee'");
        a.db.exec("DELETE FROM products WHERE id = 'pc'");
        Thread.sleep(5);
        b.db.exec("UPDATE items SET target_price = 12 WHERE id = 'coffee'");
        sync(b, a);
        sync(a, b);
        boolean item = !a.db.query("SELECT 1 FROM items WHERE id='coffee'").isEmpty() && !b.db.query("SELECT 1 FROM items WHERE id='coffee'").isEmpty();
        boolean prod = !a.db.query("SELECT 1 FROM products WHERE id='pc'").isEmpty() || !b.db.query("SELECT 1 FROM products WHERE id='pc'").isEmpty();
        report("TD a delete beats an edit made without knowing about it", item && !prod, "item on both=" + item + ", its product anywhere=" + prod);
    }

    /** Owner lost; two members use the recovery key while apart. */
    static void teDoubleTakeover() throws Exception {
        Phone[] p = household("a1", "b2", "c3", "d4");
        Phone a = p[0], b = p[1], c = p[2], d = p[3];
        for (int i = 1; i < 4; i++) sync(p[i], a);
        String key = a.h.recovery();
        b.h.takeOver(key);
        c.h.takeOver(key);
        sync(d, b);
        sync(d, c);
        sync(b, c);
        sync(c, b);
        report("TE two takeovers at once: the household agrees on one owner", !b.h.owner().equals(c.h.owner()),
            "b2 thinks owner=" + b.h.owner() + ", c3 thinks owner=" + c.h.owner() + ", d4 thinks owner=" + d.h.owner());
    }
}
