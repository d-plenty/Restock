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
    /** 0.9.5: "Ask phones to resend": every price this phone has goes in its file, once. */
    static final long ALL_PRICES_MS = 100L * 365 * 24 * 3600 * 1000;

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
        return new ServerFolder(addresses(), e.device(), ServerLink.privateKey(priv), v3() ? ServerFolder.API3 : ServerFolder.API);
    }

    /** 0.9.4: whether this phone talks protocol v3 with its server (the server is the household's owner). */
    boolean v3() {
        try {
            return "3".equals(e.meta("server_api"));
        } catch (Exception ex) {
            return false;
        }
    }

    /** Forgets a server's notes (not the connection): its files are read and written afresh. */
    void clearNotes() throws Exception {
        for (String k : new String[] { "server_top", "server_keys", "server_at", "server_unread", "server_files", "server_webkeys", "server_off_at", "server_off_prices", "server_off_waiting", "server_keysfile" })
            e.setMeta(k, null);
        e.db.exec("DELETE FROM sync_meta WHERE key LIKE 'server_seen:%' OR key LIKE 'server_ver:%' OR key LIKE 'server_webpub:%' OR key LIKE 'server_photorefs:%' OR key LIKE 'server_keysver:%' OR key LIKE 'server_bad:%' OR key LIKE 'catchup:server_seen:%'");
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
        for (String k : new String[] { "server_dev_priv", "server_home", "server_away", "server_webs", "server_api", "server_kex", "server_kex_priv", "server_sid", "server_handover", "server_mode" })
            e.setMeta(k, null);
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

    /** 0.10.1: the serverKey this phone seals for its server with (the current one), or null. */
    byte[] sealKey() throws Exception {
        byte[] k = key();
        return k == null ? null : SyncFolder.serverKey(k);
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
        /** 0.9.4: the v3 server says this phone was removed (SyncHub forgets the household). */
        boolean removed;
        /** 0.9.4: this round moved the phone to v3 (after the household was handed to the server). */
        boolean upgraded;
        /** 0.9.4: a newer household key came in keys/<device>.bin this round. */
        boolean rekeyed;
    }

    /** The round's sync part: (v3) a newer key from keys/<device>.bin first, then SyncFolder. */
    private SyncFolder.Result roundSync(ServerFolder f, String nowIso, Round out) throws Exception {
        if (v3()) {
            List<String> names = f.names();
            if (takeKeysFile(f, names)) out.rekeyed = true;
        }
        SyncFolder.Result r = new SyncFolder(e, h, "server", PRICES_MS).sync(f, nowIso);
        if (out.rekeyed) r.rekeyed = true;
        return r;
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
        List<String> names;
        try {
            names = f.names();
        } catch (ServerFolder.UpdateException up) {
            return true; // the household was handed to the server: a round upgrades this phone
        }
        SyncFolder sf = new SyncFolder(e, h, "server", PRICES_MS);
        if (!sf.ownUpToDate(names)) return true;
        String mine = SyncFolder.fileFor(e.device());
        String keys = sf.keysFile();
        // 0.9.4: a new keys/<device>.bin (a phone was removed and the household rekeyed).
        if (v3()) {
            String kf = keysFileName();
            if (names.contains(kf) && (f.version(kf) == null || !f.version(kf).equals(e.meta("server_keysfile")))) return true;
        }
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

    /**
     * 0.9.5: when the household's owner-signed `server` row has a `resend` (ms) this phone hasn't
     * answered yet ("Ask phones to resend" on the web's Data page), it writes its whole file again now,
     * with every price it has (not just the last 60 days), once for each request. The server merges it
     * as any file (nothing doubles); the next change writes the usual file. A 0.9.4 phone passes over it.
     */
    private void resendIfAsked(ServerFolder f, String nowIso, long now, Round out) {
        long at = 0;
        try {
            at = resendAsked(now);
            if (at <= 0 || String.valueOf(at).equals(e.meta("server_resent"))) return;
            // 0.9.5 (review): a try that failed waits a day (not every round: it sends everything).
            String wait = e.meta("server_resend_wait");
            if (wait != null && wait.startsWith(at + ":") && now < Long.parseLong(wait.substring(wait.indexOf(':') + 1))) return;
            e.setMeta("server_top", null);
            SyncFolder.Result again = new SyncFolder(e, h, "server", ALL_PRICES_MS).sync(f, nowIso);
            if (out.result != null) out.result.received += again.received;
            e.setMeta("server_resent", String.valueOf(at));
            e.setMeta("server_resend_wait", null);
        } catch (Exception ex) {
            resendFailed(at, now, ex);
        }
    }

    /**
     * 0.9.5 (review): a resend that failed. Turned down for its size (or the server is full): that
     * request is answered, it won't fit tomorrow either (the usual file goes as always). Anything
     * else: tried again in a day, once; a second failure answers it too. Never every round.
     */
    void resendFailed(long at, long now, Exception ex) {
        if (at <= 0) return;
        try {
            String m = ex.getMessage() == null ? "" : ex.getMessage();
            String wait = e.meta("server_resend_wait");
            boolean tried = wait != null && wait.startsWith(at + ":");
            if (tried || m.contains("too big") || m.contains("full")) {
                e.setMeta("server_resent", String.valueOf(at));
                e.setMeta("server_resend_wait", null);
            } else {
                e.setMeta("server_resend_wait", at + ":" + (now + 24L * 3600 * 1000));
            }
        } catch (Exception ignored) {
            // next round
        }
    }

    /** 0.9.5: the signed `server` row's `resend` (ms), or 0 (none, not a house's row, or from the future). */
    long resendAsked(long now) {
        try {
            if (h.serverRow() == null) return 0;
            long at = new JSONObject(e.householdValue("server")).optLong("resend", 0);
            return at > 0 && at <= now + 24L * 3600 * 1000 ? at : 0;
        } catch (Exception ex) {
            return 0;
        }
    }

    /** One round with the server. Never throws: a problem is in `error`, and nothing is deleted then. */
    Round round(String nowIso, long now) {
        Round out = new Round();
        if (!on() || key() == null) return out;
        try {
            ServerFolder f = open();
            try {
                out.result = roundSync(f, nowIso, out);
            } catch (ServerFolder.UpdateException up) {
                // 0.9.4: the household was handed to the server: carry on with v3, no code needed.
                upgrade();
                out.upgraded = true;
                f = open();
                out.result = roundSync(f, nowIso, out);
            }
            // 0.9.5: the server asked phones to resend (its signed server row's `resend`).
            if (v3()) resendIfAsked(f, nowIso, now, out);
            out.reached = f.reached();
            noteFileKey();
            List<String> names = f.names();
            e.setMeta("server_files", String.valueOf(names.size()));
            // 0.9.3: the keys files as this round saw them (anythingNew looks for a change).
            e.db.exec("DELETE FROM sync_meta WHERE key LIKE 'server_keysver:%'");
            for (String n : names)
                if ((n.startsWith("restock-sync-keys") && n.endsWith(".json")) && f.version(n) != null) e.setMeta("server_keysver:" + n, f.version(n));
            if (!v3()) try {
                writeWebKeys(f, names);
            } catch (Exception ex) {
                // next round
            }
            try {
                ServerOffload off = offloader(f, now);
                // 0.9.4: nothing older than the house's "Keep data for" goes up (it would be pruned there at once).
                JSONObject row = v3() ? h.serverRow() : null;
                long cut = row == null ? -1 : SyncHousehold.keepCutoff(row.opt("keepMonths"), now);
                if (cut > 0) off.serverCutoff = ServerOffload.iso(cut);
                ServerOffload.Result o = off.run(ServerOffload.historyWeeks(e));
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
        } catch (ServerFolder.AccessException ex) {
            out.reached = null;
            out.error = ex.getMessage();
            out.cause = ex;
            // 0.9.4: removed on a v3 server (401 removed): SyncHub forgets the household, keeping everything here.
            out.removed = ex.gone && v3();
        } catch (SyncDav.Problem ex) {
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

    // ---------- 0.9.4: protocol v3, the server is the household's owner ----------

    private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();

    private static String nonce() {
        byte[] n = new byte[16];
        RANDOM.nextBytes(n);
        return ServerLink.b64u(n);
    }

    String keysFileName() throws Exception {
        return "keys/" + e.device() + ".bin";
    }

    /** The server's ECDH key this phone pinned (from the code it scanned, or the owner-signed server row). */
    java.security.PublicKey serverKex() throws Exception {
        String k = e.meta("server_kex");
        if (k == null) {
            JSONObject row = h.serverRow();
            if (row != null) k = row.getString("kex");
        }
        if (k == null) throw new IllegalStateException("This phone doesn't know your server's key yet. Scan a code from the server's page.");
        return ServerLink.publicKey(ServerLink.unb64(k));
    }

    /**
     * What a scanned Add a phone code is, before anything is sent: { v, home, away } and, for a v3
     * server that answers, { mode, house, empty } (GET /api/v3/health), plus what this phone is in
     * now: { inHousehold, isOwner, household, owner, members, sameHouse }. Throws with words.
     */
    JSONObject check(String code) throws Exception {
        ServerFolder.Invite in = ServerFolder.parseInvite(code);
        JSONObject o = new JSONObject();
        o.put("v", in.v);
        o.put("home", in.home == null ? JSONObject.NULL : in.home);
        o.put("away", in.away == null ? JSONObject.NULL : in.away);
        boolean paired = h.paired();
        o.put("inHousehold", paired);
        if (paired) {
            o.put("isOwner", h.isOwner());
            String name = e.householdValue("name");
            o.put("household", name != null ? name : e.meta("household") != null ? e.meta("household") : "your household");
            for (JSONObject m : h.members()) if (m.optBoolean("owner")) o.put("owner", m.optString("name"));
            o.put("members", h.members().size());
            JSONObject row = h.serverRow();
            o.put("sameHouse", row != null && in.kex != null && in.kex.equals(ServerSync.spki(row.optString("kex"))));
        }
        if (in.v == 3) {
            List<String> where = new ArrayList<>();
            if (in.home != null) where.add(in.home);
            if (in.away != null) where.add(in.away);
            JSONObject hl = ServerFolder.health(where);
            if (hl != null) {
                o.put("mode", hl.optString("mode", ""));
                if (hl.has("house")) o.put("house", hl.opt("house"));
                // Only when the server says (one that doesn't is asked by trying: it refuses a bring if not).
                if (hl.opt("empty") instanceof Boolean) o.put("empty", hl.getBoolean("empty"));
            }
        }
        return o;
    }

    /**
     * 0.9.4: joins a v3 server's house with its Add a phone code. `bring`: this phone is its phone
     * household's owner and the server's house is new and empty, so the household goes onto the
     * server (the join carries the handover payload). Otherwise this phone isn't in a household (the
     * caller left it first) and its things on what it shares go up, the house's copy winning where
     * both have a record. Answers what the server said (the gift). Throws with words; nothing changes
     * on this phone then.
     */
    JSONObject join3(String code, boolean bring) throws Exception {
        ServerFolder.Invite in = ServerFolder.parseInvite(code);
        if (in.v != 3) throw new IllegalArgumentException("That code is from an older Restock server.");
        if (h.paired() && !bring) throw new IllegalStateException("Leave your household first: a phone belongs to one house at a time.");
        if (bring && !h.isOwner()) throw new IllegalStateException("Only the household's owner phone can bring it onto a server.");
        java.security.PublicKey kex = ServerLink.publicKey(ServerLink.unb64(in.kex));
        KeyPair dev = ServerLink.newKey();
        KeyPair mine = ServerLink.newKey();
        String n = nonce();
        String me = e.device();
        JSONObject body = new JSONObject();
        body.put("invite", in.invite);
        body.put("device", me);
        body.put("name", e.name());
        body.put("pub", ServerLink.b64u(dev.getPublic().getEncoded()));
        body.put("kex", ServerLink.b64u(mine.getPublic().getEncoded()));
        body.put("myPub", h.myPub());
        body.put("n", n);
        if (bring) body.put("bring", sealHandover(kex, ServerLink.unb64(in.invite)));
        List<String> where = new ArrayList<>();
        if (in.home != null) where.add(in.home);
        if (in.away != null) where.add(in.away);
        JSONObject ans = ServerFolder.join3(where, body);
        JSONObject gift = openGift(mine.getPrivate(), kex, n, me, ans);
        if (bring && !java.util.Objects.equals(h.hid(), gift.getJSONObject("household").optString("hid", null)))
            throw new IllegalStateException("The server didn't take your household. Try again, or leave it and join the server's house.");
        install(gift, in.kex, dev, mine, bring ? "keep" : "fresh");
        e.setMeta("server_home", gift.optJSONObject("server") != null && gift.getJSONObject("server").opt("home") instanceof String ? cleanOr(gift.getJSONObject("server").getString("home"), in.home) : in.home);
        String away = gift.optJSONObject("server") != null && gift.getJSONObject("server").opt("away") instanceof String ? gift.getJSONObject("server").getString("away") : null;
        e.setMeta("server_away", away != null ? cleanOr(away, in.away) : in.away);
        return gift;
    }

    private static String cleanOr(String a, String fallback) {
        try {
            String c = ServerFolder.cleanAddress(a);
            return c != null ? c : fallback;
        } catch (Exception ex) {
            return fallback;
        }
    }

    /**
     * 0.9.4: a phone of a household that's now a house (an owner-signed server row) joins the server
     * without a code, signing with its household key. Throws with words.
     */
    JSONObject joinAsMember() throws Exception {
        JSONObject row = h.serverRow();
        if (row == null || !h.paired()) throw new IllegalStateException("Your household isn't on a Restock server.");
        List<String> where = new ArrayList<>();
        for (String a : new String[] { row.optString("home", null), row.isNull("away") ? null : row.optString("away", null) }) {
            String c = cleanOr(a, null);
            if (c != null) where.add(c);
        }
        return joinAsMemberAt(row.getString("kex"), where);
    }

    /**
     * 0.9.4: as joinAsMember, at the server of a v3 Add a phone code (its key and addresses pinned
     * from the code), for a phone whose household may already be that server's house (brought onto
     * it, the server row not here yet). Throws ServerFolder.NotMember when it isn't this household's
     * server; nothing changes on this phone then.
     */
    JSONObject joinAsMember(String code) throws Exception {
        if (!h.paired()) throw new IllegalStateException("Your household isn't on a Restock server.");
        ServerFolder.Invite in = ServerFolder.parseInvite(code);
        if (in.v != 3) throw new IllegalArgumentException("That code is from an older Restock server.");
        List<String> where = new ArrayList<>();
        if (in.home != null) where.add(in.home);
        if (in.away != null) where.add(in.away);
        return joinAsMemberAt(in.kex, where);
    }

    private JSONObject joinAsMemberAt(String kexB64, List<String> where) throws Exception {
        String me = e.device();
        java.security.PublicKey kex = ServerLink.publicKey(ServerLink.unb64(kexB64));
        KeyPair dev = ServerLink.newKey();
        KeyPair mine = ServerLink.newKey();
        String n = nonce();
        String pub = ServerLink.b64u(dev.getPublic().getEncoded());
        String kx = ServerLink.b64u(mine.getPublic().getEncoded());
        JSONObject body = new JSONObject();
        body.put("member", true);
        body.put("device", me);
        body.put("pub", pub);
        body.put("kex", kx);
        body.put("n", n);
        body.put("sig", h.signMine(ServerLink.memberJoinText(me, pub, kx, n)));
        JSONObject gift = openGift(mine.getPrivate(), kex, n, me, ServerFolder.join3(where, body));
        // This household's own house: the owner key it trusts (as upgrade checks).
        String own = e.meta("owner_pin");
        if (own != null && !own.equals(gift.getJSONObject("household").optString("owner_pub", ""))) throw new SecurityException("The server's answer is for another household.");
        install(gift, ServerLink.b64u(kex.getEncoded()), dev, mine, "keep");
        e.setMeta("server_home", where.isEmpty() ? null : where.get(0));
        e.setMeta("server_away", where.size() > 1 ? where.get(1) : null);
        return gift;
    }

    /**
     * 0.9.4: a phone already on the server when its household was handed over (403 update): POST
     * /api/v3/upgrade, signed with its v2 key, so no code. It keeps sharing what it shared.
     */
    void upgrade() throws Exception {
        String me = e.device();
        KeyPair mine = ServerLink.newKey();
        String n = nonce();
        JSONObject body = new JSONObject();
        body.put("kex", ServerLink.b64u(mine.getPublic().getEncoded()));
        body.put("myPub", h.myPub());
        body.put("n", n);
        String pinned = e.meta("server_kex");
        java.security.PublicKey kex = pinned == null ? null : ServerLink.publicKey(ServerLink.unb64(pinned));
        JSONObject ha = haPayload();
        if (ha != null && kex != null) body.put("ha", ServerLink.b64u(ServerLink.sealAad(ServerLink.v3Key(mine.getPrivate(), kex, ServerLink.unb64(n), ServerLink.HA_INFO), "RSA3" + me, ha, null)));
        ServerFolder f = new ServerFolder(addresses(), me, ServerLink.privateKey(e.meta("server_dev_priv")), ServerFolder.API3);
        SyncDav.Response r = f.first("POST", ServerFolder.API3 + "/upgrade", body);
        if (r.status < 200 || r.status >= 300) {
            String said = ServerFolder.messageOf(r);
            throw new SyncDav.Problem(said.isEmpty() ? "Your Restock server didn't let this phone carry on. Scan a new code from its Add a phone page." : said);
        }
        JSONObject ans = new JSONObject(r.text());
        if (kex == null) {
            // Not pinned yet (this phone never scanned a v3 code): the server's key as it says, taken only
            // because the gift it opens has this household's own key in it (only the household has that).
            String k = ans.optString("kex", "");
            if (k.isEmpty()) k = publicKex(addresses());
            if (k.isEmpty()) throw new SyncDav.Problem("Update your Restock server to finish moving this phone over.");
            kex = ServerLink.publicKey(ServerLink.unb64(k));
        }
        JSONObject gift = openGift(mine.getPrivate(), kex, n, me, ans);
        JSONObject keys = gift.optJSONObject("keys");
        byte[] cur = h.key();
        boolean ours = false;
        if (keys != null) for (String v : SyncHousehold.keysOf(keys)) {
            try {
                if (java.util.Arrays.equals(cur, SyncWire.decodeKey(keys.getString(v)))) ours = true;
            } catch (Exception odd) {
                // not a key
            }
        }
        if (!ours) throw new SecurityException("The server's answer doesn't have your household's key in it.");
        String own = e.meta("owner_pin");
        String said = gift.getJSONObject("household").optString("owner_pub", "");
        if (own != null && !own.equals(said)) throw new SecurityException("The server's answer is for another household.");
        final String kexB64 = ServerLink.b64u(kex.getEncoded());
        e.db.transaction(() -> {
            install(gift, kexB64, null, mine, "keep");
            // What it shared before: its tabs and cards as they are, receipts as the household had them.
            e.setMeta("share_receipts", "1".equals(e.meta("receipts_eff")) ? "1" : "0");
        });
        // Home Assistant wasn't sent above when the server's key wasn't pinned yet (a phone that joined
        // with a 0.9.3 code): never sealed to a key the server only said it has. Now the gift has shown
        // the key is the house's, it goes in a second upgrade (the server takes it once, while it doesn't
        // run Home Assistant itself). Best effort: otherwise it's set up on the server's page.
        if (ha != null && pinned == null) {
            try {
                String n2 = nonce();
                JSONObject again = new JSONObject();
                again.put("kex", body.getString("kex"));
                again.put("myPub", h.myPub());
                again.put("n", n2);
                again.put("ha", ServerLink.b64u(ServerLink.sealAad(ServerLink.v3Key(mine.getPrivate(), kex, ServerLink.unb64(n2), ServerLink.HA_INFO), "RSA3" + me, ha, null)));
                f.first("POST", ServerFolder.API3 + "/upgrade", again);
            } catch (Exception ignored) {
                // Home Assistant stays as it is here; the server's page can set it up
            }
        }
    }

    /**
     * The server's kex key as it hands it to anyone (it's in every v3 code): its health answer, or its
     * sign-in challenge's. "" if neither says. Only trusted because of what the gift it opens holds.
     */
    static String publicKex(List<String> bases) {
        JSONObject hl = ServerFolder.health(bases);
        if (hl != null && !hl.optString("kex", "").isEmpty()) return hl.optString("kex");
        for (String a : bases) {
            try {
                SyncDav.Response r = SyncDav.request("GET", java.net.URI.create(a + ServerFolder.API3 + "/login/challenge?user=restock-phone"), new java.util.LinkedHashMap<>(), null, SyncDav.MAX_SMALL);
                if (r.status == 200) {
                    String k = new JSONObject(r.text()).optString("kex", "");
                    if (!k.isEmpty()) return k;
                }
            } catch (Exception ignored) {
                // the next address
            }
        }
        return "";
    }

    /** 0.9.4: Home Assistant's settings and token for the server, sealed (P4's HomeAssistant sets this), or null. */
    interface HaSource {
        JSONObject payload() throws Exception;
    }

    static volatile HaSource haSource;

    private static JSONObject haPayload() {
        try {
            HaSource s = haSource;
            return s == null ? null : s.payload();
        } catch (Exception ex) {
            return null;
        }
    }

    /** The answer's `sealed`, opened (RSJ3) and checked. */
    private static JSONObject openGift(java.security.PrivateKey mine, java.security.PublicKey kex, String n, String me, JSONObject ans) throws Exception {
        JSONObject gift;
        try {
            byte[] k = ServerLink.v3Key(mine, kex, ServerLink.unb64(n), ServerLink.JOIN_INFO);
            gift = ServerLink.openAad(k, "RSJ3" + me, ServerLink.unb64(ans.getString("sealed")));
        } catch (Exception ex) {
            throw new SecurityException("That server's answer couldn't be opened with the key in its code. Only connect to your own server.");
        }
        if (!"restock-join".equals(gift.optString("format")) || gift.optInt("v") != 3 || !me.equals(gift.optString("device")) || gift.optJSONObject("household") == null
            || gift.optJSONObject("keys") == null || gift.optInt("keyv", 0) < 1)
            throw new SecurityException("That server's answer isn't one this phone understands.");
        return gift;
    }

    /**
     * Keeps what a join (or upgrade) gave this phone. how: "fresh" (it wasn't in a household: the
     * household's key, its secret and owner key come from the server; it shares groceries only),
     * or "keep" (its household is the house's: the same key, a newer one taken if there is one).
     */
    private void install(JSONObject gift, String kex, KeyPair dev, KeyPair mine, String how) throws Exception {
        JSONObject keys = gift.getJSONObject("keys");
        int keyv = gift.getInt("keyv");
        String cur = keys.optString(String.valueOf(keyv), null);
        if (cur == null) throw new SecurityException("That server's answer has no key for this household.");
        SyncWire.decodeKey(cur);
        JSONObject hh = gift.getJSONObject("household");
        String hid = hh.optString("hid", "");
        e.db.transaction(() -> {
            if ("fresh".equals(how)) {
                h.forget();
                e.setMeta("key", cur);
                e.setMeta("keyv", String.valueOf(keyv));
                e.setMeta("secret", gift.optString("secret", ServerLink.b64u(new byte[32])));
                e.setMeta("owner_secrets", null);
                e.setMeta("owner_pin", hh.optString("owner_pub", null));
                e.setMeta("household", hh.optString("name", null));
                // What this phone shares with the house: groceries only, no receipts, no cards (it can change it after).
                e.setMeta("tabs", "pantry");
                e.setMeta("tabs_eff", null);
                e.setMeta("share_receipts", "0");
                e.setMeta("share_cards", "0");
                // Wi-Fi sync is for households without a server; turn it on to also sync at home.
                e.setMeta("wifi_sync", "0");
                e.setMeta("seed_settings", gift.optBoolean("seed", false) ? "1" : null);
                // Its own records on what it shares go up; the house's copy wins where both have one:
                // stamped before anything (-1, below even another joining phone's 0), so any copy the
                // house already has is newer, and a record only this phone has still goes up. The first
                // phone in a new house (seed) has nothing to give way to: its things are the house's.
                // Prices keep their stamps: they're only ever added (nothing to give way over), and a
                // server file carries only prices stamped in the last 60 days, so at -1 they'd never go up.
                if (!gift.optBoolean("seed", false)) e.db.exec("UPDATE sync_log SET stamp = -1, created = 0 WHERE tbl NOT IN ('household', 'prices')");
            } else {
                // Its household carries on as a house: it keeps sharing just what it shares now, so
                // when the server later widens the household's tabs and receipts (D10, once every
                // phone is on v3), this phone doesn't start sharing more by itself.
                e.setMeta("tabs", SyncEngine.joinTabs(e.tabs()));
                if (e.meta("share_receipts") == null) e.setMeta("share_receipts", "1".equals(e.meta("receipts_eff")) || e.shareReceipts() ? "1" : "0");
                if (keyv > h.keyv()) {
                    e.setMeta("key", cur);
                    e.setMeta("keyv", String.valueOf(keyv));
                }
            }
            if (gift.opt("secret") instanceof String && "keep".equals(how) && !h.isOwner()) e.setMeta("secret", gift.getString("secret"));
            if (dev != null) e.setMeta("server_dev_priv", ServerLink.b64u(dev.getPrivate().getEncoded()));
            e.setMeta("server_kex_priv", ServerLink.b64u(mine.getPrivate().getEncoded()));
            e.setMeta("server_kex", kex);
            e.setMeta("server_api", "3");
            e.setMeta("server_sid", hh.optString("sid", null));
            // What this phone calls the server ("Home" until changed), and what the server calls this phone.
            if (e.meta("server_label") == null) e.setMeta("server_label", "Home");
            e.setMeta("server_member_label", gift.opt("label") instanceof String ? gift.getString("label") : null);
            e.setMeta("server_handover", null);
            clearNotes();
            // Every serverKey the server has, so older files and archives stay readable.
            JSONObject sk = gift.optJSONObject("serverKeys");
            JSONArray all = e.meta("server_filekeys") == null ? new JSONArray() : new JSONArray(e.meta("server_filekeys"));
            Set<String> have = new HashSet<>();
            for (int i = 0; i < all.length(); i++) have.add(all.getJSONObject(i).optString("key"));
            for (String v : sk == null ? new ArrayList<String>() : SyncHousehold.keysOf(sk)) {
                String b = sk.optString(v, "");
                if (b.isEmpty() || have.contains(b)) continue;
                JSONObject x = new JSONObject();
                x.put("hid", hid);
                x.put("keyv", Integer.parseInt(v));
                x.put("key", b);
                all.put(x);
                have.add(b);
            }
            e.setMeta("server_filekeys", all.toString());
        });
        noteFileKey();
    }

    /** A newer household key from keys/<device>.bin (RSE3), if its version changed. True when one was taken. */
    boolean takeKeysFile(ServerFolder f, List<String> names) throws Exception {
        String name = keysFileName();
        if (!names.contains(name)) return false;
        String ver = f.version(name);
        if (ver != null && ver.equals(e.meta("server_keysfile"))) return false;
        byte[] b = f.read(name);
        if (b == null) return false;
        JSONObject m;
        try {
            m = ServerLink.openKeysFile(ServerLink.privateKey(e.meta("server_kex_priv")), serverKex(), e.device(), b);
        } catch (Exception ex) {
            return false; // not for this phone's key: tried again when it changes
        } finally {
            if (ver != null) e.setMeta("server_keysfile", ver);
        }
        int v = m.getInt("keyv");
        JSONObject keys = m.getJSONObject("keys");
        String k = keys.optString(String.valueOf(v), null);
        if (k == null || v <= h.keyv()) return false;
        SyncWire.decodeKey(k);
        // The serverKeys of every version it names, so their files stay readable.
        String hid = h.hid() == null ? "" : h.hid();
        JSONArray all = e.meta("server_filekeys") == null ? new JSONArray() : new JSONArray(e.meta("server_filekeys"));
        for (String x : SyncHousehold.keysOf(keys)) {
            try {
                JSONObject o = new JSONObject();
                o.put("hid", hid);
                o.put("keyv", Integer.parseInt(x));
                o.put("key", ServerLink.b64u(SyncFolder.serverKey(SyncWire.decodeKey(keys.getString(x)))));
                all.put(o);
            } catch (Exception odd) {
                // not a key
            }
        }
        noteFileKey(); // the key it had, before it changes
        e.setMeta("server_filekeys", all.toString());
        e.setMeta("key", k);
        e.setMeta("keyv", String.valueOf(v));
        e.setMeta("server_top", null);
        return true;
    }

    /**
     * 0.9.4: before leaving, takes `kinds` (Keg, Pharmacy, receipts, cards) off the server, as turning
     * each off with "Also take what this phone shared off the server" ticked: turned off here, then one
     * round so this phone's file with the deletes is on the server. Only what this phone made goes.
     * Throws (and doesn't leave: the caller stops) when that round can't reach the server; the kinds stay
     * off and taken back, so the next round sends them anyway.
     */
    void takeBackBeforeLeaving(Set<String> kinds, String nowIso, long now) throws Exception {
        if (kinds == null || kinds.isEmpty()) return;
        e.stopSharingAndTakeBack(kinds);
        // Review fix: also the ones already off and being taken back (a Leave that couldn't reach the
        // server turned them off first): their deletes may not be on the server yet, so the round
        // still has to reach it before this phone goes.
        JSONObject pending = e.takeBackKinds();
        boolean any = false;
        for (String k : kinds) any |= pending.has(k);
        if (!any) return;
        e.setMeta("server_top", null);
        Round r = round(nowIso, now);
        if (r.error != null) {
            String why = r.error.trim();
            throw new IllegalStateException(TAKE_BACK_NOT_DONE + (why.isEmpty() ? "." : ": " + why + (why.endsWith(".") ? "" : "."))
                + " Try again when the server can be reached, or leave without taking them back.");
        }
    }

    /** The start of the words when taking things back before leaving didn't reach the server (the Leave sheet looks for it). */
    static final String TAKE_BACK_NOT_DONE = "Couldn't take those things off the server";

    /** 0.9.4: leaves the house (DELETE /api/v3/devices/<me>; best effort). The caller forgets the household. */
    void leave3() {
        try {
            ServerFolder f = open();
            f.names();
            f.call("DELETE", "/devices/" + e.device(), null);
        } catch (Exception ignored) {
            // out of reach: the server's page can take it off the list
        }
    }

    /** The handover payload sealed for the server's kex key: { epub, sealed } (RSH3, salt). */
    private JSONObject sealHandover(java.security.PublicKey kex, byte[] salt) throws Exception {
        noteFileKey();
        JSONObject serverKeys = new JSONObject();
        String stored = e.meta("server_filekeys");
        JSONArray all = stored == null ? new JSONArray() : new JSONArray(stored);
        String hid = h.hid() == null ? "" : h.hid();
        for (int i = 0; i < all.length(); i++) {
            JSONObject k = all.getJSONObject(i);
            if (hid.equals(k.optString("hid")) || k.optString("hid").isEmpty()) serverKeys.put(String.valueOf(k.getInt("keyv")), k.getString("key"));
        }
        serverKeys.put(String.valueOf(h.keyv()), ServerLink.b64u(SyncFolder.serverKey(h.key())));
        JSONObject payload = h.handoverPayload(serverKeys);
        JSONObject ha = haPayload();
        if (ha != null) payload.put("ha", ha);
        KeyPair eph = ServerLink.newKey();
        JSONObject out = new JSONObject();
        out.put("epub", ServerLink.b64u(eph.getPublic().getEncoded()));
        out.put("sealed", ServerLink.b64u(ServerLink.sealAad(ServerLink.v3Key(eph.getPrivate(), kex, salt, ServerLink.HANDOVER_INFO), "RSH3", payload, null)));
        return out;
    }

    /**
     * 0.9.4: GET /api/v3/health of this phone's (v2) server: { mode, api, house }, or null when it's a
     * 0.9.3 server or can't be reached. The owner phone offers Hand this household to the server when
     * mode is "v2".
     */
    JSONObject health() {
        JSONObject hl = ServerFolder.health(addresses());
        try {
            if (hl != null) e.setMeta("server_mode", hl.optString("mode", null));
        } catch (Exception ignored) {
            // just a note
        }
        return hl;
    }

    /**
     * 0.9.4, owner phone on a v2 server: hands the household to the server with the code from the
     * server's Take this household page (restock-handover:3?u=&t=&k=). Signed with this phone's v2
     * key. The phone stays the owner until it reads the server's file with the signed owner change
     * (takeHandover); a lost answer, or a crash on either side, just means trying again or a round.
     * Throws with words.
     */
    JSONObject handOver(String code) throws Exception {
        if (!on() || v3()) throw new IllegalStateException("This phone isn't on a Restock server that's waiting for its household.");
        if (!h.isOwner()) throw new IllegalStateException("Only the owner phone can hand the household to the server.");
        ServerLink.Code c = ServerLink.parse(code);
        if (!"handover".equals(c.kind)) throw new IllegalArgumentException("That isn't the code from your server's Take this household page.");
        Set<String> hosts = new java.util.LinkedHashSet<>();
        for (String a : addresses()) {
            String x = ServerLink.hostOf(a);
            if (x != null) hosts.add(x);
        }
        if (!hosts.contains(c.host))
            throw new IllegalArgumentException("That code is from a page at " + c.host + ", not your Restock server (" + String.join(" or ", hosts) + "). Only scan codes from your own server's page.");
        if (!c.id.matches("[A-Za-z0-9_-]{20,128}")) throw new IllegalArgumentException("That code is damaged. Refresh the server's page and scan it again.");
        JSONObject body = sealHandover(c.browser, ServerLink.unb64(c.id));
        ServerFolder f = new ServerFolder(addresses(), e.device(), ServerLink.privateKey(e.meta("server_dev_priv")), ServerFolder.API);
        SyncDav.Response r = f.first("POST", ServerFolder.API3 + "/handover/" + c.id, body);
        String err = ServerFolder.errorOf(r);
        if (r.status == 409 && !"done".equals(err)) {
            String said = ServerFolder.messageOf(r);
            throw new IllegalStateException(said.isEmpty() ? "The server didn't take the household. Nothing changed; this phone is still the owner." : said);
        }
        if ((r.status < 200 || r.status >= 300) && r.status != 409) {
            if (r.status == 404 || r.status == 410) throw new IllegalStateException("That code has run out. Refresh the server's page and scan the new code.");
            throw SyncDav.problem(r.status, "hand the household over");
        }
        // Pinned from the code: the upgrade that follows opens the server's answer with it.
        e.setMeta("server_kex", ServerLink.b64u(c.browser.getEncoded()));
        e.setMeta("server_handover", String.valueOf(System.currentTimeMillis()));
        JSONObject o = new JSONObject();
        o.put("host", c.host);
        o.put("done", true);
        return o;
    }

    // ---------- the web page's codes ----------

    /** A web page's code, checked: { kind: "link" | "login", host }. Throws with words. */
    JSONObject webCode(String code) throws Exception {
        if (!on()) throw new IllegalStateException("Connect this phone to your Restock server first.");
        ServerLink.Code c = ServerLink.parse(code);
        if ("handover".equals(c.kind)) throw new IllegalArgumentException("That's the server's Take this household code. Scan it from Hand this household to the server.");
        if (c.v == 3 && !v3()) throw new IllegalArgumentException("That page is on a newer Restock server than this phone is set up for. Sync once, then try again.");
        if (c.v != 3 && v3()) throw new IllegalArgumentException("That code is from an older Restock web page. Reload the page and scan the new code.");
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
        // 0.9.4: on a v3 server the phone only says yes (signed); the server gives that browser its keys.
        JSONObject body = c.v == 3 ? new JSONObject().put("approve", true).put("k", ServerLink.b64u(c.browser.getEncoded())) : ServerLink.sealFor(c.browser, gift());
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
