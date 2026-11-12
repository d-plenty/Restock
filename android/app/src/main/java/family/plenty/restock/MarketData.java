package family.plenty.restock;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import android.net.ConnectivityManager;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import org.json.JSONObject;

/**
 * Shared price history ("Judge new items from day one"): downloads restock-prices' day-one files
 * (Restock's own weekly collection, published on GitHub) and keeps a short summary per product in
 * the market table. 0.9.13: only for the shops this phone uses, for the 8 weeks, 6 months or 12
 * months chosen in Settings → Shopping, and never from hotprices.org (the collector already folds
 * that in). The files are the same for everyone, so nothing about what you track is sent anywhere.
 * The full history isn't kept, only the summary.
 */
final class MarketData {
    private static final String TAG = "RestockMarket";
    static final String SOURCE = "restock-prices";
    /** 0.9.13: window/<shop>-<days>d.json.gz and window/index.json. */
    static final String RESTOCK_PRICES = "https://raw.githubusercontent.com/d-plenty/restock-prices/main/window/";
    /** 8 weeks (the default and the least), 6 months, 12 months. */
    static final int[] WINDOWS = {56, 182, 365};

    /** Not published (yet): HTTP 404, so a shop the collector doesn't cover is skipped quietly. */
    static final class NotThere extends Exception {
        NotThere(String why) {
            super(why);
        }
    }

    /**
     * How far back: 0.9.14, one setting for both (Settings → Prices and deals → Price history), the
     * weeks of prices this phone keeps (historyWeeks: 8, 26 or 52) and so the day-one file it gets.
     */
    static int windowDays(JSONObject settings) {
        int weeks = settings != null ? settings.optInt("historyWeeks", 0) : 0;
        if (weeks >= 52) return 365;
        if (weeks >= 26) return 182;
        if (weeks > 0) return 56;
        JSONObject md = settings != null ? settings.optJSONObject("marketData") : null;
        int d = md != null ? md.optInt("days", 56) : 56;
        for (int w : WINDOWS) if (w == d) return d;
        return 56;
    }

    /** "weekly" (after Thursday's collection, the default) or "daily" (marketData.every, 0.9.14). */
    static boolean daily(JSONObject settings) {
        JSONObject md = settings != null ? settings.optJSONObject("marketData") : null;
        return md != null && "daily".equals(md.optString("every", "weekly"));
    }

