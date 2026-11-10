package family.plenty.restock;

import java.security.KeyPair;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.2: a phone and its Restock server (docs/server-protocol.md), for SyncHub:
 *
 * - Joining with the server's Add a phone code, and Stop (which can bring the receipt photos back).
 * - A round: the phone's file and the others' through SyncFolder ("server" notes, the serverKey,
 *   prices from the last 60 days), then webkeys/ for the browsers it can trust, then moving older
 *   prices and photos off the phone (ServerOffload).
 * - Handing the household's serverKeys to a browser that shows a link or sign-in code (ServerLink).
 *
 * sync_meta: server_home, server_away (addresses), server_dev_priv (this phone's key for the server,
 * sealed by SyncKeystore), server_filekeys (every serverKey this phone has known, sealed: older
 * files stay readable), server_webs (browsers this phone let in itself), server_webpub:<webId>
 * (a browser's key, from its own sealed file), and the round's notes (server_top, server_at, …).
 *
 * No Android classes here, so it's tested on a computer too (tools/sync-test, against the real server).
 */
final class ServerSync {
    /** Prices changed within this long go in the phone's file on the server (a folder leaves them out). */
    static final long PRICES_MS = 60L * 24 * 3600 * 1000;

    final SyncEngine e;
    final SyncHousehold h;

    ServerSync(SyncEngine e, SyncHousehold h) {
        this.e = e;
        this.h = h;
    }

    private byte[] key() {
        try {
            return h.paired() ? h.key() : null;
        } catch (Exception ex) {
            return null;
        }
    }

    private int keyv() throws Exception {
        String v = e.meta("keyv");
        return v == null ? 1 : Integer.parseInt(v);
    }

    /** The server's addresses (home first, then away), or an empty list. */
    List<String> addresses() {
        List<String> out = new ArrayList<>();
        try {
            for (String k : new String[] { "server_home", "server_away" }) {
                String v = e.meta(k);
                if (v != null) out.add(v);
            }
        } catch (Exception ignored) {
            // none
        }
        return out;
    }

    /** Whether this phone has joined a Restock server. */
    boolean on() {
        try {
            return !addresses().isEmpty() && e.meta("server_dev_priv") != null;
        } catch (Exception ex) {
            return false;
        }
    }

    ServerFolder open() throws Exception {
        String priv = e.meta("server_dev_priv");
        if (priv == null || addresses().isEmpty()) throw new IllegalStateException("Connect this phone to your Restock server first.");
        return new ServerFolder(addresses(), e.device(), ServerLink.privateKey(priv));
    }

    /** Forgets a server's notes (not the connection): its files are read and written afresh. */
    void clearNotes() throws Exception {
        for (String k : new String[] { "server_top", "server_keys", "server_at", "server_unread", "server_files", "server_webkeys", "server_off_at", "server_off_prices", "server_off_waiting" })
            e.setMeta(k, null);
        e.db.exec("DELETE FROM sync_meta WHERE key LIKE 'server_seen:%' OR key LIKE 'server_ver:%' OR key LIKE 'server_webpub:%' OR key LIKE 'server_photorefs:%' OR key LIKE 'server_keysver:%' OR key LIKE 'server_bad:%'");
    }

    /**
     * Joins a Restock server with the code from its Add a phone page: this phone makes its own key
     * for the server and the server takes its public half (once per code). Answers the address that
     * answered. Throws with words.
     */
    String join(String code) throws Exception {
        if (key() == null) throw new IllegalStateException("Start or join a household first: the server keeps the household's things.");
        ServerFolder.Invite in = ServerFolder.parseInvite(code);
        KeyPair kp = ServerLink.newKey();
        List<String> where = new ArrayList<>();
        if (in.home != null) where.add(in.home);
        if (in.away != null) where.add(in.away);
        String reached = ServerFolder.join(where, in.invite, e.device(), e.name(), kp.getPublic());
        clearNotes();
        e.setMeta("server_webs", null);
        e.setMeta("server_dev_priv", ServerLink.b64u(kp.getPrivate().getEncoded()));
        e.setMeta("server_home", in.home);
        e.setMeta("server_away", in.away);
        noteFileKey();
        return reached;
    }

    /**
     * Stop using the server. bringBack: the receipt photos this phone moved there come back first
     * (throws, and stays connected, if they can't); without it they stay on the server, and the
     * phone remembers where. Older prices stay on the server either way.
     */
    void stop(boolean bringBack) throws Exception {
        if (bringBack && on() && offloadedPhotos() > 0) {
            try {
                ServerFolder f = open();
                f.names();
                offloader(f).bringBack();
            } catch (Exception ex) {
                String why = ex.getMessage() == null ? "" : ex.getMessage().trim();
                throw new IllegalStateException("Couldn't bring the photos back from the server" + (why.isEmpty() ? "." : ": " + why + (why.endsWith(".") ? "" : "."))
                    + " Try again when the server can be reached, or stop without them.");
            }
        }
        try {
            if (on()) open().leave(); // off the server's list too (best effort)
        } catch (Exception ignored) {
            // the server can take it off its list itself (Phones → Remove)
        }
        clearNotes();
        for (String k : new String[] { "server_dev_priv", "server_home", "server_away", "server_webs" }) e.setMeta(k, null);
    }

    /** How many receipt photos are on the server and not on this phone (of receipts still here). */
    int offloadedPhotos() {
        try {
            return e.db.query("SELECT COUNT(*) AS n FROM sync_meta m WHERE m.key LIKE 'photo_off:%' AND EXISTS (SELECT 1 FROM receipts r WHERE r.photo = substr(m.key, 11)"
                + " OR r.pages LIKE '%\"' || substr(m.key, 11) || '\"%')").get(0).optInt("n", 0);
        } catch (Exception ex) {
            return 0;
        }
    }

    /** Notes the current serverKey with the ones before it (older files stay readable, and browsers get them all). */
    void noteFileKey() throws Exception {
        byte[] k = key();
        if (k == null) return;
        String hid = h.hid() == null ? "" : h.hid();
        int v = keyv();
        String b = ServerLink.b64u(SyncFolder.serverKey(k));
        String stored = e.meta("server_filekeys");
        JSONArray all = stored == null ? new JSONArray() : new JSONArray(stored);
        for (int i = 0; i < all.length(); i++) if (b.equals(all.getJSONObject(i).optString("key"))) return;
        JSONObject x = new JSONObject();
        x.put("hid", hid);
        x.put("keyv", v);
        x.put("key", b);
        all.put(x);
        e.setMeta("server_filekeys", all.toString());
    }

    /** Every serverKey this phone has known, oldest first, the current one last. */
    List<byte[]> fileKeys() throws Exception {
        String stored = e.meta("server_filekeys");
        List<byte[]> out = ServerOffload.keysOf(stored == null ? null : new JSONArray(stored));
        if (key() != null) out.add(SyncFolder.serverKey(key()));
        return out;
    }

    /** What a browser is given: this household's serverKeys (every version this phone has known), its name and owner key. */
    JSONObject gift() throws Exception {
        noteFileKey();
        String hid = h.hid() == null ? "" : h.hid();
        JSONObject keys = new JSONObject();
        String stored = e.meta("server_filekeys");
        JSONArray all = stored == null ? new JSONArray() : new JSONArray(stored);
        for (int i = 0; i < all.length(); i++) {
            JSONObject k = all.getJSONObject(i);
            if (hid.equals(k.optString("hid"))) keys.put(String.valueOf(k.getInt("keyv")), k.getString("key"));
        }
        keys.put(String.valueOf(keyv()), ServerLink.b64u(SyncFolder.serverKey(key())));
        JSONObject hh = new JSONObject();
        String name = e.householdValue("name");
        hh.put("name", name != null ? name : e.meta("household"));
        hh.put("owner_pub", e.householdValue("owner_pub"));
        JSONObject g = new JSONObject();
        g.put("format", "restock-keys");
        g.put("v", 1);
        g.put("keyv", keyv());
        g.put("keys", keys);
        g.put("household", hh);
        return g;
    }

    ServerOffload offloader(ServerOffload.Remote f, long now) throws Exception {
        return new ServerOffload(e, f, fileKeys(), SyncFolder.serverKey(key()), keyv(), now);
    }

    ServerOffload offloader(ServerOffload.Remote f) throws Exception {
        return offloader(f, System.currentTimeMillis());
    }

    // ---------- a round ----------

    /** What a round did: SyncFolder's result, the address that answered, a problem in words, and the offload. */
    static final class Round {
        SyncFolder.Result result = new SyncFolder.Result();
        String reached;
        String error;
        Exception cause;
        ServerOffload.Result offload;
    }

    /**
     * 0.9.3: the 60-second check backs off while the server can't be reached or its rounds fail
     * (2, 4, 8, 16, then every 30 minutes), so a phone left open doesn't keep waking the radio and
     * sending its file to a server that turns it down. A round that works starts it over.
     */
    static final class PollGate {
        static final long FIRST_MS = 2 * 60_000L;
        static final long MAX_MS = 30 * 60_000L;
        private int fails;
        private long until;

        synchronized boolean due(long now) {
            return now >= until;
        }

        synchronized void ok() {
            fails = 0;
            until = 0;
        }

        synchronized void failed(long now) {
            fails = Math.min(fails + 1, 10);
            until = now + Math.min(MAX_MS, FIRST_MS << (fails - 1));
        }
    }

    /**
     * 0.9.3: a quick look (one listing, for the 60-second check while Restock is open): has another
     * phone's or a browser's file changed since this phone read it, has the owner's keys file changed,
     * or does this phone's own file need writing? Only then is a round worth it. Throws if the server
     * can't be reached.
     */
    boolean anythingNew() throws Exception {
        if (!on() || key() == null) return false;
        ServerFolder f = open();
        List<String> names = f.names();
        SyncFolder sf = new SyncFolder(e, h, "server", PRICES_MS);
        if (!sf.ownUpToDate(names)) return true;
        String mine = SyncFolder.fileFor(e.device());
        String keys = sf.keysFile();
        for (String n : names) {
            if (n.equals(mine)) continue;
            boolean sync = n.startsWith(SyncFolder.PREFIX) && n.endsWith(SyncFolder.SUFFIX);
            boolean keysFile = n.equals(keys) || n.equals(SyncFolder.KEYS);
            if (!sync && !keysFile) continue;
            String ver = f.version(n);
            // A server that gives no version: can't tell, so look properly.
            if (ver == null) return true;
            String noted = keysFile ? e.meta("server_keysver:" + n) : e.meta("server_ver:" + n);
            if (!ver.equals(noted) && !ver.equals(e.meta("server_bad:" + n))) return true;
        }
        // A file another phone had that's gone (removed from the server): a round notes it.
        String count = e.meta("server_files");
        return count != null && !count.equals(String.valueOf(names.size()));
    }

    /** One round with the server. Never throws: a problem is in `error`, and nothing is deleted then. */
    Round round(String nowIso, long now) {
        Round out = new Round();
        if (!on() || key() == null) return out;
        try {
            ServerFolder f = open();
            out.result = new SyncFolder(e, h, "server", PRICES_MS).sync(f, nowIso);
            out.reached = f.reached();
            noteFileKey();
            List<String> names = f.names();
            e.setMeta("server_files", String.valueOf(names.size()));
            // 0.9.3: the keys files as this round saw them (anythingNew looks for a change).
            e.db.exec("DELETE FROM sync_meta WHERE key LIKE 'server_keysver:%'");
            for (String n : names)
                if ((n.startsWith("restock-sync-keys") && n.endsWith(".json")) && f.version(n) != null) e.setMeta("server_keysver:" + n, f.version(n));
            try {
                writeWebKeys(f, names);
            } catch (Exception ex) {
                // next round
            }
            try {
                ServerOffload.Result o = offloader(f, now).run(ServerOffload.historyWeeks(e));
                out.offload = o;
                if (o.prices > 0) {
                    String had = e.meta("server_off_prices");
                    e.setMeta("server_off_prices", String.valueOf((had == null ? 0 : Long.parseLong(had)) + o.prices));
                }
                e.setMeta("server_off_waiting", o.waiting > 0 ? String.valueOf(o.waiting) : null);
                e.setMeta("server_off_at", nowIso);
                // The phone's own file lists its photos on the server: written again now, so another
                // phone sees straight away that this one uses a photo file (and doesn't delete it).
                if (o.changed) {
                    e.setMeta("server_top", null);
                    try {
                        SyncFolder.Result again = new SyncFolder(e, h, "server", PRICES_MS).sync(f, nowIso);
                        out.result.received += again.received;
                    } catch (Exception ex) {
                        // next round
                    }
                }
            } catch (Exception ex) {
                out.cause = ex; // nothing was deleted; next round
            }
        } catch (ServerFolder.AccessException | SyncDav.Problem ex) {
            out.reached = null;
            out.error = ex.getMessage();
            out.cause = ex;
        } catch (Exception ex) {
            out.reached = null;
            out.error = "Couldn't sync with your Restock server" + (ex.getMessage() == null ? "." : ": " + ex.getMessage());
            out.cause = ex;
        }
        return out;
    }

    /**
     * The current keys sealed for each browser the server lists whose key this phone can trust (one
     * it let in itself, or one named in that browser's own sealed file), as webkeys/<webId>.bin.
     * Written again when the household's key changes (a phone removed) or a browser is added.
     */
    void writeWebKeys(ServerFolder f, List<String> names) throws Exception {
        Set<String> trusted = new HashSet<>();
        String mine = e.meta("server_webs");
        if (mine != null) {
            JSONArray a = new JSONArray(mine);
            for (int i = 0; i < a.length(); i++) trusted.add(a.getString(i));
        }
        Map<String, String> named = new HashMap<>();
        for (JSONObject r : e.db.query("SELECT key, value FROM sync_meta WHERE key LIKE 'server_webpub:%'"))
            named.put(r.getString("key").substring("server_webpub:".length()), spki(r.getString("value")));
        if (trusted.isEmpty() && named.isEmpty()) return;
        JSONArray webs = f.call("GET", "/web", null).optJSONArray("webs");
        if (webs == null) return;
        List<String[]> to = new ArrayList<>();
        for (int i = 0; i < webs.length(); i++) {
            JSONObject w = webs.optJSONObject(i);
            if (w == null) continue;
            String id = w.optString("webId", ""), pub = spki(w.optString("webPub", ""));
            if (!id.matches("[A-Za-z0-9_-]{8,60}") || pub == null) continue;
            if (trusted.contains(pub) || pub.equals(named.get(id))) to.add(new String[] { id, pub });
        }
        StringBuilder mark = new StringBuilder(h.hid() + ":" + keyv());
        for (String[] w : to) mark.append('|').append(w[0]).append('=').append(w[1]);
        boolean allThere = true;
        for (String[] w : to) if (!names.contains("webkeys/" + w[0] + ".bin")) allThere = false;
        if (mark.toString().equals(e.meta("server_webkeys")) && allThere) return;
        JSONObject g = gift();
        for (String[] w : to) f.write("webkeys/" + w[0] + ".bin", ServerLink.sealWebKeys(ServerLink.publicKey(ServerLink.unb64(w[1])), g));
        e.setMeta("server_webkeys", mark.toString());
    }

    /** A public key as SPKI base64url, or null if it isn't one. */
    static String spki(String b64) {
        try {
            return ServerLink.b64u(ServerLink.publicKey(ServerLink.unb64(b64)).getEncoded());
        } catch (Exception ex) {
            return null;
        }
    }

    // ---------- the web page's codes ----------

    /** A web page's code, checked: { kind: "link" | "login", host }. Throws with words. */
    JSONObject webCode(String code) throws Exception {
        if (!on()) throw new IllegalStateException("Connect this phone to your Restock server first.");
        ServerLink.Code c = ServerLink.parse(code);
        Set<String> hosts = new java.util.LinkedHashSet<>();
        for (String a : addresses()) {
            String x = ServerLink.hostOf(a);
            if (x != null) hosts.add(x);
        }
        if (!hosts.contains(c.host))
            throw new IllegalArgumentException("That code is from a page at " + c.host + ", not your Restock server (" + String.join(" or ", hosts) + "). Only scan codes from your own server's page.");
        JSONObject o = new JSONObject();
        o.put("kind", c.kind);
        o.put("host", c.host);
        return o;
    }

    /**
     * Gives the browser showing that code the household's server keys, sealed to its own key (the
     * server passes them on but can't open them): a link (it keeps them) or a sign-in (for that
     * session). Throws with words.
     */
    JSONObject approveWeb(String code) throws Exception {
        JSONObject info = webCode(code);
        if (key() == null) throw new IllegalStateException("Start or join a household first.");
        ServerLink.Code c = ServerLink.parse(code);
        ServerFolder f = open();
        try {
            f.names();
        } catch (ServerFolder.AccessException | SyncDav.Problem ex) {
            throw ex;
        } catch (Exception ex) {
            throw new IllegalStateException("Couldn't reach your Restock server. Try again at home, or when the server's away address works.");
        }
        JSONObject body = ServerLink.sealFor(c.browser, gift());
        int st = f.status("POST", ("link".equals(c.kind) ? "/link/" : "/qrlogin/") + c.id, body);
        if (st == 404 || st == 410) throw new IllegalStateException("That code has run out. Refresh the web page and scan the new code.");
        if (st == 409) throw new IllegalStateException("That code has already been used. Refresh the web page and scan the new code.");
        if (st < 200 || st >= 300) throw SyncDav.problem(st, "pass the keys on");
        if ("link".equals(c.kind)) {
            // A browser this phone let in itself: trusted for the new keys after a rekey.
            String mine = e.meta("server_webs");
            JSONArray a = mine == null ? new JSONArray() : new JSONArray(mine);
            String pub = ServerLink.b64u(c.browser.getEncoded());
            boolean have = false;
            for (int i = 0; i < a.length(); i++) if (pub.equals(a.getString(i))) have = true;
            if (!have) a.put(pub);
            e.setMeta("server_webs", a.toString());
            e.setMeta("server_webkeys", null);
        }
        return info;
    }

    /** A receipt photo that's on the server (not on this phone), fetched for showing. Throws with words. */
    byte[] photo(String path) throws Exception {
        if (!SyncEngine.isPhotoPath(path)) throw new IllegalArgumentException("That isn't a receipt photo.");
        if (!on() || key() == null) throw new IllegalStateException("This photo is kept on your Restock server. Connect this phone to the server again to see it.");
        ServerFolder f = open();
        try {
            f.names();
        } catch (Exception ex) {
            throw new IllegalStateException("Couldn't reach your Restock server. Try again at home, or when the server's away address works.");
        }
        byte[] b = offloader(f).fetchPhoto(path);
        if (b == null) throw new IllegalStateException("That photo isn't on the server.");
        return b;
    }
}
