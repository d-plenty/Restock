package family.plenty.restock;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONObject;

/** 0.9.0 sync checks: the recovery key and folder sync. Run with the TestDb bridge. */
public class SyncTest090 {
    static String dir;
    static int fails = 0;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + what);
        if (!ok) fails++;
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

        /** Talks to this phone as `from` would on the Wi-Fi: the key `from` has picks how it's opened. */
        SyncEngine.Transport lan(Phone from) {
            return m -> {
                byte[] k = from.h.key();
                byte[] old = h.isOwner() ? h.oldKey() : null;
                int which = java.util.Arrays.equals(k, h.key()) ? SyncHousehold.CURRENT : old != null && java.util.Arrays.equals(k, old) ? SyncHousehold.OLD : -1;
                if (which < 0) throw new Exception("couldn't open it");
                return h.handle(m, "10.0.0." + id.charAt(0), which);
            };
        }

        SyncEngine.Transport pairing() {
            return m -> h.handle(m, "10.0.0." + id.charAt(0), SyncHousehold.PAIRING);
        }

        String owner() throws Exception {
            return h.owner();
        }

        int count(String sql) throws Exception {
            return db.query(sql).size();
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
        SyncEngine.Result r = a.e.syncWith(b.lan(a), "2026-11-09T00:00:00Z", 0);
        if (r.rekey != null) {
            a.h.takeRekey(r.rekey);
            a.e.syncWith(b.lan(a), "2026-11-09T00:00:00Z", 0);
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

    public static void main(String[] args) throws Exception {
        dir = args[0];
        System.out.println("recovery key");
        Phone a = new Phone("a1"), b = new Phone("b2"), c = new Phone("c3");
        a.h.create("Our house", "A");
        String key = a.h.recovery();
        check(key != null && key.matches("[A-Z2-7]{4}(-[A-Z2-7]{4}){7}"), "a new household has a recovery key: " + key);
        check(!a.h.recoverySaved(), "not marked saved yet");
        join(a, b);
        join(a, c);
        sync(b, a);
        check(b.e.householdValue("recovery") != null && b.e.householdValue("owner_pub") != null, "the other phones have the sealed copy and the owner key");
        check(b.h.recovery() == null, "only the owner can show the key");
        try {
            b.h.takeOver("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
            check(false, "a wrong key is refused");
        } catch (IllegalArgumentException ex) {
            check(ex.getMessage().contains("isn't this household's"), "a wrong key is refused: " + ex.getMessage());
        }
        try {
            b.h.takeOver("ABCD");
            check(false, "a short key is refused");
        } catch (IllegalArgumentException ex) {
            check(true, "a short key is refused");
        }
        // The owner phone is lost: B takes over with the key, typed in lower case with spaces.
        b.h.takeOver(key.toLowerCase().replace('-', ' '));
        check(b.h.isOwner(), "B is the owner");
        String key2 = b.h.recovery();
        check(key2 != null && !key2.equals(key), "B has a new recovery key to save");
        sync(c, b);
        check("b2".equals(c.owner()), "C accepts B as the owner");
        // The lost phone turns up again: it accepts the change and lets go.
        sync(a, b);
        check("b2".equals(a.owner()) && !a.h.isOwner() && a.h.recovery() == null, "A, back again, isn't the owner and forgets the key");
        // C tries the same trick without the key: refused (its change isn't signed with the owner key).
        c.db.exec("INSERT OR REPLACE INTO household (k, v) VALUES ('owner', 'c3')");
        sync(b, c);
        check("b2".equals(b.owner()), "a phone can't make itself the owner without the key");
        c.db.exec("INSERT OR REPLACE INTO household (k, v) VALUES ('owner', 'b2')");
        // B can manage the household: remove the lost phone A.
        b.h.remove("a1");
        check(b.e.householdValue("member:a1") == null, "B removes the lost phone");
        sync(c, b);
        check("2".equals(c.e.meta("keyv")), "C gets the new key");
        // Old key takeover: the old key can't be used by A any more.
        try {
            a.h.takeOver(key);
            check(false, "the old key stops working");
        } catch (Exception ex) {
            check(true, "the old key stops working after a new one: " + ex.getMessage());
        }
        // Handing over passes the key along.
        b.h.setRecoverySaved();
        b.h.handOver("c3");
        sync(c, b);
        sync(b, c);
        check(c.h.isOwner() && key2.equals(c.h.recovery()) && c.h.recoverySaved(), "handing over passes the recovery key on");
        check(b.h.recovery() == null, "and the old owner forgets it");

        System.out.println("folder sync");
        Phone p = new Phone("d4"), q = new Phone("e5"), r = new Phone("f6");
        p.h.create("Flat", "P");
        join(p, q);
        join(p, r);
        MapFolder folder = new MapFolder();
        p.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('milk', 'Milk', 'x', 'pantry')");
        p.db.exec("INSERT INTO list_entries (id, text, item_id, checked, created_at, qty) VALUES ('l1', 'Milk', 'milk', 0, 'x', 1)");
        p.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('pr1', 'coles', 'Milk 2L', 'x')");
        p.db.exec("INSERT INTO prices (product_id, date, price, source) VALUES ('pr1', '2026-11-09', 3.1, 'check')");
        SyncFolder.Result pr = p.f.sync(folder, "t1");
        check(pr.wrote && folder.files.containsKey("restock-sync-d4.bin"), "P writes its file");
        String text = new String(folder.files.get("restock-sync-d4.bin"), "ISO-8859-1");
        check(!text.contains("Milk"), "the file can't be read without the key");
        SyncFolder.Result qr = q.f.sync(folder, "t2");
        check(qr.received > 0 && q.count("SELECT 1 FROM list_entries WHERE id = 'l1'") == 1, "Q, away from home, gets the list through the folder");
        check(q.count("SELECT 1 FROM prices") == 0, "prices stay out of the folder");
        // Q ticks it off; P sees it.
        q.db.exec("UPDATE list_entries SET checked = 1 WHERE id = 'l1'");
        q.f.sync(folder, "t3");
        p.f.sync(folder, "t4");
        check(p.count("SELECT 1 FROM list_entries WHERE id = 'l1' AND checked = 1") == 1, "a tick on Q reaches P");
        SyncFolder.Result again = p.f.sync(folder, "t5");
        check(again.received == 0 && !again.wrote, "nothing new: nothing taken in or written");
        // A delete travels too.
        p.db.exec("DELETE FROM list_entries WHERE id = 'l1'");
        p.f.sync(folder, "t6");
        q.f.sync(folder, "t7");
        check(q.count("SELECT 1 FROM list_entries WHERE id = 'l1'") == 0, "a delete reaches Q");
        // The owner removes R. Q is away and only has the folder.
        p.h.remove("f6");
        p.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty) VALUES ('l2', 'Bread', 0, 'x', 1)");
        p.f.sync(folder, "t8");
        check(folder.files.containsKey(p.f.keysFile()), "the owner leaves the new key for the others");
        SyncFolder.Result q2 = q.f.sync(folder, "t9");
        check(q2.rekeyed && "2".equals(q.e.meta("keyv")), "Q takes the new key from the folder");
        check(q.count("SELECT 1 FROM list_entries WHERE id = 'l2'") == 1, "and reads P's new file");
        r.f.sync(folder, "t10");
        check(r.count("SELECT 1 FROM list_entries WHERE id = 'l2'") == 0, "the removed phone can't read it");
        r.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty) VALUES ('evil', 'Nope', 0, 'x', 1)");
        r.f.sync(folder, "t11");
        p.f.sync(folder, "t12");
        check(p.count("SELECT 1 FROM list_entries WHERE id = 'evil'") == 0, "nothing from the removed phone gets in");
        // Recovery through the folder: Q takes over, P hears about it from the folder.
        String pk = p.h.recovery();
        q.h.takeOver(pk);
        q.f.sync(folder, "t13");
        p.f.sync(folder, "t14");
        check("e5".equals(p.owner()) && !p.h.isOwner(), "a takeover reaches the old owner through the folder");
        System.out.println("pairing (0.9.0)");
        Phone w = new Phone("k1"), jn = new Phone("l2"), dup = new Phone("l2");
        w.h.create("Wire", "W");
        String code = w.h.invite("127.0.0.1", 0);
        SyncWire.Server srv = new SyncWire.Server(w.h::serverKeys, (m, host, which) -> w.h.handle(m, host, which));
        byte[] wk = SyncHousehold.pairingKey(SyncWire.unbase32(SyncHousehold.parseCode(code)[0]));
        jn.h.pairingKeyUsed = wk;
        try (SyncWire.Client cl = new SyncWire.Client(wk, "127.0.0.1", srv.port(), 2000)) {
            jn.h.join(cl, false);
        }
        check(jn.h.paired() && java.util.Arrays.equals(jn.h.key(), w.h.key()), "joins over the Wi-Fi with a fresh key exchange");
        check(w.e.householdValue("member:l2") != null && jn.e.meta("owner_pin") != null, "the owner has it as a member, and it knows the owner key");
        String code2 = w.h.invite("127.0.0.1", 0);
        byte[] pk2 = SyncHousehold.pairingKey(SyncWire.unbase32(SyncHousehold.parseCode(code2)[0]));
        dup.h.pairingKeyUsed = pk2;
        String why = null;
        try (SyncWire.Client cl = new SyncWire.Client(pk2, "127.0.0.1", srv.port(), 2000)) {
            dup.h.join(cl, false);
        } catch (Exception ex) {
            why = ex.getMessage();
        }
        check(why != null && why.contains("already in this household"), "a phone can't join as one that's already a member: " + why);
        srv.stop();

        System.out.println("takeover edge cases");
        Phone o = new Phone("g7"), x = new Phone("h8"), y = new Phone("i9"), z = new Phone("j0");
        o.h.create("Edge", "O");
        join(o, x);
        join(o, y);
        join(o, z);
        sync(x, o);
        sync(y, o);
        String ok = o.h.recovery();
        // The owner asks X to take over; X gets the request but hasn't acted on it when the owner is lost.
        o.h.handOver("h8");
        x.e.syncWith(o.lan(x), "2026-11-09T00:00:00Z", 0);
        check(x.e.householdValue("handover:h8") != null && !x.h.isOwner(), "X has the request, not yet acted on");
        // Y takes over with the recovery key.
        y.h.takeOver(ok);
        sync(x, y);
        check("i9".equals(x.owner()) && !x.h.isOwner(), "the old request doesn't make X a second owner");
        check(x.e.householdValue("handover:h8") == null, "and the request is gone");
        sync(z, y);
        check("i9".equals(z.owner()), "everyone agrees on the new owner");
        System.out.println(fails == 0 ? "all passed" : fails + " failed");
        for (Phone ph : new Phone[] { a, b, c, p, q, r, o, x, y, z, w, jn, dup }) ph.db.close();
        System.exit(fails == 0 ? 0 : 1);
    }
}
