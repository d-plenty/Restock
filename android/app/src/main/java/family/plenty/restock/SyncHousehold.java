package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;
import org.json.JSONObject;

/**
 * The household (0.8.2): who's in it, which phone is the owner, and the keys.
 *
 * - The phone that starts the household is the owner. Only the owner adds phones (with a
 *   one-time code), removes them, or hands ownership to another phone.
 * - A pairing code works once and only for 10 minutes. It never contains the household's key:
 *   the joining phone proves it has the code and is then given the key over the sealed link.
 * - Each phone has its own secret, which only the owner holds. When a phone is removed, the
 *   owner changes the household's key and gives the new one to each remaining phone sealed with
 *   that phone's secret, so the removed phone can't get it even though it had the old key.
 *
 * Stored on this phone only (sync_meta): key, keyv, oldkey and oldkey_until (owner), secret,
 * owner_secrets (owner), pair_token and pair_until (owner, while a code is open).
 * Shared by all phones (the synced household table): name, owner, member:<device>,
 * removed:<device>, handover:<device>.
 *
 * No Android classes here, so it's tested on a computer too (with SyncEngine and SyncWire).
 */
final class SyncHousehold {
    static final long CODE_LIFE_MS = 10 * 60 * 1000L;
    /** Local sync is for a household: up to 6 phones (0.8.3). */
    static final int MAX_PHONES = 6;
    static final String FULL = "A household can have up to " + MAX_PHONES + " phones. Remove one first (Settings → Local sync).";
    static final long OLD_KEY_LIFE_MS = 60L * 24 * 3600 * 1000;
    /** Which key opened a message (the order of keys()). */
    static final int CURRENT = 0, OLD = 1, PAIRING = 2;

    private static final SecureRandom RANDOM = new SecureRandom();
    final SyncEngine e;
    /** The owner's settings to hand a phone joining from the first screen (JSON text), or null. */
    interface SettingsSource {
        String settings() throws Exception;
    }

    SettingsSource settings;

    SyncHousehold(SyncEngine e) {
        this.e = e;
    }

    private static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static byte[] unb64(String s) {
        return Base64.getUrlDecoder().decode(s);
    }

    private static byte[] random(int n) {
        byte[] b = new byte[n];
        RANDOM.nextBytes(b);
        return b;
    }

    static byte[] pairingKey(byte[] token) throws Exception {
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        d.update("restock-pairing".getBytes(StandardCharsets.UTF_8));
        return d.digest(token);
    }

    /** A short public tag for an open code, so the joining phone can find the owner on the Wi-Fi. */
    static String pairingTag(byte[] token) throws Exception {
        return SyncWire.householdId(pairingKey(token));
    }

    // ---------- what this phone knows ----------

    byte[] key() throws Exception {
        String k = e.meta("key");
        return k == null ? null : SyncWire.decodeKey(k);
    }

    boolean paired() throws Exception {
        return e.meta("key") != null && e.meta("secret") != null;
    }

    /** Paired on 0.8.0 or 0.8.1, before owners and one-time codes: needs pairing again. */
    boolean legacy() throws Exception {
        return e.meta("key") != null && e.meta("secret") == null;
    }

    String owner() throws Exception {
        return e.householdValue("owner");
    }

    boolean isOwner() throws Exception {
        return e.device().equals(owner());
    }

    byte[] oldKey() throws Exception {
        String k = e.meta("oldkey");
        String until = e.meta("oldkey_until");
        if (k == null || until == null || System.currentTimeMillis() > Long.parseLong(until)) return null;
        return SyncWire.decodeKey(k);
    }

    byte[] openPairingKey() throws Exception {
        String t = e.meta("pair_token");
        String until = e.meta("pair_until");
        if (t == null || until == null || System.currentTimeMillis() > Long.parseLong(until)) return null;
        return pairingKey(SyncWire.unbase32(t));
    }

    String openPairingTag() throws Exception {
        String t = e.meta("pair_token");
        return t == null || openPairingKey() == null ? null : pairingTag(SyncWire.unbase32(t));
    }

