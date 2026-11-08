package family.plenty.restock;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteProgram;
import android.database.sqlite.SQLiteStatement;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.json.JSONObject;

/**
 * Phone-to-phone sync on the phone (0.8.0): the household key, listening for the other phones
 * (SyncWire.Server), finding them on the Wi-Fi (Android's own network discovery, the same thing
 * Apple calls Bonjour, no Google services) and syncing with each (SyncEngine).
 *
 * One per app process, used by the screens (RestockNativePlugin), the "ready to sync" service
 * (SyncService) and the background job (SyncWorker).
 */
final class SyncHub {
    private static final String TAG = "RestockSync";
    static final String SERVICE_TYPE = "_restocksync._tcp.";
    static final String WORK_NAME = "restock-sync";
    private static SyncHub instance;

    /** Told when another phone's changes arrive, so open screens refresh. */
    static volatile Runnable onChanged;

    final Context context;
    final SyncEngine engine;
    private SyncWire.Server server;
    private NsdManager.RegistrationListener registration;
    private final ReentrantLock syncing = new ReentrantLock();
    volatile String lastError;
    volatile String lastSyncAt;

    static synchronized SyncHub get(Context context) {
        if (instance == null) instance = new SyncHub(context.getApplicationContext());
        return instance;
    }

    private SyncHub(Context context) {
        this.context = context;
        this.engine = new SyncEngine(new AndroidDb(RestockDatabase.get(context)));
    }

