package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
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
 * removed:<device>, handover:<device>, tabs (0.8.5: which tabs the household shares) and
 * receipts (0.9.1: "1" when the household shares receipts; signed by the owner like tabs).
 *
 * 0.9.0, signed household changes: the household has an owner key (owner_pub in the household
 * record; the private half, owner_priv, only on the owner phone). Every phone remembers it
 * (owner_pin) when it joins, or the first time it sees it. From then on the owner's changes
 * (name, owner, tabs, removed:, handover:, recovery, hid) only count when signed with it, so a
 * phone in the household can't pretend to be the owner. Each phone also has its own key (its
 * public half in its member:<device> entry) and signs changes to its own entry (its name,
 * leaving). The key passes to the next owner with a handover, and is in the recovery copy.
 *
 * 0.9.0, the recovery key: if the owner phone is lost, another phone in the household can take
 * over as owner with the household's recovery key (32 letters and numbers the owner saves). The
 * household record has, sealed with the recovery key, what the owner phone holds: the phones'
 * secrets, the household's key, the old key while it lasts and the owner key. Taking over, a
 * phone opens it, signs itself in as owner, and makes a new recovery key (the lost phone knew the
 * old one). Two phones taking over at once end up agreeing: the later one wins everywhere.
 *
 * 0.9.0, pairing with a fresh key exchange (ECDH): the household's key and the joining phone's
 * secret travel sealed with a key the two phones work out together for this one join, so someone
 * who recorded the join and later sees the code still can't open them.
 *
 * 0.9.0, a phone that missed key changes (two phones removed while it was away, or away longer
 * than the old key lasts) asks the owner with a message sealed with its own secret (MEMBER).
 *
 * No Android classes here, so it's tested on a computer too (with SyncEngine and SyncWire).
 */
final class SyncHousehold implements SyncEngine.Household {
    static final long CODE_LIFE_MS = 10 * 60 * 1000L;
    /** Local sync is for a household: up to 6 phones (0.8.3). */
    static final int MAX_PHONES = 6;
    static final String FULL = "A household can have up to " + MAX_PHONES + " phones. Remove one first (Settings → Local sync).";
    static final long OLD_KEY_LIFE_MS = 60L * 24 * 3600 * 1000;
    /** Which key opened a message (the order of keys()): from MEMBER on, a phone's own secret. */
    static final int CURRENT = 0, OLD = 1, PAIRING = 2, MEMBER = 3;

    private static final SecureRandom RANDOM = new SecureRandom();
    final SyncEngine e;
    /** The owner's settings to hand a phone joining from the first screen (JSON text), or null. */
    interface SettingsSource {
        String settings() throws Exception;
    }

    SettingsSource settings;
    /** Which phone each MEMBER key in the last serverKeys() belongs to. */
    private volatile List<String> memberOrder = new ArrayList<>();
    /** Owner: joins half done (0.9.0): the phone's id → the key worked out with it, and when. */
    private final java.util.Map<String, Object[]> pendingJoins = new java.util.HashMap<>();

    SyncHousehold(SyncEngine e) {
        this.e = e;
        e.household = this;
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

    int keyv() throws Exception {
        String v = e.meta("keyv");
        return v == null ? 1 : Integer.parseInt(v);
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

    /** 0.9.0: the household's own id (for the folder's keys file), or null before the owner set one. */
    String hid() throws Exception {
        return e.householdValue("hid");
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

    /**
     * The keys the server accepts, in CURRENT, OLD, PAIRING order, then (on the owner, 0.9.0) each
     * phone's own secret, for a phone that missed a key change.
     */
    List<byte[]> serverKeys() {
        List<byte[]> l = new ArrayList<>();
        List<String> order = new ArrayList<>();
        try {
            l.add(key());
            boolean owner = isOwner();
            l.add(owner ? oldKey() : null);
            l.add(owner ? openPairingKey() : null);
            if (owner) {
                JSONObject s = secrets();
                for (String d : keysOf(s)) {
                    if (e.householdValue("member:" + d) == null) continue;
                    l.add(unb64(s.getString(d)));
                    order.add(d);
                }
            }
        } catch (Exception ex) {
            while (l.size() < 3) l.add(null);
        }
        memberOrder = order;
        return l;
    }

    private JSONObject secrets() throws Exception {
        String s = e.meta("owner_secrets");
        return s == null ? new JSONObject() : new JSONObject(s);
    }

    // ---------- 0.9.0: signing ----------

    private static KeyPair newSigningKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
        return g.generateKeyPair();
    }

    private static PrivateKey privateKey(String b) throws Exception {
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(unb64(b)));
    }

    private static String signWith(String priv, String text) throws Exception {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(privateKey(priv));
        s.update(text.getBytes(StandardCharsets.UTF_8));
        return b64(s.sign());
    }

    private static boolean verify(String pub, String text, String sig) {
        try {
            PublicKey k = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(unb64(pub)));
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(k);
            s.update(text.getBytes(StandardCharsets.UTF_8));
            return s.verify(unb64(sig));
        } catch (Exception ex) {
            return false;
        }
    }

    /** A one-off key pair for a key exchange (ECDH, P-256). */
    private static KeyPair newExchangeKey() throws Exception {
        return newSigningKey();
    }

