package family.plenty.restock;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.IsoFields;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.11: price helper phone mode (priceHelper.ts). On a spare phone left on its charger, on Wi-Fi:
 * every half hour or so it runs the next few searches of the week's list (about 500 everyday things)
 * at Coles and Woolworths, the first page of results only, never paging, through the same hidden
 * browser the price checks use, with a pause of half a minute or so between requests. What it found
 * (product facts and shelf prices only) goes to the restock-prices collector's helper address on
 * your own network, which adds it to restock-prices at its weekly run. The list starts again each
 * week (Monday), so it is spread over the week rather than run in one go.
 *
 * If a shop turns it away, that shop rests for six hours. Nothing is sent anywhere else, and the
 * collector's key stays on this phone.
 */
public class PriceHelper extends Worker {
    static final String UNIQUE = "restock-price-helper";
    static final String UNIQUE_NOW = "restock-price-helper-now";
    private static final String TAG = "RestockHelper";
    static final String STATE = "priceHelper";
    static final String OUTBOX = "priceHelperOutbox";
    static final String[] CHAINS = {"coles", "woolworths"};
    /** Searches (each at both shops) per run: with a run about every half hour, about one every 10 minutes. */
    static final int PER_RUN = 3;
    static final long REST_MS = 6L * 3600_000L;
    /** Most products kept waiting per shop when the collector can't be reached. */
    static final int OUTBOX_MAX = 20_000;

    public PriceHelper(Context context, WorkerParameters params) {
        super(context, params);
    }