    /** The keys the server accepts, in CURRENT, OLD, PAIRING order. */
    List<byte[]> serverKeys() {
        List<byte[]> l = new ArrayList<>();
        try {
            l.add(key());
            l.add(isOwner() ? oldKey() : null);
            l.add(isOwner() ? openPairingKey() : null);
        } catch (Exception ex) {
            while (l.size() < 3) l.add(null);
        }
        return l;
    }

    private JSONObject secrets() throws Exception {
        String s = e.meta("owner_secrets");
        return s == null ? new JSONObject() : new JSONObject(s);
    }

    // ---------- starting, inviting, joining ----------

    /** Starts a household with this phone as its owner. */
    void create(String name, String myName) throws Exception {
        if (paired()) return;
        e.setMeta("key", SyncWire.encodeKey(SyncWire.newKey()));
        e.setMeta("keyv", "1");
        e.setMeta("secret", b64(random(32)));
        e.setMeta("owner_secrets", "{}");
        if (myName != null) e.setMeta("name", myName);
        String me = e.device();
        setRow("name", name == null || name.trim().isEmpty() ? "Our house" : name.trim());
        setRow("owner", me);
        setRow("member:" + me, member(e.name()));
    }

    private static String member(String name) throws Exception {
        JSONObject m = new JSONObject();
        m.put("name", name);
        return m.toString();
    }

    private void setRow(String k, String v) throws Exception {
        e.db.exec("INSERT OR REPLACE INTO household (k, v) VALUES (?, ?)", k, v);
    }

    private void deleteRow(String k) throws Exception {
        e.db.exec("DELETE FROM household WHERE k = ?", k);
    }

    /**
     * A new one-time code (owner only): RESTOCK:3:TOKEN:IP:PORT. Each call makes a different one
     * and the one before stops working. It works once, for 10 minutes.
     */
    String invite(String ip, int port) throws Exception {
        if (!isOwner()) throw new IllegalStateException("Only the owner phone can add phones.");
        if (members().size() >= MAX_PHONES) throw new IllegalStateException(FULL);
        byte[] token = random(16);
        e.setMeta("pair_token", SyncWire.base32(token));
        e.setMeta("pair_until", String.valueOf(System.currentTimeMillis() + CODE_LIFE_MS));
        return "RESTOCK:3:" + SyncWire.base32(token) + ":" + (ip == null ? "" : ip) + ":" + port;
    }

    /** Closes the open code early (the sheet showing it was closed). */
    void closeInvite() throws Exception {
        e.setMeta("pair_token", null);
        e.setMeta("pair_until", null);
    }

    /** A scanned or pasted code: {token, host, port}. Throws a message for the person if it isn't one. */
    static String[] parseCode(String code) {
        String[] p = code.trim().replaceAll("\\s+", "").split(":");
        if (p.length >= 3 && "RESTOCK".equalsIgnoreCase(p[0]) && "3".equals(p[1])) {
            return new String[] { p[2].toUpperCase(java.util.Locale.ROOT), p.length > 3 ? p[3] : "", p.length > 4 ? p[4] : "0" };
        }
        if (p.length >= 2 && p[0].toUpperCase(java.util.Locale.ROOT).startsWith("RESTOCK")) {
            throw new IllegalArgumentException(
                "That code is from an older or newer Restock. Update both phones to the same version, then make a new code on the owner phone.");
        }
        throw new IllegalArgumentException("That isn't a Restock sync code.");
    }

    /**
     * Joins over a link sealed with the code's pairing key: proves it has the code, gets the
     * household key, and leaves this phone's secret with the owner. Answers what the owner sent
     * (household name, owner, its settings when asked for).
     */
    JSONObject join(SyncEngine.Transport t, boolean wantSettings) throws Exception {
        String secret = b64(random(32));
        JSONObject m = new JSONObject();
        m.put("op", "join");
        m.put("device", e.device());
        m.put("name", e.name());
        m.put("secret", secret);
        m.put("settings", wantSettings);
        JSONObject r = t.send(m);
        if (r.has("error")) throw new IllegalStateException(r.getString("error"));
        SyncWire.decodeKey(r.getString("key"));
        e.setMeta("key", r.getString("key"));
        e.setMeta("keyv", String.valueOf(r.optInt("keyv", 1)));
        e.setMeta("secret", secret);
        e.setMeta("owner_secrets", null);
        return r;
    }

