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
 * Shared price history, for testing: downloads hotprices.org's public Coles and Woolworths
 * files (an open-source project that records both stores' prices daily) and keeps a short
 * summary per product in the market table. The files are the same for everyone, so nothing
 * about what you track is sent anywhere. The full history isn't kept, only the summary.
 */
final class MarketData {
    private static final String TAG = "RestockMarket";
    static final String SOURCE = "hotprices.org";
    /** Restock chain → the file name hotprices.org uses. */
    static final Map<String, String> FILES = new LinkedHashMap<>();

    static {
        FILES.put("woolworths", "https://hotprices.org/data/latest-canonical.woolies.compressed.json.gz");
        FILES.put("coles", "https://hotprices.org/data/latest-canonical.coles.compressed.json.gz");
    }

    /** Summaries cover the last 26 weeks, however much history the phone keeps itself. */
    static final int WINDOW_DAYS = 182;
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
    }

    private MarketData() {}

    static boolean tableReady(SQLiteDatabase db) {
        try (Cursor c = db.rawQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'market'", null)) {
            return c.moveToFirst();
        }
    }

    /** Called after background price checks: refresh if it's switched on and a week old. */
    static void maybeRefresh(Context context, SQLiteDatabase db, JSONObject settings) {
        try {
            JSONObject md = settings.optJSONObject("marketData");
            if (md == null || !md.optBoolean("enabled", false)) return;
            if (md.optBoolean("wifiOnly", true) && onMobileData(context)) return;
            JSONObject last = PriceChecker.readKv(db, "marketImport");
            String at = last != null ? last.optString("at", "") : "";
            if (!at.isEmpty() && System.currentTimeMillis() - Instant.parse(at).toEpochMilli() < REFRESH_MS) return;
            importAll(db, null);
        } catch (Exception e) {
            Log.w(TAG, "background refresh failed", e);
        }
    }

    /** True on mobile data or a hotspot (Android calls these "metered"). */
    static boolean onMobileData(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        return cm == null || cm.isActiveNetworkMetered();
    }

    static synchronized Result importAll(SQLiteDatabase db, Progress progress) throws Exception {
        Result result = new Result();
        if (!tableReady(db)) throw new Exception("Open Restock once to finish updating, then try again.");
        long now = System.currentTimeMillis();
        String stamp = PriceChecker.now();
        for (Map.Entry<String, String> f : FILES.entrySet()) {
            String chain = f.getKey();
            try {
                int n = importFile(db, chain, f.getValue(), now, stamp, result, progress);
                result.byChain.put(chain, n);
                result.products += n;
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
        PriceChecker.writeKv(db, "marketImport", status);
        return result;
    }

    private static int importFile(SQLiteDatabase db, String chain, String url, long now, String stamp, Result result, Progress progress)
        throws Exception {
        HttpURLConnection c = (HttpURLConnection) Net.url(url).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("User-Agent", StoreClient.APP_UA + " shared-history-test");
        c.setRequestProperty("Accept-Encoding", "gzip");
        int status = c.getResponseCode();
        if (status != 200) throw new Exception(SOURCE + " returned HTTP " + status);

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
            MarketParser.parse(in, now, WINDOW_DAYS, (id, m) -> {
                ids.add(id);
                rows.add(m);
            }, (seen, kept) -> {
                if (progress != null) progress.onProgress(chain, count[0], kept);
            });
        } finally {
            c.disconnect();
        }
        if (rows.isEmpty()) throw new Exception(SOURCE + " sent no usable prices for " + chain);

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
                ins.bindString(9, SOURCE);
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
