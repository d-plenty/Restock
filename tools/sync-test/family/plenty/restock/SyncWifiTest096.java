package family.plenty.restock;

/**
 * 0.9.6: Wi-Fi sync (phone to phone) is its own feature, off in a server's house unless set up.
 * SyncHousehold.wifiSyncOn: a stored "1" or "0" wins; nothing stored is on for a household of phones,
 * off in a server's house, except a phone that really synced with another phone on the Wi-Fi in the
 * last 30 days (a sync_peers row with an address and a recent synced_at), which keeps it on; that
 * answer is stored. 0.9.6 (review L4): an old row alone (phones that once met on the LAN) is off.
 * Arguments: the out dir.
 */
public class SyncWifiTest096 {
    static int fails = 0;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    static void makeHouse(SyncFamily.Phone p) throws Exception {
        p.db.exec("INSERT OR REPLACE INTO household (k, v) VALUES ('owner', 'srv-test')");
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        SyncFamily.Phone[] local = SyncFamily.household("w1", "w2");
        report("L1 a household of phones: nothing stored means on", !local[0].h.wifiSyncOn() || local[0].e.meta("wifi_sync") != null, "meta " + local[0].e.meta("wifi_sync"));
        local[0].e.setMeta("wifi_sync", "0");
        report("L2 a household of phones can turn it off", local[0].h.wifiSyncOn(), "meta " + local[0].e.meta("wifi_sync"));

        SyncFamily.Phone[] fresh = SyncFamily.household("w3", "w4");
        makeHouse(fresh[0]);
        report("H1 a server's house phone that never used the Wi-Fi: off, and stored", fresh[0].h.wifiSyncOn() || !"0".equals(fresh[0].e.meta("wifi_sync")), "meta " + fresh[0].e.meta("wifi_sync"));
        fresh[0].e.setMeta("wifi_sync", "1");
        report("H2 set up on purpose: on", !fresh[0].h.wifiSyncOn(), "meta " + fresh[0].e.meta("wifi_sync"));
        fresh[0].e.setMeta("wifi_sync", "0");
        report("H3 stopped: off", fresh[0].h.wifiSyncOn(), "meta " + fresh[0].e.meta("wifi_sync"));

        long now = SyncHousehold.isoMillis("2026-11-11T09:00:00.000Z");
        report("T1 reads the times sync_peers keeps", now <= 0 || SyncHousehold.isoMillis("2026-11-11T09:00:00Z") != now || SyncHousehold.isoMillis("nonsense") != 0, "now " + now);

        SyncFamily.Phone[] used = SyncFamily.household("w5", "w6");
        used[0].db.exec("INSERT OR REPLACE INTO sync_peers (device, got, host, port, synced_at) VALUES ('w6', 3, '192.168.1.20', 4242, '2026-11-01T08:00:00.000Z')");
        makeHouse(used[0]);
        report("M1 a 0.9.5 house phone that synced over the Wi-Fi in the last 30 days keeps it on (choice stored)", !used[0].h.wifiSyncOn(now) || !"1".equals(used[0].e.meta("wifi_sync")), "meta " + used[0].e.meta("wifi_sync"));

        SyncFamily.Phone[] stale = SyncFamily.household("w7", "w8");
        stale[0].db.exec("INSERT OR REPLACE INTO sync_peers (device, got, host, port, synced_at) VALUES ('w8', 3, '192.168.1.21', 4242, '2026-08-01T08:00:00.000Z')");
        makeHouse(stale[0]);
        report("M2 a house phone whose Wi-Fi peer last synced months ago: off (Declan's case), and stored", stale[0].h.wifiSyncOn(now) || !"0".equals(stale[0].e.meta("wifi_sync")), "meta " + stale[0].e.meta("wifi_sync"));

        SyncFamily.Phone[] never = SyncFamily.household("w9", "w10");
        never[0].db.exec("INSERT OR REPLACE INTO sync_peers (device, got, host, port) VALUES ('w10', 0, '192.168.1.22', 4242)");
        makeHouse(never[0]);
        report("M3 a house phone with an address but no sync time: off", never[0].h.wifiSyncOn(now), "meta " + never[0].e.meta("wifi_sync"));

        SyncFamily.Phone[] future = SyncFamily.household("w11", "w12");
        future[0].db.exec("INSERT OR REPLACE INTO sync_peers (device, got, host, port, synced_at) VALUES ('w12', 3, '192.168.1.23', 4242, '2027-06-01T08:00:00.000Z')");
        makeHouse(future[0]);
        report("M4 a peer's clock far ahead doesn't count as recent: off", future[0].h.wifiSyncOn(now), "meta " + future[0].e.meta("wifi_sync"));

        SyncFamily.Phone[] chosen = SyncFamily.household("w13", "w14");
        chosen[0].db.exec("INSERT OR REPLACE INTO sync_peers (device, got, host, port, synced_at) VALUES ('w14', 3, '192.168.1.24', 4242, '2026-08-01T08:00:00.000Z')");
        makeHouse(chosen[0]);
        chosen[0].e.setMeta("wifi_sync", "1");
        report("M5 explicitly set up stays on, however old the peer", !chosen[0].h.wifiSyncOn(now), "meta " + chosen[0].e.meta("wifi_sync"));

        System.out.println(fails == 0 ? "0.9.6 Wi-Fi sync: all passed" : "0.9.6 Wi-Fi sync: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