    /** window/index.json: when each shop was last published ("to") and last fully collected ("full"). */
    static JSONObject readIndex() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) Net.url(RESTOCK_PRICES + "index.json").openConnection();
            c.setConnectTimeout(15_000);
            c.setReadTimeout(20_000);
            c.setRequestProperty("User-Agent", StoreClient.APP_UA + " shared-history");
            c.setRequestProperty("Cache-Control", "no-cache");
            if (c.getResponseCode() != 200) return null;
            byte[] body = readAtMost(c.getInputStream(), 256 * 1024);
            JSONObject o = new JSONObject(new String(body, java.nio.charset.StandardCharsets.UTF_8));
            return "restock-window-index".equals(o.optString("format")) ? o : null;
        } catch (Exception e) {
            Log.w(TAG, "index", e);
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static byte[] readAtMost(InputStream in, int max) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) {
            out.write(b, 0, n);
            if (out.size() > max) throw new IOException("too big");
        }
        return out.toByteArray();
    }

    /**
     * Whether there's something new for this phone's shops since the last download: weekly, a newer
     * full collection; daily, anything newer (the collector adds phones' prices every night).
     */
    static boolean newer(JSONObject index, JSONObject last, List<String> chains, boolean daily) {
        JSONObject shops = index != null ? index.optJSONObject("shops") : null;
        if (shops == null) return false;
        JSONObject had = last != null ? last.optJSONObject("index") : null;
        for (String c : chains) {
            JSONObject now = shops.optJSONObject(c);
            if (now == null) continue;
            JSONObject was = had != null ? had.optJSONObject(c) : null;
            String key = daily ? "to" : "full";
            String a = now.optString(key, now.optString("to", ""));
            String b = was != null ? was.optString(key, was.optString("to", "")) : "";
            if (a.compareTo(b) > 0) return true;
        }
        return false;
    }

    /** The shops this phone uses (enabledChains), each once. */
    static List<String> chainsOf(JSONObject settings) {
        List<String> out = new ArrayList<>();
        org.json.JSONArray a = settings != null ? settings.optJSONArray("enabledChains") : null;
        if (a != null) for (int i = 0; i < a.length(); i++) {
            String c = a.optString(i, "");
            if (c.matches("[a-z0-9_-]{2,40}") && !out.contains(c)) out.add(c);
        }
        return out;
    }

    /** Refresh weekly at most. */
    static final long REFRESH_MS = 7L * 86_400_000L;
    /** Give up on a file bigger than this (it would mean something unexpected is being served). */
    static final long MAX_BYTES = 150L * 1024 * 1024;
    /**
     * 0.9.0: and on one that unpacks to more than this. The real files download at 10 to 40 MB, so
     * this leaves them plenty of room, and still stops a broken or booby-trapped file, which could
     * unpack to many gigabytes and keep the phone busy for ages. (The file is read a product at a
     * time, so this is about time and battery, not memory.)
     */
    static final long MAX_UNPACKED = 1024L * 1024 * 1024;

    interface Progress {
        void onProgress(String chain, long bytes, int products);
    }

    static final class Result {
        int products;
        long bytes;
        final Map<String, Integer> byChain = new LinkedHashMap<>();
        final Map<String, String> errors = new LinkedHashMap<>();
        /** 0.9.13: shops with no day-one file (restock-prices doesn't collect them). */
        final List<String> missing = new ArrayList<>();
    }

    private MarketData() {}

    static boolean tableReady(SQLiteDatabase db) {
        try (Cursor c = db.rawQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'market'", null)) {
            return c.moveToFirst();
        }
    }

    /**
     * Called after background price checks: downloads when there's something new (0.9.14: weekly, once
     * Thursday's collection is published; daily, whenever the collector has published since).
     */
    static void maybeRefresh(Context context, SQLiteDatabase db, JSONObject settings) {
        try {
            JSONObject md = settings.optJSONObject("marketData");
            if (md == null || !md.optBoolean("enabled", false)) return;
            if (md.optBoolean("wifiOnly", true) && onMobileData(context)) return;
            JSONObject last = PriceChecker.readKv(db, "marketImport");
            String at = last != null ? last.optString("at", "") : "";
            long since = at.isEmpty() ? Long.MAX_VALUE : System.currentTimeMillis() - Instant.parse(at).toEpochMilli();
            boolean daily = daily(settings);
            // A day at least between downloads, even on "every day" (prices are checked once a day).
            if (since < 20L * 3_600_000L) return;
            boolean changedLength = last != null && last.optInt("days", windowDays(settings)) != windowDays(settings);
            if (!at.isEmpty() && !changedLength) {
                JSONObject index = readIndex();
                if (index == null) {
                    if (since < REFRESH_MS) return; // can't tell: the old weekly rule
                } else if (!newer(index, last, chainsOf(settings), daily)) return;
            }
            importAll(db, settings, null);
        } catch (Exception e) {
            Log.w(TAG, "background refresh failed", e);
        }
    }

    /** True on mobile data or a hotspot (Android calls these "metered"). */
    static boolean onMobileData(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        return cm == null || cm.isActiveNetworkMetered();
    }

    static synchronized Result importAll(SQLiteDatabase db, JSONObject settings, Progress progress) throws Exception {
        Result result = new Result();
        if (!tableReady(db)) throw new Exception("Open Restock once to finish updating, then try again.");
        long now = System.currentTimeMillis();
        String stamp = PriceChecker.now();
        int days = windowDays(settings);
        List<String> chains = chainsOf(settings);
        JSONObject index = readIndex();
        JSONObject listed = index != null ? index.optJSONObject("shops") : null;
        // 0.9.13: a shop this phone stopped using, and anything from before (hotprices.org), goes.
        StringBuilder keep = new StringBuilder();
        List<String> args = new ArrayList<>();
        for (String c : chains) {
            keep.append(keep.length() == 0 ? "?" : ", ?");
            args.add(c);
        }
        db.delete("market", chains.isEmpty() ? null : "chain NOT IN (" + keep + ")", chains.isEmpty() ? null : args.toArray(new String[0]));
        db.delete("market", "source != ?", new String[] {SOURCE});
        for (String chain : chains) {
            // 0.9.14: a shop the collector doesn't publish (bottle shops, chemists, or nothing yet).
            if (index != null && (listed == null || !listed.has(chain))) {
                result.missing.add(chain);
                db.delete("market", "chain = ?", new String[] {chain});
                continue;
            }
            try {
                int n = importFile(db, chain, RESTOCK_PRICES + chain + "-" + days + "d.json.gz", days, now, stamp, result, progress);
                result.byChain.put(chain, n);
                result.products += n;
            } catch (NotThere e) {
                // Bottle shops and chemists: restock-prices doesn't collect them (yet).
                result.missing.add(chain);
                db.delete("market", "chain = ?", new String[] {chain});
            } catch (Exception e) {
                Log.w(TAG, chain + " import failed", e);
                result.errors.put(chain, e.getMessage() != null ? e.getMessage() : e.toString());
            } catch (OutOfMemoryError e) {
                // 0.9.0: a file this phone can't hold (one huge entry, say): skip it, rather than
                // stopping the background check that called this.
                Log.w(TAG, chain + " import ran out of memory", e);
                result.errors.put(chain, "the file was too big for this phone");
            }
        }
        JSONObject status = new JSONObject();
        status.put("at", stamp);
        status.put("products", result.products);
        status.put("bytes", result.bytes);
        JSONObject errors = new JSONObject();
        for (Map.Entry<String, String> e : result.errors.entrySet()) errors.put(e.getKey(), e.getValue());
        status.put("errors", errors);
        status.put("days", days);
        org.json.JSONArray missing = new org.json.JSONArray();
        for (String c : result.missing) missing.put(c);
        status.put("missing", missing);
        // 0.9.14: what was published then, so the next check knows whether there's anything newer.
        JSONObject seen = new JSONObject();
        if (listed != null) for (String c : chains) {
            JSONObject x = listed.optJSONObject(c);
            if (x != null && !result.errors.containsKey(c)) seen.put(c, new JSONObject().put("to", x.optString("to", "")).put("full", x.optString("full", x.optString("to", ""))));
        }
        status.put("index", seen);
        status.put("published", index != null);
        PriceChecker.writeKv(db, "marketImport", status);
        return result;
    }

    private static int importFile(SQLiteDatabase db, String chain, String url, int days, long now, String stamp, Result result, Progress progress)
        throws Exception {
        final String source = SOURCE;
        HttpURLConnection c = (HttpURLConnection) Net.url(url).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("User-Agent", StoreClient.APP_UA + " shared-history");
        c.setRequestProperty("Accept-Encoding", "gzip");
        int status = c.getResponseCode();
        if (status == 404) {
            c.disconnect();
            throw new NotThere(source + " has no " + chain + " file yet");
        }
        if (status != 200) throw new Exception(source + " returned HTTP " + status);

        final long[] count = {0};
        InputStream raw = new FilterInputStream(c.getInputStream()) {
            @Override
            public int read() throws IOException {
                int b = super.read();
                if (b >= 0) tick(1);
                return b;
            }

            @Override
            public int read(byte[] buf, int off, int len) throws IOException {
                int n = super.read(buf, off, len);
                if (n > 0) tick(n);
                return n;
            }

            private void tick(long n) throws IOException {
                count[0] += n;
                if (count[0] > MAX_BYTES) throw new IOException("the file is unexpectedly large");
            }
        };
        // The file is gzip. Some connections unzip it on the way, so check the first two bytes.
        BufferedInputStream buf = new BufferedInputStream(raw, 64 * 1024);
        buf.mark(2);
        int b0 = buf.read(), b1 = buf.read();
        buf.reset();
        InputStream in = b0 == 0x1f && b1 == 0x8b ? unpackedAtMost(new GZIPInputStream(buf, 64 * 1024), MAX_UNPACKED) : buf;

        // Download and summarise first (this is the slow part), then write in one short transaction,
        // so the app's own saves never wait on the network.
        final List<String> ids = new ArrayList<>();
        final List<Deals.Market> rows = new ArrayList<>();
        try {
            MarketParser.Sink sink = (id, m) -> {
                ids.add(id);
                rows.add(m);
            };
            MarketParser.Progress tick = (seen, kept) -> {
                if (progress != null) progress.onProgress(chain, count[0], kept);
            };
            MarketParser.parseWindow(in, now, days, sink, tick);
        } finally {
            c.disconnect();
        }
        if (rows.isEmpty()) throw new Exception(source + " sent no usable prices for " + chain);

        db.beginTransaction();
        try {
            db.delete("market", "chain = ?", new String[] {chain});
            SQLiteStatement ins = db.compileStatement(
                "INSERT OR REPLACE INTO market (chain, store_product_id, normal, sale, sale_share, low, cycle_weeks, days, source, updated_at, latest)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            for (int i = 0; i < rows.size(); i++) {
                Deals.Market m = rows.get(i);
                ins.clearBindings();
                ins.bindString(1, chain);
                ins.bindString(2, ids.get(i));
                ins.bindDouble(3, m.normal);
                if (m.sale != null) ins.bindDouble(4, m.sale);
                else ins.bindNull(4);
                ins.bindDouble(5, m.saleShare);
                ins.bindDouble(6, m.low);
                if (m.cycleWeeks != null) ins.bindLong(7, m.cycleWeeks);
                else ins.bindNull(7);
                ins.bindLong(8, m.days);
                ins.bindString(9, source);
                ins.bindString(10, stamp);
                if (m.latest != null) ins.bindDouble(11, m.latest);
                else ins.bindNull(11);
                ins.executeInsert();
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        int written = rows.size();
        result.bytes += count[0];
        if (progress != null) progress.onProgress(chain, count[0], written);
        return written;
    }

    /** 0.9.0: the unpacked file, stopping cleanly (an IOException) once it passes `max` bytes. */
    static InputStream unpackedAtMost(InputStream in, final long max) {
        return new FilterInputStream(in) {
            private long total;

            @Override
            public int read() throws IOException {
                int b = super.read();
                if (b >= 0) tick(1);
                return b;
            }

            @Override
            public int read(byte[] b, int off, int len) throws IOException {
                int n = super.read(b, off, len);
                if (n > 0) tick(n);
                return n;
            }

            @Override
            public long skip(long n) throws IOException {
                long s = super.skip(n);
                if (s > 0) tick(s);
                return s;
            }

            private void tick(long n) throws IOException {
                total += n;
                if (total > max) throw new IOException("the file is unexpectedly large once unpacked");
            }
        };
    }
}