    // ---------- answering other phones ----------

    /** Answers a message, depending on which key opened it. */
    JSONObject handle(JSONObject req, String host, int which) throws Exception {
        String device = req.optString("device");
        JSONObject res = new JSONObject();
        if (which == PAIRING) {
            if (!"join".equals(req.optString("op"))) return res.put("error", "Use the code to join first.");
            if (openPairingKey() == null || !isOwner()) return res.put("error", "That code has run out. Make a new one on the owner phone.");
            closeInvite(); // one use only
            if (members().size() >= MAX_PHONES) return res.put("error", FULL);
            String name = req.optString("name", "Phone");
            JSONObject s = secrets();
            s.put(device, req.getString("secret"));
            e.setMeta("owner_secrets", s.toString());
            deleteRow("removed:" + device);
            setRow("member:" + device, member(name));
            e.notePeer(device, name, host, 0);
            res.put("key", e.meta("key"));
            res.put("keyv", Integer.parseInt(e.meta("keyv") == null ? "1" : e.meta("keyv")));
            res.put("household", e.householdValue("name"));
            res.put("owner", e.device());
            res.put("ownerName", e.name());
            if (req.optBoolean("settings", false) && settings != null) {
                String st = settings.settings();
                if (st != null) res.put("settings", st);
            }
            return res;
        }
        if (which == OLD) {
            // A phone with the old key: removed, or it missed the change.
            res.put("device", e.device());
            if (e.householdValue("removed:" + device) != null) return res.put("removed", true);
            String secret = secrets().optString(device, null);
            if (secret == null || e.householdValue("member:" + device) == null) return res.put("error", "Not in this household.");
            JSONObject k = new JSONObject();
            k.put("key", e.meta("key"));
            k.put("keyv", e.meta("keyv"));
            res.put("rekey", b64(SyncWire.seal(unb64(secret), k)));
            return res;
        }
        if (e.householdValue("removed:" + device) != null) {
            res.put("device", e.device());
            return res.put("removed", true);
        }
        return e.handle(req, host);
    }

    /** The household's key changed: open the new one with this phone's secret and use it. */
    void takeRekey(String sealed) throws Exception {
        JSONObject k = SyncWire.open(unb64(e.meta("secret")), unb64(sealed));
        SyncWire.decodeKey(k.getString("key"));
        e.setMeta("key", k.getString("key"));
        e.setMeta("keyv", k.optString("keyv", "1"));
    }

    // ---------- owner jobs ----------

    /** Owner: removes a phone. The household gets a new key the removed phone never sees. */
    void remove(String device) throws Exception {
        if (!isOwner()) throw new IllegalStateException("Only the owner phone can remove phones.");
        if (device.equals(e.device())) throw new IllegalArgumentException("To take the owner phone out, hand ownership to another phone first.");
        e.db.transaction(() -> {
            e.setMeta("oldkey", e.meta("key"));
            e.setMeta("oldkey_until", String.valueOf(System.currentTimeMillis() + OLD_KEY_LIFE_MS));
            e.setMeta("key", SyncWire.encodeKey(SyncWire.newKey()));
            int v = Integer.parseInt(e.meta("keyv") == null ? "1" : e.meta("keyv")) + 1;
            e.setMeta("keyv", String.valueOf(v));
            JSONObject s = secrets();
            s.remove(device);
            e.setMeta("owner_secrets", s.toString());
            deleteRow("member:" + device);
            setRow("removed:" + device, String.valueOf(System.currentTimeMillis()));
            e.db.exec("DELETE FROM sync_peers WHERE device = ?", device);
        });
    }

