package family.plenty.restock;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The once-a-day recall check (RecallWorker), and "Check now" in Settings → Recall alerts.
 * Fetches the official lists, matches them against what you have (Pantry, Keg, Pharmacy, the
 * shopping list and kept receipts), saves what it found for the app to show, and sends a
 * notification for anything new. Nothing about you is sent anywhere: the lists are downloaded and
 * the matching happens on the phone.
 */
final class RecallChecker {
    private static final String TAG = "RestockRecalls";
    static final String CHANNEL_ID = "recalls";
    private static final int NOTIFICATION_BASE = 5100;
    private static final long KEEP_DAYS = 120;

    static final String FSANZ = "https://www.foodstandards.gov.au/food-recalls/alerts";
    static final String ACCC = "https://www.productsafety.gov.au/rss/recalls.xml";
    static final String TGA = "https://www.tga.gov.au/feeds/alert/safety-alerts.xml";

    static final class Result {
        int checked;
        int found;
        int fresh;
        final Map<String, String> errors = new LinkedHashMap<>();
    }

    private RecallChecker() {}

    static Result run(Context context, boolean notify) {
        Result result = new Result();
        SQLiteDatabase db = RestockDatabase.get(context);
        if (!RestockDatabase.ready(db)) return result;
        JSONObject settings = PriceChecker.readKv(db, "settings");
        JSONObject rc = settings == null ? null : settings.optJSONObject("recalls");
        if (rc != null && !rc.optBoolean("enabled", true)) return result;

        // 1. The lists.
        List<Recalls.Recall> all = new ArrayList<>();
        try {
            all.addAll(Recalls.parseFsanzList(get(FSANZ)));
        } catch (Exception e) {
            result.errors.put("FSANZ", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        try {
            all.addAll(Recalls.parseRss(get(ACCC), "Product Safety Australia"));
        } catch (Exception e) {
            result.errors.put("Product Safety Australia", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        try {
            all.addAll(Recalls.parseRss(get(TGA), "TGA"));
        } catch (Exception e) {
            // The TGA feed is a bonus: medicines recalls are mostly in their own database (linked in the app).
            Log.i(TAG, "TGA feed: " + e);
        }
        result.checked = all.size();

        // 2. What you have.
        List<Recalls.Thing> things = things(db, settings);

        // 3. Matches, newest lists first, skipping very old notices.
        JSONArray saved = arr(PriceChecker.readKvRaw(db, "recalls"));
        Map<String, JSONObject> byId = new LinkedHashMap<>();
        for (int i = 0; i < saved.length(); i++) {
            JSONObject o = saved.optJSONObject(i);
            if (o != null && !tooOld(o.optString("foundAt", null))) byId.put(o.optString("id"), o);
        }
        Set<String> dismissed = set(arr(PriceChecker.readKvRaw(db, "recallDismissed")));
        Set<String> notified = set(arr(PriceChecker.readKvRaw(db, "recallNotified")));
        List<JSONObject> fresh = new ArrayList<>();
        for (Recalls.Recall r : all) {
            if (r.date != null && tooOld(r.date)) continue;
            List<String> hit = Recalls.affected(r, things);
            if (hit.isEmpty()) continue;
            result.found++;
            if ("FSANZ".equals(r.source) && r.reason == null) {
                try {
                    Recalls.readFsanzPage(r, get(r.url));
                } catch (Exception ignored) {
                    // the link still works
                }
            }
            JSONObject o = byId.containsKey(r.id) ? byId.get(r.id) : new JSONObject();
            try {
                o.put("id", r.id).put("source", r.source).put("title", r.title).put("url", r.url).put("date", r.date)
                    .put("reason", r.reason).put("dates", r.dates).put("whatToDo", r.whatToDo).put("affected", new JSONArray(hit));
                if (!o.has("foundAt")) o.put("foundAt", Instant.now().toString());
            } catch (Exception ignored) {
                // keep what we have
            }
            byId.put(r.id, o);
            if (!dismissed.contains(r.id) && !notified.contains(r.id)) fresh.add(o);
        }
        result.fresh = fresh.size();

        JSONArray out = new JSONArray();
        for (JSONObject o : byId.values()) out.put(o);
        PriceChecker.writeKvRaw(db, "recalls", out.toString());
        try {
            settings = PriceChecker.readKv(db, "settings");
            if (settings != null) {
                JSONObject r = settings.optJSONObject("recalls");
                if (r == null) r = new JSONObject();
                r.put("lastCheck", Instant.now().toString());
                settings.put("recalls", r);
                PriceChecker.writeKvRaw(db, "settings", settings.toString());
            }
        } catch (Exception ignored) {
            // the app shows "never" until next time
        }

        // 4. Tell the person about new ones.
        if (!fresh.isEmpty()) {
            JSONArray n = arr(PriceChecker.readKvRaw(db, "recallNotified"));
            for (JSONObject o : fresh) n.put(o.optString("id"));
            PriceChecker.writeKvRaw(db, "recallNotified", n.toString());
            if (notify) for (int i = 0; i < Math.min(3, fresh.size()); i++) show(context, fresh.get(i), i);
        }
        return result;
    }

    /** Everything to match against: items on tabs that are on, their products, the shopping list and kept receipts. */
    static List<Recalls.Thing> things(SQLiteDatabase db, JSONObject settings) {
        List<Recalls.Thing> out = new ArrayList<>();
        JSONObject sections = settings == null ? null : settings.optJSONObject("sections");
        boolean hasSection = PriceChecker.hasColumn(db, "items", "section");
        Set<String> productIds = new HashSet<>();
        try (Cursor c = db.rawQuery("SELECT name, usual_product_id, same_product_ids, alt_product_ids, " + (hasSection ? "section" : "'pantry'") + " FROM items", null)) {
            while (c.moveToNext()) {
                String section = c.isNull(4) ? "pantry" : c.getString(4);
                if (!"pantry".equals(section) && (sections == null || !sections.optBoolean(section, false))) continue;
                out.add(new Recalls.Thing(section, c.getString(0), null));
                if (!c.isNull(1)) productIds.add(c.getString(1));
                addIds(productIds, c.getString(2));
                addIds(productIds, c.getString(3));
            }
        } catch (Exception e) {
            Log.w(TAG, "items", e);
        }
        try (Cursor c = db.rawQuery("SELECT id, name, brand FROM products", null)) {
            while (c.moveToNext()) if (productIds.contains(c.getString(0))) out.add(new Recalls.Thing("product", c.getString(1), c.isNull(2) ? null : c.getString(2)));
        } catch (Exception e) {
            Log.w(TAG, "products", e);
        }
        try (Cursor c = db.rawQuery("SELECT text FROM list_entries WHERE checked = 0", null)) {
            while (c.moveToNext()) out.add(new Recalls.Thing("list", c.getString(0), null));
        } catch (Exception e) {
            Log.w(TAG, "list", e);
        }
        if (PriceChecker.hasColumn(db, "receipts", "text")) {
            try (Cursor c = db.rawQuery("SELECT text FROM receipts WHERE text IS NOT NULL", null)) {
                while (c.moveToNext()) {
                    for (String line : c.getString(0).split("\\n")) {
                        String l = line.replaceAll("\\$?\\d+\\.\\d{2}", " ").trim();
                        if (l.length() >= 8) out.add(new Recalls.Thing("receipt", l, null));
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "receipts", e);
            }
        }
        return out;
    }

    private static void addIds(Set<String> ids, String json) {
        try {
            JSONArray a = new JSONArray(json == null ? "[]" : json);
            for (int i = 0; i < a.length(); i++) ids.add(a.getString(i));
        } catch (Exception ignored) {
            // none
        }
    }

    private static boolean tooOld(String date) {
        Date d = parseDate(date);
        return d != null && System.currentTimeMillis() - d.getTime() > KEEP_DAYS * 86_400_000L;
    }

    static Date parseDate(String s) {
        if (s == null) return null;
        for (String f : new String[] {"d MMMM yyyy", "EEE, dd MMM yyyy HH:mm:ss Z", "EEE, d MMM yyyy HH:mm:ss Z"}) {
            try {
                return new SimpleDateFormat(f, Locale.ENGLISH).parse(s.trim());
            } catch (Exception ignored) {
                // next format
            }
        }
        try {
            return Date.from(Instant.parse(s));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JSONArray arr(JSONObject wrapped) {
        if (wrapped == null) return new JSONArray();
        JSONArray a = wrapped.optJSONArray("v");
        return a == null ? new JSONArray() : a;
    }

    private static Set<String> set(JSONArray a) {
        Set<String> s = new HashSet<>();
        for (int i = 0; i < a.length(); i++) s.add(a.optString(i));
        return s;
    }

    static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(15_000);
            c.setReadTimeout(25_000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "Restock/0.6 (Android; open-source price tracker; recall check)");
            c.setRequestProperty("Accept", "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8");
            int status = c.getResponseCode();
            if (status >= 400) throw new Exception("HTTP " + status);
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[16384];
                int n;
                while ((n = in.read(b)) > 0 && buf.size() < 4_000_000) buf.write(b, 0, n);
                return new String(buf.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally {
            c.disconnect();
        }
    }

    private static void show(Context context, JSONObject o, int index) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Recall alerts", NotificationManager.IMPORTANCE_HIGH));
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open != null) open.putExtra("restockAction", "recalls");
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(context, 77 + index, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        JSONArray affected = o.optJSONArray("affected");
        String yours = affected != null && affected.length() > 0 ? affected.optString(0) : "";
        String reason = o.optString("reason", "");
        String body = (reason.isEmpty() ? "" : reason + " ") + (yours.isEmpty() ? "" : "Might be your " + yours + ". ") + "Tap for the official notice.";
        Notification.Builder b = new Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_restock)
            .setColor(0xFFC8102E)
            .setContentTitle("Possible recall: " + o.optString("title"))
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true);
        if (tap != null) b.setContentIntent(tap);
        nm.notify(NOTIFICATION_BASE + index, b.build());
    }
}
