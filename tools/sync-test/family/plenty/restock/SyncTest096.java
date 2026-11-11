package family.plenty.restock;

import java.util.List;
import org.json.JSONObject;

/**
 * 0.9.6: "Move to" a shopping list line between Groceries, Keg, Health and General (src/lib/moveLine.ts).
 *
 * No new record kind or field: the sync code here is 0.9.5's, unchanged, so these are also what a
 * 0.9.5 phone (and a 0.9.5 server, the same merge in engine.ts) does with a move.
 * - Between Groceries and General (one tab for sync): the line itself changes, the same id.
 * - Across tabs (to or from Keg or Health): the line is made again on the new list with a new id
 *   and the old one deleted. A changed line whose tab changes isn't seen by a phone not sharing the
 *   new tab through a folder or a server (one file for every phone): it would keep a stale copy on
 *   the old list. A delete is seen by everyone. Moved back (Undo), the old line comes back with its
 *   own id.
 *
 * Arguments: the out dir.
 */
public class SyncTest096 {
    static int fails = 0;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    static void line(SyncFamily.Phone p, String id, String text, String section, int qty) throws Exception {
        p.db.exec("INSERT INTO list_entries (id, text, checked, qty, qty_at, created_at, section) VALUES (?, ?, 0, ?, 1, 'x', ?)", id, text, qty, section);
    }

