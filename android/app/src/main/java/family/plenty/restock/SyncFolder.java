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
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Sync through a folder (0.9.0): for phones that aren't on the same Wi-Fi. The household picks a
 * folder each phone can reach (0.9.1: on a Nextcloud or other WebDAV server, see SyncDav, or a
 * folder on the phone that Syncthing or a similar app keeps the same everywhere), and:
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
 * - 0.9.1: a folder is tried out before it's used (check(): a test file written, read back, listed
 *   and deleted), so one an app can't really hold is turned down straight away. Each file also says
 *   how far its phone has got through the others' changes ("seen"), so they can tidy old deletes.
 * - 0.9.2: a Restock server (ServerFolder) is a folder too, with its own notes in sync_meta
 *   ("server_…" rather than "folder_…") so a phone can use both. Its files are sealed with the
 *   serverKey (made from the household's key, so the web app can be given it without the household's
 *   key, which also opens Wi-Fi sync and picked folders), and carry prices changed in the last 60
 *   days and the photos the phone moved to the server (ServerOffload).
 * - 0.9.3: a phone's file on a Restock server also carries "summary": its own settings in a few
 *   words for the web app's Settings → Phones (PhoneSummary, from an allow-list). Not in a picked
 *   folder's or WebDAV's files. Household settings travel as entries like everything else.
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

        /** 0.9.1: removes a file (only the test file check() writes). */
        default void delete(String name) throws Exception {
            throw new UnsupportedOperationException("can't delete");
        }
    }

    /** Thrown by check() with words for the person. */
    static final class Unusable extends Exception {
        Unusable(String why, Throwable cause) {
            super(why, cause);
        }
    }

    /**
     * 0.9.1: tries a folder out before it's used: writes a small test file, reads it back, finds it
     * in the folder's list and deletes it. Any step failing throws Unusable with `why`.
     */
    static void check(Folder f, String why) throws Unusable {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        String name = PREFIX + "test-" + Base64.getUrlEncoder().withoutPadding().encodeToString(b).substring(0, 12) + ".tmp";
        byte[] data = ("Restock checking it can use this folder. " + Base64.getEncoder().encodeToString(b)).getBytes(StandardCharsets.UTF_8);
        String step = "write";
        try {
            f.write(name, data);
            step = "read";
            byte[] back = f.read(name);
            if (back == null || !java.util.Arrays.equals(back, data)) throw new java.io.IOException("the test file came back different");
            step = "list";
            if (!f.names().contains(name)) throw new java.io.IOException("the test file isn't in the folder's list");
            step = "delete";
            f.delete(name);
        } catch (Unusable u) {
            throw u;
        } catch (Exception ex) {
            if (!"write".equals(step)) {
                try {
                    f.delete(name);
                } catch (Exception ignored) {
                    // leave it
                }
            }
            throw new Unusable(why, ex);
        }
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
    /** 0.9.2: where this folder's notes are kept in sync_meta: "folder" (a picked folder or WebDAV) or "server". */
    final String p;
    /** 0.9.2: prices changed within this long go in too (0: none, as for a picked folder). */
    final long pricesMs;

    SyncFolder(SyncEngine e, SyncHousehold h) {
        this(e, h, "folder", 0);
    }

    SyncFolder(SyncEngine e, SyncHousehold h, String prefix, long pricesMs) {
        this.e = e;
        this.h = h;
        this.p = prefix;
        this.pricesMs = pricesMs;
    }

    boolean server() {
        return "server".equals(p);
    }

    /** 0.9.4: a v3 server (the household's owner): no keys file, and the file says what this phone shares. */
    boolean v3() {
        try {
            return server() && "3".equals(e.meta("server_api"));
        } catch (Exception ex) {
            return false;
        }
    }

    /** 0.9.2: the key this folder's files are sealed with: the serverKey on a Restock server, else the household's. */
    byte[] fileKey(byte[] householdKey) throws Exception {
        return server() ? serverKey(householdKey) : householdKey;
    }

    /** serverKey = HMAC-SHA256(householdKey, "restock-server-files-v1"). */
    static byte[] serverKey(byte[] householdKey) throws Exception {
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(householdKey, "HmacSHA256"));
        return mac.doFinal("restock-server-files-v1".getBytes(StandardCharsets.UTF_8));
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
        // 0.9.4: with a v3 server, new keys come in keys/<device>.bin (ServerSync), never a keys file.
        boolean v3 = v3();
        if (!h.isOwner() && !v3) {
            if (names.contains(keys)) res.rekeyed = takeKeys(f.read(keys));
            if (!res.rekeyed && !keys.equals(KEYS) && names.contains(KEYS)) res.rekeyed = takeKeys(f.read(KEYS));
        }
        byte[] key = fileKey(h.key());
        String me = e.device();
        e.noteTabs();
        readOthers(f, names, key, me, now, res);
        // 0.9.1: a file just read made the household share more (a tab, or receipts): read the
        // files again for what was passed over a moment ago.
        if (e.noteTabs()) readOthers(f, names, key, me, now, res);
        // Made the owner by the phone before (handed over in the folder)? Take over.
        h.takeHandover();
        writeOwn(f, names, me, now, res);
        if (h.isOwner() && !v3 && !h.isHouse()) writeKeys(f, names);
        // "Synced through the folder" only when another phone's file was read.
        if (res.phones > 0) e.setMeta(p + "_at", now);
        e.setMeta(p + "_unread", res.unread > 0 ? String.valueOf(res.unread) : null);
        return res;
    }

    /** Takes in the other phones' files that changed since last time. */
    private void readOthers(Folder f, List<String> names, byte[] key, String me, String now, Result res) throws Exception {
        res.unread = 0;
        for (String name : names) {
            if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX) || name.equals(fileFor(me))) continue;
            // Not changed since last time: nothing to read.
            String ver = f.version(name);
            String verKey = p + "_ver:" + name;
            if (ver != null && ver.equals(e.meta(verKey))) continue;
            byte[] data = f.read(name);
            if (data == null) continue;
            String seenKey = p + "_seen:" + name;
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
                // 0.9.3: which version couldn't be opened, so the quick look (ServerSync.anythingNew)
                // doesn't take it for news every time. It's still tried every round.
                if (ver != null) e.setMeta(p + "_bad:" + name, ver);
                continue;
            }
            if (ver != null) e.setMeta(verKey, ver);
            String device = m.optString("device", "");
            // 0.9.2: on a server each file is its writer's own (the server lets a phone or browser write only
            // its own name), so a file that names another device inside is passed over: a browser can't pose
            // as a phone (or as another browser) by what it puts in its file.
            if (server() && !name.equals(fileFor(device))) {
                e.setMeta(seenKey, sum);
                continue;
            }
            // 0.9.2: the web app's file names its public key; only a browser with the serverKey could write it, so
            // SyncHub trusts that key for webkeys/ after a rekey (docs/server-protocol.md, Changes).
            if (server() && device.startsWith("web-") && m.optString("webPub", "").length() > 0) e.setMeta("server_webpub:" + device.substring(4), m.optString("webPub"));
            if (device.isEmpty() || device.equals(me) || e.householdValue("removed:" + device) != null) {
                e.setMeta(seenKey, sum);
                continue;
            }
            // 0.9.2: the photos that phone moved to the server (another phone mustn't delete one it uses).
            if (server()) notePhotoRefs(device, m.optJSONObject("photos"));
            JSONArray entries = m.optJSONArray("entries");
            // 0.9.2: a browser's file never changes the household, loyalty cards or prices (it has none of its
            // own to give; docs/server-protocol.md): any such entry in it is left out.
            if (device.startsWith("web-")) entries = webEntries(entries);
            int n = e.apply(entries);
            if (n > 0) e.tidyCategories();
            e.notePeer(device, m.optString("name", null), null, 0);
            // 0.9.1: how far this phone has now got through that one's changes (for its own file),
            // and how far that one got through this phone's (for tidying old deletes).
            long theirTop = m.optLong("top", 0);
            if (theirTop > 0) {
                String gotKey = "folder_got:" + device;
                String had = e.meta(gotKey);
                if (had == null || Long.parseLong(had) < theirTop) e.setMeta(gotKey, String.valueOf(theirTop));
            }
            JSONObject seen = m.optJSONObject("seen");
            if (seen != null) e.setSeen(device, seen.optLong(me, 0));
            e.markSynced(device, now);
            e.setMeta(seenKey, sum);
            res.received += n;
            res.phones++;
        }
    }

    /** What a browser's file can change: everything but the household, loyalty cards and prices. */
    static final java.util.Set<String> WEB_LEAVES_OUT = new java.util.HashSet<>(java.util.Arrays.asList("household", "cards", "prices"));

    static JSONArray webEntries(JSONArray entries) {
        if (entries == null) return null;
        JSONArray out = new JSONArray();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject x = entries.optJSONObject(i);
            if (x != null && !WEB_LEAVES_OUT.contains(x.optString("tbl"))) out.put(x);
        }
        return out;
    }

    /** 0.9.2: notes the photo files (sha256) another device's server file says it uses, or forgets them. */
    private void notePhotoRefs(String device, JSONObject photos) throws Exception {
        StringBuilder b = new StringBuilder();
        if (photos != null) for (java.util.Iterator<String> i = photos.keys(); i.hasNext(); ) {
            String sha = photos.optString(i.next(), "");
            if (sha.matches("[0-9a-f]{64}")) b.append(b.length() == 0 ? "" : ",").append(sha);
        }
        e.setMeta("server_photorefs:" + device, b.length() == 0 ? null : b.toString());
    }

    /**
     * 0.9.4: what this phone shares with a v3 server (docs/server-protocol.md "v3"): { tabs, receipts,
     * cards }. Null elsewhere.
     */
    JSONObject shares() throws Exception {
        if (!v3()) return null;
        JSONObject o = new JSONObject();
        o.put("tabs", SyncEngine.tabsJson(e.tabs()));
        o.put("receipts", e.shareReceipts());
        o.put("cards", e.shareCards());
        return o;
    }

    /** 0.9.4: at most this many of a shop's specials go in the phone's server file. */
    static final int SPECIALS_PER_CHAIN = 120;

    /**
     * 0.9.4: the specials this phone already fetched (the Specials page keeps them in kv "specials"),
     * for the web app, on a server only: { at, lists: [{ chain, at, items: [{ storeProductId, name,
     * price, wasPrice, promo, imageUrl, isSpecial }] }] }. Nothing is fetched for it. Null if none.
     */
    JSONObject specials() {
        if (!server()) return null;
        try {
            List<JSONObject> r = e.db.query("SELECT value FROM kv WHERE key = 'specials'");
            if (r.isEmpty()) return null;
            JSONArray lists = new JSONArray(r.get(0).getString("value"));
            JSONArray outLists = new JSONArray();
            String newest = null;
            // Only shops on the tabs this phone shares: a Keg or Pharmacy tab it keeps to itself stays here.
            java.util.Set<String> tabs = e.tabs();
            for (int i = 0; i < lists.length() && i < 10; i++) {
                JSONObject l = lists.optJSONObject(i);
                if (l == null || !(l.opt("chain") instanceof String)) continue;
                String tab = e.chainTab(l.getString("chain"));
                if (tab == null || !tabs.contains(tab)) continue;
                JSONArray items = l.optJSONArray("items");
                JSONArray outItems = new JSONArray();
                if (items != null) for (int j = 0; j < items.length() && outItems.length() < SPECIALS_PER_CHAIN; j++) {
                    JSONObject x = items.optJSONObject(j);
                    if (x == null || !(x.opt("name") instanceof String)) continue;
                    JSONObject y = new JSONObject();
                    for (String k : new String[] { "storeProductId", "name", "promo", "imageUrl" }) {
                        Object v = x.opt(k);
                        if (v instanceof String && ((String) v).length() <= 500) y.put(k, v);
                    }
                    for (String k : new String[] { "price", "wasPrice" }) if (x.opt(k) instanceof Number) y.put(k, x.get(k));
                    y.put("isSpecial", x.optBoolean("isSpecial", true));
                    outItems.put(y);
                }
                JSONObject o = new JSONObject();
                o.put("chain", l.getString("chain"));
                String at = l.optString("at", "");
                o.put("at", at);
                o.put("items", outItems);
                outLists.put(o);
                if (newest == null || at.compareTo(newest) > 0) newest = at;
            }
            if (outLists.length() == 0) return null;
            JSONObject out = new JSONObject();
            out.put("at", newest == null ? "" : newest);
            out.put("lists", outLists);
            return out;
        } catch (Exception ex) {
            return null;
        }
    }

    /**
     * 0.9.4: the catalogue links this phone found for the shops it follows (kv "catalogue:<chain>",
     * Catalogues page), on a server only: { "<chain>": { url } }. The supermarkets' are known to the
     * web app already. Null if none.
     */
    JSONObject catalogues() {
        if (!server()) return null;
        try {
            JSONObject s = SharedSettings.settings(e);
            JSONArray chains = s == null ? null : s.optJSONArray("enabledChains");
            if (chains == null) return null;
            JSONObject out = new JSONObject();
            java.util.Set<String> tabs = e.tabs();
            for (int i = 0; i < chains.length() && i < 60; i++) {
                String c = chains.optString(i, "");
                if (!c.matches("[A-Za-z0-9_-]{1,60}")) continue;
                // Only shops on the tabs this phone shares (as specials()).
                String tab = e.chainTab(c);
                if (tab == null || !tabs.contains(tab)) continue;
                List<JSONObject> r = e.db.query("SELECT value FROM kv WHERE key = ?", "catalogue:" + c);
                if (r.isEmpty()) continue;
                JSONObject v = new JSONObject(r.get(0).getString("value"));
                String url = v.optString("url", "");
                if (!url.matches("(?i)https://\\S{1,500}")) continue;
                JSONObject o = new JSONObject();
                o.put("url", url);
                if (v.opt("note") instanceof String) o.put("note", v.getString("note"));
                out.put(c, o);
            }
            return out.length() == 0 ? null : out;
        } catch (Exception ex) {
            return null;
        }
    }

    /** 0.9.3: this phone's settings summary, on a server only (null elsewhere, or if it can't be made). */
    JSONObject summary() {
        if (!server()) return null;
        try {
            return PhoneSummary.of(e);
        } catch (Exception ex) {
            return null;
        }
    }

    /**
     * What this phone's own file was written from: its newest change, the key version, the tabs, cards
     * and receipts, and (0.9.3, on a server) its settings summary. A different mark: write it again.
     */
    String ownMark(JSONObject summary) throws Exception {
        List<JSONObject> top = e.db.query("SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log");
        String mark = top.get(0).optLong("top", 0) + "/" + keyv() + "/" + String.join(",", e.tabs()) + "/" + e.shareCards() + "/" + e.shareReceipts();
        // 0.9.4: what this phone takes back off a v3 server, and the specials it fetched.
        if (v3()) mark += "/v3" + e.takeBackKinds().toString();
        if (server()) {
            JSONObject sp = specials(), ca = catalogues();
            if (sp != null || ca != null) mark += "/" + hash((String.valueOf(sp) + String.valueOf(ca)).getBytes(StandardCharsets.UTF_8)).substring(0, 12);
        }
        return summary == null ? mark : mark + "/" + hash(summary.toString().getBytes(StandardCharsets.UTF_8)).substring(0, 12);
    }

    /** 0.9.3: whether this phone's own file is as it would write it now (so a quick look can skip a round). */
    boolean ownUpToDate(List<String> names) throws Exception {
        return names.contains(fileFor(e.device())) && ownMark(summary()).equals(e.meta(p + "_top"));
    }

    /** This phone's own file, when something changed since it was last written. */
    private void writeOwn(Folder f, List<String> names, String me, String now, Result res) throws Exception {
        List<JSONObject> top = e.db.query("SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log");
        JSONObject summary = summary();
        String mark = ownMark(summary);
        if (!mark.equals(e.meta(p + "_top")) || !names.contains(fileFor(me))) {
            // Everything but prices (0.9.2: a server takes recent prices too); deletes older than half
            // a year are left out to keep it small.
            long oldest = System.currentTimeMillis() - SyncEngine.OLD_DELETE_MS;
            String prices = pricesMs > 0 ? " AND (tbl <> 'prices' OR stamp > " + (System.currentTimeMillis() - pricesMs) + ")" : " AND tbl <> 'prices'";
            JSONObject c = e.collect(0, null, 5_000_000, null, prices, true, oldest);
            // 0.9.1: how far a phone reading this file gets through this phone's changes: all of
            // them, except it stops short of the first old delete left out above.
            long fileTop = top.get(0).optLong("top", 0);
            List<JSONObject> left = e.db.query("SELECT MIN(seq) AS s FROM sync_log WHERE deleted = 1 AND tbl <> '_seq' AND stamp < ?", oldest);
            if (!left.isEmpty() && !left.get(0).isNull("s")) fileTop = Math.min(fileTop, left.get(0).getLong("s") - 1);
            JSONObject seen = new JSONObject();
            for (JSONObject r : e.db.query("SELECT key, value FROM sync_meta WHERE key LIKE 'folder_got:%'")) {
                try {
                    seen.put(r.getString("key").substring("folder_got:".length()), Long.parseLong(r.getString("value")));
                } catch (NumberFormatException ignored) {
                    // an odd value
                }
            }
            JSONObject out = new JSONObject();
            out.put("top", fileTop);
            out.put("seen", seen);
            out.put("format", "restock-sync");
            out.put("v", 1);
            out.put("device", me);
            out.put("name", e.name());
            out.put("keyv", keyv());
            out.put("at", now);
            JSONArray entries = c.getJSONArray("entries");
            // 0.9.4: "Also take what this phone shared off the server": plain deletes for this phone's
            // own records of what it stopped sharing (instead of the "moved" ones collect gives).
            if (v3()) {
                List<JSONObject> back = e.takeBackEntries();
                if (!back.isEmpty()) {
                    java.util.Set<String> keys = new java.util.HashSet<>();
                    for (JSONObject x : back) keys.add(x.getString("tbl") + "|" + x.getString("pk"));
                    JSONArray kept = new JSONArray();
                    for (int i = 0; i < entries.length(); i++) {
                        JSONObject x = entries.getJSONObject(i);
                        if (!keys.contains(x.optString("tbl") + "|" + x.optString("pk"))) kept.put(x);
                    }
                    for (JSONObject x : back) kept.put(x);
                    entries = kept;
                }
            }
            out.put("entries", entries);
            // 0.9.4: on a v3 server, what this phone shares (the server takes only that from it).
            JSONObject shares = shares();
            if (shares != null) out.put("shares", shares);
            // 0.9.4: on a server, the specials and catalogue links this phone already fetched (for the web app).
            JSONObject sp = specials();
            if (sp != null) out.put("specials", sp);
            JSONObject ca = catalogues();
            if (ca != null) out.put("catalogues", ca);
            // 0.9.2: on a server, the receipt photos this phone moved there ({ path: sha256 }).
            if (server()) out.put("photos", ServerOffload.photosMap(e));
            // 0.9.3: on a server, this phone's own settings for the web app (PhoneSummary).
            if (summary != null) out.put("summary", summary);
            f.write(fileFor(me), seal(fileKey(h.key()), out));
            e.setMeta(p + "_top", mark);
            res.wrote = true;
        }
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
        if (mark.equals(e.meta(p + "_keys")) && names.contains(keys)) {
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
        e.setMeta(p + "_keys", mark);
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
