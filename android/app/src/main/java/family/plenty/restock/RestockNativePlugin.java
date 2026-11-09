package family.plenty.restock;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.database.Cursor;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteProgram;
import android.database.sqlite.SQLiteStatement;
import androidx.activity.result.ActivityResult;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The app's bridge to native code: SQLite access for the screens (src/lib/sql/native.ts),
 * the background schedule, "Check now", permissions and approximate location.
 *
 * Permissions are asked for by alias from JavaScript (checkPermissions / requestPermissions,
 * which Capacitor provides for every plugin).
 */
@CapacitorPlugin(
    name = "RestockNative",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION }),
    }
)
public class RestockNativePlugin extends Plugin {
    /** One thread for database calls keeps them in order. */
    private final ExecutorService dbThread = Executors.newSingleThreadExecutor();
    private final ExecutorService checkThread = Executors.newSingleThreadExecutor();
    /** Shared price history downloads get their own thread, so Check now never waits behind one. */
    private final ExecutorService marketThread = Executors.newSingleThreadExecutor();

    private SQLiteDatabase db() {
        return RestockDatabase.get(getContext());
    }

    // ---------- SQL ----------

    // ---------- the search test, with the screen off (0.8.6) ----------

    @PluginMethod
    public void searchTestStart(PluginCall call) {
        try {
            SearchTestService.begin(getContext(), call.getInt("total", 0));
            call.resolve();
        } catch (Exception e) {
            // Android said no (rare): the test still runs while Restock is open.
            call.reject(e.getMessage());
        }
    }

    /** Updates the notification, and says whether its Stop button was tapped. */
    @PluginMethod
    public void searchTestProgress(PluginCall call) {
        SearchTestService.progress(getContext(), call.getInt("done", 0), call.getInt("total", 0), call.getString("text", ""));
        JSObject out = new JSObject();
        out.put("stop", SearchTestService.stopAsked);
        call.resolve(out);
    }

    @PluginMethod
    public void searchTestEnd(PluginCall call) {
        SearchTestService.end(getContext(), call.getString("title"), call.getString("text", ""));
        call.resolve();
    }

    /**
     * A pause that keeps time with the screen off: the WebView's own timers slow right down when
     * Restock isn't on screen, which would stretch a 1-second pause to a minute.
     */
    @PluginMethod
    public void pause(PluginCall call) {
        long ms = Math.max(0, Math.min(60000, call.getInt("ms", 1000)));
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(call::resolve, ms);
    }