    static String nowIso() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }

    // ---------- the household ----------

    /** True once the app's tables (and sync's) exist. */
    boolean ready() {
        try (Cursor c = RestockDatabase.get(context).rawQuery("SELECT 1 FROM sqlite_master WHERE name = 'sync_meta'", null)) {
            return c.moveToFirst();
        }
    }

    byte[] key() {
        try {
            if (!ready()) return null;
            String k = engine.meta("key");
            return k == null ? null : SyncWire.decodeKey(k);
        } catch (Exception e) {
            return null;
        }
    }

    boolean paired() {
        return key() != null;
    }

    boolean keepReady() throws Exception {
        return !"0".equals(engine.meta("keep_ready"));
    }

    /** Starts a household on this phone (or reuses it) and returns the code the other phone scans. */
    String invite(String household, boolean shareCards) throws Exception {
        if (!paired()) engine.setMeta("key", SyncWire.encodeKey(SyncWire.newKey()));
        if (household != null && !household.trim().isEmpty()) engine.setMeta("household", household.trim());
        engine.setShareCards(shareCards);
        if (engine.meta("name") == null) engine.setMeta("name", defaultName());
        start();
        return pairingCode();
    }

    /** RESTOCK-SYNC:1:key:ip:port:household — scanned by the other phone (Settings → Sync). */
    String pairingCode() throws Exception {
        String ip = localIp();
        String household = engine.meta("household");
        return "RESTOCK-SYNC:1:" + engine.meta("key") + ":" + (ip == null ? "" : ip) + ":" + (server == null ? 0 : server.port()) + ":"
            + URLEncoder.encode(household == null ? "" : household, "UTF-8");
    }

    /** Joins the household in a scanned code. `replace`: this phone starts from the household's things. */
    void join(String code, boolean replace, boolean shareCards) throws Exception {
        String[] p = code.trim().split(":", 6);
        if (p.length < 6 || !"RESTOCK-SYNC".equals(p[0])) throw new IllegalArgumentException("That isn't a Restock sync code.");
        if (!"1".equals(p[1])) throw new IllegalArgumentException("That code is from a newer Restock. Update this phone first.");
        SyncWire.decodeKey(p[2]); // throws if it's damaged
        stop();
        if (replace) engine.clearForJoin();
        engine.setMeta("key", p[2]);
        String household = URLDecoder.decode(p[5], "UTF-8");
        if (!household.isEmpty()) engine.setMeta("household", household);
        engine.setShareCards(shareCards);
        if (engine.meta("name") == null) engine.setMeta("name", defaultName());
        if (!p[3].isEmpty()) engine.setMeta("invite", p[3] + ":" + p[4]);
        start();
    }

    /** Leaves the household: this phone keeps its things but stops syncing. */
    void leave() throws Exception {
        stop();
        context.stopService(new android.content.Intent(context, SyncService.class));
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        engine.setMeta("key", null);
        engine.setMeta("invite", null);
        engine.db.exec("DELETE FROM sync_peers");
    }

    static String defaultName() {
        String m = Build.MODEL == null ? "" : Build.MODEL.trim();
        return m.isEmpty() ? "Android phone" : m;
    }

    // ---------- listening ----------

    /** Listens for the household's other phones and tells the Wi-Fi this phone is here. */
    synchronized void start() {
        byte[] key = key();
        if (key == null || server != null) return;
        try {
            server = new SyncWire.Server(key, new SyncWire.Handler() {
                volatile boolean took;

                @Override
                public JSONObject handle(JSONObject m, String host) throws Exception {
                    JSONObject r = engine.handle(m, host);
                    if (r.optInt("changed", 0) > 0) took = true;
                    return r;
                }

                @Override
                public void done(String host) {
                    lastSyncAt = nowIso();
                    if (took) {
                        took = false;
                        changed();
                    }
                }
            });
            advertise(key, server.port());
            schedule();
        } catch (Exception e) {
            lastError = "Couldn't listen for other phones: " + e.getMessage();
            Log.w(TAG, "start", e);
        }
    }

    synchronized void stop() {
        if (registration != null) {
            try {
                nsd().unregisterService(registration);
            } catch (Exception ignored) {
                // already gone
            }
            registration = null;
        }
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    int port() {
        SyncWire.Server s = server;
        return s == null ? 0 : s.port();
    }

    private NsdManager nsd() {
        return (NsdManager) context.getSystemService(Context.NSD_SERVICE);
    }

    private void advertise(byte[] key, int port) throws Exception {
        NsdServiceInfo info = new NsdServiceInfo();
        String device = engine.device();
        info.setServiceName("Restock-" + device.substring(0, Math.min(8, device.length())));
        info.setServiceType(SERVICE_TYPE);
        info.setPort(port);
        info.setAttribute("h", SyncWire.householdId(key));
        info.setAttribute("d", device);
        registration = new NsdManager.RegistrationListener() {
            @Override
            public void onServiceRegistered(NsdServiceInfo i) {}

            @Override
            public void onRegistrationFailed(NsdServiceInfo i, int code) {
                Log.w(TAG, "advertise failed " + code);
            }

            @Override
            public void onServiceUnregistered(NsdServiceInfo i) {}

            @Override
            public void onUnregistrationFailed(NsdServiceInfo i, int code) {}
        };
        nsd().registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
    }

    /** Every 15 minutes or so, sync in the background (works best with "don't restrict battery"). */
    void schedule() {
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    // ---------- finding the other phones ----------

    /** The household's other phones on this Wi-Fi, as host:port, found within `ms`. */
    List<String> discover(long ms) {
        List<String> found = new ArrayList<>();
        byte[] key = key();
        if (key == null) return found;
        final String household = SyncWire.householdId(key);
        String me;
        try {
            me = engine.device();
        } catch (Exception e) {
            return found;
        }
        final String self = me;
        WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi == null ? null : wifi.createMulticastLock("restock-sync");
        final List<NsdServiceInfo> seen = new ArrayList<>();
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String t, int code) {
                Log.w(TAG, "discovery failed " + code);
            }

            @Override
            public void onStopDiscoveryFailed(String t, int code) {}

            @Override
            public void onDiscoveryStarted(String t) {}

            @Override
            public void onDiscoveryStopped(String t) {}

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                if (info.getServiceName() != null && info.getServiceName().startsWith("Restock-")) synchronized (seen) {
                    seen.add(info);
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo info) {}
        };
        try {
            if (lock != null) {
                lock.setReferenceCounted(false);
                lock.acquire();
            }
            nsd().discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
            Thread.sleep(ms);
            try {
                nsd().stopServiceDiscovery(listener);
            } catch (Exception ignored) {
                // stopped already
            }
            List<NsdServiceInfo> list;
            synchronized (seen) {
                list = new ArrayList<>(seen);
            }
            // Android resolves one at a time.
            for (NsdServiceInfo info : list) {
                final NsdServiceInfo[] got = { null };
                final CountDownLatch latch = new CountDownLatch(1);
                nsd().resolveService(info, new NsdManager.ResolveListener() {
                    @Override
                    public void onResolveFailed(NsdServiceInfo i, int code) {
                        latch.countDown();
                    }

                    @Override
                    public void onServiceResolved(NsdServiceInfo i) {
                        got[0] = i;
                        latch.countDown();
                    }
                });
                latch.await(4, TimeUnit.SECONDS);
                NsdServiceInfo r = got[0];
                if (r == null || r.getHost() == null) continue;
                Map<String, byte[]> attrs = r.getAttributes();
                String h = attrs.get("h") == null ? null : new String(attrs.get("h"), StandardCharsets.UTF_8);
                String d = attrs.get("d") == null ? null : new String(attrs.get("d"), StandardCharsets.UTF_8);
                if (!household.equals(h) || self.equals(d)) continue;
                found.add(r.getHost().getHostAddress() + ":" + r.getPort());
            }
        } catch (Exception e) {
            Log.w(TAG, "discover", e);
        } finally {
            if (lock != null && lock.isHeld()) lock.release();
        }
        return found;
    }

    /** This phone's address on the Wi-Fi, for the pairing code. */
    String localIp() {
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm == null ? null : cm.getActiveNetwork();
            LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
            if (lp == null) return null;
            for (LinkAddress a : lp.getLinkAddresses()) {
                InetAddress ip = a.getAddress();
                if (ip instanceof Inet4Address && !ip.isLoopbackAddress()) return ip.getHostAddress();
            }
        } catch (Exception ignored) {
            // no network
        }
        return null;
    }

    // ---------- syncing ----------

    /** What a sync with every phone it could reach did. */
    static final class Summary {
        int reached;
        int received;
        int sent;
        final List<String> names = new ArrayList<>();
    }

    /** Finds the household's other phones and syncs with each. One at a time. */
    Summary syncAll() {
        Summary s = new Summary();
        byte[] key = key();
        if (key == null) return s;
        if (!syncing.tryLock()) return s;
        try {
            start();
            Set<String> where = new LinkedHashSet<>();
            // Where they were last time (quickest), the phone that invited this one, then a fresh look.
            try (Cursor c = RestockDatabase.get(context).rawQuery("SELECT host, port FROM sync_peers WHERE host IS NOT NULL AND port > 0", null)) {
                while (c.moveToNext()) where.add(c.getString(0) + ":" + c.getInt(1));
            }
            String invite = engine.meta("invite");
            if (invite != null && !invite.endsWith(":0")) where.add(invite);
            where.addAll(discover(4000));
            String mine = localIp();
            String error = null;
            Set<String> done = new LinkedHashSet<>();
            for (String hp : where) {
                int colon = hp.lastIndexOf(':');
                String host = hp.substring(0, colon);
                int port = Integer.parseInt(hp.substring(colon + 1));
                if (host.equals(mine) && port == port()) continue;
                try (SyncWire.Client c = new SyncWire.Client(key, host, port, 2500)) {
                    SyncEngine.Result r = engine.syncWith(c, nowIso(), port());
                    if (r.peer == null || r.peer.isEmpty() || r.peer.equals(engine.device()) || !done.add(r.peer)) continue;
                    engine.notePeer(r.peer, r.peerName, host, port);
                    s.reached++;
                    s.received += r.received;
                    s.sent += r.sent;
                    if (r.peerName != null) s.names.add(r.peerName);
                    if (invite != null && invite.equals(hp)) engine.setMeta("invite", null);
                } catch (Exception e) {
                    error = e.getMessage();
                }
            }
            lastSyncAt = nowIso();
            lastError = s.reached > 0 ? null : (where.isEmpty() ? "No other phones found on this Wi-Fi." : "Couldn't reach the other phone" + (error == null ? "." : ": " + error));
            if (s.received > 0) changed();
        } catch (Exception e) {
            lastError = e.getMessage();
            Log.w(TAG, "syncAll", e);
        } finally {
            syncing.unlock();
        }
        return s;
    }

    private void changed() {
        Runnable r = onChanged;
        if (r != null) r.run();
        try {
            Widgets.refreshAll(context);
        } catch (Throwable ignored) {
            // widgets refresh next time
        }
    }

    boolean batteryExempt() {
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    // ---------- the database, for SyncEngine ----------

    /** SyncEngine's view of the phone's SQLite database. */
    static final class AndroidDb implements SyncEngine.Db {
        private final SQLiteDatabase db;

        AndroidDb(SQLiteDatabase db) {
            this.db = db;
        }

        private static void bind(SQLiteProgram p, Object[] args) {
            for (int i = 0; i < args.length; i++) {
                Object v = args[i];
                int idx = i + 1;
                if (v == null || v == JSONObject.NULL) p.bindNull(idx);
                else if (v instanceof Boolean) p.bindLong(idx, ((Boolean) v) ? 1 : 0);
                else if (v instanceof Integer || v instanceof Long) p.bindLong(idx, ((Number) v).longValue());
                else if (v instanceof Number) p.bindDouble(idx, ((Number) v).doubleValue());
                else p.bindString(idx, String.valueOf(v));
            }
        }

        @Override
        public List<JSONObject> query(String sql, final Object... args) throws Exception {
            List<JSONObject> rows = new ArrayList<>();
            try (Cursor c = db.rawQueryWithFactory(
                (database, driver, editTable, query) -> {
                    bind(query, args);
                    return new SQLiteCursor(driver, editTable, query);
                },
                sql, null, null)) {
                String[] cols = c.getColumnNames();
                while (c.moveToNext()) {
                    JSONObject row = new JSONObject();
                    for (int i = 0; i < cols.length; i++) {
                        switch (c.getType(i)) {
                            case Cursor.FIELD_TYPE_NULL: row.put(cols[i], JSONObject.NULL); break;
                            case Cursor.FIELD_TYPE_INTEGER: row.put(cols[i], c.getLong(i)); break;
                            case Cursor.FIELD_TYPE_FLOAT: row.put(cols[i], c.getDouble(i)); break;
                            default: row.put(cols[i], c.getString(i));
                        }
                    }
                    rows.add(row);
                }
            }
            return rows;
        }

        @Override
        public void exec(String sql, Object... args) throws Exception {
            try (SQLiteStatement st = db.compileStatement(sql)) {
                bind(st, args);
                st.execute();
            }
        }

        @Override
        public void transaction(Body body) throws Exception {
            db.beginTransaction();
            try {
                body.run();
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
    }
}
