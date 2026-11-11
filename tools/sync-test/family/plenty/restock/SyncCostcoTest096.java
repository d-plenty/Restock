package family.plenty.restock;

import java.util.List;
import org.json.JSONObject;

/**
 * 0.9.6 (review H1, L2): Costco and the shared shopping list and items, phone to phone (SyncEngine.java;
 * engine.ts does the same, src/stores/costcoReview096.test.ts).
 * - A list line an earlier build put at Costco is an ordinary line: it is shared as "Any shop" (no
 *   Costco shop, price or product leaves the phone), its tick reaches the others, and a delete from
 *   another phone takes it off. The phone that has it at Costco keeps that while the others only
 *   change the tick or amount.
 * - Taking a Costco pick out of an item that goes to another phone leaves that phone's own usual pick.
 *
 * Arguments: the out dir.
 */
public class SyncCostcoTest096 {
    static int fails = 0;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    static String line(SyncFamily.Phone p, String id) throws Exception {
        List<JSONObject> r = p.db.query("SELECT chain, price, product, checked, qty FROM list_entries WHERE id = ?", id);
        if (r.isEmpty()) return "gone";
        JSONObject o = r.get(0);
        return (o.isNull("chain") ? "any" : o.getString("chain")) + "/" + (o.isNull("price") ? "-" : String.valueOf(o.get("price"))) + "/"
            + (o.isNull("product") ? "-" : "product") + "/" + o.optInt("checked") + "/" + o.optInt("qty");
    }

    static String everything(SyncFamily.Phone p) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (String t : new String[] { "list_entries", "products", "prices", "items" }) sb.append(p.db.query("SELECT * FROM " + t).toString());
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        SyncFamily.Phone[] ps = SyncFamily.household("a1", "b2");
        SyncFamily.Phone a = ps[0], b = ps[1];

        // C1: a shared Coles line, then switched to Costco on a (as an earlier 0.9.6 build let it).
        a.db.exec("INSERT INTO list_entries (id, text, chain, price, checked, qty, qty_at, created_at, section) VALUES ('cl-milk', 'Milk', 'coles', 3.1, 0, 1, 1, 'x', 'pantry')");
        SyncFamily.sync(b, a);
        boolean start = "coles/3.1/-/0/1".equals(line(b, "cl-milk"));
        a.db.exec("UPDATE list_entries SET chain = 'costco', price = 9.99, product = ? WHERE id = 'cl-milk'",
            "{\"chain\":\"costco\",\"name\":\"Milk 3 x 2L\",\"storeProductId\":\"51210\"}");
        a.db.exec("INSERT INTO list_entries (id, text, chain, price, product, checked, qty, qty_at, created_at, section) VALUES ('cl-nuts', 'Nuts', 'costco', 23.99, ?, 0, 1, 1, 'x', NULL)",
            "{\"chain\":\"costco\",\"name\":\"Nuts 1.13kg\",\"storeProductId\":\"277790\"}");
        SyncFamily.sync(b, a);
        report("C1 a line switched to Costco reaches the other phone as Any shop (no Costco shop, price or product)",
            !start || !"any/-/-/0/1".equals(line(b, "cl-milk")) || !"any/-/-/0/1".equals(line(b, "cl-nuts")),
            "start " + start + ", b " + line(b, "cl-milk") + " " + line(b, "cl-nuts"));
        String bAll = everything(b);
        report("C2 nothing about Costco left the phone", bAll.contains("costco") || bAll.contains("9.99") || bAll.contains("23.99") || bAll.contains("51210"),
            bAll.length() + " chars");
        report("C3 the phone that put it at Costco keeps that", !"costco/9.99/product/0/1".equals(line(a, "cl-milk")), "a " + line(a, "cl-milk"));

        // C4: a tick on a reaches b.
        a.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'cl-milk'", System.currentTimeMillis());
        SyncFamily.sync(b, a);
        report("C4 a tick on the Costco line reaches the other phone", !"any/-/-/1/1".equals(line(b, "cl-milk")), "b " + line(b, "cl-milk"));

        // C5: b changes the amount (all it can see is Any shop): a takes it, and keeps its own Costco details.
        Thread.sleep(5);
        b.db.exec("UPDATE list_entries SET qty = 3, qty_at = ? WHERE id = 'cl-nuts'", System.currentTimeMillis());
        SyncFamily.sync(b, a);
        report("C5 another phone's change comes in, never ignored; this phone keeps its Costco details", !"costco/23.99/product/0/3".equals(line(a, "cl-nuts")),
            "a " + line(a, "cl-nuts"));

        // C6: b picks a real shop: that wins on a.
        Thread.sleep(5);
        b.db.exec("UPDATE list_entries SET chain = 'woolworths' WHERE id = 'cl-nuts'");
        SyncFamily.sync(b, a);
        report("C6 a shop picked on another phone replaces Costco", !line(a, "cl-nuts").startsWith("woolworths/"), "a " + line(a, "cl-nuts"));

        // C7: b clears the Costco line: it goes off a too.
        Thread.sleep(5);
        b.db.exec("DELETE FROM list_entries WHERE id = 'cl-milk'");
        SyncFamily.sync(b, a);
        report("C7 a delete from another phone takes the Costco line off this phone", !"gone".equals(line(a, "cl-milk")), "a " + line(a, "cl-milk"));

        // C8 (review L2): b's own usual pick stays when a sends the item without its Costco pick.
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('p-w', 'woolworths', 'Pasta 500g', 'x')");
        a.db.exec("INSERT INTO items (id, name, usual_product_id, same_product_ids, alert_level, created_at) VALUES ('g-pasta', 'Pasta', 'p-w', '[]', 'good', 'x')");
        SyncFamily.sync(b, a);
        b.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('p-c2', 'coles', 'Pasta 1kg', 'x')");
        Thread.sleep(5);
        b.db.exec("UPDATE items SET usual_product_id = 'p-c2', same_product_ids = '[\"p-w\"]' WHERE id = 'g-pasta'");
        SyncFamily.sync(b, a);
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('p-cc', 'costco', 'Pasta 10 x 500g', 'x')");
        Thread.sleep(5);
        a.db.exec("UPDATE items SET usual_product_id = 'p-cc', name = 'Pasta shapes' WHERE id = 'g-pasta'");
        SyncFamily.sync(b, a);
        String bu = b.one("SELECT usual_product_id FROM items WHERE id = 'g-pasta'");
        String bn = b.one("SELECT name FROM items WHERE id = 'g-pasta'");
        String au = a.one("SELECT usual_product_id FROM items WHERE id = 'g-pasta'");
        report("C8 a Costco usual pick is left out: the other phone keeps its own, the rest of the change comes in",
            !"p-c2".equals(bu) || !"Pasta shapes".equals(bn) || !"p-cc".equals(au), "b " + bu + " " + bn + ", a " + au);

        System.out.println(fails == 0 ? "0.9.6 Costco and the shared list: all passed" : "0.9.6 Costco and the shared list: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
