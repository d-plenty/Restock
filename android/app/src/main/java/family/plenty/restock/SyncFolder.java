package family.plenty.restock;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/**
 * Sync through a folder (0.9.0): for phones that aren't on the same Wi-Fi. The household picks a
 * folder each phone can reach (Nextcloud, Syncthing, Google Drive and the like), and:
 *
 * - Each phone writes one file of its own, restock-sync-DEVICE.bin: everything it knows (its own
 *   changes and the ones it took in), sealed with the household's key (AES-256-GCM, gzipped
 *   first). Only phones in the household can read it; the folder's owner sees a jumble.
 * - Each phone reads the others' files and takes in what's newer, by the same rules as Wi-Fi sync
 *   (the later change wins; deletes are remembered). One file per phone, so no two phones ever
 *   write the same file.
 * - Prices stay out (they sync on the Wi-Fi), so the files stay small.
 * - When the owner removes a phone, the household's key changes. The owner also writes
 *   restock-sync-keys-HOUSEHOLD.json: the new key sealed for each phone still in the household
 *   with that phone's own secret, so a phone away from home picks it up from the folder. A phone
 *   only ever takes a newer key than it has (an old keys file put back can't set it back), and
 *   each household has its own keys file, so two households sharing a folder don't clash.
 * - A file that hasn't changed since last time (same size and time) isn't read again.
 *
 * No Android classes here (the folder is an interface), so it's tested on a computer too.
 */
final class SyncFolder {
    static final String PREFIX = "restock-sync-";
    static final String SUFFIX = ".bin";
    static final String KEYS = "restock-sync-keys.json";
    private static final byte[] MAGIC = "RSF1".getBytes(StandardCharsets.US_ASCII);
    private static final SecureRandom RANDOM = new SecureRandom();

    /** A folder: its file names, and reading and writing a file by name. */
    interface Folder {
        List<String> names() throws Exception;

        /** The file's bytes, or null if it isn't there. */
        byte[] read(String name) throws Exception;

        /** Something that changes whenever the file does (its time and size), or null if unknown. */
        default String version(String name) throws Exception {
            return null;
        }

        void write(String name, byte[] data) throws Exception;
    }

    /** What a round did. */
    static final class Result {
        int received;
        int phones;
        /** Other phones' files that couldn't be opened (another household, or a key this phone doesn't have). */
        int unread;
        boolean wrote;
        boolean rekeyed;
    }

    final SyncEngine e;
    final SyncHousehold h;

    SyncFolder(SyncEngine e, SyncHousehold h) {
        this.e = e;
        this.h = h;
    }

    static String fileFor(String device) {
        return PREFIX + device + SUFFIX;
    }

    /** The household's keys file (0.9.0: one per household; the plain name for a household without an id yet). */
    String keysFile() throws Exception {
        String hid = h.hid();
        return hid == null ? KEYS : "restock-sync-keys-" + hid.replaceAll("[^A-Za-z0-9_-]", "") + ".json";
    }

    // ---------- sealing ----------

    static byte[] seal(byte[] key, JSONObject message) throws Exception {
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        try (GZIPOutputStream z = new GZIPOutputStream(raw)) {
            z.write(message.toString().getBytes(StandardCharsets.UTF_8));
        }
        byte[] nonce = new byte[12];
        RANDOM.nextBytes(nonce);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        c.updateAAD(MAGIC);
        byte[] body = c.doFinal(raw.toByteArray());
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(MAGIC);
        out.write(nonce);
        out.write(body);
        return out.toByteArray();
    }

