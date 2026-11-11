package family.plenty.restock;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.6: Deals.java against the shared answers in tools/sync-test/deals-fixtures-096.json (a product with an
 * unknown size sits out of the cheapest comparison), which src/lib/dealsParity096.test.ts checks on the
 * TypeScript side. Run through tools/sync-test/deals-parity.sh.
 */
public class DealsTest096 {
    public static void main(String[] args) throws Exception {
        JSONObject f = new JSONObject(new String(Files.readAllBytes(Path.of(args[0])), "UTF-8"));
        long now = java.time.OffsetDateTime.parse(f.getString("now")).toInstant().toEpochMilli();
        JSONArray cases = f.getJSONArray("cases");
        int failures = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            Map<String, Deals.Product> products = new HashMap<>();
            Map<String, List<Deals.Reading>> readings = new HashMap<>();
            JSONArray ps = c.getJSONArray("products");
            for (int j = 0; j < ps.length(); j++) {
                JSONObject p = ps.getJSONObject(j);
                String id = p.getString("id");
                products.put(id, new Deals.Product(id, p.getString("chain"), p.getString("name"), p.optString("size", null), null, null));
                List<Deals.Reading> rs = new ArrayList<>();
                rs.add(new Deals.Reading(java.time.Instant.ofEpochMilli(now).toString(), p.getDouble("price"), null, false, false));
                readings.put(id, rs);
            }
            JSONArray main = c.getJSONArray("main");
            List<String> same = new ArrayList<>();
            for (int j = 1; j < main.length(); j++) same.add(main.getString(j));
            List<String> alts = new ArrayList<>();
            JSONArray as = c.getJSONArray("alts");
            for (int j = 0; j < as.length(); j++) alts.add(as.getString(j));
            Deals.Item item = new Deals.Item("g", "Thing", main.getString(0), same, alts, null, "any");
            Deals.Recommendation rec = Deals.recommend(item, products, readings, new HashSet<>(), now);
            String best = rec.best == null ? null : rec.best.product.id;
            String action = rec.action.name().toLowerCase();
            if (!c.getString("best").equals(best) || !c.getString("action").equals(action)) {
                failures++;
                System.out.println("FAIL " + c.getString("name") + ": want " + c.getString("best") + "/" + c.getString("action") + ", got " + best + "/" + action);
            }
        }
        System.out.println(failures == 0 ? "deals parity ok (" + cases.length() + " cases)" : failures + " failures");
        System.exit(failures == 0 ? 0 : 1);
    }
}
