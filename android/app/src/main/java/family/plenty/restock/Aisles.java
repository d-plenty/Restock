package family.plenty.restock;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.10.2: aisle numbers, as the shops give them for a branch. Only Coles does (its products'
 * "locations", for the store asked about); Woolworths' website gives an online category instead, and
 * Aldi and Costco don't publish aisles. No Android here, so tools/sync-test/aisle-parity.sh can check
 * it against aisles.ts with the same answers (tools/sync-test/aisle-fixtures-0102.json).
 */
final class Aisles {
    private Aisles() {}

    /**
     * The first of a Coles product's locations with an aisle: {"a": aisle, "side": its side, "o": order}.
     * {} when Coles says aisle information isn't available, null when there are no locations at all
     * (its online store). Mirrors colesAisle in src/stores/coles.ts.
     */
    static JSONObject coles(JSONObject p) {
        JSONArray locs = p.optJSONArray("locations");
        if (locs == null) return null;
        JSONObject out = new JSONObject();
        for (int i = 0; i < locs.length(); i++) {
            JSONObject l = locs.optJSONObject(i);
            if (l == null) continue;
            String a = text(l, "aisle");
            if (a == null || "0".equals(a)) continue;
            try {
                out.put("a", cut(a, 24));
                String side = text(l, "aisleSide");
                if (side != null) out.put("side", cut(side, 16));
                Object o = l.opt("order");
                if (o instanceof Number) out.put("o", ((Number) o).intValue());
                else if (o instanceof String && ((String) o).trim().matches("-?\\d{1,6}")) out.put("o", Integer.parseInt(((String) o).trim()));
            } catch (Exception ignored) {
                // a value JSON can't hold: left out
            }
            break;
        }
        return out;
    }

    private static String text(JSONObject o, String key) {
        Object v = o.opt(key);
        if (v == null || v == JSONObject.NULL) return null;
        String s = String.valueOf(v).trim();
        return s.isEmpty() || "null".equalsIgnoreCase(s) ? null : s;
    }

    private static String cut(String s, int n) {
        return s.length() > n ? s.substring(0, n) : s;
    }
}
