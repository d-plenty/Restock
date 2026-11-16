package family.plenty.restock;

import org.json.JSONObject;

/**
 * 0.11.3: what a price check notices about a product besides its price, kept on this phone only (kv
 * "shelfWatch", like "aisles"): {"<product id>": {"miss": {"since", "last", "n", "why"}, "saw": {"size", "name", "at"}}}.
 *
 * - "miss": the shop didn't have the product when asked. "gone": its own page for that product number
 *   answered "not found" (Woolworths). "unlisted": a search for its name no longer lists that product
 *   number (Coles and Aldi, which are looked up by searching). Counted once a day, and wiped the moment
 *   the product is found again. Never from "out of stock", a block, a timeout or any other failure: those
 *   aren't answers. The app (lib/shelfWatch.ts) says "no longer sold" only after it has repeated.
 * - "saw": the shop now gives another size (or name) for the same product number than the one kept. The
 *   app works out whether the amount really changed (500 g to 450 g) and says so.
 *
 * No Android here, so tools/sync-test can run it on a computer.
 */
final class ShelfWatch {
    private ShelfWatch() {}

    static final String KV = "shelfWatch";

    /** Only these shops: each has a way of asking that can tell "not there" from "couldn't ask". */
    static boolean watched(String chain) {
        return "woolworths".equals(chain) || "coles".equals(chain) || "aldi".equals(chain);
    }

    private static String squash(String s) {
        return s == null ? "" : s.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9.]", "");
    }

    /**
     * One product, after the shop was asked. `found`: it answered with the product. `missWhy`: "gone" or
     * "unlisted" when it answered without it, null when that's not known (then nothing is counted).
     * True when `watch` changed.
     */
    static boolean note(JSONObject watch, String productId, String keptSize, String seenSize, String seenName, boolean found, String missWhy, String today) {
        try {
            JSONObject e = watch.optJSONObject(productId);
            boolean changed = false;
            if (found) {
                if (e != null && e.has("miss")) {
                    e.remove("miss");
                    changed = true;
                }
                boolean other = seenSize != null && !seenSize.trim().isEmpty() && !squash(seenSize).equals(squash(keptSize));
                if (other) {
                    JSONObject was = e != null ? e.optJSONObject("saw") : null;
                    if (was == null || !squash(was.optString("size", "")).equals(squash(seenSize))) {
                        if (e == null) e = new JSONObject();
                        JSONObject saw = new JSONObject().put("size", seenSize.trim()).put("at", today);
                        if (seenName != null && !seenName.trim().isEmpty()) saw.put("name", seenName.trim());
                        e.put("saw", saw);
                        watch.put(productId, e);
                        changed = true;
                    }
                } else if (e != null && e.has("saw")) {
                    e.remove("saw");
                    changed = true;
                }
            } else if ("gone".equals(missWhy) || "unlisted".equals(missWhy)) {
                if (e == null) e = new JSONObject();
                JSONObject miss = e.optJSONObject("miss");
                if (miss == null) {
                    e.put("miss", new JSONObject().put("since", today).put("last", today).put("n", 1).put("why", missWhy));
                    changed = true;
                } else if (!today.equals(miss.optString("last", ""))) {
                    miss.put("last", today).put("n", miss.optInt("n", 1) + 1).put("why", missWhy);
                    changed = true;
                }
                watch.put(productId, e);
            }
            if (e != null && e.length() == 0) {
                watch.remove(productId);
                changed = true;
            }
            return changed;
        } catch (Exception ex) {
            return false;
        }
    }
}