    /** Opens a sealed file; throws if it isn't one, or wasn't sealed with this key. */
    static JSONObject open(byte[] key, byte[] data) throws Exception {
        if (data == null || data.length < MAGIC.length + 12 + 16) throw new SecurityException("not a sync file");
        for (int i = 0; i < MAGIC.length; i++) if (data[i] != MAGIC[i]) throw new SecurityException("not a sync file");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, data, MAGIC.length, 12));
        c.updateAAD(MAGIC);
        byte[] gz = c.doFinal(data, MAGIC.length + 12, data.length - MAGIC.length - 12);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (GZIPInputStream z = new GZIPInputStream(new ByteArrayInputStream(gz))) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = z.read(buf)) > 0) out.write(buf, 0, n);
        }
        return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
    }

    private static String hash(byte[] b) throws Exception {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(b));
    }

    private int keyv() throws Exception {
        String v = e.meta("keyv");
        return v == null ? 1 : Integer.parseInt(v);
    }

    // ---------- one round ----------

    /** Takes in the other phones' files, then writes this phone's (if anything changed). */
    Result sync(Folder f, String now) throws Exception {
        Result res = new Result();
        if (!h.paired()) return res;
        List<String> names = f.names();
        // A newer household key, left by the owner for this phone.
        String keys = keysFile();
        if (!h.isOwner()) {
            if (names.contains(keys)) res.rekeyed = takeKeys(f.read(keys));
            if (!res.rekeyed && !keys.equals(KEYS) && names.contains(KEYS)) res.rekeyed = takeKeys(f.read(KEYS));
        }
        byte[] key = h.key();
        String me = e.device();
        for (String name : names) {
            if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX) || name.equals(fileFor(me))) continue;
            // Not changed since last time: nothing to read.
            String ver = f.version(name);
            String verKey = "folder_ver:" + name;
            if (ver != null && ver.equals(e.meta(verKey))) continue;
            byte[] data = f.read(name);
            if (data == null) continue;
            String seenKey = "folder_seen:" + name;
            String sum = hash(data);
            if (sum.equals(e.meta(seenKey))) {
                if (ver != null) e.setMeta(verKey, ver);
                continue;
            }
            JSONObject m;
            try {
                m = open(key, data);
            } catch (Exception notOurs) {
                // Another household's, or sealed with a key this phone doesn't have (yet).
                res.unread++;
                continue;
            }
            if (ver != null) e.setMeta(verKey, ver);
            String device = m.optString("device", "");
            if (device.isEmpty() || device.equals(me) || e.householdValue("removed:" + device) != null) {
                e.setMeta(seenKey, sum);
                continue;
            }
            int n = e.apply(m.optJSONArray("entries"));
            if (n > 0) e.tidyCategories();
            e.notePeer(device, m.optString("name", null), null, 0);
            e.markSynced(device, now);
            e.setMeta(seenKey, sum);
            res.received += n;
            res.phones++;
        }
        // Made the owner by the phone before (handed over in the folder)? Take over.
        h.takeHandover();
        // This phone's own file, when something changed since it was last written.
        List<JSONObject> top = e.db.query("SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log");
        String mark = top.get(0).optLong("top", 0) + "/" + keyv() + "/" + String.join(",", e.tabs()) + "/" + e.shareCards();
        if (!mark.equals(e.meta("folder_top")) || !names.contains(fileFor(me))) {
            // Everything but prices; deletes older than half a year are left out to keep it small.
            JSONObject c = e.collect(0, null, 5_000_000, null, " AND tbl <> 'prices'", true, System.currentTimeMillis() - SyncEngine.OLD_DELETE_MS);
            JSONObject out = new JSONObject();
            out.put("format", "restock-sync");
            out.put("v", 1);
            out.put("device", me);
            out.put("name", e.name());
            out.put("keyv", keyv());
            out.put("at", now);
            out.put("entries", c.getJSONArray("entries"));
            f.write(fileFor(me), seal(h.key(), out));
            e.setMeta("folder_top", mark);
            res.wrote = true;
        }
        if (h.isOwner()) writeKeys(f, names);
        // "Synced through the folder" only when another phone's file was read.
        if (res.phones > 0) e.setMeta("folder_at", now);
        e.setMeta("folder_unread", res.unread > 0 ? String.valueOf(res.unread) : null);
        return res;
    }

    /** Owner: the household's key, sealed for each phone still in it (after a phone was removed). */
    private void writeKeys(Folder f, List<String> names) throws Exception {
        int v = keyv();
        String keys = keysFile();
        if (v <= 1 && !names.contains(keys)) return; // never changed: nothing to hand out
        String secrets = e.meta("owner_secrets");
        JSONObject s = secrets == null ? new JSONObject() : new JSONObject(secrets);
        StringBuilder who = new StringBuilder();
        for (String d : SyncHousehold.keysOf(s)) if (e.householdValue("member:" + d) != null) who.append(d).append(',');
        String mark = v + ":" + who;
        if (mark.equals(e.meta("folder_keys")) && names.contains(keys)) {
            // Still the file this phone wrote? (Someone could have put an old one back.)
            byte[] there = f.read(keys);
            try {
                if (there != null && new JSONObject(new String(there, StandardCharsets.UTF_8)).optInt("keyv", 0) == v) return;
            } catch (Exception ignored) {
                // not ours: write it again
            }
        }
        JSONObject phones = new JSONObject();
        for (String d : SyncHousehold.keysOf(s)) {
            if (e.householdValue("member:" + d) == null) continue;
            phones.put(d, h.sealKeyFor(d, s.getString(d)));
        }
        JSONObject out = new JSONObject();
        out.put("format", "restock-sync-keys");
        out.put("v", 1);
        out.put("keyv", v);
        out.put("phones", phones);
        f.write(keys, out.toString().getBytes(StandardCharsets.UTF_8));
        e.setMeta("folder_keys", mark);
    }

    /** A phone away from home: takes a newer household key from the owner's keys file. */
    private boolean takeKeys(byte[] data) {
        try {
            if (data == null) return false;
            JSONObject k = new JSONObject(new String(data, StandardCharsets.UTF_8));
            String sealed = k.getJSONObject("phones").optString(e.device(), null);
            if (sealed == null) return false;
            // takeRekey checks the sealed key number itself: only a newer key, made for this phone.
            return h.takeRekey(sealed);
        } catch (Exception ex) {
            return false;
        }
    }

}
