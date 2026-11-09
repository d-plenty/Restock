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
 *
 * 0.9.1:
 * - Listens only while the phone is on Wi-Fi or Ethernet (a ConnectivityManager callback), on
 *   that network's own address. On mobile data it doesn't listen or look for phones; sync away
 *   from home (a WebDAV server or a folder) still works.
 * - Sync away from home can be a Nextcloud (signed in with Nextcloud's Login Flow v2), another
 *   WebDAV server (SyncDav), or a folder picked on the phone. Each is tried out before it's used.
 * - Secrets in sync_meta are sealed with a key in Android's key store (SyncKeystore).
 * - Receipt photos travel over the Wi-Fi (AndroidPhotos), and old deletes are tidied away once a day.
 *
 * 0.9.2: a Restock server (ServerFolder, docs/server-protocol.md) as well, on a card of its own: a
 * phone can use it alongside Wi-Fi sync and the away-from-home choice. With it, older prices and
 * receipt photos move there (ServerOffload), the web app is given the household's server key when a
 * phone scans its code (ServerLink), and again after the key changes (webkeys/).
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
    /** 0.9.0: folder sync's last problem, or null. */
    volatile String folderError;
    /** 0.9.2: the Restock server's last problem in words, or null; and the address that answered last. */
    volatile String serverError;
    volatile String serverReached;

    static synchronized SyncHub get(Context context) {
        if (instance == null) instance = new SyncHub(context.getApplicationContext());
        return instance;
    }

    final SyncKeystore keystore = new SyncKeystore();

    private SyncHub(Context context) {
        this.context = context;
        this.engine = new SyncEngine(new AndroidDb(RestockDatabase.get(context)));
        // 0.9.1: secrets sealed in Android's key store; receipt photos from Restock's own storage.
        engine.secrets = keystore;
        engine.photos = new AndroidPhotos(context);
        this.household = new SyncHousehold(engine);
        watchNetworks();
        // A phone joining from the first screen gets the owner's shop choices and settings once.
        household.settings = () -> {
            try (Cursor c = RestockDatabase.get(context).rawQuery("SELECT value FROM kv WHERE key = 'settings'", null)) {
                if (!c.moveToFirst()) return null;
                // 0.9.0: the automatic backups' password stays on this phone.
                JSONObject st = new JSONObject(c.getString(0));
                JSONObject ab = st.optJSONObject("autoBackup");
                if (ab != null) ab.remove("password");
                return st.toString();
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
            // 0.9.1: secrets this phone can't open any more (its data was copied onto another phone,
            // or Android's key store was reset): like a phone that isn't in a household, and say so.
            if (ready() && (!secretsChecked || engine.secretsLost)) {
                boolean lost = engine.checkSecrets(); // a passing key store problem throws: try again next time
                secretsChecked = true;
                if (lost) {
                    stop();
                    household.forget();
                    engine.secretsLost = false;
                    engine.setMeta("notice", "keys");
                    return;
                }
            }
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
        if (!onLan()) throw new IllegalStateException(OFF_WIFI);
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

    /** 0.9.1: phones only pair (and sync with each other) on Wi-Fi or Ethernet. */
    static final String OFF_WIFI = "Connect this phone to your Wi-Fi first. Phones join a household on the same Wi-Fi.";

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
                } catch (SyncHousehold.OwnerSaid | SyncWire.Refused e) {
                    // The owner phone was reached and said no: say why, rather than "couldn't reach it".
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
        if (!onLan()) throw new IllegalStateException(OFF_WIFI);
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
        household.pairingKeyUsed = SyncHousehold.pairingKey(SyncWire.unbase32(SyncHousehold.parseCode(code)[0]));
        JSONObject got = withOwner(code, cl -> household.join(cl, true));
        String reached = got.optString("_reached", null);
        got.remove("_reached");
        stop();
        Set<String> mine = tabs == null ? SyncEngine.parseTabs((String) null) : tabs;
        if (replace) engine.clearForJoin(mine);
        // 0.9.0, "Combine": where the household already has something, its version wins.
        else engine.yieldToHousehold();
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

    /** 0.9.1, owner: whether the household shares receipts (and, over the Wi-Fi, their photos). */
    void setHouseholdReceipts(boolean on) throws Exception {
        household.setHouseholdReceipts(on);
        new Thread(this::syncAll).start();
    }

    /** This phone leaves the household (keeping its things). False: the owner must hand over first. */
    boolean leave() throws Exception {
        if (!household.paired()) return true;
        if (!household.startLeaving()) return false;
        syncAll(); // let the others see it go, if they're here
        stop();
        letGoOfServer();
        letGoOfRestockServer(true);
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

    private volatile boolean secretsChecked;

    // ---------- 0.9.1: Wi-Fi and Ethernet only ----------

    /** The Wi-Fi and Ethernet networks the phone is on now, with their addresses. */
    private final Map<Network, LinkProperties> lans = new java.util.concurrent.ConcurrentHashMap<>();
    private volatile boolean lansKnown;
    /** Whether something asked to listen (start()) and nothing asked to stop since. */
    private volatile boolean wanted;
    /** The address the listener is tied to. */
    private volatile InetAddress boundTo;

    private void watchNetworks() {
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            android.net.NetworkRequest req = new android.net.NetworkRequest.Builder()
                .addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                .addTransportType(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)
                // A home network without the internet still counts.
                .removeCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
            cm.registerNetworkCallback(req, new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network n) {
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (lp != null) lans.put(n, lp);
                    lansKnown = true;
                    networksChanged();
                }

                @Override
                public void onLinkPropertiesChanged(Network n, LinkProperties lp) {
                    lans.put(n, lp);
                    lansKnown = true;
                    networksChanged();
                }

                @Override
                public void onLost(Network n) {
                    lans.remove(n);
                    networksChanged();
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "watchNetworks", e);
        }
    }

    /** Whether the phone is on Wi-Fi or Ethernet now. */
    boolean onLan() {
        if (!lans.isEmpty()) return true;
        if (lansKnown) return false;
        // Before the first callback: what Android says about the active network.
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm == null ? null : cm.getActiveNetwork();
            android.net.NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
            return c != null && (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET));
        } catch (Exception e) {
            return false;
        }
    }

    /** This phone's IPv4 address on the Wi-Fi or Ethernet, or null. */
    private InetAddress lanAddress() {
        for (LinkProperties lp : lans.values()) {
            for (LinkAddress a : lp.getLinkAddresses()) {
                InetAddress ip = a.getAddress();
                if (ip instanceof Inet4Address && !ip.isLoopbackAddress()) return ip;
            }
        }
        return null;
    }

    /** Wi-Fi came or went, or its address changed: listen, stop, or listen on the new address. */
    private void networksChanged() {
        new Thread(() -> {
            synchronized (SyncHub.this) {
                boolean on = onLan();
                InetAddress at = lanAddress();
                if (server != null && (!on || (at != null && !at.equals(boundTo)))) pause();
                if (on && wanted && server == null) start();
            }
        }, "restock-sync-net").start();
    }

    // ---------- listening ----------

    /**
     * Listens for the household's other phones and tells the Wi-Fi this phone is here. 0.9.1: only
     * on Wi-Fi or Ethernet (it starts by itself when the phone gets there), on its address there.
     */
    synchronized void start() {
        upgradeOldPairing();
        if (key() == null) return;
        wanted = true;
        if (server != null || !onLan()) return;
        try {
            InetAddress at = lanAddress();
            SyncWire.Handler handler = new SyncWire.Handler() {
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
            };
            try {
                server = new SyncWire.Server(household::serverKeys, handler, at);
                boundTo = at;
            } catch (java.io.IOException cantBind) {
                // That address can't be listened on (it's just changed): every address, for now.
                server = new SyncWire.Server(household::serverKeys, handler, null);
                boundTo = null;
            }
            advertise();
            schedule();
        } catch (Exception e) {
            lastError = "Couldn't listen for other phones: " + e.getMessage();
            Log.w(TAG, "start", e);
        }
    }

    synchronized void stop() {
        wanted = false;
        pause();
    }

    /** Stops listening for now (off the Wi-Fi); start() or the Wi-Fi coming back starts it again. */
    private synchronized void pause() {
        unadvertise();
        if (server != null) {
            server.stop();
            server = null;
        }
        boundTo = null;
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

    /** The name this phone advertises under (random, 0.9.0), so it can skip itself when looking. */
    private volatile String myServiceName;

    /**
     * Tells the Wi-Fi this phone is here: "h" is a public tag for the household's key (and "o"
     * for the one before it, on the owner), "p" for an open pairing code. 0.9.0: the tags change
     * every day and the name is random, so nobody can follow this phone around by them.
     */
    private synchronized void advertise() throws Exception {
        byte[] key = key();
        if (key == null || server == null) return;
        NsdServiceInfo info = new NsdServiceInfo();
        byte[] r = new byte[4];
        new java.security.SecureRandom().nextBytes(r);
        StringBuilder name = new StringBuilder("Restock-");
        for (byte x : r) name.append(String.format("%02x", x & 0xff));
        myServiceName = name.toString();
        info.setServiceName(myServiceName);
        info.setServiceType(SERVICE_TYPE);
        info.setPort(server.port());
        info.setAttribute("h", SyncWire.dayTag(key, 0));
        if (household.isOwner()) {
            byte[] old = household.oldKey();
            if (old != null) info.setAttribute("o", SyncWire.dayTag(old, 0));
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
        // Today's tag, yesterday's and tomorrow's (phones either side of midnight), and the fixed
        // tag phones on 0.8.x still use.
        List<String> found = discover(ms, "h", SyncWire.dayTag(key, 0));
        for (String tag : new String[] { SyncWire.dayTag(key, -1), SyncWire.dayTag(key, 1), SyncWire.householdId(key) })
            for (String hp : discover(0, "h", tag)) if (!found.contains(hp)) found.add(hp);
        // An owner that changed the key still shows the old one as "o", for phones that missed it.
        for (String tag : new String[] { SyncWire.dayTag(key, 0), SyncWire.dayTag(key, -1), SyncWire.dayTag(key, 1), SyncWire.householdId(key) })
            for (String hp : discover(0, "o", tag)) if (!found.contains(hp)) found.add(hp);
        return found;
    }

    /** Everyone on this Wi-Fi advertising Restock (from the last look), for a phone that lost track of the key. */
    private List<String> everyoneSeen() {
        List<String> all = new ArrayList<>();
        synchronized (lastAttrs) {
            all.addAll(lastAttrs.keySet());
        }
        return all;
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
                String n = info.getServiceName();
                if (n != null && n.startsWith("Restock-") && !n.equals(myServiceName)) synchronized (seen) {
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
                if (!household.equals(text.get(wanted)) || self.equals(text.get("d")) || (r.getServiceName() != null && r.getServiceName().equals(myServiceName))) continue;
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
        InetAddress lan = lanAddress();
        if (lan != null) return lan.getHostAddress();
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
            // 0.9.1: the other phones only on the Wi-Fi (or Ethernet), never over mobile data.
            boolean lan = onLan();
            // Where they were last time (quickest), the phone that invited this one, then a fresh look.
            if (lan) try (Cursor c = RestockDatabase.get(context).rawQuery("SELECT host, port FROM sync_peers WHERE host IS NOT NULL AND port > 0", null)) {
                while (c.moveToNext()) where.add(c.getString(0) + ":" + c.getInt(1));
            }
            String invite = engine.meta("invite");
            if (lan && invite != null && !invite.endsWith(":0")) where.add(invite);
            if (lan) where.addAll(discover(4000));
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
                    letGoOfServer();
                    letGoOfRestockServer(true);
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
                    s.received += r.received + r.photos;
                    s.sent += r.sent;
                    if (r.peerName != null) s.names.add(r.peerName);
                    if (invite != null && invite.equals(hp)) engine.setMeta("invite", null);
                }
            }
            // Made the owner by the phone before? Take over (the phones' secrets came sealed for this one).
            if (key() != null && household.takeHandover()) readvertise();
            // 0.9.0: this phone's signing key, and on the owner the owner key, the household's id and
            // the recovery key, for households from before 0.9.0 (and after a double takeover).
            if (key() != null) household.ensureKeys();
            // 0.9.0: no phone answered with the key this phone has: maybe it missed key changes
            // (phones removed while it was away). Ask the owner with this phone's own secret, now
            // and then.
            if (lan && key() != null && s.reached == 0 && !household.isOwner()) {
                long last = 0;
                try {
                    last = Long.parseLong(String.valueOf(engine.meta("asked_key_at")));
                } catch (Exception ignored) {
                    // never asked
                }
                if (System.currentTimeMillis() - last > 10 * 60 * 1000L) {
                    engine.setMeta("asked_key_at", String.valueOf(System.currentTimeMillis()));
                    List<String> ask = new ArrayList<>(where);
                    for (String hp : everyoneSeen()) if (!ask.contains(hp)) ask.add(hp);
                    String secret = engine.meta("secret");
                    for (String hp : ask) {
                        int colon = hp.lastIndexOf(':');
                        try (SyncWire.Client c = new SyncWire.Client(java.util.Base64.getUrlDecoder().decode(secret), hp.substring(0, colon), Integer.parseInt(hp.substring(colon + 1)), 2500)) {
                            if (household.askForKey(c)) {
                                readvertise();
                                break;
                            }
                        } catch (SyncHousehold.RemovedException gone) {
                            stop();
                            letGoOfServer();
                            letGoOfRestockServer(true);
                            household.forget();
                            engine.setMeta("notice", "removed");
                            context.stopService(new android.content.Intent(context, SyncService.class));
                            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
                            changed();
                            return s;
                        } catch (Exception notThisOne) {
                            // not the owner, or not there
                        }
                    }
                }
            }
            // 0.9.0: then the folder, for the phones that aren't on this Wi-Fi.
            SyncFolder.Result fr = syncFolder();
            if (fr != null) {
                s.received += fr.received;
                if (fr.rekeyed) readvertise();
            }
            // 0.9.2: then the Restock server, if this phone uses one.
            SyncFolder.Result sr = syncServer();
            if (sr != null) {
                s.received += sr.received;
                if (sr.rekeyed) readvertise();
            }
            // The folder (or server) only counts when another phone's file was there to read.
            boolean viaFolder = (fr != null && folderError == null && fr.phones > 0) || (sr != null && serverError == null && sr.phones > 0);
            if (s.reached > 0 || viaFolder) lastSyncAt = nowIso();
            lastSummary = s;
            lastError = s.reached > 0 || viaFolder
                ? null
                : !lan
                    ? "This phone isn't on Wi-Fi, so it can't reach the other phones right now."
                    : (where.isEmpty() ? "No other phones found on this Wi-Fi." : "Couldn't reach the other phone" + (error == null ? "." : ": " + error));
            if (s.received > 0) changed();
            // 0.9.1: now and then (once a day at most), tidy away old deletes everyone has seen.
            if (s.reached > 0 || viaFolder) compactNow();
        } catch (Exception e) {
            lastError = e.getMessage();
            Log.w(TAG, "syncAll", e);
        } finally {
            syncing.unlock();
        }
        return s;
    }

    // ---------- 0.9.0: sync through a folder ----------

    /** The folder the household syncs through (a picked folder's address), or null. */
    String folder() {
        try {
            return engine.meta("folder");
        } catch (Exception e) {
            return null;
        }
    }

    /** 0.9.1: what sync away from home goes through: "nextcloud", "webdav", "folder", or null. */
    String folderKind() {
        String f = folder();
        if (f == null) return null;
        if (!f.startsWith("https://") && !f.startsWith("http://")) return "folder";
        try {
            return "nextcloud".equals(engine.meta("dav_kind")) ? "nextcloud" : "webdav";
        } catch (Exception e) {
            return "webdav";
        }
    }

    /**
     * Where sync away from home goes (a picked folder's address, or 0.9.1: a WebDAV folder's), or
     * stop (null). Stopping, or changing, forgets the WebDAV sign-in on this phone.
     */
    void setFolder(String uri) throws Exception {
        if (uri == null || !(uri.startsWith("https://") || uri.startsWith("http://"))) letGoOfServer();
        engine.setMeta("folder", uri == null || uri.isEmpty() ? null : uri);
        engine.setMeta("folder_top", null);
        engine.setMeta("folder_keys", null);
        engine.db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%'");
        if (uri == null || !(uri.startsWith("https://") || uri.startsWith("http://"))) {
            engine.setMeta("dav_user", null);
            engine.setMeta("dav_pass", null);
            engine.setMeta("dav_kind", null);
        }
        if (uri == null) {
            engine.setMeta("folder_at", null);
            folderError = null;
        }
    }

    static final String CANT_HOLD = "That app can't hold a folder for Restock. Try Nextcloud, Syncthing or a folder on this phone.";

    /** 0.9.1: a folder picked on the phone, tried out first (a test file written, read back and deleted). */
    void setPickedFolder(String uri) throws Exception {
        try {
            SyncFolder.check(new AndroidFolder(context, android.net.Uri.parse(uri)), CANT_HOLD);
        } catch (SyncFolder.Unusable u) {
            Log.w(TAG, "folder check", u.getCause());
            throw new IllegalStateException(CANT_HOLD);
        }
        setFolder(uri);
        folderError = null;
    }

    /**
     * 0.9.1: a WebDAV folder (`url`, made if it isn't there), tried out first. `kind`: "nextcloud"
     * or "webdav". The password stays on this phone only, sealed (SyncKeystore).
     */
    void setWebDav(String url, String user, String password, String kind) throws Exception {
        SyncDav.DavFolder f = new SyncDav.DavFolder(url, user, password);
        f.ensure();
        try {
            SyncFolder.check(f, "");
        } catch (SyncFolder.Unusable u) {
            Throwable c = u.getCause();
            throw new IllegalStateException(c instanceof SyncDav.Problem ? c.getMessage() : "Restock couldn't save a test file in that folder" + (c == null || c.getMessage() == null ? "." : ": " + c.getMessage()));
        }
        // Signed in to Nextcloud again (or somewhere else): Nextcloud can forget the old app password.
        if (!java.util.Objects.equals(password, engine.meta("dav_pass"))) letGoOfServer();
        engine.setMeta("dav_user", user == null ? "" : user);
        engine.setMeta("dav_pass", password == null ? "" : password);
        engine.setMeta("dav_kind", kind);
        setFolder(f.base.toString());
        folderError = null;
    }

    /**
     * 0.9.1: this phone is letting go of its Nextcloud sign-in (Stop, signing in again, leaving the
     * household, Erase everything): ask Nextcloud to delete Restock's app password, in the
     * background. Only Nextcloud has a way to do that; other servers' passwords are the person's own.
     */
    void letGoOfServer() {
        try {
            if (!"nextcloud".equals(folderKind())) return;
            final String url = folder(), user = engine.meta("dav_user"), pass = engine.meta("dav_pass");
            if (pass == null || pass.isEmpty()) return;
            new Thread(() -> SyncDav.revokeNextcloud(url, user, pass), "restock-nextcloud-bye").start();
        } catch (Exception e) {
            Log.w(TAG, "letGoOfServer", e);
        }
    }

    private volatile boolean signInCancelled;

    /**
     * 0.9.1, "Sign in to Nextcloud": Nextcloud's Login Flow v2. Opens Nextcloud's sign-in page in the
     * browser (`open`), waits for the person to finish (asking every 2 seconds, for up to 20
     * minutes, until cancelNextcloud()), then uses the app password Nextcloud gave Restock for a
     * folder named `folder` (made if it isn't there). False if cancelled.
     */
    boolean signInNextcloud(String server, String folder, java.util.function.Consumer<String> open) throws Exception {
        signInCancelled = false;
        String name = SyncDav.folderName(folder);
        SyncDav.Login l = SyncDav.startLogin(server);
        open.accept(l.login.toString());
        SyncDav.Signin s = SyncDav.pollLogin(l, () -> signInCancelled, 2000, 20 * 60 * 1000L);
        if (s == null) return false;
        setWebDav(SyncDav.nextcloudFolderUrl(s.server, s.loginName, name), s.loginName, s.appPassword, "nextcloud");
        return true;
    }

    void cancelNextcloud() {
        signInCancelled = true;
    }

    /** The folder to sync through, as SyncFolder needs it. */
    private SyncFolder.Folder openFolder(String uri) throws Exception {
        if (uri.startsWith("https://") || uri.startsWith("http://")) return new SyncDav.DavFolder(uri, engine.meta("dav_user"), engine.meta("dav_pass"));
        return new AndroidFolder(context, android.net.Uri.parse(uri));
    }

    /** One round with the folder, if there is one; null when there isn't. */
    SyncFolder.Result syncFolder() {
        String uri = folder();
        if (uri == null || key() == null) return null;
        boolean dav = uri.startsWith("https://") || uri.startsWith("http://");
        try {
            SyncFolder.Result r = new SyncFolder(engine, household).sync(openFolder(uri), nowIso());
            folderError = null;
            return r;
        } catch (SecurityException e) {
            folderError = "Restock can't open the sync folder any more. Pick it again in Settings → Local sync.";
        } catch (SyncDav.Problem e) {
            boolean nc = "nextcloud".equals(folderKind());
            folderError = e.getMessage().contains("user name or password")
                ? (nc ? "Nextcloud didn't accept Restock's sign-in any more. Tap Change and sign in again." : "The server didn't accept the user name or password. Tap Change and enter them again.")
                : e.getMessage();
        } catch (Exception e) {
            folderError = "Couldn't sync " + (dav ? "with the server" : "through the folder") + (e.getMessage() == null ? "." : ": " + e.getMessage());
            Log.w(TAG, "syncFolder", e);
        }
        return new SyncFolder.Result();
    }

    // ---------- 0.9.2: sync through a Restock server (ServerSync) ----------

    private ServerSync server() {
        return new ServerSync(engine, household);
    }

    List<String> serverAddresses() {
        return server().addresses();
    }

    boolean serverOn() {
        return ready() && server().on();
    }

    int offloadedPhotos() {
        return server().offloadedPhotos();
    }

    /**
     * Joining and stopping wait for a round that's going (in the background, say) to finish: one
     * mid-way could otherwise move photos off the phone after Stop brought them back, or write notes
     * for the server just forgotten.
     */
    private void lockForServer() throws Exception {
        boolean got;
        try {
            got = syncing.tryLock(3, TimeUnit.MINUTES);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            got = false;
        }
        if (!got) throw new IllegalStateException("Restock is still syncing. Try again in a minute.");
    }

    /** Joins a Restock server with the code from its Add a phone page. Throws with words. */
    void joinServer(String code) throws Exception {
        lockForServer();
        try {
            serverReached = server().join(code);
            serverError = null;
        } finally {
            syncing.unlock();
        }
    }

    /** Stop using the server (bringBack: its receipt photos come back first; throws if they can't). */
    void stopServer(boolean bringBack) throws Exception {
        lockForServer();
        try {
            server().stop(bringBack);
            serverError = null;
            serverReached = null;
        } finally {
            syncing.unlock();
        }
    }

    /** Leaving the household (or removed from it): photos back if the server can be reached, then off the server. */
    void letGoOfRestockServer(boolean bringBack) {
        try {
            if (serverOn()) stopServer(bringBack);
        } catch (Exception e) {
            Log.w(TAG, "letGoOfRestockServer", e);
            try {
                stopServer(false);
            } catch (Exception ignored) {
                // forget() clears the rest
            }
        }
    }

    /** One round with the server, if this phone uses one; null when it doesn't. */
    SyncFolder.Result syncServer() {
        if (!serverOn() || key() == null) return null;
        ServerSync.Round r = server().round(nowIso(), System.currentTimeMillis());
        serverReached = r.reached;
        serverError = r.error;
        if (r.error != null && r.cause != null) Log.w(TAG, "syncServer", r.cause);
        if (r.offload != null && (r.offload.changed || r.offload.pruned > 0)) changed();
        return r.result;
    }

    JSONObject webCode(String code) throws Exception {
        return server().webCode(code);
    }

    JSONObject approveWeb(String code) throws Exception {
        return server().approveWeb(code);
    }

    byte[] serverPhoto(String path) throws Exception {
        return server().photo(path);
    }

    /** 0.9.1: tidies old deletes from sync_log, at most once a day. */
    private void compactNow() {
        try {
            long now = System.currentTimeMillis();
            String at = engine.meta("compact_at");
            if (at != null && now - Long.parseLong(at) < 24L * 3600 * 1000) return;
            engine.setMeta("compact_at", String.valueOf(now));
            int n = engine.compact(now);
            if (n > 0) Log.i(TAG, "tidied " + n + " old deletes");
        } catch (Exception e) {
            Log.w(TAG, "compact", e);
        }
    }

    /** A folder picked with Android's folder picker, as SyncFolder needs it. */
    static final class AndroidFolder implements SyncFolder.Folder {
        private final android.content.ContentResolver cr;
        private final android.net.Uri tree;
        private final Map<String, String> ids = new java.util.HashMap<>();
        private final Map<String, String> versions = new java.util.HashMap<>();

        AndroidFolder(Context context, android.net.Uri tree) {
            this.cr = context.getContentResolver();
            this.tree = tree;
        }

        private android.net.Uri dir() {
            return android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, android.provider.DocumentsContract.getTreeDocumentId(tree));
        }

        @Override
        public List<String> names() throws Exception {
            ids.clear();
            versions.clear();
            android.net.Uri children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, android.provider.DocumentsContract.getTreeDocumentId(tree));
            Map<String, Long> when = new java.util.HashMap<>();
            try (Cursor c = cr.query(children, new String[] {
                android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID, android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED, android.provider.DocumentsContract.Document.COLUMN_SIZE }, null, null, null)) {
                if (c == null) throw new Exception("the folder can't be read");
                while (c.moveToNext()) {
                    String n = c.getString(1);
                    if (n == null || !n.startsWith(SyncFolder.PREFIX)) continue;
                    long t = c.isNull(2) ? 0 : c.getLong(2);
                    // Two files with the same name (some apps allow it): the newest.
                    if (ids.containsKey(n) && when.getOrDefault(n, 0L) >= t) continue;
                    ids.put(n, c.getString(0));
                    when.put(n, t);
                    long size = c.isNull(3) ? -1 : c.getLong(3);
                    versions.put(n, t > 0 && size >= 0 ? t + ":" + size : null);
                }
            }
            return new ArrayList<>(ids.keySet());
        }

        @Override
        public String version(String name) {
            return versions.get(name);
        }

        @Override
        public byte[] read(String name) throws Exception {
            String id = ids.get(name);
            if (id == null) return null;
            try (java.io.InputStream in = cr.openInputStream(android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, id))) {
                if (in == null) return null;
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            }
        }

        @Override
        public void write(String name, byte[] data) throws Exception {
            String id = ids.get(name);
            android.net.Uri file = id != null
                ? android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, id)
                : android.provider.DocumentsContract.createDocument(cr, dir(), name.endsWith(".json") ? "application/json" : "application/octet-stream", name);
            if (file == null) throw new Exception("the folder didn't let Restock save there");
            if (id == null) {
                // Some folders rename a new file whose name is taken ("… (1).json"): that copy would never be read.
                String got = null;
                try (Cursor c = cr.query(file, new String[] { android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst()) got = c.getString(0);
                }
                if (got != null && !got.equals(name)) {
                    try {
                        android.provider.DocumentsContract.deleteDocument(cr, file);
                    } catch (Exception ignored) {
                        // leave it
                    }
                    throw new Exception("the folder renamed " + name + "; Restock will try again");
                }
            }
            try (java.io.OutputStream out = cr.openOutputStream(file, "wt")) {
                if (out == null) throw new Exception("couldn't open " + name);
                out.write(data);
            }
            if (id == null) ids.put(name, android.provider.DocumentsContract.getDocumentId(file));
        }

        @Override
        public void delete(String name) throws Exception {
            String id = ids.get(name);
            if (id == null) return;
            if (!android.provider.DocumentsContract.deleteDocument(cr, android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, id)))
                throw new Exception("the folder didn't let Restock delete " + name);
            ids.remove(name);
        }
    }

    /**
     * 0.9.1: receipt photos in Restock's private storage, for sync. Only real receipt photo paths
     * (receipts/<id>.jpg), only inside the receipts folder, at most SyncEngine.MAX_PHOTO bytes.
     */
    static final class AndroidPhotos implements SyncEngine.Photos {
        private final Context context;

        AndroidPhotos(Context context) {
            this.context = context;
        }

        private java.io.File file(String path) throws Exception {
            if (!SyncEngine.isPhotoPath(path)) throw new SecurityException("not a receipt photo");
            java.io.File dir = new java.io.File(context.getFilesDir(), "receipts").getCanonicalFile();
            java.io.File f = new java.io.File(dir, path.substring("receipts/".length())).getCanonicalFile();
            if (!dir.equals(f.getParentFile())) throw new SecurityException("not a receipt photo");
            return f;
        }

        @Override
        public long size(String path) throws Exception {
            java.io.File f = file(path);
            return f.isFile() && f.length() > 0 ? f.length() : -1;
        }

        @Override
        public byte[] read(String path) throws Exception {
            java.io.File f = file(path);
            if (!f.isFile() || f.length() > SyncEngine.MAX_PHOTO) return null;
            return java.nio.file.Files.readAllBytes(f.toPath());
        }

        @Override
        public void write(String path, byte[] data) throws Exception {
            if (data.length > SyncEngine.MAX_PHOTO) throw new SecurityException("too big");
            java.io.File f = file(path);
            java.io.File dir = f.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) throw new java.io.IOException("Couldn't make the receipts folder");
            java.io.File tmp = new java.io.File(dir, f.getName() + ".part");
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) {
                out.write(data);
            }
            if (!tmp.renameTo(f)) {
                tmp.delete();
                throw new java.io.IOException("Couldn't save the photo");
            }
        }

        @Override
        public void delete(String path) throws Exception {
            java.io.File f = file(path);
            if (f.exists() && !f.delete()) throw new java.io.IOException("Couldn't delete the photo");
        }
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
