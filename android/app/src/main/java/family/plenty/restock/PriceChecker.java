package family.plenty.restock;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.util.Log;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Checks today's price for every tracked product, saves new readings, and sends one
 * notification for deals worth grabbing. Used by both "Check now" and the background worker.
 */
final class PriceChecker {
    private static final String TAG = "RestockCheck";
    static final String CHANNEL_ID = "deals";
    private static final int NOTIFICATION_ID = 4242;
    private static final long PAUSE_MS = 1200;

    /** Same format the app writes: 2026-11-05T01:02:03.456Z */
    static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC);

    interface Progress {
        void onProgress(int done, int total);
    }

    static final class Result {
        int checked;
        int updated;
        final Map<String, String> errors = new LinkedHashMap<>();
    }

    private PriceChecker() {}

    static String now() {
        return ISO.format(Instant.now());
    }

    /** Synchronized so "Check now" and the background worker never run at the same time. */
    static synchronized Result run(Context context, Progress progress, boolean fromBackground) throws Exception {
        Result result = new Result();
        SQLiteDatabase db = RestockDatabase.get(context);
        if (!RestockDatabase.ready(db)) return result;

        JSONObject settings = readKv(db, "settings");
        if (settings == null) settings = new JSONObject();
        if (fromBackground) {
            JSONObject sync = settings.optJSONObject("sync");
            if (sync != null && !sync.optBoolean("backgroundActivity", true)) return result;
            // Weekly checks: the worker wakes daily, but only checks on the chosen day.
            // On the days it doesn't check, the catalogue-day summary still goes out (from the last prices).
            if (settings.optInt("checkIntervalHours", 12) >= 168) {
                int want = settings.optInt("checkWeekday", 3); // 0 = Sunday, as in the app
                int today = java.time.LocalDate.now().getDayOfWeek().getValue() % 7;
                if (today != want) return summaryOnly(context, db, settings, result);
                String lastWeekly = settings.optString("lastCheck", "");
                try {
                    if (!lastWeekly.isEmpty() && Instant.now().toEpochMilli() - Instant.parse(lastWeekly).toEpochMilli() < 3 * 86_400_000L) {
                        return summaryOnly(context, db, settings, result);
                    }
                } catch (Exception ignored) {
                    // Unreadable date: just check.
                }
            }
            // Skip if the app checked very recently.
            String last = settings.optString("lastCheck", "");
            if (!last.isEmpty() && !"null".equals(last)) {
                try {
                    if (Instant.now().toEpochMilli() - Instant.parse(last).toEpochMilli() < 30 * 60_000L) return summaryOnly(context, db, settings, result);
                } catch (Exception ignored) {
                    // Unreadable date: just check.
                }
            }
        }

        Set<String> enabled = new HashSet<>();
        JSONArray chains = settings.optJSONArray("enabledChains");
        if (chains == null) {
            enabled.add("woolworths");
            enabled.add("coles");
            enabled.add("aldi");
        } else {
            Shops.addCustoms(settings.optJSONArray("customShops"));
            JSONObject sections = settings.optJSONObject("sections");
            for (int i = 0; i < chains.length(); i++) {
                String chain = chains.optString(i);
                // Keg and Pharmacy shops only while that tab is switched on (shops.ts sectionOn).
                String section = Shops.section(chain);
                if (!"pantry".equals(section) && (sections == null || !sections.optBoolean(section, false))) continue;
                enabled.add(chain);
                // Liquorland Warehouse and Cellars are priced from liquorland.com.au.
                enabled.add(Shops.priceSource(chain));
            }
        }
        JSONObject stores = settings.optJSONObject("stores");

        // Tracked products, grouped by chain.
        Map<String, List<String[]>> byChain = new LinkedHashMap<>();
        int total = 0;
        try (Cursor c = db.rawQuery(
            "SELECT id, chain, name, store_product_id, image_url FROM products WHERE store_product_id IS NOT NULL AND id NOT LIKE 'demo-%'",
            null)) {
            while (c.moveToNext()) {
                String chain = c.getString(1);
                if (!enabled.contains(chain)) continue;
                if (StoreClient.pageless(chain, c.getString(3))) continue;
                List<String[]> list = byChain.get(chain);
                if (list == null) {
                    list = new ArrayList<>();
                    byChain.put(chain, list);
                }
                list.add(new String[] {c.getString(0), chain, c.getString(2), c.getString(3), c.isNull(4) ? null : c.getString(4)});
                total++;
            }
        }

        StoreClient client = new StoreClient();
        client.setWebFetcher(StoreWeb.forAll(context), "browser".equals(settings.optString("connection", "auto")));
        JSONObject accounts = settings.optJSONObject("accounts");
        JSONObject woolies = accounts != null ? accounts.optJSONObject("woolworths") : null;
        client.useWoolworthsAccount(woolies != null && woolies.optBoolean("signedIn", false));
        int done = 0;
        // The phone's own calendar day, not UTC's (Deals.localDay).
        String today = Deals.localDay(now());
        for (Map.Entry<String, List<String[]>> entry : byChain.entrySet()) {
            String chain = entry.getKey();
            String storeId = null;
            if (stores != null && stores.optJSONObject(chain) != null) {
                String s = stores.optJSONObject(chain).optString("storeId", "");
                storeId = s.isEmpty() || "null".equals(s) ? null : s;
                // Testing (0.6.10): your Coles branch's own prices and stock (searchStoreId in types.ts).
                String branch = stores.optJSONObject(chain).optString("branchStoreNo", "");
                if ("coles".equals(chain) && settings.optBoolean("localPrices", false) && !branch.isEmpty() && !"null".equals(branch)) storeId = branch;
            }
            final boolean ownBranch = "coles".equals(chain) && storeId != null && settings.optBoolean("localPrices", false);
            // Your second Coles (0.6.11): its stock too, so "out at yours" can say "in at the other one".
            String second = null;
            if (ownBranch && stores != null && stores.optJSONObject(chain) != null) {
                String s2 = stores.optJSONObject(chain).optString("branchStoreNo2", "");
                if (!s2.isEmpty() && !"null".equals(s2) && !s2.equals(storeId)) second = s2;
            }
            for (String[] p : entry.getValue()) {
                try {
                    StoreClient.Quote q;
                    try {
                        q = client.refresh(chain, p[3], p[2], storeId);
                    } catch (StoreClient.BlockedException e) {
                        throw e;
                    } catch (Exception e) {
                        if (!ownBranch) throw e;
                        q = null;
                    }
                    // Your branch didn't have it, or didn't answer: the online store's price instead.
                    if (q == null && ownBranch) q = client.refresh(chain, p[3], p[2], null);
                    if (second != null) {
                        try {
                            StoreClient.Quote q2 = client.refresh(chain, p[3], p[2], second);
                            saveStock2(db, p[0], q2 != null ? q2.inStock : null);
                        } catch (StoreClient.BlockedException e) {
                            throw e;
                        } catch (Exception e) {
                            Log.w(TAG, "second store check failed", e);
                        }
                    }
                    result.checked++;
                    if (q != null) {
                        if (saveIfChanged(db, p[0], q, today)) result.updated++;
                        saveStock(db, p[0], q.inStock);
                        if (p[4] == null && q.imageUrl != null) {
                            ContentValues v = new ContentValues();
                            v.put("image_url", q.imageUrl);
                            db.update("products", v, "id = ?", new String[] {p[0]});
                        }
                    }
                } catch (StoreClient.BlockedException e) {
                    result.errors.put(chain, e.getMessage());
                    Log.w(TAG, chain + " blocked", e);
                    // Don't keep knocking if the store has blocked us.
                    done += 1 + countRemaining(entry.getValue(), p);
                    if (progress != null) progress.onProgress(done, total);
                    break;
                } catch (Exception e) {
                    result.errors.put(chain, e.getMessage() != null ? e.getMessage() : e.toString());
                    Log.w(TAG, chain + " check failed", e);
                }
                done++;
                if (progress != null) progress.onProgress(done, total);
                Thread.sleep(PAUSE_MS);
            }
        }

        // Store health: when each store last worked, and since when it's been failing (health.ts).
        try {
            JSONObject health = readKv(db, "storeHealth");
            if (health == null) health = new JSONObject();
            String at = now();
            for (String chain : byChain.keySet()) {
                JSONObject cur = health.optJSONObject(chain);
                if (cur == null) cur = new JSONObject();
                JSONObject next = new JSONObject();
                String err = result.errors.get(chain);
                if (err == null) {
                    next.put("lastOk", at);
                    if (cur.has("lastFail")) next.put("lastFail", cur.optString("lastFail"));
                } else {
                    if (cur.has("lastOk")) next.put("lastOk", cur.optString("lastOk"));
                    next.put("lastFail", at);
                    next.put("error", err);
                    next.put("failingSince", cur.optString("failingSince", at).isEmpty() ? at : cur.optString("failingSince", at));
                }
                health.put(chain, next);
            }
            writeKv(db, "storeHealth", health);
        } catch (Exception e) {
            Log.w(TAG, "store health not saved", e);
        }

        // Re-read so a setting changed in the app during the check isn't overwritten. No settings
        // means everything was erased during the check: write nothing back and send nothing.
        JSONObject latest = readKv(db, "settings");
        if (latest == null) return result;
        latest.put("lastCheck", now());
        writeKv(db, "settings", latest);
        settings = latest;

        // Alerts first: the shared price history download can be slow, and the worker only gets about 10 minutes.
        JSONObject alerts = settings.optJSONObject("alerts");
        try {
            // With deal alerts off this still works out the catalogue-day summary.
            alertDeals(context, db, settings, alerts == null || alerts.optBoolean("greatDeals", true));
        } finally {
            // Shared price history (testing): refresh weekly from the background, if it's switched on.
            if (fromBackground) MarketData.maybeRefresh(context, db, settings);
        }
        return result;
    }

    /** A background wake-up that doesn't check prices: just the catalogue-day summary, if it's due. */
    private static Result summaryOnly(Context context, SQLiteDatabase db, JSONObject settings, Result result) {
        try {
            if (summaryDue(db, settings)) alertDeals(context, db, settings, false);
        } catch (Exception e) {
            Log.w(TAG, "weekly summary failed", e);
        }
        return result;
    }

    private static int countRemaining(List<String[]> list, String[] current) {
        return list.size() - list.indexOf(current) - 1;
    }

    private static boolean saveIfChanged(SQLiteDatabase db, String productId, StoreClient.Quote q, String today) {
        try (Cursor c = db.rawQuery("SELECT date, price, is_special FROM prices WHERE product_id = ? ORDER BY date DESC LIMIT 1",
            new String[] {productId})) {
            if (c.moveToFirst()) {
                boolean sameDay = Deals.localDay(c.getString(0)).equals(today);
                boolean unchanged = sameDay && Math.abs(c.getDouble(1) - q.price) < 0.0001 && (c.getInt(2) == 1) == q.special;
                if (unchanged) return false;
            }
        }
        ContentValues v = new ContentValues();
        v.put("product_id", productId);
        v.put("date", now());
        v.put("price", q.price);
        if (q.was != null) v.put("was_price", q.was);
        else v.putNull("was_price");
        v.put("is_special", q.special ? 1 : 0);
        v.put("member_only", q.member ? 1 : 0);
        if (q.promo != null) v.put("promo", q.promo);
        else v.putNull("promo");
        v.put("source", "auto");
        db.insert("prices", null, v);
        return true;
    }

    // ---------- deal alerts ----------

    /** Is a shop's stock about your own store? Woolworths when signed in; Coles with your store number (Java twin of types.ts stockKnown). */
    static boolean stockKnown(JSONObject settings, String chain) {
        if (settings == null) return false;
        if ("woolworths".equals(chain)) {
            JSONObject a = settings.optJSONObject("accounts");
            JSONObject w = a != null ? a.optJSONObject("woolworths") : null;
            return w != null && w.optBoolean("signedIn", false);
        }
        if ("coles".equals(chain)) {
            JSONObject stores = settings.optJSONObject("stores");
            JSONObject coles = stores != null ? stores.optJSONObject("coles") : null;
            String no = coles != null ? coles.optString("branchStoreNo", "") : "";
            return settings.optBoolean("localPrices", false) && !no.isEmpty();
        }
        return false;
    }

    /** Deal alerts (when dealAlerts is on) and the catalogue-day summary (whatever dealAlerts says). */
    static void alertDeals(Context context, SQLiteDatabase db, JSONObject settings, boolean dealAlerts) throws Exception {
        Set<String> cardChains = new HashSet<>();
        try (Cursor c = db.rawQuery("SELECT program FROM cards", null)) {
            while (c.moveToNext()) {
                // Flybuys also covers Liquorland; Everyday Rewards also covers BWS (same as db.ts cardChains).
                if ("flybuys".equals(c.getString(0))) cardChains.addAll(java.util.Arrays.asList("coles", "liquorland", "liquorlandwarehouse", "liquorlandcellars"));
                if ("everyday".equals(c.getString(0))) cardChains.addAll(java.util.Arrays.asList("woolworths", "bws"));
            }
        }

        Map<String, Deals.Product> products = new HashMap<>();
        try (Cursor c = db.rawQuery("SELECT * FROM products", null)) {
            int stockCol = c.getColumnIndex("in_stock");
            while (c.moveToNext()) {
                Boolean inStock = stockCol < 0 || c.isNull(stockCol) ? null : c.getInt(stockCol) == 1;
                // Like the app (types.ts stockKnown): stock only counts when it's for your own store.
                if (!stockKnown(settings, c.getString(c.getColumnIndexOrThrow("chain")))) inStock = null;
                products.put(c.getString(c.getColumnIndexOrThrow("id")), new Deals.Product(
                    c.getString(c.getColumnIndexOrThrow("id")),
                    c.getString(c.getColumnIndexOrThrow("chain")),
                    c.getString(c.getColumnIndexOrThrow("name")),
                    str(c, "size"), num(c, "qty"), str(c, "qty_unit"), inStock));
            }
        }
        // Shared price history for products that are still learning (see Deals.withMarket).
        if (MarketData.tableReady(db)) {
            Map<String, String> byStoreId = new HashMap<>();
            try (Cursor c = db.rawQuery("SELECT id, chain, store_product_id FROM products WHERE store_product_id IS NOT NULL", null)) {
                while (c.moveToNext()) byStoreId.put(c.getString(1) + ":" + c.getString(2), c.getString(0));
            }
            try (Cursor c = db.rawQuery(
                "SELECT m.chain, m.store_product_id, m.normal, m.sale, m.sale_share, m.low, m.cycle_weeks, m.days, m.latest FROM market m"
                    + " JOIN products p ON p.chain = m.chain AND p.store_product_id = m.store_product_id", null)) {
                while (c.moveToNext()) {
                    Deals.Product p = products.get(byStoreId.get(c.getString(0) + ":" + c.getString(1)));
                    if (p == null) continue;
                    Deals.Market m = new Deals.Market();
                    m.normal = c.getDouble(2);
                    m.sale = c.isNull(3) ? null : c.getDouble(3);
                    m.saleShare = c.getDouble(4);
                    m.low = c.getDouble(5);
                    m.cycleWeeks = c.isNull(6) ? null : c.getInt(6);
                    m.days = c.getInt(7);
                    m.latest = c.isNull(8) ? null : c.getDouble(8);
                    p.market = m;
                }
            }
        }

        Map<String, List<Deals.Reading>> readings = new HashMap<>();
        String cutoff = ISO.format(Instant.now().minusSeconds((Deals.HISTORY_DAYS + 1L) * 86_400L));
        try (Cursor c = db.rawQuery(
            "SELECT product_id, date, price, was_price, is_special, member_only, promo FROM prices WHERE date >= ? ORDER BY date",
            new String[] {cutoff})) {
            while (c.moveToNext()) {
                List<Deals.Reading> list = readings.get(c.getString(0));
                if (list == null) {
                    list = new ArrayList<>();
                    readings.put(c.getString(0), list);
                }
                list.add(new Deals.Reading(c.getString(1), c.getDouble(2), c.isNull(3) ? null : c.getDouble(3), c.getInt(4) == 1, c.getInt(5) == 1,
                    c.isNull(6) ? null : c.getString(6)));
            }
        }

        JSONObject seenRow = readKvRaw(db, "notified");
        JSONArray seenArr = seenRow != null ? seenRow.optJSONArray("v") : null;
        Set<String> seen = new HashSet<>();
        List<String> seenList = new ArrayList<>();
        if (seenArr != null) {
            for (int i = 0; i < seenArr.length(); i++) {
                seen.add(seenArr.optString(i));
                seenList.add(seenArr.optString(i));
            }
        }

        List<String> lines = new ArrayList<>();
        long nowMs = Instant.now().toEpochMilli();
        // Items on a tab that's switched off (Keg, Pharmacy) don't send alerts. (The section column
        // arrives with the app's 0.5.0 update, which may not have opened yet.)
        JSONObject sectionsOn = settings.optJSONObject("sections");
        boolean hasSection = hasColumn(db, "items", "section");
        // "Alert me under $X" arrives with 0.6.0.
        boolean hasTarget = hasColumn(db, "items", "target_price");
        // The multi-buy setting arrives with 0.6.8.
        boolean hasMulti = hasColumn(db, "items", "allow_multi");
        JSONObject alerts = settings.optJSONObject("alerts");
        boolean stockUp = alerts == null || alerts.optBoolean("stockUpTips", true);
        int onSpecial = 0;
        double weekSaving = 0;
        try (Cursor c = db.rawQuery("SELECT id, name, usual_product_id, same_product_ids, alt_product_ids, threshold_pct, alert_level, allow_bulk, "
            + (hasSection ? "section" : "'pantry'") + ", " + (hasTarget ? "target_price" : "NULL") + ", " + (hasMulti ? "allow_multi" : "1") + " FROM items", null)) {
            while (c.moveToNext()) {
                String section = c.isNull(8) ? "pantry" : c.getString(8);
                if (!"pantry".equals(section) && (sectionsOn == null || !sectionsOn.optBoolean(section, false))) continue;
                Deals.Item item = new Deals.Item(c.getString(0), c.getString(1), c.isNull(2) ? null : c.getString(2),
                    ids(c.getString(3)), ids(c.getString(4)), c.isNull(5) ? null : c.getDouble(5), c.getString(6),
                    c.isNull(7) || c.getInt(7) == 1);
                item.allowMulti = c.isNull(10) || c.getInt(10) == 1;
                Deals.Recommendation rec = Deals.recommend(item, products, readings, cardChains, nowMs);
                // On special this week, for the Wednesday summary (whatever the item's alert setting).
                Deals.Option onSale = Deals.dealOption(rec);
                if (onSale != null && onSale.price != null && onSale.stats.current != null && onSale.stats.current.special) {
                    onSpecial++;
                    if (onSale.stats.typical != null && onSale.stats.typical > onSale.price) weekSaving += onSale.stats.typical - onSale.price;
                }
                if (!dealAlerts) continue;
                // Under the item's target price at its cheapest shop.
                Double target = c.isNull(9) ? null : c.getDouble(9);
                if (target != null && rec.best != null && rec.best.price != null && rec.best.price <= target + 0.004 && rec.best.stats.current != null) {
                    // Once per price, not once per day it stays there (see priceSince).
                    String tkey = "target:" + item.id + ":" + rec.best.product.id + ":" + String.format(Locale.ROOT, "%.2f", rec.best.price) + ":"
                        + priceSince(readings.get(rec.best.product.id), rec.best.stats.current);
                    if (!seen.contains(tkey)) {
                        seenList.add(tkey);
                        seen.add(tkey);
                        lines.add(String.format(Locale.ROOT, "%s — $%.2f at %s, under your $%.2f target", item.name, rec.best.price,
                            Deals.chainName(rec.best.product.chain), target));
                    }
                }
                if (!Deals.worthAlerting(rec)) continue;
                Deals.Option deal = Deals.dealOption(rec);
                Deals.Reading cur = deal.stats.current;
                // A week-long special alerts once: the key is the day this price showed up, not today's reading.
                String key = item.id + ":" + deal.product.id + ":" + String.format(Locale.ROOT, "%.2f", deal.price) + ":"
                    + priceSince(readings.get(deal.product.id), cur);
                if (seen.contains(key)) continue;
                seenList.add(key);
                // Swaps name the product to get, so it's clear what "swap" means.
                String what = rec.action == Deals.Action.ALT
                    ? ": " + deal.product.name + ", " + String.format(Locale.ROOT, "$%.2f", deal.price)
                    : "";
                // Multi-buys say so, since the price is per item when you buy the set.
                double[] mb = Deals.multiBuy(cur.promo);
                if (mb != null && deal.price != null && deal.price < cur.price - 0.004) {
                    what += String.format(Locale.ROOT, " (%d for $%.2f)", (int) mb[0], mb[1]);
                }
                // Stock-up nudge: a real sale on something that only goes on sale every few weeks.
                if (stockUp && deal.stats.cycleWeeks != null && deal.stats.cycleWeeks >= 4 && cur.special) {
                    what += String.format(Locale.ROOT, " · usually on sale every %d weeks, a good time to stock up", deal.stats.cycleWeeks);
                }
                lines.add(item.name + " — " + rec.headline + what);
            }
        }
        weeklySummary(context, db, settings, onSpecial, weekSaving);
        if (!dealAlerts) return;
        if (lines.isEmpty()) {
            if (!seenList.isEmpty()) writeKvRaw(db, "notified", new JSONArray(seenList).toString());
            return;
        }

        while (seenList.size() > 300) seenList.remove(0);
        writeKvRaw(db, "notified", new JSONArray(seenList).toString());
        notify(context, lines.size() == 1 ? "Worth grabbing" : lines.size() + " deals worth grabbing", lines);
    }

    /**
     * Once a week, on catalogue day (Wednesday unless changed), after the first price check of the
     * day: "4 of your items are on special this week, saving about $18."
     */
    static void weeklySummary(Context context, SQLiteDatabase db, JSONObject settings, int onSpecial, double saving) {
        if (!summaryDue(db, settings)) return;
        writeKvRaw(db, "weeklySummary", JSONObject.quote(java.time.LocalDate.now().toString()));
        List<String> lines = new ArrayList<>();
        if (onSpecial == 0) {
            // With background activity on, the app doesn't schedule its plain catalogue-day reminder
            // (notify.ts), so this stands in for it.
            lines.add("Open Restock to see what's worth buying this week.");
            notify(context, "New specials are out", lines, NOTIFICATION_ID + 1);
            return;
        }
        String title = onSpecial == 1 ? "1 of your items is on special this week" : onSpecial + " of your items are on special this week";
        lines.add(saving >= 0.5 ? String.format(Locale.ROOT, "Saving about $%.0f against normal prices. Open Restock to see them.", saving)
            : "Open Restock to see what's worth buying.");
        notify(context, title, lines, NOTIFICATION_ID + 1);
    }

    /** Is today catalogue day, with the summary switched on and not sent yet today? */
    static boolean summaryDue(SQLiteDatabase db, JSONObject settings) {
        JSONObject alerts = settings.optJSONObject("alerts");
        if (alerts != null && !alerts.optBoolean("catalogueDay", true)) return false;
        int weekday = alerts == null ? 3 : alerts.optInt("catalogueWeekday", 3); // 0 = Sunday
        java.time.LocalDate today = java.time.LocalDate.now();
        if (today.getDayOfWeek().getValue() % 7 != weekday) return false;
        JSONObject last = readKvRaw(db, "weeklySummary");
        String done = last == null ? null : last.optString("v", null);
        return !today.toString().equals(done);
    }

    /**
     * The day (on the phone's calendar) a product's current price first showed up: walk back
     * through its readings while the price is the same. A deal keyed on this alerts once, however
     * many days it lasts; the same price back again after a change alerts again.
     */
    static String priceSince(List<Deals.Reading> list, Deals.Reading cur) {
        String since = cur.date;
        if (list != null) {
            for (int i = list.size() - 1; i >= 0; i--) {
                Deals.Reading r = list.get(i);
                if (r.date.compareTo(cur.date) > 0) continue;
                if (Math.abs(r.price - cur.price) >= 0.005) break;
                since = r.date;
            }
        }
        return Deals.localDay(since);
    }

    static boolean hasColumn(SQLiteDatabase db, String table, String column) {
        try (Cursor t = db.rawQuery("SELECT " + column + " FROM " + table + " LIMIT 0", null)) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String str(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return i < 0 || c.isNull(i) ? null : c.getString(i);
    }

    private static Double num(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return i < 0 || c.isNull(i) ? null : c.getDouble(i);
    }

    /**
     * Online stock as the store says now; null (the store doesn't say) clears an old answer.
     * Skipped quietly if the app hasn't added the column yet.
     */
    /** Stock at your second Coles (in_stock_2, from 0.6.11). */
    private static void saveStock2(SQLiteDatabase db, String productId, Boolean inStock) {
        try {
            if (!hasColumn(db, "products", "in_stock_2")) return;
            ContentValues v = new ContentValues();
            if (inStock == null) v.putNull("in_stock_2");
            else v.put("in_stock_2", inStock ? 1 : 0);
            db.update("products", v, "id = ?", new String[] {productId});
        } catch (Exception e) {
            Log.w(TAG, "couldn't save second store stock", e);
        }
    }

    private static void saveStock(SQLiteDatabase db, String productId, Boolean inStock) {
        try {
            ContentValues v = new ContentValues();
            if (inStock == null) {
                v.putNull("in_stock");
                v.putNull("stock_at");
            } else {
                v.put("in_stock", inStock ? 1 : 0);
                v.put("stock_at", now());
            }
            db.update("products", v, "id = ?", new String[] {productId});
        } catch (Exception e) {
            Log.w(TAG, "couldn't save stock", e);
        }
    }

    private static List<String> ids(String json) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(json == null ? "[]" : json);
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        } catch (Exception ignored) {
            // Leave empty.
        }
        return out;
    }

    private static void notify(Context context, String title, List<String> lines) {
        notify(context, title, lines, NOTIFICATION_ID);
    }

    static void notify(Context context, String title, List<String> lines, int id) {
        if (Build.VERSION.SDK_INT >= 33
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Deals", NotificationManager.IMPORTANCE_DEFAULT));

        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent tap = open == null ? null
            : PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        StringBuilder body = new StringBuilder();
        for (int i = 0; i < Math.min(4, lines.size()); i++) body.append(i > 0 ? "\n" : "").append(lines.get(i));

        Notification.Builder b = new Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_restock)
            .setColor(0xFF00843D)
            .setContentTitle(title)
            .setContentText(lines.get(0))
            .setStyle(new Notification.BigTextStyle().bigText(body.toString()))
            .setAutoCancel(true);
        if (tap != null) b.setContentIntent(tap);
        nm.notify(id, b.build());
    }

    // ---------- key/value table (values are JSON text, same as the app) ----------

    static JSONObject readKv(SQLiteDatabase db, String key) {
        try (Cursor c = db.rawQuery("SELECT value FROM kv WHERE key = ?", new String[] {key})) {
            if (!c.moveToFirst()) return null;
            return new JSONObject(c.getString(0));
        } catch (Exception e) {
            return null;
        }
    }

    /** Reads a kv value of any JSON type, wrapped as {"v": value}. */
    static JSONObject readKvRaw(SQLiteDatabase db, String key) {
        try (Cursor c = db.rawQuery("SELECT value FROM kv WHERE key = ?", new String[] {key})) {
            if (!c.moveToFirst()) return null;
            return new JSONObject("{\"v\":" + c.getString(0) + "}");
        } catch (Exception e) {
            return null;
        }
    }

    static void writeKv(SQLiteDatabase db, String key, JSONObject value) {
        writeKvRaw(db, key, value.toString());
    }

    static void writeKvRaw(SQLiteDatabase db, String key, String json) {
        ContentValues v = new ContentValues();
        v.put("key", key);
        v.put("value", json);
        db.insertWithOnConflict("kv", null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }
}