    /** What moveLine.ts writes: the line changed where it is (Groceries and General), or made again with a new id and the old one deleted. */
    static String move(SyncFamily.Phone p, String id, String section) throws Exception {
        List<JSONObject> r = p.db.query("SELECT * FROM list_entries WHERE id = ?", id);
        JSONObject o = r.get(0);
        String was = o.isNull("section") ? "pantry" : o.getString("section");
        boolean same = tab(was).equals(tab(section));
        if (same) {
            p.db.exec("UPDATE list_entries SET section = ?, item_id = NULL, category_id = NULL WHERE id = ?", section, id);
            return id;
        }
        String to = id + "-" + section;
        p.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section, checked_at, qty_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            to, o.getString("text"), o.optInt("checked"), o.optInt("qty", 1), o.getString("created_at"), section, System.currentTimeMillis(), System.currentTimeMillis());
        p.db.exec("DELETE FROM list_entries WHERE id = ?", id);
        return to;
    }

    /** Undo of a move across tabs: the new line off, the old one made again with its own id (undo.ts). */
    static void undoMove(SyncFamily.Phone p, JSONObject old, String made) throws Exception {
        p.db.exec("DELETE FROM list_entries WHERE id = ?", made);
        p.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section, checked_at, qty_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            old.getString("id"), old.getString("text"), old.optInt("checked"), old.optInt("qty", 1), old.getString("created_at"), old.isNull("section") ? null : old.getString("section"),
            old.optLong("checked_at"), old.optLong("qty_at"));
    }

    static String tab(String section) {
        return "keg".equals(section) || "pharmacy".equals(section) ? section : "pantry";
    }

    /** section/qty/checked, or "gone". */
    static String state(SyncFamily.Phone p, String id) throws Exception {
        List<JSONObject> r = p.db.query("SELECT section, qty, checked FROM list_entries WHERE id = ?", id);
        if (r.isEmpty()) return "gone";
        JSONObject o = r.get(0);
        return (o.isNull("section") ? "(none)" : o.getString("section")) + "/" + o.optInt("qty") + "/" + o.optInt("checked");
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        wifi();
        folder();
        System.out.println(fails == 0 ? "0.9.6 Move to: all passed" : "0.9.6 Move to: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    static SyncFamily.Phone[] house(String... ids) throws Exception {
        SyncFamily.Phone[] ps = SyncFamily.household(ids);
        ps[0].h.setHouseholdTabs(new java.util.LinkedHashSet<>(java.util.Arrays.asList("pantry", "keg", "pharmacy")));
        for (int i = 1; i < ps.length; i++) SyncFamily.sync(ps[i], ps[0]);
        // The last phone shares only Groceries (and so General).
        SyncFamily.Phone c = ps[ps.length - 1];
        c.e.setMeta("tabs", "pantry");
        c.e.noteTabs();
        return ps;
    }

    /** Phone to phone on the Wi-Fi. */
    static void wifi() throws Exception {
        SyncFamily.Phone[] ps = house("a1", "b2", "c3");
        SyncFamily.Phone a = ps[0], b = ps[1], c = ps[2];
        line(a, "m-ice", "Ice", "pantry", 3);
        line(a, "m-tape", "Tape", "general", 1);
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        boolean start = "pantry/3/0".equals(state(c, "m-ice")) && "general/1/0".equals(state(b, "m-tape"));
        JSONObject was = a.db.query("SELECT * FROM list_entries WHERE id = 'm-ice'").get(0);
        // Groceries to Keg, and General to Groceries.
        String ice = move(a, "m-ice", "keg");
        String tape = move(a, "m-tape", "pantry");
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        report("M1 Wi-Fi: a move reaches a phone sharing both lists, amount kept, nothing left behind",
            !start || !"keg/3/0".equals(state(b, ice)) || !"gone".equals(state(b, "m-ice")) || !"pantry/1/0".equals(state(b, tape)) || !tape.equals("m-tape"),
            "start " + start + ", b " + state(b, ice) + " old " + state(b, "m-ice") + ", tape " + state(b, tape));
        report("M2 Wi-Fi: a phone not sharing Keg sees it go off Groceries; General to Groceries is the same line, moved", !"gone".equals(state(c, "m-ice")) || !"gone".equals(state(c, ice)) || !"pantry/1/0".equals(state(c, tape)),
            "c " + state(c, "m-ice") + " " + state(c, ice) + " " + state(c, tape));
        SyncFamily.sync(c, b);
        SyncFamily.sync(c, a);
        SyncFamily.sync(b, a);
        report("M3 Wi-Fi: and that never takes it off the phones that share Keg", !"keg/3/0".equals(state(a, ice)) || !"keg/3/0".equals(state(b, ice)),
            "a " + state(a, ice) + ", b " + state(b, ice));
        // Undo on a: back on Groceries, the same line as before, on every phone.
        undoMove(a, was, ice);
        SyncFamily.sync(c, a);
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, b);
        report("M4 Wi-Fi: Undo puts the same line back on every phone, with its amount; the moved one goes",
            !"pantry/3/0".equals(state(c, "m-ice")) || !"pantry/3/0".equals(state(b, "m-ice")) || !"gone".equals(state(b, ice)) || !"pantry/3/0".equals(state(a, "m-ice")),
            "a " + state(a, "m-ice") + ", b " + state(b, "m-ice") + " " + state(b, ice) + ", c " + state(c, "m-ice"));
        // Ticked when moved: still ticked on the new list.
        line(a, "m-gum", "Gum", "pantry", 2);
        a.db.exec("UPDATE list_entries SET checked = 1, checked_at = 5 WHERE id = 'm-gum'");
        String gum = move(a, "m-gum", "pharmacy");
        SyncFamily.sync(b, a);
        report("M5 Wi-Fi: ticked stays ticked on the new list", !"pharmacy/2/1".equals(state(b, gum)) || !"gone".equals(state(b, "m-gum")), "b " + state(b, gum) + " old " + state(b, "m-gum"));
        // Groceries and General: a tick on one phone and a move on another both stay (the same line).
        line(a, "m-pegs", "Pegs", "pantry", 1);
        SyncFamily.sync(b, a);
        b.db.exec("UPDATE list_entries SET checked = 1, checked_at = 999999999999999 WHERE id = 'm-pegs'");
        Thread.sleep(5); // the move after the tick (in the same millisecond the higher device id wins, as for any change)
        move(a, "m-pegs", "general");
        SyncFamily.sync(b, a);
        SyncFamily.sync(c, a);
        report("M6 Wi-Fi: Groceries to General while another phone ticks it: both stay, on every phone", !"general/1/1".equals(state(a, "m-pegs")) || !"general/1/1".equals(state(b, "m-pegs")) || !"general/1/1".equals(state(c, "m-pegs")),
            "a " + state(a, "m-pegs") + ", b " + state(b, "m-pegs") + ", c " + state(c, "m-pegs"));
    }

    /** Through a shared folder (as through a Restock server: one file for every phone). */
    static void folder() throws Exception {
        SyncFamily.Phone[] ps = house("f1", "g2", "h3");
        SyncFamily.Phone a = ps[0], b = ps[1], c = ps[2];
        SyncFamily.MapFolder folder = new SyncFamily.MapFolder();
        line(a, "f-ice", "Ice", "pantry", 3);
        line(a, "f-tape", "Tape", "general", 2);
        for (int i = 0; i < 2; i++) for (SyncFamily.Phone x : ps) x.f.sync(folder, SyncFamily.NOW);
        boolean start = "pantry/3/0".equals(state(c, "f-ice")) && "pantry/3/0".equals(state(b, "f-ice"));
        JSONObject was = a.db.query("SELECT * FROM list_entries WHERE id = 'f-ice'").get(0);
        String ice = move(a, "f-ice", "keg");
        String tape = move(a, "f-tape", "pantry");
        for (int i = 0; i < 3; i++) for (SyncFamily.Phone x : ps) x.f.sync(folder, SyncFamily.NOW);
        report("F1 folder: a move reaches a phone sharing Keg, amount kept, nothing left on Groceries", !start || !"keg/3/0".equals(state(b, ice)) || !"gone".equals(state(b, "f-ice")),
            "start " + start + ", b " + state(b, ice) + " old " + state(b, "f-ice"));
        report("F2 folder: a phone not sharing Keg sees it go off Groceries (no stale copy)", !"gone".equals(state(c, "f-ice")) || !"gone".equals(state(c, ice)), "c " + state(c, "f-ice") + " " + state(c, ice));
        report("F3 folder: and that never takes it off the phones that share Keg; General to Groceries reaches all",
            !"keg/3/0".equals(state(a, ice)) || !"keg/3/0".equals(state(b, ice)) || !"pantry/2/0".equals(state(c, tape)),
            "a " + state(a, ice) + ", b " + state(b, ice) + ", c tape " + state(c, tape));
        undoMove(a, was, ice);
        for (int i = 0; i < 3; i++) for (SyncFamily.Phone x : ps) x.f.sync(folder, SyncFamily.NOW);
        report("F4 folder: Undo, it's back on every phone as the same line with its amount",
            !"pantry/3/0".equals(state(a, "f-ice")) || !"pantry/3/0".equals(state(b, "f-ice")) || !"pantry/3/0".equals(state(c, "f-ice")) || !"gone".equals(state(b, ice)),
            "a " + state(a, "f-ice") + ", b " + state(b, "f-ice") + " " + state(b, ice) + ", c " + state(c, "f-ice"));
    }
}