    @PluginMethod
    public void sqlQuery(final PluginCall call) {
        final String sql = call.getString("sql");
        final JSArray values = call.getArray("values", new JSArray());
        dbThread.execute(() -> {
            try (Cursor c = db().rawQueryWithFactory(
                (database, driver, editTable, query) -> {
                    bindAll(query, values);
                    return new SQLiteCursor(driver, editTable, query);
                },
                sql, null, null)) {
                JSArray rows = new JSArray();
                String[] cols = c.getColumnNames();
                while (c.moveToNext()) {
                    JSObject row = new JSObject();
                    for (int i = 0; i < cols.length; i++) {
                        switch (c.getType(i)) {
                            case Cursor.FIELD_TYPE_NULL: row.put(cols[i], JSONObject.NULL); break;
                            case Cursor.FIELD_TYPE_INTEGER: row.put(cols[i], c.getLong(i)); break;
                            case Cursor.FIELD_TYPE_FLOAT: row.put(cols[i], c.getDouble(i)); break;
                            default: row.put(cols[i], c.getString(i));
                        }
                    }
                    rows.put(row);
                }
                JSObject ret = new JSObject();
                ret.put("rows", rows);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("SQL query failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void sqlRun(final PluginCall call) {
        final String sql = call.getString("sql");
        final JSArray values = call.getArray("values", new JSArray());
        dbThread.execute(() -> {
            try (SQLiteStatement st = db().compileStatement(sql)) {
                bindAll(st, values);
                String verb = sql.trim().toUpperCase(Locale.ROOT);
                JSObject ret = new JSObject();
                if (verb.startsWith("INSERT") || verb.startsWith("REPLACE")) {
                    long id = st.executeInsert();
                    ret.put("changes", id == -1 ? 0 : 1);
                    ret.put("lastId", id);
                } else if (verb.startsWith("UPDATE") || verb.startsWith("DELETE")) {
                    ret.put("changes", st.executeUpdateDelete());
                    ret.put("lastId", 0);
                } else {
                    st.execute();
                    ret.put("changes", 0);
                    ret.put("lastId", 0);
                }
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("SQL failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void sqlBatch(final PluginCall call) {
        final JSArray ops = call.getArray("ops", new JSArray());
        dbThread.execute(() -> {
            SQLiteDatabase db = db();
            db.beginTransaction();
            try {
                for (int i = 0; i < ops.length(); i++) {
                    JSONObject op = ops.getJSONObject(i);
                    JSONArray values = op.optJSONArray("values");
                    db.execSQL(op.getString("sql"), toArgs(values));
                }
                db.setTransactionSuccessful();
                call.resolve();
            } catch (Exception e) {
                call.reject("SQL batch failed: " + e.getMessage(), e);
            } finally {
                db.endTransaction();
            }
        });
    }

    private static void bindAll(SQLiteProgram p, JSONArray values) {
        if (values == null) return;
        for (int i = 0; i < values.length(); i++) {
            Object v = values.opt(i);
            int idx = i + 1;
            if (v == null || v == JSONObject.NULL) p.bindNull(idx);
            else if (v instanceof Boolean) p.bindLong(idx, ((Boolean) v) ? 1 : 0);
            else if (v instanceof Integer || v instanceof Long) p.bindLong(idx, ((Number) v).longValue());
            else if (v instanceof Number) p.bindDouble(idx, ((Number) v).doubleValue());
            else p.bindString(idx, String.valueOf(v));
        }
    }

    private static Object[] toArgs(JSONArray values) {
        if (values == null) return new Object[0];
        Object[] args = new Object[values.length()];
        for (int i = 0; i < values.length(); i++) {
            Object v = values.opt(i);
            if (v == null || v == JSONObject.NULL) args[i] = null;
            else if (v instanceof Boolean) args[i] = ((Boolean) v) ? 1L : 0L;
            else if (v instanceof Integer || v instanceof Long) args[i] = ((Number) v).longValue();
            else if (v instanceof Number) args[i] = ((Number) v).doubleValue();
            else args[i] = String.valueOf(v);
        }
        return args;
    }

    // ---------- background schedule ----------

    @PluginMethod
    public void scheduleChecks(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        int hours = call.getInt("intervalHours", 12);
        // Weekly: wake once a day; PriceChecker only checks on the chosen weekday.
        if (hours >= 168) hours = 24;
        WorkManager wm = WorkManager.getInstance(getContext());
        if (enabled) {
            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .setRequiresBatteryNotLow(true)
                .build();
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(PriceCheckWorker.class, Math.max(1, hours), TimeUnit.HOURS)
                .setConstraints(constraints)
                .build();
            wm.enqueueUniquePeriodicWork(PriceCheckWorker.UNIQUE_NAME, ExistingPeriodicWorkPolicy.UPDATE, req);
        } else {
            wm.cancelUniqueWork(PriceCheckWorker.UNIQUE_NAME);
        }
        JSObject ret = new JSObject();
        ret.put("scheduled", enabled);
        call.resolve(ret);
    }

    // ---------- check now ----------

    @PluginMethod
    public void checkNow(final PluginCall call) {
        checkThread.execute(() -> {
            try {
                PriceChecker.Result r = PriceChecker.run(getContext(), (done, total) -> {
                    JSObject e = new JSObject();
                    e.put("done", done);
                    e.put("total", total);
                    notifyListeners("checkProgress", e);
                }, false);
                JSObject errors = new JSObject();
                for (Map.Entry<String, String> e : r.errors.entrySet()) errors.put(e.getKey(), e.getValue());
                JSObject ret = new JSObject();
                ret.put("checked", r.checked);
                ret.put("updated", r.updated);
                ret.put("errors", errors);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Price check failed: " + e.getMessage(), e);
            } finally {
                // 0.9.0: the shops' hidden pages aren't needed until next time.
                StoreWeb.blankAll();
            }
        });
    }

    // ---------- shared price history (testing) ----------

    @PluginMethod
    public void importMarket(final PluginCall call) {
        final boolean onlyUnmetered = Boolean.TRUE.equals(call.getBoolean("onlyUnmetered", false));
        marketThread.execute(() -> {
            try {
                if (onlyUnmetered && MarketData.onMobileData(getContext())) {
                    JSObject wait = new JSObject();
                    wait.put("products", 0);
                    wait.put("bytes", 0);
                    wait.put("byChain", new JSObject());
                    wait.put("errors", new JSObject());
                    wait.put("waitingForWifi", true);
                    call.resolve(wait);
                    return;
                }
                MarketData.Result r = MarketData.importAll(RestockDatabase.get(getContext()), (chain, bytes, products) -> {
                    JSObject e = new JSObject();
                    e.put("chain", chain);
                    e.put("bytes", bytes);
                    e.put("products", products);
                    notifyListeners("marketProgress", e);
                });
                JSObject byChain = new JSObject();
                for (Map.Entry<String, Integer> e : r.byChain.entrySet()) byChain.put(e.getKey(), e.getValue());
                JSObject errors = new JSObject();
                for (Map.Entry<String, String> e : r.errors.entrySet()) errors.put(e.getKey(), e.getValue());
                JSObject ret = new JSObject();
                ret.put("products", r.products);
                ret.put("bytes", r.bytes);
                ret.put("byChain", byChain);
                ret.put("errors", errors);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Couldn't download shared price history: " + e.getMessage(), e);
            }
        });
    }

    // ---------- location & settings ----------

    @PluginMethod
    public void getLocation(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Restock isn't allowed to use your location. You can allow it in Settings.", "NO_PERMISSION");
            return;
        }
        Locator.locate(getContext(), (loc, error) -> {
            if (loc == null) {
                call.reject(error, "UNAVAILABLE");
                return;
            }
            JSObject out = new JSObject();
            out.put("lat", loc.getLatitude());
            out.put("lon", loc.getLongitude());
            out.put("accuracy", (double) loc.getAccuracy());
            call.resolve(out);
        });
    }

    /** Opens Restock's page in Android Settings, for permissions that were turned down before. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ---------- stores through a real browser page ----------

    private final java.util.concurrent.ExecutorService webThread = Executors.newSingleThreadExecutor();

    /** A shop the page names: built in, or one the person added (registered with its website). */
    private static boolean knownShop(String chain, String home) {
        if (chain.startsWith("custom-") && home != null) Shops.addCustom(chain, home);
        return Shops.known(chain);
    }

    /** A request made from inside the store's own web page (see StoreWeb). Resolves {status, body}. */
    @PluginMethod
    public void storeFetch(PluginCall call) {
        final String chain = call.getString("chain", "");
        final String method = call.getString("method", "GET");
        final String url = call.getString("url");
        final String body = call.getString("body");
        boolean known = knownShop(chain, call.getString("home"));
        // 0.9.0: the address is read against the shop's home page and has to land on the shop's own
        // site (its APIs, such as api.aldi.com.au, are on it). That refuses "//elsewhere" and
        // "/\elsewhere", which a browser would take to another site.
        boolean allowed = known && StoreWeb.onSite(chain, url) != null;
        if (!known || !allowed) {
            call.reject("Not a store address Restock uses");
            return;
        }
        webThread.execute(() -> {
            try {
                String[] r = StoreWeb.get(getContext(), chain).get(method, url, body);
                JSObject out = new JSObject();
                out.put("status", Integer.parseInt(r[0]));
                out.put("body", r[1]);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    /** Opens a page of a shop's website in the hidden browser and returns it once drawn. Resolves {status, html, url}. */
    @PluginMethod
    public void storeRender(PluginCall call) {
        final String chain = call.getString("chain", "");
        final String url = call.getString("url");
        // 0.9.0: read strictly (StoreWeb.onShopSite), the same way the hidden browser is kept on the site.
        if (!knownShop(chain, call.getString("home")) || url == null || !StoreWeb.onShopSite(chain, url)) {
            call.reject("Not a page of a shop Restock uses");
            return;
        }
        webThread.execute(() -> {
            try {
                String[] r = StoreWeb.get(getContext(), chain).render(url);
                JSObject out = new JSObject();
                out.put("status", Integer.parseInt(r[0]));
                out.put("html", r[1]);
                out.put("url", r[2] == null || r[2].isEmpty() ? url : r[2]);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    /** Shows the store's website so the user can clear its "are you human" check. Resolves when closed. */
    @PluginMethod
    public void openStore(PluginCall call) {
        final String chain = call.getString("chain", "coles");
        if (!knownShop(chain, call.getString("home"))) {
            call.reject("Not a shop Restock uses");
            return;
        }
        final String path = call.getString("path");
        final String message = call.getString("message");
        final boolean record = Boolean.TRUE.equals(call.getBoolean("record", false));
        final boolean pickStore = !record && Boolean.TRUE.equals(call.getBoolean("pickStore", false));
        getActivity().runOnUiThread(() -> StoreWeb.showUnblock(getActivity(), chain, path, message, record, pickStore, json -> {
            com.getcapacitor.JSObject out = new com.getcapacitor.JSObject();
            // evaluateJavascript hands back a JSON string literal ("\"[...]\""): the app unwraps it.
            // With pickStore, it's the store page's address instead (0.7.2).
            if (json != null) out.put(pickStore ? "storePage" : "recording", json);
            call.resolve(out);
        }));
    }

    // ---------- screen edges ----------

    /**
     * How far the status bar and navigation bar overlap the app, in CSS pixels, so the page can
     * keep clear of them even if the WebView's own safe-area values come through as zero. If
     * Android has already padded the app clear of the bars, the overlap is 0.
     */
    @PluginMethod
    @SuppressWarnings("deprecation") // getSystemWindowInset* is only used before Android 11
    public void getInsets(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            android.view.View decor = getActivity().getWindow().getDecorView();
            android.view.WindowInsets wi = decor.getRootWindowInsets();
            int top = 0;
            int bottom = 0;
            if (wi != null) {
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets bars = wi.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                    top = bars.top;
                    bottom = bars.bottom;
                } else {
                    top = wi.getSystemWindowInsetTop();
                    bottom = wi.getSystemWindowInsetBottom();
                }
            }
            float density = getActivity().getResources().getDisplayMetrics().density;
            JSObject out = new JSObject();
            out.put("top", Math.max(0, top - decor.getPaddingTop()) / density);
            out.put("bottom", Math.max(0, bottom - decor.getPaddingBottom()) / density);
            call.resolve(out);
        });
    }

    // ---------- 0.6.0: recall alerts ----------

    @PluginMethod
    public void scheduleRecalls(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        WorkManager wm = WorkManager.getInstance(getContext());
        if (enabled) {
            Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(RecallWorker.class, 24, TimeUnit.HOURS).setConstraints(constraints).build();
            wm.enqueueUniquePeriodicWork(RecallWorker.UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, req);
        } else {
            wm.cancelUniqueWork(RecallWorker.UNIQUE_NAME);
        }
        call.resolve();
    }

    @PluginMethod
    public void checkRecalls(final PluginCall call) {
        checkThread.execute(() -> {
            try {
                RecallChecker.Result r = RecallChecker.run(getContext(), true);
                JSObject errors = new JSObject();
                for (Map.Entry<String, String> e : r.errors.entrySet()) errors.put(e.getKey(), e.getValue());
                JSObject ret = new JSObject();
                ret.put("checked", r.checked);
                ret.put("found", r.found);
                ret.put("fresh", r.fresh);
                ret.put("errors", errors);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Recall check failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void notify(PluginCall call) {
        java.util.List<String> lines = new java.util.ArrayList<>();
        lines.add(call.getString("body", ""));
        PriceChecker.notify(getContext(), call.getString("title", "Restock"), lines, call.getInt("id", 4300));
        call.resolve();
    }

    /**
     * 0.7.3: updates from GitHub. Downloads an official release's APK into the app's cache and opens
     * Android's installer, which shows its own Install screen. Only Restock's own release addresses
     * are allowed. The first time, Android needs "Install unknown apps" allowed for Restock: this
     * opens that page instead and resolves needsPermission.
     *
     * 0.9.0: the downloaded file is only handed to the installer if it's Restock, signed with the
     * same key as the Restock on this phone, and a newer version (see notOurUpdate); otherwise it's
     * deleted. Every address on the way is read properly (see updateAddress).
     */
    @PluginMethod
    public void installUpdate(final PluginCall call) {
        final String url = call.getString("url");
        final java.net.URI release = updateAddress(url, true);
        if (release == null) {
            call.reject("Not a Restock release");
            return;
        }
        final android.content.Context ctx = getContext();
        if (!ctx.getPackageManager().canRequestPackageInstalls()) {
            android.content.Intent i = new android.content.Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                android.net.Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            JSObject out = new JSObject();
            out.put("needsPermission", true);
            call.resolve(out);
            return;
        }
        webThread.execute(() -> {
            try {
                java.io.File dir = new java.io.File(ctx.getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("Couldn't make a folder for the download");
                java.io.File apk = new java.io.File(dir, "restock-update.apk");
                java.net.URI next = release;
                java.net.HttpURLConnection c = null;
                int code = 0;
                // GitHub sends the download on to its file server: follow up to five hops, https only.
                // 0.8.3: GitHub's file server sometimes answers 502-504 for a moment; wait and try
                // again (three times) before giving up.
                int retries = 0;
                for (int hop = 0; hop < 5; hop++) {
                    c = (java.net.HttpURLConnection) next.toURL().openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(60000);
                    c.setRequestProperty("User-Agent", "Restock");
                    code = c.getResponseCode();
                    if (code >= 300 && code < 400) {
                        String loc = c.getHeaderField("Location");
                        c.disconnect();
                        // 0.9.0: only on to GitHub's own file servers (or the release on github.com),
                        // read against the address it came from.
                        java.net.URI to = null;
                        try {
                            if (loc != null) to = updateAddress(next.resolve(loc.trim()).toString(), false);
                        } catch (IllegalArgumentException ignored) {
                            // not an address at all
                        }
                        if (to == null) throw new java.io.IOException("GitHub sent an unexpected address");
                        next = to;
                        continue;
                    }
                    if (code >= 500 && retries < 3) {
                        c.disconnect();
                        retries++;
                        hop--;
                        next = release;
                        Thread.sleep(2000L * retries);
                        continue;
                    }
                    if (code != 200)
                        throw new java.io.IOException("GitHub answered " + code + (code >= 500 ? " (GitHub's download server is busy; try again in a few minutes)" : ""));
                    break;
                }
                // 0.9.0: still being sent on after five hops: stop, rather than read a redirect as the file.
                if (code != 200 || c == null) throw new java.io.IOException("GitHub kept sending the download somewhere else. Try again in a few minutes.");
                // How big GitHub says the file is, so a download cut short isn't handed to the installer.
                long expected = c.getContentLengthLong();
                long got = 0;
                try (java.io.InputStream in = c.getInputStream(); java.io.FileOutputStream out = new java.io.FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                    }
                } finally {
                    c.disconnect();
                }
                if (expected > 0 && got != expected) {
                    apk.delete();
                    throw new java.io.IOException("The download stopped part way (" + (got / 1024) + " of " + (expected / 1024)
                        + " KB). Check your connection and try again.");
                }
                // 0.9.0: before Android's installer sees it: is it a newer Restock, signed like this one?
                String wrong = notOurUpdate(ctx, apk);
                if (wrong != null) {
                    if (!apk.delete()) apk.deleteOnExit();
                    throw new java.io.IOException(wrong);
                }
                android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
                android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                JSObject out = new JSObject();
                out.put("started", true);
                // Android 10 and later won't open the installer from the background (you switched apps
                // while it downloaded), so then a notification opens it when you tap it instead.
                if (android.os.Build.VERSION.SDK_INT >= 29 && !inForeground() && readyToInstall(ctx, i, url)) {
                    out.put("notified", true);
                } else {
                    ctx.startActivity(i);
                }
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    /** 0.9.0: Restock's release file on github.com: .../d-plenty/Restock/releases/download/v0.9.1/restock.apk (or restock-0.9.1.apk). */
    private static final java.util.regex.Pattern RELEASE_FILE =
        java.util.regex.Pattern.compile("/d-plenty/[Rr]estock/releases/download/[^/]+/restock(-[0-9][0-9A-Za-z.-]*)?\\.apk");

    /**
     * 0.9.0: an address an update may be downloaded from, read with java.net.URI (not by how it
     * starts), or null. The first (`release`) must be Restock's release file on github.com; GitHub
     * then sends the download on to its file servers (objects.githubusercontent.com or
     * release-assets.githubusercontent.com). Always https, with no "user@" part, other port, ".."
     * or backslash.
     */
    static java.net.URI updateAddress(String s, boolean release) {
        if (s == null) return null;
        try {
            java.net.URI u = new java.net.URI(s);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getRawUserInfo() != null) return null;
            if (u.getPort() != -1 && u.getPort() != 443) return null;
            String path = u.getRawPath() == null ? "" : u.getRawPath().toLowerCase(Locale.ROOT);
            if (path.contains("..") || path.contains("\\") || path.contains("%2e") || path.contains("%2f") || path.contains("%5c")) return null;
            String host = u.getHost().toLowerCase(Locale.ROOT);
            boolean releaseFile = "github.com".equals(host) && RELEASE_FILE.matcher(u.getRawPath()).matches();
            if (release) return releaseFile ? u : null;
            boolean fileServer = "objects.githubusercontent.com".equals(host) || "release-assets.githubusercontent.com".equals(host);
            return releaseFile || fileServer ? u : null;
        } catch (java.net.URISyntaxException e) {
            return null;
        }
    }

    /**
     * 0.9.0: why a downloaded update mustn't be installed, or null when it's fine: it has to be
     * Restock (this copy's package name), signed with exactly the same key as the Restock on this
     * phone, and a newer version (a higher versionCode).
     */
    @SuppressWarnings("deprecation") // GET_SIGNATURES, signatures and versionCode are what Android 8 has
    static String notOurUpdate(android.content.Context ctx, java.io.File apk) {
        final String notOurs = "That update isn't signed by Restock, so it wasn't installed.";
        try {
            android.content.pm.PackageManager pm = ctx.getPackageManager();
            // Android 9 can leave signingInfo empty for a file that isn't installed yet, so ask for
            // the older form as well (signers() uses whichever is there).
            int flags = android.os.Build.VERSION.SDK_INT >= 28
                ? android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES | android.content.pm.PackageManager.GET_SIGNATURES
                : android.content.pm.PackageManager.GET_SIGNATURES;
            android.content.pm.PackageInfo got = pm.getPackageArchiveInfo(apk.getPath(), flags);
            android.content.pm.PackageInfo mine = pm.getPackageInfo(ctx.getPackageName(), flags);
            if (got == null || !ctx.getPackageName().equals(got.packageName)) return notOurs;
            java.util.Set<String> want = signers(mine);
            if (want.isEmpty() || !want.equals(signers(got))) return notOurs;
            long gotVersion = android.os.Build.VERSION.SDK_INT >= 28 ? got.getLongVersionCode() : got.versionCode;
            long myVersion = android.os.Build.VERSION.SDK_INT >= 28 ? mine.getLongVersionCode() : mine.versionCode;
            if (gotVersion <= myVersion) return "That update isn't newer than the Restock you have, so it wasn't installed.";
            return null;
        } catch (Exception e) {
            return notOurs;
        }
    }

    /** The certificates a package is signed with now (not any it rotated away from). */
    @SuppressWarnings("deprecation")
    private static java.util.Set<String> signers(android.content.pm.PackageInfo p) {
        java.util.Set<String> out = new java.util.HashSet<>();
        android.content.pm.Signature[] s = null;
        if (android.os.Build.VERSION.SDK_INT >= 28 && p.signingInfo != null) s = p.signingInfo.getApkContentsSigners();
        if (s == null || s.length == 0) s = p.signatures;
        if (s != null) for (android.content.pm.Signature x : s) if (x != null) out.add(x.toCharsString());
        return out;
    }

    /** Is Restock on screen right now? */
    private static boolean inForeground() {
        android.app.ActivityManager.RunningAppProcessInfo me = new android.app.ActivityManager.RunningAppProcessInfo();
        android.app.ActivityManager.getMyMemoryState(me);
        return me.importance == android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    private static final String UPDATES_CHANNEL = "updates";
    private static final int UPDATE_NOTIFICATION_ID = 4250;

    /** "Restock 0.8.5 is ready to install": tapping it opens the installer. False if notifications are off. */
    private static boolean readyToInstall(android.content.Context ctx, android.content.Intent installer, String url) {
        if (android.os.Build.VERSION.SDK_INT >= 33
            && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
        if (nm == null) return false;
        nm.createNotificationChannel(new android.app.NotificationChannel(UPDATES_CHANNEL, "App updates", android.app.NotificationManager.IMPORTANCE_DEFAULT));
        // The version from the release address: .../releases/download/v0.8.5/restock-0.8.5.apk
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("/releases/download/v?([^/]+)/").matcher(url);
        String version = m.find() ? m.group(1) : "update";
        android.app.PendingIntent tap = android.app.PendingIntent.getActivity(ctx, UPDATE_NOTIFICATION_ID, installer,
            android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
        android.app.Notification n = new android.app.Notification.Builder(ctx, UPDATES_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_restock)
            .setColor(0xFF00843D)
            .setContentTitle("Restock " + version + " is ready to install")
            .setContentText("Tap to install it.")
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build();
        nm.notify(UPDATE_NOTIFICATION_ID, n);
        return true;
    }

    // ---------- 0.6.0: automatic backups into a folder the person picks ----------

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No folder picked");
            return;
        }
        Uri tree = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {
            // some pickers don't offer lasting access; writing still works this time
        }
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        ret.put("name", Backups.folderName(getContext(), tree));
        call.resolve(ret);
    }

    @PluginMethod
    public void writeBackup(final PluginCall call) {
        final String uri = call.getString("uri");
        final String name = call.getString("name");
        final String json = call.getString("json");
        final int keep = call.getInt("keep", 5);
        dbThread.execute(() -> {
            try {
                int removed = Backups.write(getContext(), Uri.parse(uri), name, json, keep);
                JSObject ret = new JSObject();
                ret.put("written", name);
                ret.put("removed", removed);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Couldn't write the backup" : e.getMessage(), e);
            }
        });
    }

    // ---------- 0.6.0: receipt photos in Restock's private storage ----------

    private java.io.File appFile(String path) throws Exception {
        java.io.File base = getContext().getFilesDir().getCanonicalFile();
        java.io.File f = new java.io.File(base, path).getCanonicalFile();
        if (!f.getPath().startsWith(base.getPath() + java.io.File.separator)) throw new Exception("Not a Restock file");
        return f;
    }

    @PluginMethod
    public void writeAppFile(final PluginCall call) {
        dbThread.execute(() -> {
            try {
                java.io.File f = appFile(call.getString("path"));
                java.io.File dir = f.getParentFile();
                if (dir != null && !dir.exists() && !dir.mkdirs()) throw new Exception("Couldn't make the folder");
                byte[] bytes = android.util.Base64.decode(call.getString("data", ""), android.util.Base64.DEFAULT);
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
                    out.write(bytes);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Couldn't save the file: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void readAppFile(final PluginCall call) {
        dbThread.execute(() -> {
            try {
                java.io.File f = appFile(call.getString("path"));
                byte[] bytes = java.nio.file.Files.readAllBytes(f.toPath());
                JSObject ret = new JSObject();
                ret.put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Couldn't read the file: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void deleteAppFile(final PluginCall call) {
        dbThread.execute(() -> {
            try {
                java.io.File f = appFile(call.getString("path"));
                if (f.exists() && !f.delete()) throw new Exception("Couldn't delete it");
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void appFilesSize(final PluginCall call) {
        dbThread.execute(() -> {
            try {
                java.io.File dir = appFile(call.getString("dir", "receipts"));
                long total = 0;
                java.io.File[] files = dir.listFiles();
                if (files != null) for (java.io.File f : files) total += f.length();
                JSObject ret = new JSObject();
                ret.put("bytes", total);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("bytes", 0);
                call.resolve(ret);
            }
        });
    }

    // 0.9.0: downloadAppFile (any https file into Restock's private storage) is gone: nothing used it.

    /** Where a file in Restock's private storage is (for the app to load it), and whether it's there. */
    @PluginMethod
    public void appFileInfo(PluginCall call) {
        try {
            java.io.File f = appFile(call.getString("path"));
            JSObject ret = new JSObject();
            ret.put("uri", android.net.Uri.fromFile(f).toString());
            ret.put("exists", f.exists());
            ret.put("bytes", f.exists() ? f.length() : 0);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** Removes a folder in Restock's private storage (removing the receipt reader). */
    @PluginMethod
    public void deleteAppDir(final PluginCall call) {
        dbThread.execute(() -> {
            try {
                java.io.File d = appFile(call.getString("path"));
                java.io.File[] files = d.listFiles();
                if (files != null) for (java.io.File f : files) f.delete();
                d.delete();
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    // ---------- 0.6.0: app icon colour, widgets ----------

    @PluginMethod
    public void setAppIcon(PluginCall call) {
        boolean ok = AppIcons.set(getContext(), call.getString("id", "green"));
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void updateWidgets(PluginCall call) {
        Widgets.saveFromApp(getContext(), call.getString("data", "{}"));
        call.resolve();
    }

    // ---------- 0.9.0: copying ----------

    /**
     * Copies text to the clipboard. sensitive (the recovery key): marked so Android 13 and later
     * doesn't show it in the "Copied" preview, and keyboards leave it out of their clipboard history.
     */
    @PluginMethod
    public void copyText(PluginCall call) {
        final String text = call.getString("text", "");
        final boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", false));
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                if (cm == null) throw new IllegalStateException("No clipboard on this phone");
                android.content.ClipData clip = android.content.ClipData.newPlainText(sensitive ? "Restock recovery key" : "Restock", text);
                if (sensitive) {
                    android.os.PersistableBundle extras = new android.os.PersistableBundle();
                    // ClipDescription.EXTRA_IS_SENSITIVE (Android 13); older Android ignores it, some keyboards still use it.
                    extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                    clip.getDescription().setExtras(extras);
                }
                cm.setPrimaryClip(clip);
                call.resolve();
            } catch (Exception e) {
                call.reject("Couldn't copy it: " + e.getMessage(), e);
            }
        });
    }

    // ---------- 0.6.0: shared links and app icon shortcuts ----------

    private JSObject pendingAction;

    /** "share" (text from another app's share menu), or a shortcut / notification: "scan", "list", "receipt", "recalls". */
    static JSObject actionFrom(Intent intent) {
        if (intent == null) return null;
        JSObject a = new JSObject();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (text == null && subject == null) return null;
            a.put("action", "share");
            a.put("text", ((subject != null && (text == null || !text.contains(subject))) ? subject + " " : "") + (text == null ? "" : text));
            return a;
        }
        String act = intent.getStringExtra("restockAction");
        if (act == null) return null;
        a.put("action", act);
        return a;
    }

    @Override
    public void load() {
        if (getActivity() != null) {
            pendingAction = actionFrom(getActivity().getIntent());
            consume(getActivity().getIntent());
        }
        // 0.8.0: another phone's changes arrived; open screens refresh.
        SyncHub.onChanged = () -> notifyListeners("syncChanged", new JSObject());
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // Opening Restock syncs with the household's phones on this Wi-Fi (0.8.0).
        syncThread.execute(() -> {
            SyncHub hub = SyncHub.get(getContext());
            if (!hub.paired()) return;
            SyncService.startIfWanted(getContext());
            hub.syncAll();
            notifyListeners("syncDone", syncInfoObject(hub));
        });
    }

    // ---------- 0.8.0: phone-to-phone sync ----------

    private final ExecutorService syncThread = Executors.newSingleThreadExecutor();

    private JSObject syncInfoObject(SyncHub hub) {
        JSObject o = new JSObject();
        try {
            hub.upgradeOldPairing();
            boolean ready = hub.ready();
            o.put("paired", ready && hub.paired());
            if (ready) {
                o.put("device", hub.engine.device());
                o.put("name", hub.engine.name());
                String hh = hub.engine.householdValue("name");
                o.put("household", hh != null ? hh : hub.engine.meta("household"));
                o.put("isOwner", hub.paired() && hub.household.isOwner());
                o.put("notice", hub.engine.meta("notice"));
                JSArray members = new JSArray();
                if (hub.paired()) for (JSONObject m : hub.household.members()) members.put(m);
                o.put("members", members);
                o.put("shareCards", hub.engine.shareCards());
                // 0.8.5: what the household shares, what this phone chose, and what it syncs.
                o.put("householdTabs", tabsArray(hub.engine.householdTabs()));
                o.put("myTabs", tabsArray(hub.engine.myTabs()));
                o.put("tabs", tabsArray(hub.engine.tabs()));
                o.put("handoverTo", hub.paired() ? hub.household.handingOverTo() : null);
                // 0.9.0: the recovery key (whether there is one to save) and folder sync.
                boolean owner = hub.paired() && hub.household.isOwner();
                o.put("hasRecovery", owner && hub.engine.meta("recovery") != null);
                o.put("recoverySaved", owner && hub.household.recoverySaved());
                o.put("canRecover", hub.paired() && !owner && hub.engine.householdValue("recovery") != null);
                String folder = hub.folder();
                o.put("folder", folder);
                o.put("folderName", folder == null ? null : Backups.folderName(getContext(), Uri.parse(folder)));
                o.put("folderAt", hub.engine.meta("folder_at"));
                o.put("folderError", hub.folderError);
                // 0.9.0: other phones' files in the folder that couldn't be opened, and a phone whose date looks wrong.
                String unread = hub.engine.meta("folder_unread");
                o.put("folderUnread", unread == null ? 0 : Integer.parseInt(unread));
                String warn = hub.engine.meta("clock_warn");
                if (warn != null) {
                    String who = null;
                    for (JSONObject m : hub.household.members()) if (warn.equals(m.optString("device"))) who = m.optString("name");
                    o.put("clockWarning", who != null ? who : "Another phone");
                }
                o.put("keepReady", hub.keepReady());
                JSArray peers = new JSArray();
                for (JSONObject r : hub.engine.db.query("SELECT device, name, synced_at FROM sync_peers ORDER BY synced_at DESC")) {
                    JSObject p = new JSObject();
                    p.put("device", r.optString("device"));
                    p.put("name", r.isNull("name") ? null : r.optString("name"));
                    p.put("syncedAt", r.isNull("synced_at") ? null : r.optString("synced_at"));
                    peers.put(p);
                }
                o.put("peers", peers);
            }
            o.put("batteryExempt", hub.batteryExempt());
            o.put("lastSyncAt", hub.lastSyncAt);
            o.put("lastError", hub.lastError);
            o.put("listening", hub.port() > 0);
            o.put("maker", android.os.Build.MANUFACTURER);
        } catch (Exception e) {
            o.put("error", e.getMessage());
        }
        return o;
    }

    private static JSArray tabsArray(java.util.Set<String> tabs) {
        JSArray a = new JSArray();
        for (String t : SyncEngine.ALL_TABS) if (tabs.contains(t)) a.put(t);
        return a;
    }

    /** Tabs from the screens (["pantry", "keg"]), or null when not given. */
    private static java.util.Set<String> tabsFrom(PluginCall call, String key) {
        JSArray a = call.getArray(key, null);
        if (a == null) return null;
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < a.length(); i++) b.append(i == 0 ? "" : ",").append(a.optString(i));
        return SyncEngine.parseTabs(b.toString());
    }

    @PluginMethod
    public void syncInfo(PluginCall call) {
        syncThread.execute(() -> call.resolve(syncInfoObject(SyncHub.get(getContext()))));
    }

    /** Starts (or reuses) the household and returns the pairing code to show as a QR code. */
    @PluginMethod
    public void syncInvite(PluginCall call) {
        final String household = call.getString("household", "");
        final boolean shareCards = Boolean.TRUE.equals(call.getBoolean("shareCards", false));
        final java.util.Set<String> tabs = tabsFrom(call, "tabs");
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                JSObject r = new JSObject();
                r.put("code", hub.invite(household, shareCards, tabs));
                r.put("expiresInMs", SyncHousehold.CODE_LIFE_MS);
                SyncService.startIfWanted(getContext());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** 0.8.5: what a code's household is, before joining (name, owner, what it shares, the owner's settings). */
    @PluginMethod
    public void syncPeek(PluginCall call) {
        final String code = call.getString("code", "");
        syncThread.execute(() -> {
            try {
                JSONObject got = SyncHub.get(getContext()).peek(code);
                JSObject r = new JSObject();
                r.put("household", got.optString("household", null));
                r.put("ownerName", got.optString("ownerName", null));
                // An owner on 0.8.4 or older doesn't say: it shares everything.
                JSONArray tabs = got.optJSONArray("tabs");
                r.put("tabs", tabs != null ? tabs : SyncEngine.tabsJson(SyncEngine.parseTabs((String) null)));
                if (got.has("settings")) r.put("settings", got.getString("settings"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void syncJoin(PluginCall call) {
        final String code = call.getString("code", "");
        final boolean replace = Boolean.TRUE.equals(call.getBoolean("replace", false));
        final boolean shareCards = Boolean.TRUE.equals(call.getBoolean("shareCards", false));
        final java.util.Set<String> tabs = tabsFrom(call, "tabs");
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                JSONObject got = hub.join(code, replace, shareCards, tabs);
                SyncService.startIfWanted(getContext());
                SyncHub.Summary s = hub.syncAll();
                JSObject r = syncInfoObject(hub);
                if (got.has("settings")) r.put("settings", got.getString("settings"));
                r.put("ownerName", got.optString("ownerName", null));
                r.put("reached", s.reached);
                r.put("received", s.received);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void syncNow(PluginCall call) {
        syncThread.execute(() -> {
            SyncHub hub = SyncHub.get(getContext());
            SyncHub.Summary s = hub.syncAll();
            JSObject r = syncInfoObject(hub);
            r.put("reached", s.reached);
            r.put("received", s.received);
            r.put("sent", s.sent);
            call.resolve(r);
        });
    }

    /** Changes this phone's name, card sharing or "stay ready to sync". */
    @PluginMethod
    public void syncSet(PluginCall call) {
        final String name = call.getString("name");
        final Boolean shareCards = call.getBoolean("shareCards");
        final Boolean keepReady = call.getBoolean("keepReady");
        final String householdName = call.getString("household");
        final java.util.Set<String> myTabs = tabsFrom(call, "tabs");
        final java.util.Set<String> householdTabs = tabsFrom(call, "householdTabs");
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                if (myTabs != null && hub.paired()) hub.setMyTabs(myTabs);
                if (householdTabs != null && hub.paired()) hub.setHouseholdTabs(householdTabs);
                if (name != null && !name.trim().isEmpty()) hub.household.rename(name.trim());
                if (householdName != null && !householdName.trim().isEmpty() && hub.paired()) hub.household.renameHousehold(householdName.trim());
                if (shareCards != null) hub.engine.setShareCards(shareCards);
                if (keepReady != null) {
                    hub.engine.setMeta("keep_ready", keepReady ? "1" : "0");
                    if (keepReady) SyncService.startIfWanted(getContext());
                    else getContext().stopService(new Intent(getContext(), SyncService.class));
                }
                call.resolve(syncInfoObject(hub));
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** The sheet showing a code was closed: the code stops working. */
    @PluginMethod
    public void syncCloseInvite(PluginCall call) {
        syncThread.execute(() -> {
            try {
                SyncHub.get(getContext()).closeInvite();
            } catch (Exception ignored) {
                // nothing open
            }
            call.resolve();
        });
    }

    /** Owner: take a phone out of the household. */
    @PluginMethod
    public void syncRemove(PluginCall call) {
        final String device = call.getString("device", "");
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                hub.remove(device);
                call.resolve(syncInfoObject(hub));
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** Owner: make another phone the owner. */
    @PluginMethod
    public void syncHandOver(PluginCall call) {
        final String device = call.getString("device", "");
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                hub.handOver(device);
                call.resolve(syncInfoObject(hub));
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** Owner: never mind making another phone the owner. */
    @PluginMethod
    public void syncCancelHandOver(PluginCall call) {
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                hub.cancelHandOver();
                call.resolve(syncInfoObject(hub));
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    // ---------- 0.9.0: the recovery key and folder sync ----------

    /** Owner: shows the recovery key, after the phone's screen lock if it has one. */
    @PluginMethod
    public void syncRecovery(PluginCall call) {
        android.app.KeyguardManager km = (android.app.KeyguardManager) getContext().getSystemService(android.content.Context.KEYGUARD_SERVICE);
        if (km != null && km.isKeyguardSecure()) {
            Intent i = km.createConfirmDeviceCredentialIntent("Your recovery key", "Unlock to see your household's recovery key");
            if (i != null) {
                startActivityForResult(call, i, "recoveryUnlocked");
                return;
            }
        }
        giveRecovery(call);
    }

    @ActivityCallback
    private void recoveryUnlocked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK) {
            call.reject("Not unlocked");
            return;
        }
        giveRecovery(call);
    }

    private void giveRecovery(PluginCall call) {
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                hub.household.ensureRecovery();
                String k = hub.household.recovery();
                if (k == null) throw new IllegalStateException("Only the owner phone has the recovery key.");
                JSObject r = new JSObject();
                r.put("key", k);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** Owner: the person saved the recovery key; or (fresh: true) wants a new one. */
    @PluginMethod
    public void syncRecoverySaved(PluginCall call) {
        final boolean fresh = Boolean.TRUE.equals(call.getBoolean("fresh", false));
        final String shown = call.getString("key", null);
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                if (fresh) {
                    hub.household.newRecovery();
                    new Thread(hub::syncAll).start();
                } else {
                    // Only the key the person was shown counts as saved.
                    String now = hub.household.recovery();
                    if (shown != null && now != null && !now.equals(shown)) throw new IllegalStateException("The recovery key changed. Open it again and save the new one.");
                    hub.household.setRecoverySaved();
                }
                call.resolve(syncInfoObject(hub));
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** Takes over as owner with the recovery key (the owner phone was lost). */
    @PluginMethod
    public void syncTakeOver(PluginCall call) {
        final String key = call.getString("key", "");
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                hub.syncAll(); // the newest household record first
                hub.household.takeOver(key);
                hub.readvertise();
                new Thread(hub::syncAll).start();
                call.resolve(syncInfoObject(hub));
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** Sync through a folder (uri), or stop (no uri). */
    @PluginMethod
    public void syncSetFolder(PluginCall call) {
        final String uri = call.getString("uri", null);
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                hub.setFolder(uri);
                if (uri != null) {
                    hub.schedule();
                    hub.syncAll(); // the folder straight away (and any phones on this Wi-Fi)
                }
                call.resolve(syncInfoObject(hub));
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** Erase everything (0.8.2): forget the household on this phone and stop all background work. */
    @PluginMethod
    public void eraseNative(PluginCall call) {
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                hub.stop();
                if (hub.ready()) hub.household.forget();
                getContext().stopService(new Intent(getContext(), SyncService.class));
                WorkManager wm = WorkManager.getInstance(getContext());
                wm.cancelUniqueWork(SyncHub.WORK_NAME);
                wm.cancelUniqueWork(PriceCheckWorker.UNIQUE_NAME);
                wm.cancelUniqueWork(RecallWorker.UNIQUE_NAME);
            } catch (Exception e) {
                android.util.Log.w("Restock", "erase", e);
            }
            // 0.9.0: and what Restock keeps outside its database.
            eraseOutsideDatabase(getContext());
            call.resolve();
        });
    }

    /**
     * 0.9.0, Erase everything: the shops' cookies and site storage (so no shop account stays signed
     * in), everything in the cache folder (shared backups and spreadsheets, diagnostics, recordings,
     * a downloaded update), photos the camera saved for "Take a photo", and the home screen
     * widgets' copy of your deals and list. Each part on its own, so one failing doesn't stop the rest.
     */
    private void eraseOutsideDatabase(android.content.Context ctx) {
        // The shops' hidden pages first (so they can't set anything again), then the browser's data.
        // WebView wants these on the main thread; wait (a few seconds at most) for them to finish.
        StoreWeb.blankAll();
        final java.util.concurrent.CountDownLatch webDone = new java.util.concurrent.CountDownLatch(1);
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                android.webkit.WebStorage.getInstance().deleteAllData();
                // The browser's own download cache (shared by every WebView in Restock).
                if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().clearCache(true);
                final android.webkit.CookieManager cookies = android.webkit.CookieManager.getInstance();
                cookies.removeAllCookies(removed -> {
                    cookies.flush();
                    webDone.countDown();
                });
            } catch (Exception e) {
                android.util.Log.w("Restock", "erase web data", e);
                webDone.countDown();
            }
        });
        try {
            if (!webDone.await(5, TimeUnit.SECONDS)) android.util.Log.w("Restock", "erase: cookies still clearing");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        try {
            // Everything in the cache folder except the browser's own (in use, and cleared above).
            java.io.File[] all = ctx.getCacheDir().listFiles();
            if (all != null) for (java.io.File f : all) {
                if (f.getName().startsWith("WebView") || f.getName().startsWith("org.chromium")) continue;
                deleteAll(f);
            }
        } catch (Exception e) {
            android.util.Log.w("Restock", "erase cache", e);
        }
        try {
            // Capacitor has the camera app save "Take a photo" pictures here (see res/xml/file_paths.xml).
            java.io.File pictures = ctx.getExternalFilesDir(android.os.Environment.DIRECTORY_PICTURES);
            java.io.File[] all = pictures == null ? null : pictures.listFiles();
            if (all != null) for (java.io.File f : all) deleteAll(f);
        } catch (Exception e) {
            android.util.Log.w("Restock", "erase photos", e);
        }
        try {
            // The widgets keep their own copy; empty it and redraw them ("Open Restock to fill this in").
            Widgets.saveFromApp(ctx, "{}");
        } catch (Exception e) {
            android.util.Log.w("Restock", "erase widgets", e);
        }
    }

    /** Deletes a file, or a folder and everything in it (a link is removed, not followed). */
    private static void deleteAll(java.io.File f) {
        if (f.isDirectory() && !java.nio.file.Files.isSymbolicLink(f.toPath())) {
            java.io.File[] inside = f.listFiles();
            if (inside != null) for (java.io.File g : inside) deleteAll(g);
        }
        if (!f.delete()) android.util.Log.w("Restock", "couldn't delete " + f.getName());
    }

    @PluginMethod
    public void syncDismissNotice(PluginCall call) {
        syncThread.execute(() -> {
            try {
                SyncHub.get(getContext()).engine.setMeta("notice", null);
                SyncHub.get(getContext()).engine.setMeta("clock_warn", null);
            } catch (Exception ignored) {
                // fine
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void syncLeave(PluginCall call) {
        syncThread.execute(() -> {
            try {
                SyncHub hub = SyncHub.get(getContext());
                boolean left = hub.leave();
                JSObject r = syncInfoObject(hub);
                r.put("left", left);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** Android's "Allow Restock to always run in the background?" question. */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            if (!SyncHub.get(getContext()).batteryExempt()) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    private static void consume(Intent intent) {
        if (intent == null) return;
        intent.removeExtra("restockAction");
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            intent.setAction(Intent.ACTION_MAIN);
            intent.removeExtra(Intent.EXTRA_TEXT);
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        JSObject a = actionFrom(intent);
        consume(intent);
        if (a != null) notifyListeners("launchAction", a, true);
    }

    @PluginMethod
    public void takeLaunchAction(PluginCall call) {
        JSObject a = pendingAction != null ? pendingAction : new JSObject();
        pendingAction = null;
        call.resolve(a);
    }
}
