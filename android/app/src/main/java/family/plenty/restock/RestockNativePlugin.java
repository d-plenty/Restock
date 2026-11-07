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
        boolean allowed = url != null
            && (url.startsWith("/") || url.startsWith("https://api.aldi.com.au/") || url.startsWith("https://api.danmurphys.com.au/")
                || url.startsWith("https://api.bws.com.au/") || Shops.sameSite(chain, url));
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
        if (!knownShop(chain, call.getString("home")) || url == null || !Shops.sameSite(chain, url)) {
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
        getActivity().runOnUiThread(() -> StoreWeb.showUnblock(getActivity(), chain, path, message, record, json -> {
            com.getcapacitor.JSObject out = new com.getcapacitor.JSObject();
            // evaluateJavascript hands back a JSON string literal ("\"[...]\""): the app unwraps it.
            if (json != null) out.put("recording", json);
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

    /** Downloads a file into Restock's private storage (the receipt reader), with "downloadProgress" events. */
    @PluginMethod
    public void downloadAppFile(final PluginCall call) {
        final String url = call.getString("url");
        final String path = call.getString("path");
        checkThread.execute(() -> {
            java.io.File tmp = null;
            try {
                if (url == null || !url.startsWith("https://")) throw new Exception("Not a secure link");
                java.io.File f = appFile(path);
                java.io.File dir = f.getParentFile();
                if (dir != null && !dir.exists() && !dir.mkdirs()) throw new Exception("Couldn't make the folder");
                tmp = new java.io.File(f.getPath() + ".part");
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(30000);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent", "Restock (Android)");
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("The download site said " + code);
                long total = c.getContentLengthLong();
                long got = 0;
                long lastSent = 0;
                byte[] buf = new byte[64 * 1024];
                try (java.io.InputStream in = c.getInputStream(); java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        if (got - lastSent > 256 * 1024) {
                            lastSent = got;
                            JSObject p = new JSObject();
                            p.put("path", path);
                            p.put("bytes", got);
                            p.put("total", total);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                } finally {
                    c.disconnect();
                }
                if (total > 0 && got != total) throw new Exception("The download stopped part-way. Try again.");
                if (f.exists() && !f.delete()) throw new Exception("Couldn't replace the old file");
                if (!tmp.renameTo(f)) throw new Exception("Couldn't save the file");
                JSObject ret = new JSObject();
                ret.put("uri", android.net.Uri.fromFile(f).toString());
                ret.put("bytes", got);
                call.resolve(ret);
            } catch (Exception e) {
                if (tmp != null && tmp.exists()) tmp.delete();
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage(), e);
            }
        });
    }

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
