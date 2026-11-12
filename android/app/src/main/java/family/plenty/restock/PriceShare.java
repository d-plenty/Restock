package family.plenty.restock;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.14: "Send prices back" (Settings → Privacy and sharing, on unless turned off). The shelf
 * prices this phone read from Coles, Woolworths, Aldi and Costco go to Restock's shared price
 * service (the restock-prices collector, lib/share.mjs there), for everyone's day-one prices:
 *  - prices a price check on this phone recorded from the shop (source "auto") since the last send,
 *    never ones another phone or the Restock server synced here (that phone sends its own);
 *  - what searches showed (the app keeps them in the "priceShareOutbox" store entry, priceShare.ts).
 * Only what the shop's website said: never a price typed in or changed by hand (source "manual" or
 * "import"), sample items, shops added by hand, or anything about the person. A random install
 * number goes with it, only so the service can tell phones apart and limit how much one sends.
 * Runs after background price checks, and when the app asks (after searches, when it opens).
 */
final class PriceShare {
    private static final String TAG = "RestockShare";
    static final String URL = "https://restock-prices.plenty.family/share/prices";
    static final String[] SHOPS = {"coles", "woolworths", "aldi", "costco"};
    private static final int BATCH = 2000;
    private static final int MAX_ROWS = 8000;
    private static final Object LOCK = new Object();

    private PriceShare() {}

    static boolean on(JSONObject settings) {
        return settings == null || !"no".equals(settings.optString("sharePrices", "unasked"));
    }

    /** The install number (the app makes the same one, feedback.ts), made here if it isn't there yet. */
    static String install(SQLiteDatabase db) {
        JSONObject v = PriceChecker.readKvRaw(db, "installId");
        String id = v != null ? v.optString("v", "") : "";
        if (id.matches("[\\w-]{6,64}")) return id;
        id = UUID.randomUUID().toString();
        PriceChecker.writeKvRaw(db, "installId", JSONObject.quote(id));
        return id;
    }

    /** Sends what's waiting. Returns how many prices went (0 when off, nothing new or no signal). */
    static int sendNow(SQLiteDatabase db, JSONObject settings) {
        if (!on(settings)) return 0;
        synchronized (LOCK) {
            JSONObject status = new JSONObject();
            int sent = 0;
            try {
                JSONObject cursorKv = PriceChecker.readKvRaw(db, "priceShareCursor");
                long cursor = cursorKv != null ? cursorKv.optLong("v", -1) : -1;
                Map<String, JSONArray> byChain = new LinkedHashMap<>();
                long last = readPrices(db, cursor, byChain);
                JSONObject box = PriceChecker.readKvRaw(db, "priceShareOutbox");
                JSONArray waiting = box != null ? box.optJSONArray("v") : null;
                if (waiting != null) {
                    for (int i = 0; i < waiting.length(); i++) {
                        JSONObject p = waiting.optJSONObject(i);
                        String chain = p != null ? p.optString("chain", "") : "";
                        if (!isShop(chain)) continue;
                        byChain.computeIfAbsent(chain, k -> new JSONArray()).put(p);
                    }
                }
                if (byChain.isEmpty()) return 0;
                String install = install(db);
                for (Map.Entry<String, JSONArray> e : byChain.entrySet()) {
                    JSONArray all = e.getValue();
                    for (int from = 0; from < all.length(); from += BATCH) {
                        JSONArray part = new JSONArray();
                        for (int i = from; i < Math.min(all.length(), from + BATCH); i++) part.put(all.get(i));
                        JSONObject body = new JSONObject();
                        body.put("format", "restock-share");
                        body.put("v", 1);
                        body.put("install", install);
                        body.put("chain", e.getKey());
                        body.put("products", part);
                        int code = post(body.toString());
                        // A 400 (something the service won't take) would never go: drop it. Anything else: try later.
                        if (code != 200 && code != 400) throw new Exception(code == 429 ? "the shared price service has had enough for today" : "the shared price service answered " + code);
                        sent += part.length();
                    }
                }
                if (last > cursor) PriceChecker.writeKvRaw(db, "priceShareCursor", String.valueOf(last));
                // Only the ones read above: a search's prices added meanwhile wait for next time.
                int taken = waiting != null ? waiting.length() : 0;
                JSONObject now = PriceChecker.readKvRaw(db, "priceShareOutbox");
                JSONArray cur = now != null ? now.optJSONArray("v") : null;
                JSONArray left = new JSONArray();
                if (cur != null) for (int i = taken; i < cur.length(); i++) left.put(cur.get(i));
                PriceChecker.writeKvRaw(db, "priceShareOutbox", left.toString());
                status.put("at", PriceChecker.now());
                status.put("sent", sent);
            } catch (Exception e) {
                Log.w(TAG, "send failed", e);
                try {
                    status.put("at", PriceChecker.now());
                    status.put("sent", sent);
                    status.put("error", String.valueOf(e.getMessage()));
                } catch (Exception ignored) {
                    // string keys never fail
                }
            }
            try {
                JSONObject old = PriceChecker.readKv(db, "priceShare");
                status.put("total", (old != null ? old.optLong("total", 0) : 0) + sent);
                String prev = old != null ? old.optString("lastSentAt", "") : "";
                if (sent > 0) status.put("lastSentAt", status.optString("at"));
                else if (!prev.isEmpty()) status.put("lastSentAt", prev);
                PriceChecker.writeKv(db, "priceShare", status);
            } catch (Exception ignored) {
                // the status is only for the Privacy and sharing page
            }
            return sent;
        }
    }

