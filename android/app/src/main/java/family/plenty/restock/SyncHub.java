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
        this.household = new SyncHousehold(engine);
        // A phone joining from the first screen gets the owner's shop choices and settings once.
        household.settings = () -> {
            try (Cursor c = RestockDatabase.get(context).rawQuery("SELECT value FROM kv WHERE key = 'settings'", null)) {
                return c.moveToFirst() ? c.getString(0) : null;
            }
        };
    }

    static String nowIso() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }

    // ---------- the household ----------

    final SyncHousehold household;

    /** True once the app's tables (and sync's) exist. */
    boolean ready() {
        try (Cursor c = RestockDatabase.get(context).rawQuery("SELECT 1 FROM sqlite_master WHERE name = 'household'", null)) {
            return c.moveToFirst();
        }
    }

    /** The household's current key, or null when this phone isn't in one. */
    byte[] key() {
        try {
            if (!ready() || !household.paired()) return null;
            return household.key();
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

    /**
     * 0.8.2: phones paired on 0.8.0 or 0.8.1 pair again (owner phone and one-time codes need it).
     * They keep everything; the Sync screen says what to do.
     */
    void upgradeOldPairing() {
        try {
            if (ready() && household.legacy()) {
                household.forget();
                engine.setMeta("notice", "repair");
            }
        } catch (Exception e) {
            Log.w(TAG, "upgradeOldPairing", e);
        }
    }

    /**
     * Owner: a new one-time code for another phone (starting the household first if there isn't
     * one). Each call makes a different code; it works once, for 10 minutes.
     */
    String invite(String householdName, boolean shareCards, Set<String> tabs) throws Exception {
        upgradeOldPairing();
        if (!household.paired()) {
            if (engine.meta("name") == null) engine.setMeta("name", defaultName());
            household.create(householdName, null, tabs);
            engine.setShareCards(shareCards);
            engine.setMeta("notice", null);
        }
        start();
        String code = household.invite(localIp(), port());
        readvertise();
        return code;
    }

    void closeInvite() throws Exception {
        household.closeInvite();
        readvertise();
    }

    /** Something the joining phone sends the owner over the code's sealed link. */
    interface PairingStep {
        JSONObject run(SyncWire.Client c) throws Exception;
    }

    /**
     * Reaches the owner phone with a code (at the address in it, or by looking for it on the
     * Wi-Fi) and does `step`. What the owner says (a full household, a used code) comes straight
     * back; only connection problems are tried again.
     */
    private JSONObject withOwner(String code, PairingStep step) throws Exception {
        String[] c = SyncHousehold.parseCode(code);
        byte[] token = SyncWire.unbase32(c[0]);
        if (token.length != 16) throw new IllegalArgumentException("That code is damaged. Make a new one on the owner phone.");
        byte[] pk = SyncHousehold.pairingKey(token);
        List<String> where = new ArrayList<>();
        if (!c[1].isEmpty() && !"0".equals(c[2])) where.add(c[1] + ":" + c[2]);
        for (int round = 0; round < 2; round++) {
            if (round == 1) where = discover(5000, "p", SyncHousehold.pairingTag(token));
            for (String hp : where) {
                int colon = hp.lastIndexOf(':');
                try (SyncWire.Client cl = new SyncWire.Client(pk, hp.substring(0, colon), Integer.parseInt(hp.substring(colon + 1)), 3000)) {
                    JSONObject r = step.run(cl);
                    r.put("_reached", hp);
                    return r;
                } catch (SyncHousehold.OwnerSaid e) {
                    throw new IllegalStateException(e.getMessage());
                } catch (Exception e) {
                    // not there: try the next address
                }
            }
        }
        throw new IllegalStateException(
            "Couldn't reach the owner phone. Keep Restock open on it with the code showing, make sure both phones are on the same Wi-Fi, and try again.");
    }

    /** 0.8.5: what a code's household is (name, owner, what it shares, the owner's settings), before joining. */
    JSONObject peek(String code) throws Exception {
        upgradeOldPairing();
        if (household.paired()) throw new IllegalStateException("This phone is already in a household. Stop syncing it first.");
        return withOwner(code, household::peek);
    }

    /**
     * Joins with a scanned or pasted code and gets the household's key. `replace`: this phone
     * starts from the household's things on the tabs it shares. `tabs`: what this phone shares
     * (null: everything the household shares). Answers what the owner sent.
     */
    JSONObject join(String code, boolean replace, boolean shareCards, Set<String> tabs) throws Exception {
        upgradeOldPairing();
        if (household.paired()) throw new IllegalStateException("This phone is already in a household. Stop syncing it first.");
        if (engine.meta("name") == null) engine.setMeta("name", defaultName());
        // Anything left from an earlier household (a phone that left before 0.8.5 kept its record) goes.
        household.forget();
        // Starting over from the household's things: a fresh sync name, so the others don't skip
        // records this phone made before (they'd think it already has them).
        if (replace) engine.newDevice();
        JSONObject got = withOwner(code, cl -> household.join(cl, true));
        String reached = got.optString("_reached", null);
        got.remove("_reached");
        stop();
        Set<String> mine = tabs == null ? SyncEngine.parseTabs((String) null) : tabs;
        if (replace) engine.clearForJoin(mine);
        engine.setMeta("tabs", tabs == null ? null : SyncEngine.joinTabs(tabs));
        engine.setMeta("tabs_eff", null);
        engine.setShareCards(shareCards);
        engine.setMeta("notice", null);
        if (got.has("household")) engine.setMeta("household", got.optString("household"));
        if (reached != null) engine.setMeta("invite", reached);
        start();
        return got;
    }

    /** This phone picks which of the household's tabs it shares. */
    void setMyTabs(Set<String> tabs) throws Exception {
        if (tabs.isEmpty()) throw new IllegalArgumentException("Pick at least one thing to share, or stop syncing this phone.");
        engine.setMeta("tabs", SyncEngine.joinTabs(tabs));
        engine.noteTabs();
        new Thread(this::syncAll).start();
    }

    /** Owner: what the household shares. */
    void setHouseholdTabs(Set<String> tabs) throws Exception {
        household.setHouseholdTabs(tabs);
        new Thread(this::syncAll).start();
    }

    /** This phone leaves the household (keeping its things). False: the owner must hand over first. */
    boolean leave() throws Exception {
        if (!household.paired()) return true;
        if (!household.startLeaving()) return false;
        syncAll(); // let the others see it go, if they're here
        stop();
        household.forget();
        context.stopService(new android.content.Intent(context, SyncService.class));
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        return true;
    }

    /** Owner: removes a phone. The household's key changes so it can't sync again. */
    void remove(String device) throws Exception {
        household.remove(device);
        readvertise();
        new Thread(this::syncAll).start(); // hand the new key out to whoever's here
    }

    /** Owner: asks another phone to be the owner (it takes over when it next syncs). */
    void handOver(String device) throws Exception {
        household.handOver(device);
        readvertise();
        new Thread(this::syncAll).start();
    }

    void cancelHandOver() throws Exception {
        household.cancelHandOver();
        new Thread(this::syncAll).start();
    }

    static String defaultName() {
        String m = Build.MODEL == null ? "" : Build.MODEL.trim();
        return m.isEmpty() ? "Android phone" : m;
    }

    // ---------- listening ----------

    /** Listens for the household's other phones and tells the Wi-Fi this phone is here. */
    synchronized void start() {
        upgradeOldPairing();
        if (key() == null || server != null) return;
        try {
            server = new SyncWire.Server(household::serverKeys, new SyncWire.Handler() {
                volatile boolean took;
                volatile boolean real;

                @Override
                public JSONObject handle(JSONObject m, String host, int which) throws Exception {
                    JSONObject r = household.handle(m, host, which);
                    if (r.optInt("changed", 0) > 0) took = true;
                    if (which != SyncHousehold.PAIRING && !r.has("error") && !r.has("removed") && !r.has("rekey") && "push".equals(m.optString("op"))) real = true;
                    if (which == SyncHousehold.PAIRING && r.has("key")) {
                        took = true;
                        readvertise(); // the code is used up
                    }
                    return r;
                }

                @Override
                public void done(String host) {
                    // Only a sync that went through counts as "synced" (0.8.5).
                    if (real) {
                        real = false;
                        lastSyncAt = nowIso();
                    }
                    try {
                        if (household.takeHandover()) readvertise();
                    } catch (Exception ignored) {
                        // next time
                    }
                    if (took) {
                        took = false;
                        changed();
                    }
                }
            });
            advertise();
            schedule();
        } catch (Exception e) {
            lastError = "Couldn't listen for other phones: " + e.getMessage();
            Log.w(TAG, "start", e);
        }
    }

    synchronized void stop() {
        unadvertise();
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

    private synchronized void unadvertise() {
        if (registration != null) {
            try {
                nsd().unregisterService(registration);
            } catch (Exception ignored) {
                // already gone
            }
            registration = null;
        }
    }

    /** The household's key, an open code, or the owner changed: tell the Wi-Fi again. */
    synchronized void readvertise() {
        if (server == null) return;
        unadvertise();
        try {
            advertise();
        } catch (Exception e) {
            Log.w(TAG, "readvertise", e);
        }
    }

    /**
     * Tells the Wi-Fi this phone is here: "h" is a public tag for the household's key (and "o"
     * for the one before it, on the owner), "p" for an open pairing code, "d" this phone.
     */
    private synchronized void advertise() throws Exception {
        byte[] key = key();
        if (key == null || server == null) return;
        NsdServiceInfo info = new NsdServiceInfo();
        String device = engine.device();
        info.setServiceName("Restock-" + device.substring(0, Math.min(8, device.length())));
        info.setServiceType(SERVICE_TYPE);
        info.setPort(server.port());
        info.setAttribute("h", SyncWire.householdId(key));
        info.setAttribute("d", device);
        if (household.isOwner()) {
            byte[] old = household.oldKey();
            if (old != null) info.setAttribute("o", SyncWire.householdId(old));
            String tag = household.openPairingTag();
            if (tag != null) info.setAttribute("p", tag);
        }
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
        byte[] key = key();
        if (key == null) return new ArrayList<>();
        List<String> found = discover(ms, "h", SyncWire.householdId(key));
        // An owner that changed the key still shows the old one as "o", for phones that missed it.
        for (String hp : discover(0, "o", SyncWire.householdId(key))) if (!found.contains(hp)) found.add(hp);
        return found;
    }

    private final Map<String, Map<String, String>> lastAttrs = new java.util.HashMap<>();

    /**
     * Phones on this Wi-Fi whose `attr` is `value` (the household, or an open pairing code), as
     * host:port, looking for `ms`. With ms 0, matches among what the last look found.
     */
    List<String> discover(long ms, String attr, String value) {
        List<String> found = new ArrayList<>();
        if (ms <= 0) {
            synchronized (lastAttrs) {
                for (Map.Entry<String, Map<String, String>> en : lastAttrs.entrySet()) if (value.equals(en.getValue().get(attr))) found.add(en.getKey());
            }
            return found;
        }
        final String household = value;
        final String wanted = attr;
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
                Map<String, String> text = new java.util.HashMap<>();
                for (Map.Entry<String, byte[]> en : attrs.entrySet())
                    if (en.getValue() != null) text.put(en.getKey(), new String(en.getValue(), StandardCharsets.UTF_8));
                String hp = r.getHost().getHostAddress() + ":" + r.getPort();
                synchronized (lastAttrs) {
                    lastAttrs.put(hp, text);
                }
                if (!household.equals(text.get(wanted)) || self.equals(text.get("d"))) continue;
                found.add(hp);
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

    private volatile Summary lastSummary;

    /** Finds the household's other phones and syncs with each. One at a time. */
    Summary syncAll() {
        Summary s = new Summary();
        byte[] key = key();
        if (key == null) return s;
        if (!syncing.tryLock()) {
            // A sync is already going (in the background, say): wait for it and answer with what it did.
            try {
                if (syncing.tryLock(60, TimeUnit.SECONDS)) syncing.unlock();
            } catch (InterruptedException ignored) {
                // answer with what's known
            }
            Summary last = lastSummary;
            return last != null ? last : s;
        }
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
                SyncEngine.Result r = null;
                for (int attempt = 0; attempt < 2; attempt++) {
                    try (SyncWire.Client c = new SyncWire.Client(key, host, port, 2500)) {
                        r = engine.syncWith(c, nowIso(), port());
                    } catch (Exception e) {
                        error = e.getMessage();
                        r = null;
                    }
                    if (r == null || r.rekey == null) break;
                    // The owner changed the household's key (it removed a phone): take the new one and go again.
                    household.takeRekey(r.rekey);
                    key = key();
                    readvertise();
                }
                if (r == null) continue;
                // Only the owner can say this phone was removed (another phone may not know it was let back in).
                if (r.removed && r.peer != null && !r.peer.equals(household.owner())) continue;
                if (r.removed) {
                    // The owner removed this phone. It keeps its things, but stops syncing.
                    stop();
                    household.forget();
                    engine.setMeta("notice", "removed");
                    context.stopService(new android.content.Intent(context, SyncService.class));
                    WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
                    changed();
                    break;
                }
                {
                    if (r.peer == null || r.peer.isEmpty() || r.peer.equals(engine.device()) || !done.add(r.peer)) continue;
                    engine.notePeer(r.peer, r.peerName, host, port);
                    // A phone that joined with a short code learns the household's name here.
                    if (engine.meta("household") == null && r.household != null && !r.household.isEmpty()) engine.setMeta("household", r.household);
                    s.reached++;
                    s.received += r.received;
                    s.sent += r.sent;
                    if (r.peerName != null) s.names.add(r.peerName);
                    if (invite != null && invite.equals(hp)) engine.setMeta("invite", null);
                }
            }
            // Made the owner by the phone before? Take over (the phones' secrets came sealed for this one).
            if (key() != null && household.takeHandover()) readvertise();
            if (s.reached > 0) lastSyncAt = nowIso();
            lastSummary = s;
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