    /** The key both phones work out from their one-off keys and the code's pairing key. */
    private static byte[] joinKey(KeyPair mine, String theirPub, byte[] pairingKey) throws Exception {
        PublicKey theirs = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(unb64(theirPub)));
        javax.crypto.KeyAgreement ka = javax.crypto.KeyAgreement.getInstance("ECDH");
        ka.init(mine.getPrivate());
        ka.doPhase(theirs, true);
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        d.update("restock-join".getBytes(StandardCharsets.UTF_8));
        d.update(ka.generateSecret());
        d.update(pairingKey);
        return d.digest();
    }

    /** What a household change's signature covers: which entry, its value (or "deleted") and its stamp. */
    static String signed(JSONObject entry) {
        boolean deleted = entry.optBoolean("deleted", false);
        JSONObject row = entry.optJSONObject("row");
        String v = deleted || row == null ? "-" : "v=" + row.optString("v", "");
        return "restock-hh1|" + entry.optString("pk") + "|" + v + "|" + entry.optLong("stamp");
    }

    /** Entries only the owner changes. */
    static boolean ownerOnly(String pk) {
        return "name".equals(pk) || "owner".equals(pk) || "tabs".equals(pk) || "owner_pub".equals(pk) || "recovery".equals(pk) || "hid".equals(pk)
            || "receipts".equals(pk) || pk.startsWith("removed:") || pk.startsWith("handover:")
            // 0.9.4: where the house's server is (docs/server-protocol.md "v3").
            || "server".equals(pk);
    }

    /** 0.9.4: whether the household is a house: its owner is a Restock server (srv-<sid>). */
    boolean isHouse() throws Exception {
        String o = owner();
        return o != null && o.startsWith("srv-");
    }

    /**
     * 0.9.4: the owner-signed `server` row, checked (engine.ts parseServerRow): { v: 3, sid, home,
     * away, kex, keepMonths }, or null when there's none or it isn't one.
     */
    JSONObject serverRow() throws Exception {
        return parseServerRow(e.householdValue("server"));
    }

    static JSONObject parseServerRow(String v) {
        if (v == null) return null;
        try {
            JSONObject m = new JSONObject(v);
            if (m.optInt("v", 0) != 3 || !(m.opt("sid") instanceof String) || !(m.opt("home") instanceof String) || !(m.opt("kex") instanceof String)) return null;
            JSONObject out = new JSONObject();
            out.put("v", 3);
            out.put("sid", m.getString("sid"));
            out.put("home", m.getString("home"));
            out.put("away", m.opt("away") instanceof String ? m.getString("away") : JSONObject.NULL);
            out.put("kex", m.getString("kex"));
            Object k = m.opt("keepMonths");
            int km = k instanceof Number ? ((Number) k).intValue() : 0;
            boolean ok = k instanceof Number && ((Number) k).doubleValue() == km && keepMonthsOk(km);
            out.put("keepMonths", ok ? (Object) km : JSONObject.NULL);
            return out;
        } catch (Exception ex) {
            return null;
        }
    }

    /** 0.9.4: this phone's household signing key (my_priv) over `text`, base64url DER (a member join). */
    String signMine(String text) throws Exception {
        myPub();
        return signWith(e.meta("my_priv"), text);
    }

    /**
     * 0.9.4, owner: what the server needs to become the household's owner (docs/server-protocol.md
     * "v3", RSH3): the household key and version, every serverKey, the owner key, the phones'
     * secrets and this phone's own, the recovery key, the household's id and name.
     */
    JSONObject handoverPayload(JSONObject serverKeys) throws Exception {
        if (!isOwner() || e.meta("owner_priv") == null) throw new IllegalStateException("Only the owner phone can hand the household to the server.");
        ensureKeys();
        JSONObject p = new JSONObject();
        p.put("format", "restock-handover");
        p.put("v", 3);
        p.put("key", e.meta("key"));
        p.put("keyv", keyv());
        p.put("serverKeys", serverKeys);
        if (e.meta("oldkey") != null && e.meta("oldkey_until") != null) {
            p.put("oldkey", e.meta("oldkey"));
            p.put("oldkey_until", e.meta("oldkey_until"));
        }
        p.put("owner_priv", e.meta("owner_priv"));
        p.put("owner_pubkey", e.meta("owner_pubkey") != null ? e.meta("owner_pubkey") : e.householdValue("owner_pub"));
        JSONObject s = secrets();
        for (String d : keysOf(new JSONObject(s.toString()))) if (e.householdValue("member:" + d) == null) s.remove(d);
        p.put("owner_secrets", s);
        p.put("secret", e.meta("secret"));
        if (e.meta("recovery") != null) {
            p.put("recovery", e.meta("recovery"));
            p.put("recovery_saved", recoverySaved());
        }
        p.put("hid", hid());
        String name = e.householdValue("name");
        p.put("name", name != null ? name : e.meta("household") != null ? e.meta("household") : "Our house");
        return p;
    }

    /** 0.9.4: a month for "Keep data for" (a year's 365.25 days over 12), as engine.ts MONTH_MS. */
    static final long MONTH_MS = 2_629_800_000L;

    /** 0.9.5: Auto delete: any whole number of months from 1 to 120 (engine.ts keepMonthsOk). 0.9.4 took 3, 6, 9 or 12 only. */
    static boolean keepMonthsOk(int km) {
        return km >= 1 && km <= 120;
    }

    /** 0.9.4: keepCutoff (engine.ts): ms of now − keepMonths months, or -1 for none (off, or not a whole number 1 to 120). */
    static long keepCutoff(Object keepMonths, long now) {
        if (!(keepMonths instanceof Number)) return -1;
        int km = ((Number) keepMonths).intValue();
        if (((Number) keepMonths).doubleValue() != km || !keepMonthsOk(km)) return -1;
        return now - km * MONTH_MS;
    }

    @Override
    public String sign(JSONObject entry) throws Exception {
        String pk = entry.optString("pk");
        String me = e.device();
        if (pk.equals("member:" + me) && me.equals(entry.optString("device")) && e.meta("my_priv") != null) return signWith(e.meta("my_priv"), signed(entry));
        if ((ownerOnly(pk) || pk.startsWith("member:")) && isOwner() && e.meta("owner_priv") != null) return signWith(e.meta("owner_priv"), signed(entry));
        return null;
    }

    @Override
    public boolean allowed(String pk, String byDevice, JSONObject entry) throws Exception {
        String pin = e.meta("owner_pin");
        boolean deleted = entry.optBoolean("deleted", false);
        JSONObject row = entry.optJSONObject("row");
        String v = row == null ? null : row.optString("v", null);
        if (pin == null) {
            // A household whose owner is still on 0.8.x (or this phone hasn't seen the key yet).
            boolean ok = e.legacyHouseholdChangeAllowed(pk, byDevice, entry);
            if (ok && "owner_pub".equals(pk) && !deleted && v != null) e.setMeta("owner_pin", v);
            return ok;
        }
        String sig = entry.isNull("sig") ? null : entry.optString("sig", null);
        boolean byOwner = sig != null && verify(pin, signed(entry), sig);
        if (ownerOnly(pk)) {
            if (!byOwner) return false;
            // A new owner key, signed with the one before it.
            if ("owner_pub".equals(pk) && !deleted && v != null) e.setMeta("owner_pin", v);
            return true;
        }
        if (pk.startsWith("member:")) {
            if (byOwner) return true;
            // The phone itself: signed with its own key, the one in its entry.
            String cur = e.householdValue(pk);
            String pub = null;
            if (cur != null) {
                try {
                    pub = new JSONObject(cur).optString("pub", null);
                } catch (Exception ignored) {
                    // an odd entry
                }
            }
            if (pub != null && !pub.isEmpty()) return sig != null && verify(pub, signed(entry), sig);
            // A phone from before 0.9.0 (no key on record yet): its own entry, as before.
            return byDevice.equals(pk.substring("member:".length()));
        }
        return e.legacyHouseholdChangeAllowed(pk, byDevice, entry);
    }

    /** This phone's own signing key (0.9.0), made the first time it's needed. */
    synchronized String myPub() throws Exception {
        if (e.meta("my_priv") == null || e.meta("my_pub") == null) {
            KeyPair kp = newSigningKey();
            e.setMeta("my_priv", b64(kp.getPrivate().getEncoded()));
            e.setMeta("my_pub", b64(kp.getPublic().getEncoded()));
        }
        return e.meta("my_pub");
    }

    /**
     * 0.9.0, after each sync: this phone's entry carries its key, and (on the owner) the household
     * has an owner key, an id, and a recovery key whose sealed copy is up to date.
     */
    synchronized void ensureKeys() throws Exception {
        if (!paired()) return;
        String me = e.device();
        String mine = e.householdValue("member:" + me);
        if (mine != null) {
            JSONObject m;
            try {
                m = new JSONObject(mine);
            } catch (Exception ex) {
                m = new JSONObject();
            }
            if (m.optString("pub", "").isEmpty()) setRow("member:" + me, member(m.optString("name", e.name())));
        }
        if (!isOwner()) return;
        if (e.meta("owner_priv") == null || e.householdValue("owner_pub") == null) {
            String pub = e.meta("owner_pubkey");
            if (e.meta("owner_priv") == null || pub == null) {
                KeyPair kp = newSigningKey();
                e.setMeta("owner_priv", b64(kp.getPrivate().getEncoded()));
                e.setMeta("owner_pubkey", pub = b64(kp.getPublic().getEncoded()));
            }
            setRow("owner_pub", pub);
            if (e.meta("owner_pin") == null) e.setMeta("owner_pin", pub);
        }
        if (hid() == null) setRow("hid", b64(random(9)));
        ensureRecovery();
    }

    // ---------- 0.9.0: the recovery key ----------

    static final int RECOVERY_BYTES = 20;

    static byte[] recoveryKey(byte[] r) throws Exception {
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        d.update("restock-recovery".getBytes(StandardCharsets.UTF_8));
        return d.digest(r);
    }

    /** "ABCD-EFGH-…": 32 letters and numbers in eights of four. */
    static String formatRecovery(byte[] r) {
        String b = SyncWire.base32(r);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < b.length(); i += 4) out.append(i == 0 ? "" : "-").append(b, i, Math.min(b.length(), i + 4));
        return out.toString();
    }

    /** A typed or scanned recovery key, forgiving spaces, dashes, case and 0/O, 1/I, 8/B mix-ups. */
    static byte[] parseRecovery(String s) {
        String t = s == null ? "" : s.toUpperCase(java.util.Locale.ROOT).replace("RESTOCK-RECOVERY:", "").replaceAll("[^A-Z0-9]", "");
        t = t.replace('0', 'O').replace('1', 'I').replace('8', 'B');
        if (t.length() != 32) throw new IllegalArgumentException("That isn't a whole recovery key. It's 32 letters and numbers, like ABCD-EFGH-….");
        return SyncWire.unbase32(t);
    }

    /** The recovery key, for the owner to see and save (null on other phones). */
    String recovery() throws Exception {
        String r = e.meta("recovery");
        return r == null || !isOwner() ? null : formatRecovery(SyncWire.unbase32(r));
    }

    /** Whether the owner has said it saved the recovery key. */
    boolean recoverySaved() throws Exception {
        return "1".equals(e.meta("recovery_saved"));
    }

    void setRecoverySaved() throws Exception {
        e.setMeta("recovery_saved", "1");
    }

    /**
     * Owner: a recovery key exists, and the household's sealed copy opens with it (after two
     * phones took over at once, the copy that stuck may be the other one's: seal it again).
     */
    synchronized void ensureRecovery() throws Exception {
        if (!paired() || !isOwner()) return;
        if (e.meta("recovery") == null) {
            newRecovery();
            return;
        }
        String blob = e.householdValue("recovery");
        boolean opens = false;
        if (blob != null) {
            try {
                SyncWire.open(recoveryKey(SyncWire.unbase32(e.meta("recovery"))), unb64(blob));
                opens = true;
            } catch (Exception ex) {
                opens = false;
            }
        }
        if (!opens) saveRecovery();
    }

    /** Owner: a new recovery key (the old one stops working). */
    synchronized void newRecovery() throws Exception {
        if (!isOwner()) throw new IllegalStateException("Only the owner phone has the recovery key.");
        e.db.transaction(() -> {
            e.setMeta("recovery", SyncWire.base32(random(RECOVERY_BYTES)));
            e.setMeta("recovery_saved", null);
            saveRecovery();
        });
    }

    /** Owner: refreshes the sealed copy of what a phone needs to take over (phones joined or left). */
    void saveRecovery() throws Exception {
        String r = e.meta("recovery");
        if (r == null || !isOwner()) return;
        JSONObject s = secrets();
        s.put(e.device(), e.meta("secret"));
        JSONObject give = new JSONObject();
        give.put("secrets", s);
        if (e.meta("owner_priv") != null) {
            give.put("owner_priv", e.meta("owner_priv"));
            give.put("owner_pubkey", e.meta("owner_pubkey"));
        }
        // The household's key as it is now, so a phone taking over that missed a key change still has it.
        give.put("key", e.meta("key"));
        give.put("keyv", String.valueOf(keyv()));
        if (e.meta("oldkey") != null) {
            give.put("oldkey", e.meta("oldkey"));
            give.put("oldkey_until", e.meta("oldkey_until"));
        }
        setRow("recovery", b64(SyncWire.seal(recoveryKey(SyncWire.unbase32(r)), give)));
    }

    /**
     * Takes over as owner with the recovery key (the owner phone was lost). Throws a message for the
     * person if the key is wrong. Afterwards this phone has a new recovery key to save.
     */
    synchronized void takeOver(String code) throws Exception {
        if (!paired()) throw new IllegalStateException("This phone isn't in a household.");
        if (isOwner()) throw new IllegalStateException("This phone is already the owner.");
        byte[] r = parseRecovery(code);
        String blob = e.householdValue("recovery");
        if (blob == null)
            throw new IllegalStateException("This household doesn't have a recovery key yet. The owner phone makes one when it opens Restock 0.9.0 or newer and syncs.");
        JSONObject give;
        try {
            give = SyncWire.open(recoveryKey(r), unb64(blob));
        } catch (Exception ex) {
            throw new IllegalArgumentException("That recovery key isn't this household's. Check it and try again.");
        }
        if (!give.has("owner_priv")) throw new IllegalStateException("This household's recovery copy is from an older Restock. Open Restock 0.9.0 on the owner phone first.");
        String me = e.device();
        JSONObject secrets = give.getJSONObject("secrets");
        secrets.remove(me);
        e.db.transaction(() -> {
            e.setMeta("owner_secrets", secrets.toString());
            e.setMeta("owner_priv", give.getString("owner_priv"));
            e.setMeta("owner_pubkey", give.optString("owner_pubkey", null));
            if (give.has("oldkey")) {
                e.setMeta("oldkey", give.getString("oldkey"));
                e.setMeta("oldkey_until", give.optString("oldkey_until"));
            }
            // A newer household key than this phone has (the owner removed a phone before it was lost).
            if (give.has("key") && Integer.parseInt(give.optString("keyv", "1")) > keyv()) {
                SyncWire.decodeKey(give.getString("key"));
                e.setMeta("key", give.getString("key"));
                e.setMeta("keyv", give.optString("keyv", "1"));
            }
            e.setMeta("recovery", SyncWire.base32(r));
            setRow("owner", me);
            for (JSONObject x : e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%'")) deleteRow(x.getString("k"));
            closeInvite();
        });
        // The lost phone knew the old recovery key: make a new one for the person to save.
        newRecovery();
    }

    // ---------- starting, inviting, joining ----------

    /** Starts a household with this phone as its owner. */
    void create(String name, String myName) throws Exception {
        create(name, myName, null);
    }

    /** As above, sharing `tabs` (null: all three). */
    void create(String name, String myName, java.util.Set<String> tabs) throws Exception {
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
        java.util.Set<String> t = tabs == null || tabs.isEmpty() ? SyncEngine.parseTabs((String) null) : tabs;
        setRow("tabs", SyncEngine.joinTabs(t));
        e.setMeta("tabs", null);
        e.noteTabs();
        ensureKeys();
    }

    /** Owner: which tabs the household shares. */
    void setHouseholdTabs(java.util.Set<String> tabs) throws Exception {
        if (!isOwner()) throw new IllegalStateException("Only the owner phone can change what the household shares.");
        if (tabs.isEmpty()) throw new IllegalArgumentException("Pick at least one thing to share.");
        setRow("tabs", SyncEngine.joinTabs(tabs));
        e.noteTabs();
    }

    /** 0.9.1, owner: whether the household shares receipts (off by default). */
    void setHouseholdReceipts(boolean on) throws Exception {
        if (!isOwner()) throw new IllegalStateException("Only the owner phone can change what the household shares.");
        setRow("receipts", on ? "1" : "0");
        e.noteTabs();
    }

    /** This phone's entry: its name and (0.9.0) its signing key. */
    private String member(String name) throws Exception {
        JSONObject m = new JSONObject();
        m.put("name", name);
        m.put("pub", myPub());
        return m.toString();
    }

    private static String member(String name, String pub) throws Exception {
        JSONObject m = new JSONObject();
        m.put("name", name);
        if (pub != null && !pub.isEmpty()) m.put("pub", pub);
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

    /** Thrown with what the owner phone said (a full household, a used code), not a connection problem. */
    static final class OwnerSaid extends IllegalStateException {
        OwnerSaid(String m) {
            super(m);
        }
    }

    /**
     * 0.8.5: before joining, asks the owner what the household is: its name, the owner's name, what
     * it shares and the owner's settings. Doesn't use the code up.
     */
    JSONObject peek(SyncEngine.Transport t) throws Exception {
        JSONObject m = new JSONObject();
        m.put("op", "peek");
        m.put("device", e.device());
        JSONObject r = t.send(m);
        if (r.has("error")) throw new OwnerSaid(r.getString("error"));
        return r;
    }

    /**
     * Joins over a link sealed with the code's pairing key: proves it has the code, gets the
     * household key, and leaves this phone's secret (and, 0.9.0, its signing key) with the owner.
     * Answers what the owner sent (household name, owner, its settings when asked for).
     */
    JSONObject join(SyncEngine.Transport t, boolean wantSettings) throws Exception {
        String secret = b64(random(32));
        // 0.9.0: a fresh key exchange first.
        KeyPair eph = newExchangeKey();
        JSONObject m = new JSONObject();
        m.put("op", "join");
        m.put("device", e.device());
        m.put("name", e.name());
        m.put("pub", myPub());
        m.put("epk", b64(eph.getPublic().getEncoded()));
        m.put("settings", wantSettings);
        JSONObject r = t.send(m);
        if (r.has("epk") && r.has("sealed")) {
            byte[] k = joinKey(eph, r.getString("epk"), pairingKeyUsed);
            JSONObject got = SyncWire.open(k, unb64(r.getString("sealed")));
            JSONObject done = new JSONObject();
            done.put("op", "join2");
            done.put("device", e.device());
            done.put("sealed", b64(SyncWire.seal(k, new JSONObject().put("secret", secret))));
            JSONObject ok = t.send(done);
            if (ok.has("error")) throw new OwnerSaid(ok.getString("error"));
            for (String key : keysOf(got)) r.put(key, got.get(key));
            r.remove("sealed");
            r.remove("epk");
        } else {
            // An owner on 0.8.x: the join as it was (the secret goes in the message).
            if (r.has("error") && !String.valueOf(r.optString("error")).toLowerCase(java.util.Locale.ROOT).contains("secret")) throw new OwnerSaid(r.getString("error"));
            m.remove("epk");
            m.put("secret", secret);
            r = t.send(m);
        }
        if (r.has("error")) throw new OwnerSaid(r.getString("error"));
        SyncWire.decodeKey(r.getString("key"));
        e.setMeta("key", r.getString("key"));
        e.setMeta("keyv", String.valueOf(r.optInt("keyv", 1)));
        e.setMeta("secret", secret);
        e.setMeta("owner_secrets", null);
        // 0.9.0: the household's owner key, straight from the owner.
        String pub = r.optString("owner_pub", null);
        e.setMeta("owner_pin", pub == null || pub.isEmpty() ? null : pub);
        return r;
    }

    /** The pairing key of the code this phone is joining with (set by SyncHub before join()). */
    byte[] pairingKeyUsed = new byte[32];

    /** 0.9.0: a phone that missed key changes asks the owner, with a message sealed with its own secret. */
    boolean askForKey(SyncEngine.Transport t) throws Exception {
        JSONObject m = new JSONObject();
        m.put("op", "rekey");
        m.put("device", e.device());
        JSONObject r = t.send(m);
        if (r.optBoolean("removed", false)) throw new RemovedException();
        String k = r.optString("key", null);
        int v = r.optInt("keyv", 0);
        if (k == null || v <= keyv()) return false;
        SyncWire.decodeKey(k);
        e.setMeta("key", k);
        e.setMeta("keyv", String.valueOf(v));
        return true;
    }

    /** The owner said this phone was removed. */
    static final class RemovedException extends Exception {}

    // ---------- answering other phones ----------

    /** Answers a message, depending on which key opened it. */
    JSONObject handle(JSONObject req, String host, int which) throws Exception {
        String device = req.optString("device");
        JSONObject res = new JSONObject();
        if (which == PAIRING) {
            String op = req.optString("op");
            if ("join2".equals(op)) return finishJoin(req, host);
            if (!"join".equals(op) && !"peek".equals(op)) return res.put("error", "Use the code to join first.");
            if (openPairingKey() == null || !isOwner()) return res.put("error", "That code has run out. Make a new one on the owner phone.");
            if (members().size() >= MAX_PHONES) return res.put("error", FULL);
            // 0.9.0: a phone can't join as one that's already in the household (or as the owner).
            if (device.isEmpty() || device.equals(e.device()) || e.householdValue("member:" + device) != null)
                return res.put("error", "That phone is already in this household.");
            if ("peek".equals(op)) {
                res.put("v", SyncEngine.VERSION);
                res.put("household", e.householdValue("name"));
                res.put("ownerName", e.name());
                res.put("tabs", SyncEngine.tabsJson(e.householdTabs()));
                if (settings != null) {
                    String st = settings.settings();
                    if (st != null) res.put("settings", st);
                }
                return res;
            }
            if (req.has("epk") && !req.has("secret")) {
                // 0.9.0: the key exchange. The household's key goes sealed with the key worked out
                // for this join; the phone's secret comes back the same way (join2).
                KeyPair eph = newExchangeKey();
                byte[] k = joinKey(eph, req.getString("epk"), openPairingKey());
                synchronized (pendingJoins) {
                    pendingJoins.put(device, new Object[] { k, System.currentTimeMillis(), req.optString("name", "Phone"), req.optString("pub", null) });
                }
                JSONObject give = new JSONObject();
                give.put("key", e.meta("key"));
                give.put("keyv", keyv());
                give.put("household", e.householdValue("name"));
                give.put("owner", e.device());
                give.put("ownerName", e.name());
                String pub = e.householdValue("owner_pub");
                if (pub != null) give.put("owner_pub", pub);
                if (req.optBoolean("settings", false) && settings != null) {
                    String st = settings.settings();
                    if (st != null) give.put("settings", st);
                }
                res.put("epk", b64(eph.getPublic().getEncoded()));
                res.put("sealed", b64(SyncWire.seal(k, give)));
                return res;
            }
            closeInvite(); // one use only
            String name = req.optString("name", "Phone");
            JSONObject s = secrets();
            s.put(device, req.getString("secret"));
            e.setMeta("owner_secrets", s.toString());
            deleteRow("removed:" + device);
            setRow("member:" + device, member(name, req.optString("pub", null)));
            e.notePeer(device, name, host, 0);
            saveRecovery();
            res.put("key", e.meta("key"));
            res.put("keyv", keyv());
            res.put("household", e.householdValue("name"));
            res.put("owner", e.device());
            res.put("ownerName", e.name());
            String pub = e.householdValue("owner_pub");
            if (pub != null) res.put("owner_pub", pub);
            if (req.optBoolean("settings", false) && settings != null) {
                String st = settings.settings();
                if (st != null) res.put("settings", st);
            }
            return res;
        }
        if (which >= MEMBER) {
            // 0.9.0: a phone that missed key changes, using its own secret.
            List<String> order = memberOrder;
            String d = which - MEMBER < order.size() ? order.get(which - MEMBER) : device;
            res.put("device", e.device());
            if (!"rekey".equals(req.optString("op"))) return res.put("error", "Ask for the key first.");
            if (e.householdValue("removed:" + d) != null || e.householdValue("member:" + d) == null) return res.put("removed", true);
            res.put("key", e.meta("key"));
            res.put("keyv", keyv());
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
            k.put("keyv", String.valueOf(keyv()));
            k.put("for", device);
            res.put("rekey", b64(SyncWire.seal(unb64(secret), k)));
            return res;
        }
        // Only the owner says a phone was removed: another phone may not have heard it was let back in.
        if (isOwner() && e.householdValue("removed:" + device) != null) {
            res.put("device", e.device());
            return res.put("removed", true);
        }
        return e.handle(req, host);
    }

    /** 0.9.0, owner: the second half of a join: the phone's secret, sealed with the join's key. */
    private JSONObject finishJoin(JSONObject req, String host) throws Exception {
        String device = req.optString("device");
        JSONObject res = new JSONObject();
        Object[] p;
        synchronized (pendingJoins) {
            p = pendingJoins.remove(device);
        }
        if (p == null || System.currentTimeMillis() - (Long) p[1] > 2 * 60 * 1000L || !isOwner()) return res.put("error", "That join took too long. Make a new code and try again.");
        if (e.householdValue("member:" + device) != null) return res.put("error", "That phone is already in this household.");
        if (members().size() >= MAX_PHONES) return res.put("error", FULL);
        JSONObject got = SyncWire.open((byte[]) p[0], unb64(req.getString("sealed")));
        closeInvite(); // one use only
        String name = (String) p[2];
        JSONObject s = secrets();
        s.put(device, got.getString("secret"));
        e.setMeta("owner_secrets", s.toString());
        deleteRow("removed:" + device);
        setRow("member:" + device, member(name, (String) p[3]));
        e.notePeer(device, name, host, 0);
        saveRecovery();
        return res.put("ok", true);
    }

    /**
     * The household's key changed: open the new one with this phone's secret and use it. 0.9.0:
     * only a newer key than this phone has (an old one played back can't set it back).
     */
    boolean takeRekey(String sealed) throws Exception {
        JSONObject k = SyncWire.open(unb64(e.meta("secret")), unb64(sealed));
        String forWho = k.optString("for", null);
        if (forWho != null && !forWho.equals(e.device())) return false;
        int v = Integer.parseInt(k.optString("keyv", "1"));
        if (v <= keyv()) return false;
        SyncWire.decodeKey(k.getString("key"));
        e.setMeta("key", k.getString("key"));
        e.setMeta("keyv", String.valueOf(v));
        return true;
    }

    /** Owner: the household's key sealed for one phone (the folder's keys file). */
    String sealKeyFor(String device, String secret) throws Exception {
        JSONObject k = new JSONObject();
        k.put("key", e.meta("key"));
        k.put("keyv", String.valueOf(keyv()));
        k.put("for", device);
        return b64(SyncWire.seal(unb64(secret), k));
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
            e.setMeta("keyv", String.valueOf(keyv() + 1));
            JSONObject s = secrets();
            s.remove(device);
            e.setMeta("owner_secrets", s.toString());
            deleteRow("member:" + device);
            setRow("removed:" + device, String.valueOf(System.currentTimeMillis()));
            e.db.exec("DELETE FROM sync_peers WHERE device = ?", device);
            saveRecovery();
        });
    }

    /**
     * Owner: asks another phone to be the owner (0.8.5: this phone stays the owner until that one
     * takes over at its next sync, so nothing is stuck if it never does; cancelHandOver() undoes it).
     * The phones' secrets (and 0.9.0: the owner key and the recovery key) go to it sealed with its
     * own secret, inside the household record.
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
        if (e.meta("owner_priv") != null) {
            give.put("owner_priv", e.meta("owner_priv"));
            give.put("owner_pubkey", e.meta("owner_pubkey"));
        }
        if (e.meta("recovery") != null) {
            give.put("recovery", e.meta("recovery"));
            give.put("recovery_saved", recoverySaved());
        }
        String blob = b64(SyncWire.seal(unb64(theirs), give));
        e.db.transaction(() -> {
            for (JSONObject r : e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%'")) deleteRow(r.getString("k"));
            setRow("handover:" + device, blob);
            closeInvite();
        });
    }

    /** The phone the owner asked to take over, while it hasn't yet. */
    String handingOverTo() throws Exception {
        for (JSONObject r : e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%'")) return r.getString("k").substring("handover:".length());
        return null;
    }

    /** Owner: never mind, stay the owner. */
    void cancelHandOver() throws Exception {
        if (!isOwner()) throw new IllegalStateException("Only the owner phone can do that.");
        for (JSONObject r : e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%'")) deleteRow(r.getString("k"));
    }

    /**
     * After a sync: if the owner asked this phone to take over, take the phones' secrets and
     * become the owner. And a phone that was the owner lets go of the secrets once another took over.
     */
    synchronized boolean takeHandover() throws Exception {
        String me = e.device();
        String blob = e.householdValue("handover:" + me);
        // 0.9.0: only a request from the owner as it is now (not one left over from before a takeover).
        if (blob != null && !me.equals(owner())) {
            List<JSONObject> by = e.db.query("SELECT device FROM sync_log WHERE tbl = 'household' AND pk = ?", "handover:" + me);
            if (!by.isEmpty() && !by.get(0).optString("device", "").equals(owner())) {
                // Left over from before a takeover: drop it here, quietly (it isn't this phone's to change for the others).
                e.db.transaction(() -> {
                    e.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
                    deleteRow("handover:" + me);
                    e.db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
                });
                blob = null;
            }
        }
        if (blob == null || me.equals(owner())) {
            if (!me.equals(owner()) && e.meta("owner_secrets") != null && owner() != null) {
                // Another phone took over from this one.
                for (String k : new String[] { "owner_secrets", "oldkey", "oldkey_until", "recovery", "recovery_saved", "owner_priv", "owner_pubkey" }) e.setMeta(k, null);
                closeInvite();
                return true;
            }
            return false;
        }
        JSONObject give = SyncWire.open(unb64(e.meta("secret")), unb64(blob));
        e.db.transaction(() -> {
            e.setMeta("owner_secrets", give.getJSONObject("secrets").toString());
            if (give.has("oldkey")) {
                e.setMeta("oldkey", give.getString("oldkey"));
                e.setMeta("oldkey_until", give.optString("oldkey_until"));
            }
            if (give.has("owner_priv")) {
                e.setMeta("owner_priv", give.getString("owner_priv"));
                e.setMeta("owner_pubkey", give.optString("owner_pubkey", null));
            }
            if (give.has("recovery")) {
                e.setMeta("recovery", give.getString("recovery"));
                e.setMeta("recovery_saved", give.optBoolean("recovery_saved") ? "1" : null);
            }
            setRow("owner", me);
            deleteRow("handover:" + me);
        });
        ensureKeys();
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
        // 0.9.4: in a house the server names each phone (its label, renamed on the server's page).
        if (paired() && !isHouse() && e.householdValue("member:" + e.device()) != null) setRow("member:" + e.device(), member(name));
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

    /**
     * Forgets the household on this phone (keys, secrets, phones, and the household record, so a
     * new household starts clean), keeping everything else. 0.9.0: this phone's change numbers
     * never go back down (the household's notes held the highest), or a phone rejoining with
     * "Combine" would reuse numbers the others think they already have.
     */
    void forget() throws Exception {
        // 0.9.3: also the household's settings (household_settings); this phone's settings stay as they are.
        for (String k : new String[] { "key", "keyv", "oldkey", "oldkey_until", "secret", "owner_secrets", "pair_token", "pair_until", "invite", "household", "tabs", "tabs_eff",
            "recovery", "recovery_saved", "owner_priv", "owner_pubkey", "owner_pin", "folder", "folder_top", "folder_keys", "folder_at", "folder_unread", "clock_warn", "rehousehold",
            // 0.9.1: the WebDAV or Nextcloud sign-in (only ever on this phone), receipts and tidying.
            "dav_user", "dav_pass", "dav_kind", "receipts_eff", "compact_at",
            // 0.9.2: the Restock server connection (this phone's key for it, its addresses and notes).
            // What the phone moved there (photo_off:…) and the keys that open it (server_filekeys)
            // stay, so the photos can still come back if it connects again.
            "server_dev_priv", "server_home", "server_away", "server_top", "server_keys", "server_at", "server_unread", "server_files", "server_webs",
            "server_webkeys", "server_off_at", "server_off_prices", "server_off_waiting",
            // 0.9.4: a v3 server (its kex key, this phone's for it, the label, what this phone shares with it).
            "server_api", "server_kex", "server_kex_priv", "server_label", "server_sid", "server_keysfile", "share_receipts", "server_takeback",
            "seed_settings", "wifi_sync", "server_handover", "server_mode", "server_member_label" })
            e.setMeta(k, null);
        e.db.transaction(() -> {
            e.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
            List<JSONObject> top = e.db.query("SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log");
            e.db.exec("DELETE FROM household");
            e.db.exec("DELETE FROM sync_log WHERE tbl = 'household'");
            // 0.9.4 review: deletes held for tabs this phone didn't sync were that household's.
            if (e.hasOrigin()) e.db.exec("DELETE FROM sync_held");
            // 0.9.3: the household's settings go too; this phone keeps its settings as they are now.
            // Its "Always use this for …" and "Keep it as just …" rows stay (they're about its own
            // items and lines, and go with them if it makes or joins another household).
            if (SharedSettings.hasTable(e)) {
                e.db.exec("DELETE FROM " + SharedSettings.TABLE + " WHERE NOT " + SharedSettings.KEPT_ON_LEAVING);
                e.db.exec("DELETE FROM sync_log WHERE tbl = ? AND NOT (pk LIKE 'alias:%' OR pk LIKE 'keep:%')", SharedSettings.TABLE);
            }
            e.db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%' OR key LIKE 'folder_got:%' OR key LIKE 'server_seen:%' OR key LIKE 'server_ver:%' OR key LIKE 'server_webpub:%' OR key LIKE 'server_photorefs:%'"
                + " OR key LIKE 'server_keysver:%' OR key LIKE 'server_bad:%' OR key LIKE 'folder_bad:%' OR key LIKE 'catchup:%' OR key LIKE 'catchup_peer:%'");
            // A marker that keeps the highest number (not a record: sync skips it).
            e.db.exec("INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq) VALUES ('_seq', 'floor', 0, '', 1, ?)", top.get(0).optLong("top", 0));
            e.db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
        e.db.exec("DELETE FROM sync_peers");
    }

    /** Names in an object's keys, for tests and the Sync screen. */
    static List<String> keysOf(JSONObject o) {
        List<String> l = new ArrayList<>();
        for (Iterator<String> it = o.keys(); it.hasNext(); ) l.add(it.next());
        return l;
    }
}