    /** Turns the half-hourly job on or off to match the settings (when Restock opens, and when they change). */
    static void schedule(Context context, JSONObject settings) {
        WorkManager wm = WorkManager.getInstance(context);
        JSONObject ph = settings != null ? settings.optJSONObject("priceHelper") : null;
        if (!ready(ph)) {
            wm.cancelUniqueWork(UNIQUE);
            return;
        }
        Constraints c = new Constraints.Builder().setRequiresCharging(true).setRequiredNetworkType(NetworkType.UNMETERED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(PriceHelper.class, 30, TimeUnit.MINUTES).setConstraints(c).build();
        wm.enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    /** "Run a few now": one run straight away, charging or not (any network). */
    static void runNow(Context context) {
        Constraints c = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(PriceHelper.class).setConstraints(c).build();
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_NOW, ExistingWorkPolicy.KEEP, req);
    }

    static boolean ready(JSONObject ph) {
        return ph != null && ph.optBoolean("enabled", false) && !ph.optString("url", "").isEmpty() && !ph.optString("key", "").isEmpty();
    }

    /** "2026-W46": the list starts again each ISO week. */
    static String weekOf(LocalDate d) {
        return d.get(IsoFields.WEEK_BASED_YEAR) + "-W" + String.format(java.util.Locale.ROOT, "%02d", d.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR));
    }

    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        try {
            SQLiteDatabase db = RestockDatabase.get(ctx);
            if (!RestockDatabase.ready(db)) return Result.success();
            JSONObject settings = PriceChecker.readKv(db, "settings");
            JSONObject ph = settings != null ? settings.optJSONObject("priceHelper") : null;
            if (!ready(ph)) return Result.success();
            JSONArray terms = ph.optJSONArray("searches");
            if (terms == null || terms.length() == 0) return Result.success();
            String url = ph.optString("url").replaceAll("/+$", "");
            String key = ph.optString("key");

            JSONObject state = PriceChecker.readKv(db, STATE);
            if (state == null) state = new JSONObject();
            LocalDate today = LocalDate.now(ZoneId.systemDefault());
            String week = weekOf(today);
            JSONObject outbox = PriceChecker.readKv(db, OUTBOX);
            if (outbox == null) outbox = new JSONObject();
            if (!week.equals(state.optString("week"))) {
                JSONObject fresh = new JSONObject();
                fresh.put("week", week);
                fresh.put("done", 0);
                fresh.put("sent", 0);
                state = fresh;
                // The household's own Coles and Woolworths products too, once a week.
                tracked(db, outbox);
            }
            state.put("of", terms.length());

            StoreClient client = new StoreClient();
            client.setWebFetcher(StoreWeb.forAll(ctx), true);
            JSONObject paused = state.optJSONObject("paused");
            if (paused == null) paused = new JSONObject();
            long now = System.currentTimeMillis();
            Random rnd = new Random();
            String day = today.toString();
            int done = state.optInt("done", 0);
            boolean asked = false;
            for (int n = 0; n < PER_RUN && done < terms.length() && !isStopped(); n++) {
                String term = terms.optString(done, "").trim();
                for (String chain : CHAINS) {
                    String until = paused.optString(chain, "");
                    if (!until.isEmpty() && Instant.parse(until).toEpochMilli() > now) continue;
                    if (asked) Thread.sleep(20_000 + rnd.nextInt(20_000));
                    asked = true;
                    try {
                        JSONArray found = "coles".equals(chain) ? client.colesSearch(term) : client.woolworthsSearch(term);
                        JSONArray box = outbox.optJSONArray(chain);
                        if (box == null) box = new JSONArray();
                        for (int i = 0; i < found.length(); i++) {
                            JSONObject p = "coles".equals(chain) ? fromColes(found.optJSONObject(i)) : fromWoolworths(found.optJSONObject(i));
                            if (p != null && box.length() < OUTBOX_MAX) box.put(p.put("day", day));
                        }
                        outbox.put(chain, box);
                    } catch (StoreClient.BlockedException e) {
                        paused.put(chain, Instant.ofEpochMilli(now + REST_MS).toString());
                        state.put("lastError", e.getMessage());
                    } catch (Exception e) {
                        state.put("lastError", chain + ": " + e.getMessage());
                    }
                }
                done++;
            }
            state.put("done", done);
            state.put("paused", paused);
            PriceChecker.writeKv(db, OUTBOX, outbox);

            int sent = send(url, key, outbox, state);
            PriceChecker.writeKv(db, OUTBOX, outbox);
            state.put("sent", state.optInt("sent", 0) + sent);
            int waiting = 0;
            for (String chain : CHAINS) waiting += outbox.optJSONArray(chain) != null ? outbox.optJSONArray(chain).length() : 0;
            state.put("waiting", waiting);
            state.put("lastAt", PriceChecker.now());
            PriceChecker.writeKv(db, STATE, state);
        } catch (Exception e) {
            Log.w(TAG, "price helper run failed", e);
        }
        return Result.success();
    }

    /** Sends what's waiting, a shop at a time, in parts of 2,000. Returns how many products went. */
    static int send(String url, String key, JSONObject outbox, JSONObject state) throws Exception {
        int sent = 0;
        for (String chain : CHAINS) {
            JSONArray box = outbox.optJSONArray(chain);
            while (box != null && box.length() > 0) {
                int n = Math.min(2000, box.length());
                JSONArray part = new JSONArray();
                for (int i = 0; i < n; i++) part.put(box.opt(i));
                try {
                    JSONObject body = new JSONObject();
                    body.put("format", "restock-helper");
                    body.put("version", 1);
                    body.put("chain", chain);
                    body.put("products", part);
                    int status = post(url + "/helper/prices", key, body.toString());
                    if (status == 401 || status == 403) {
                        state.put("lastError", "The collector didn't accept the key. Check it in Settings.");
                        return sent;
                    }
                    if (status != 200) {
                        state.put("lastError", "The collector answered HTTP " + status + ". Kept to send next time.");
                        return sent;
                    }
                } catch (Exception e) {
                    state.put("lastError", "Couldn't reach the collector (" + e.getMessage() + "). Kept to send next time.");
                    return sent;
                }
                JSONArray rest = new JSONArray();
                for (int i = n; i < box.length(); i++) rest.put(box.opt(i));
                outbox.put(chain, rest);
                box = rest;
                sent += n;
            }
        }
        if (sent > 0) state.remove("lastError");
        return sent;
    }

    /**
     * Through SyncDav's own connection, as the Restock server and Home Assistant are: plain http://
     * only to an address at home (192.168.x.x and the like) or on Tailscale, https:// anywhere.
     */
    static int post(String url, String key, String body) throws Exception {
        return SyncDav.request("POST", URI.create(url), headers(key, true), body.getBytes(StandardCharsets.UTF_8), 64 * 1024).status;
    }

    private static Map<String, String> headers(String key, boolean json) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Authorization", "Bearer " + key);
        h.put("Accept", "application/json");
        h.put("User-Agent", StoreClient.APP_UA + " price-helper");
        if (json) h.put("Content-Type", "application/json");
        return h;
    }

    /** "Test": asks the collector whether it takes this key. Returns {ok, status} or {ok:false, error}. */
    static JSONObject test(String url, String key) {
        JSONObject r = new JSONObject();
        try {
            int status = SyncDav.request("GET", URI.create(url.replaceAll("/+$", "") + "/helper/status"), headers(key, false), null, 64 * 1024).status;
            r.put("ok", status == 200);
            r.put("status", status);
        } catch (Exception e) {
            try {
                r.put("ok", false);
                r.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
                // a string key never fails
            }
        }
        return r;
    }

    /** A Coles search result as restock-prices keeps a product (restock-export, with its price). */
    static JSONObject fromColes(JSONObject p) throws Exception {
        if (p == null || p.opt("id") == null) return null;
        StoreClient.Quote q = StoreClient.mapColes(p);
        if (q == null) return null;
        String id = String.valueOf(p.opt("id"));
        String name = p.optString("name", "").trim();
        String brand = p.optString("brand", "").trim();
        if (!brand.isEmpty() && !name.toLowerCase().startsWith(brand.toLowerCase())) name = brand + " " + name;
        if (name.isEmpty()) return null;
        return product("coles", id, name, brand, p.optString("size", ""), null, q);
    }

    /** A Woolworths search result, the same way. */
    static JSONObject fromWoolworths(JSONObject p) throws Exception {
        if (p == null || p.opt("Stockcode") == null) return null;
        StoreClient.Quote q = StoreClient.mapWoolworths(p);
        if (q == null) return null;
        String name = p.optString("DisplayName", "").trim();
        if (name.isEmpty()) name = p.optString("Name", "").trim();
        if (name.isEmpty()) return null;
        String barcode = p.optString("Barcode", "");
        return product("woolworths", String.valueOf(p.opt("Stockcode")), name, p.optString("Brand", ""), p.optString("PackageSize", ""), barcode.matches("\\d{8,14}") ? barcode : null, q);
    }

    static JSONObject product(String chain, String id, String name, String brand, String size, String barcode, StoreClient.Quote q) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", chain + ":" + id);
        o.put("chain", chain);
        o.put("store_product_id", id);
        o.put("name", name);
        if (brand != null && !brand.isEmpty()) o.put("brand", brand);
        if (size != null && !size.isEmpty()) o.put("size", size);
        if (barcode != null) o.put("barcode", barcode);
        if (q.imageUrl != null) o.put("image_url", q.imageUrl);
        JSONObject price = new JSONObject();
        price.put("price", q.price);
        if (q.was != null) price.put("was_price", q.was);
        price.put("is_special", q.special);
        price.put("member_only", q.member);
        if (q.promo != null) price.put("promo", q.promo);
        o.put("price", price);
        return o;
    }

    /**
     * The household's own Coles and Woolworths products, with the newest price Restock read from the
     * shop in the last week (never one typed in by hand): product facts and prices only.
     */
    static void tracked(SQLiteDatabase db, JSONObject outbox) {
        String sql = "SELECT p.chain, p.store_product_id, p.name, p.brand, p.size, p.barcode, p.image_url, r.price, r.was_price, r.is_special, r.member_only, r.promo, r.date"
            + " FROM products p JOIN prices r ON r.product_id = p.id"
            + " WHERE p.chain IN ('coles', 'woolworths') AND p.store_product_id IS NOT NULL AND p.store_product_id != '' AND p.id NOT LIKE 'demo-%'"
            + " AND r.source = 'auto' AND r.date >= ?"
            + " AND r.date = (SELECT MAX(date) FROM prices WHERE product_id = p.id AND source = 'auto')";
        String since = Instant.now().minusMillis(7L * 86_400_000L).toString();
        try (Cursor c = db.rawQuery(sql, new String[] {since})) {
            while (c.moveToNext()) {
                String chain = c.getString(0);
                StoreClient.Quote q = new StoreClient.Quote();
                q.price = c.getDouble(7);
                q.was = c.isNull(8) ? null : c.getDouble(8);
                q.special = c.getInt(9) != 0;
                q.member = c.getInt(10) != 0;
                q.promo = c.isNull(11) ? null : c.getString(11);
                q.imageUrl = c.isNull(6) ? null : c.getString(6);
                JSONObject p = product(chain, c.getString(1), c.getString(2), c.isNull(3) ? null : c.getString(3), c.isNull(4) ? null : c.getString(4),
                    c.isNull(5) || !c.getString(5).matches("\\d{8,14}") ? null : c.getString(5), q);
                String date = c.getString(12);
                p.put("day", date.length() >= 10 ? date.substring(0, 10) : LocalDate.now().toString());
                JSONArray box = outbox.optJSONArray(chain);
                if (box == null) box = new JSONArray();
                if (box.length() < OUTBOX_MAX) box.put(p);
                outbox.put(chain, box);
            }
        } catch (Exception e) {
            Log.w(TAG, "tracked products", e);
        }
    }
}