    static boolean isShop(String chain) {
        for (String s : SHOPS) if (s.equals(chain)) return true;
        return false;
    }

    /**
     * Prices read from the shops since the last send (at most the last fortnight: the service takes
     * nothing older). Returns the newest price row's id.
     */
    static long readPrices(SQLiteDatabase db, long cursor, Map<String, JSONArray> byChain) {
        long last = cursor;
        String since = Instant.now().minusMillis(14L * 86_400_000L).toString();
        String sql = "SELECT r.id, p.chain, p.store_product_id, p.name, p.brand, p.size, p.barcode, p.image_url, r.price, r.was_price, r.is_special, r.member_only, r.promo, r.date"
            + " FROM prices r JOIN products p ON p.id = r.product_id"
            + " WHERE r.id > ? AND r.source = 'auto' AND r.date >= ?"
            + " AND p.chain IN ('coles', 'woolworths', 'aldi', 'costco') AND p.store_product_id IS NOT NULL AND p.store_product_id != '' AND p.id NOT LIKE 'demo-%'"
            // Only what this phone read itself: a price another phone (or the Restock server) synced here
            // was sent by that phone already, so it isn't sent twice (and can't count as a second phone).
            + " AND NOT EXISTS (SELECT 1 FROM sync_log l WHERE l.tbl = 'prices' AND l.pk = r.product_id || '|' || r.date"
            + " AND l.device <> COALESCE((SELECT value FROM sync_meta WHERE key = 'device'), ''))"
            + " ORDER BY r.id LIMIT " + MAX_ROWS;
        try (Cursor c = db.rawQuery(sql, new String[] {String.valueOf(cursor), since})) {
            while (c.moveToNext()) {
                last = Math.max(last, c.getLong(0));
                if (!(c.getDouble(8) > 0)) continue;
                StoreClient.Quote q = new StoreClient.Quote();
                q.price = c.getDouble(8);
                q.was = c.isNull(9) ? null : c.getDouble(9);
                q.special = c.getInt(10) != 0;
                q.member = c.getInt(11) != 0;
                q.promo = c.isNull(12) ? null : c.getString(12);
                q.imageUrl = c.isNull(7) ? null : c.getString(7);
                String barcode = c.isNull(6) ? null : c.getString(6);
                JSONObject o = PriceHelper.product(c.getString(1), c.getString(2), c.getString(3), c.isNull(4) ? null : c.getString(4), c.isNull(5) ? null : c.getString(5),
                    barcode != null && barcode.matches("\\d{8,14}") ? barcode : null, q);
                o.put("day", localDay(c.getString(13)));
                byChain.computeIfAbsent(c.getString(1), k -> new JSONArray()).put(o);
            }
        } catch (Exception e) {
            Log.w(TAG, "reading prices", e);
        }
        return last;
    }

    /** "2026-11-12T22:30:00Z" → the day on this phone's calendar ("2026-11-13" in Brisbane). */
    static String localDay(String iso) {
        try {
            return Instant.parse(iso).atZone(ZoneId.systemDefault()).toLocalDate().toString();
        } catch (Exception e) {
            return iso != null && iso.length() >= 10 ? iso.substring(0, 10) : LocalDate.now().toString();
        }
    }

    private static int post(String body) throws Exception {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Accept", "application/json");
        h.put("Content-Type", "application/json");
        h.put("User-Agent", StoreClient.APP_UA + " share");
        return SyncDav.request("POST", URI.create(URL), h, body.getBytes(StandardCharsets.UTF_8), 64 * 1024).status;
    }
}