    /**
     * Owner: makes another phone the owner. The phones' secrets go to it sealed with its own
     * secret, inside the household record, so only it can open them.
     */
    void handOver(String device) throws Exception {
        if (!isOwner()) throw new IllegalStateException("Only the owner phone can do that.");
        JSONObject s = secrets();
        String theirs = s.optString(device, null);
        if (theirs == null || e.householdValue("member:" + device) == null) throw new IllegalArgumentException("That phone isn't in the household.");
        JSONObject give = new JSONObject();
        JSONObject rest = new JSONObject(s.toString());
        rest.remove(device);
        rest.put(e.device(), e.meta("secret"));
        give.put("secrets", rest);
        if (e.meta("oldkey") != null) {
            give.put("oldkey", e.meta("oldkey"));
            give.put("oldkey_until", e.meta("oldkey_until"));
        }
        String blob = b64(SyncWire.seal(unb64(theirs), give));
        e.db.transaction(() -> {
            setRow("handover:" + device, blob);
            setRow("owner", device);
            e.setMeta("owner_secrets", null);
            e.setMeta("oldkey", null);
            closeInvite();
        });
    }

    /** After a sync: if this phone was just made the owner, take over the phones' secrets. */
    boolean takeHandover() throws Exception {
        String me = e.device();
        String blob = e.householdValue("handover:" + me);
        if (blob == null || !me.equals(owner())) return false;
        JSONObject give = SyncWire.open(unb64(e.meta("secret")), unb64(blob));
        e.setMeta("owner_secrets", give.getJSONObject("secrets").toString());
        if (give.has("oldkey")) {
            e.setMeta("oldkey", give.getString("oldkey"));
            e.setMeta("oldkey_until", give.optString("oldkey_until"));
        }
        deleteRow("handover:" + me);
        return true;
    }

    /** The household's phones: [{device, name, owner, me}]. */
    List<JSONObject> members() throws Exception {
        List<JSONObject> out = new ArrayList<>();
        String owner = owner();
        String me = e.device();
        for (JSONObject r : e.db.query("SELECT k, v FROM household WHERE k LIKE 'member:%' ORDER BY k")) {
            String d = r.getString("k").substring("member:".length());
            JSONObject m = new JSONObject();
            m.put("device", d);
            String name = "Phone";
            try {
                name = new JSONObject(r.getString("v")).optString("name", name);
            } catch (Exception ignored) {
                // an odd entry: keep the default name
            }
            m.put("name", name);
            m.put("owner", d.equals(owner));
            m.put("me", d.equals(me));
            out.add(m);
        }
        return out;
    }

    /** Owner: renames the household (the other phones get the new name when they sync). */
    void renameHousehold(String name) throws Exception {
        if (isOwner()) setRow("name", name);
    }

    /** This phone's name changed: tell the household (its own member entry). */
    void rename(String name) throws Exception {
        e.setMeta("name", name);
        if (paired() && e.householdValue("member:" + e.device()) != null) setRow("member:" + e.device(), member(name));
    }

    /**
     * This phone is leaving (it keeps its things): takes its own entry out of the household, so
     * the others see it go once this is synced, then call forget(). The owner can only leave once
     * another phone is the owner, or when it's the only phone. False: hand over first.
     */
    boolean startLeaving() throws Exception {
        if (isOwner()) {
            for (JSONObject m : members()) if (!m.getBoolean("me")) return false;
        }
        deleteRow("member:" + e.device());
        return true;
    }

    /** Forgets the household on this phone (keys, secrets, phones), keeping everything else. */
    void forget() throws Exception {
        for (String k : new String[] { "key", "keyv", "oldkey", "oldkey_until", "secret", "owner_secrets", "pair_token", "pair_until", "invite" }) e.setMeta(k, null);
        e.db.exec("DELETE FROM sync_peers");
    }

    /** Names in an object's keys, for tests and the Sync screen. */
    static List<String> keysOf(JSONObject o) {
        List<String> l = new ArrayList<>();
        for (Iterator<String> it = o.keys(); it.hasNext(); ) l.add(it.next());
        return l;
    }
}
