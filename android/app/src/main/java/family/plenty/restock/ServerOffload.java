package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.2: with a Restock server, the phone keeps only its "Keep price history for" on itself and
 * moves what's older to the server (docs/server-protocol.md, Offload):
 *
 * - Prices older than that (not an item's latest, not the sample items') go to
 *   archive/<device>/<yyyy-mm>.bin, sealed with the serverKey: { prices, receipts, photos }.
 * - Photos of receipts older than that go to photos/<sha256>.bin (sealed too), and the receipt's row
 *   goes in the month's archive with a photos entry. The receipt itself stays on the phone (it's
 *   small); it shows "Photo kept on your Restock server" and can fetch it back.
 * - The phone deletes its own copy only after a fresh listing from the server shows the file with
 *   the size this phone sent and the version the server gave when it was saved, and the file read
 *   back is the very bytes sent. Anything going wrong (the server out of reach, a file that doesn't
 *   match) and nothing is deleted: it's tried again next round. A month file is always read before
 *   it's written (even if the listing missed it), so its earlier prices are never written over.
 * - Photos are never fetched back over the Wi-Fi once they're on the server (SyncEngine.fetchPhotos),
 *   and a photo file another phone's server file lists (it uses the same copy) is never deleted.
 * - Only what the household already shares goes: prices of products on the tabs this phone syncs,
 *   and photos only when the household shares receipts. Older prices on tabs this phone doesn't
 *   share are tidied as they always were (deleted).
 * - A receipt deleted later: its photo file goes from the server and its line from the archive.
 *
 * Without a server none of this runs, and the screens tidy old prices as in 0.9.1 (db.ts pruneHistory).
 * No Android classes here, so it's tested on a computer too (tools/sync-test).
 */
final class ServerOffload {
    /** The server, as offloading needs it (ServerFolder; a fake in the tests). */
    interface Remote {
        List<String> names() throws Exception;

        long size(String name);

        String version(String name);

        byte[] read(String name) throws Exception;

        /** Saves a file; the server's { name, size, version }. */
        JSONObject put(String name, byte[] data) throws Exception;

        void delete(String name) throws Exception;
    }

    /** sync_meta: a photo that's on the server, not on the phone: "photo_off:<path>" = { sha256, size, month, id }. */
    static final String OFF = "photo_off:";
    static final int PHOTOS_PER_ROUND = 20;
    static final int PRICES_PER_ROUND = 20_000;
    static final int[] HISTORY_WEEKS = { 4, 8, 13, 26, 52 };
    /** Prices pruneHistory (db.ts) would delete: older than the cut-off, not the sample items', not an item's latest. */
    private static final String PRICE_OLD = "p.date < ? AND p.source <> 'demo' AND p.date < (SELECT MAX(q.date) FROM prices q WHERE q.product_id = p.product_id)";
    /** The same, for a DELETE (no table alias there on older Android SQLite). */
    private static final String PRICE_OLD_DEL = "date < ? AND source <> 'demo' AND date < (SELECT MAX(q.date) FROM prices q WHERE q.product_id = prices.product_id)";

    /** What a round did. */
    static final class Result {
        int prices;
        int photos;
        /** Saved on the server, but not confirmed yet (or the server gave no version): kept on the phone. */
        int waiting;
        /** Older prices on tabs this phone doesn't share, tidied (deleted) as before. */
        int pruned;
        int problems;
        boolean changed;
    }

    final SyncEngine e;
    final Remote r;
    /** Every serverKey this phone knows (to open older files), and the current one (to seal). */
    final List<byte[]> keys;
    final byte[] key;
    final int keyv;
    final long now;

    ServerOffload(SyncEngine e, Remote r, List<byte[]> keys, byte[] key, int keyv, long now) {
        this.e = e;
        this.r = r;
        this.keys = keys;
        this.key = key;
        this.keyv = keyv;
        this.now = now;
    }

    static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    /** The phone's "Keep price history for" (weeks), or 0 if it isn't one of the real choices. */
    static int historyWeeks(SyncEngine e) {
        try {
            List<JSONObject> rows = e.db.query("SELECT value FROM kv WHERE key = 'settings'");
            int w = rows.isEmpty() ? 8 : new JSONObject(rows.get(0).getString("value")).optInt("historyWeeks", 8);
            for (int ok : HISTORY_WEEKS) if (ok == w) return w;
            return 0;
        } catch (Exception ex) {
            return 0;
        }
    }

    static String archiveName(String device, String month) {
        return "archive/" + device + "/" + month + ".bin";
    }

    static String photoName(String sha) {
        return "photos/" + sha + ".bin";
    }

    /** Opens a server file with any key this phone knows; null if none fits. */
    JSONObject open(byte[] data) {
        if (data == null) return null;
        for (int i = keys.size() - 1; i >= 0; i--) {
            try {
                return SyncFolder.open(keys.get(i), data);
            } catch (Exception wrongKey) {
                // the next one
            }
        }
        return null;
    }

    static List<byte[]> keysOf(JSONArray stored) {
        List<byte[]> out = new ArrayList<>();
        if (stored != null) for (int i = 0; i < stored.length(); i++) {
            JSONObject k = stored.optJSONObject(i);
            if (k != null && k.has("key")) out.add(ServerLink.unb64(k.optString("key")));
        }
        return out;
    }

    // ---------- one round ----------

    /** After a sync round with the server (names() already worked): moves what's old enough. */
    Result run(int weeks) throws Exception {
        Result res = new Result();
        if (weeks <= 0) return res;
        String device = e.device();
        String cutoff = iso(now - weeks * 7L * 86_400_000L);
        Set<String> tabs = e.tabs();
        boolean receipts = e.shareReceipts();

        // Older prices on tabs this phone doesn't sync: tidied as before (they never go to the server).
        List<JSONObject> local = new ArrayList<>();
        List<JSONObject> prices = new ArrayList<>();
        for (JSONObject p : e.db.query("SELECT p.product_id, p.date, p.price, p.was_price, p.is_special, p.member_only, p.promo, p.source, pr.chain FROM prices p LEFT JOIN products pr ON pr.id = p.product_id WHERE "
            + PRICE_OLD + " ORDER BY p.date LIMIT ?", cutoff, (long) PRICES_PER_ROUND)) {
            String chain = p.isNull("chain") ? null : p.optString("chain", null);
            String tab = e.chainTab(chain);
            p.remove("chain");
            if (tab != null && tabs.contains(tab) && !p.optString("product_id").startsWith("demo-")) prices.add(p);
            else local.add(p);
        }
        if (!local.isEmpty()) {
            e.db.transaction(() -> {
                for (JSONObject p : local) e.db.exec("DELETE FROM prices WHERE product_id = ? AND date = ? AND " + PRICE_OLD_DEL, p.getString("product_id"), p.getString("date"), cutoff);
            });
            res.pruned = local.size();
        }

        // Photos of old receipts, when the household shares receipts.
        Map<String, JSONObject> rows = new HashMap<>();
        List<String[]> photos = new ArrayList<>(); // path, receipt id, month
        if (receipts && e.photos != null) {
            for (JSONObject row : e.db.query("SELECT * FROM receipts WHERE scanned_at < ? AND pinned = 0 AND id NOT LIKE 'demo-%' ORDER BY scanned_at", cutoff)) {
                String tab = e.tabOf("receipts", row);
                if (tab != null && !tabs.contains(tab)) continue;
                for (String path : SyncEngine.photoPaths(row)) {
                    if (photos.size() >= PHOTOS_PER_ROUND) break;
                    if (e.meta(OFF + path) != null || e.photos.size(path) < 0) continue;
                    photos.add(new String[] { path, row.getString("id"), month(row.optString("scanned_at")) });
                    rows.put(row.getString("id"), row);
                }
            }
        }

        // Photos the phone moved off whose receipt has gone since: off the server, and out of the archive.
        Map<String, JSONObject> stale = new LinkedHashMap<>();
        Map<String, JSONObject> kept = new HashMap<>();
        for (JSONObject m : e.db.query("SELECT key, value FROM sync_meta WHERE key LIKE 'photo_off:%'")) {
            String path = m.getString("key").substring(OFF.length());
            JSONObject v;
            try {
                v = new JSONObject(m.getString("value"));
            } catch (Exception bad) {
                continue;
            }
            if (e.db.query("SELECT 1 FROM receipts WHERE photo = ? OR pages LIKE ?", path, "%\"" + path + "\"%").isEmpty()) stale.put(path, v);
            else if (e.photos != null && e.photos.size(path) >= 0) {
                // The photo is on the phone again (a backup put back, or taken again): this phone
                // just has it now. The server's copy stays (another phone may use the same file); if
                // it's old enough it's moved again (and the archive's entry follows).
                e.setMeta(OFF + path, null);
                res.changed = true;
            } else kept.put(path, v);
        }

        // Month by month.
        Map<String, List<JSONObject>> byMonth = new TreeMap<>();
        for (JSONObject p : prices) byMonth.computeIfAbsent(month(p.optString("date")), k -> new ArrayList<>());
        for (JSONObject p : prices) byMonth.get(month(p.optString("date"))).add(p);
        Map<String, List<String[]>> photosByMonth = new TreeMap<>();
        for (String[] ph : photos) photosByMonth.computeIfAbsent(ph[2], k -> new ArrayList<>()).add(ph);
        Set<String> months = new java.util.TreeSet<>(byMonth.keySet());
        months.addAll(photosByMonth.keySet());
        for (JSONObject v : stale.values()) if (v.has("month")) months.add(v.getString("month"));
        if (months.isEmpty()) return res;

        List<String> names = r.names();
        // What was saved this round: name → [size, version]; and the sha256 of what was sent, to read back.
        Map<String, String[]> saved = new HashMap<>();
        Map<String, String> sent = new HashMap<>();
        Map<String, List<JSONObject>> monthPrices = new HashMap<>();
        Map<String, List<String[]>> monthPhotos = new HashMap<>();
        Map<String, String> shaOf = new HashMap<>();
        Set<String> rewritten = new HashSet<>();
        // Months whose archive (as the server has it now) no longer lists a stale photo.
        Set<String> clean = new HashSet<>();

        for (String month : months) {
            String name = archiveName(device, month);
            try {
                JSONObject arch;
                // Read even when the listing doesn't show it: a listing that missed a month file
                // mustn't make this phone write a new one over it (its earlier prices are only there).
                byte[] there = r.read(name);
                if (there != null) {
                    arch = open(there);
                    // A month file this phone can't open (a key it no longer has): left alone.
                    if (arch == null) {
                        res.problems++;
                        continue;
                    }
                } else if (names.contains(name)) {
                    // Listed, but not there a moment later: next round.
                    res.problems++;
                    continue;
                } else {
                    arch = new JSONObject();
                }
                boolean changed = false;
                // Prices: by product and date.
                JSONArray had = arch.optJSONArray("prices");
                Map<String, JSONObject> pmap = new LinkedHashMap<>();
                if (had != null) for (int i = 0; i < had.length(); i++) {
                    JSONObject p = had.getJSONObject(i);
                    pmap.put(p.optString("product_id") + "|" + p.optString("date"), p);
                }
                List<JSONObject> mine = byMonth.getOrDefault(month, new ArrayList<>());
                for (JSONObject p : mine) {
                    // The phone's copy is the one that counts (a price changed since it was last saved there).
                    String k = p.optString("product_id") + "|" + p.optString("date");
                    JSONObject was = pmap.get(k);
                    if (was == null || !sameRow(was, p)) {
                        pmap.put(k, p);
                        changed = true;
                    }
                }
                // Receipts and their photos.
                JSONArray hadR = arch.optJSONArray("receipts");
                Map<String, JSONObject> rmap = new LinkedHashMap<>();
                if (hadR != null) for (int i = 0; i < hadR.length(); i++) rmap.put(hadR.getJSONObject(i).optString("id"), hadR.getJSONObject(i));
                JSONObject pm = arch.optJSONObject("photos") != null ? arch.getJSONObject("photos") : new JSONObject();
                List<String[]> up = new ArrayList<>();
                for (String[] ph : photosByMonth.getOrDefault(month, new ArrayList<>())) {
                    String sha = uploadPhoto(ph[0], names, saved, sent);
                    if (sha == null) {
                        res.problems++;
                        continue;
                    }
                    shaOf.put(ph[0], sha);
                    up.add(ph);
                    pm.put(ph[0], sha);
                    rmap.put(ph[1], rows.get(ph[1]));
                    changed = true;
                }
                for (Map.Entry<String, JSONObject> s : stale.entrySet()) {
                    if (!month.equals(s.getValue().optString("month"))) continue;
                    if (pm.has(s.getKey())) {
                        pm.remove(s.getKey());
                        changed = true;
                    }
                    String id = s.getValue().optString("id");
                    if (rmap.containsKey(id) && e.db.query("SELECT 1 FROM receipts WHERE id = ?", id).isEmpty()) {
                        rmap.remove(id);
                        changed = true;
                    }
                }
                if (!changed) {
                    if (mine.isEmpty() && up.isEmpty()) {
                        clean.add(month);
                        continue;
                    }
                    // Already all in the server's file (saved last time, not confirmed then): that
                    // file, as listed now, is what a fresh listing must still show.
                    saved.put(name, new String[] { String.valueOf(r.size(name)), r.version(name) });
                    monthPrices.put(month, mine);
                    monthPhotos.put(month, up);
                    rewritten.add(month);
                    continue;
                }
                JSONObject out = new JSONObject();
                out.put("format", "restock-archive");
                out.put("v", 1);
                out.put("device", device);
                out.put("keyv", keyv);
                out.put("month", month);
                out.put("prices", new JSONArray(new ArrayList<>(pmap.values())));
                out.put("receipts", new JSONArray(new ArrayList<>(rmap.values())));
                out.put("photos", pm);
                byte[] sealed = SyncFolder.seal(key, out);
                putChecked(name, sealed, saved, sent);
                monthPrices.put(month, mine);
                monthPhotos.put(month, up);
                rewritten.add(month);
            } catch (Exception ex) {
                res.problems++;
            }
        }
        // A fresh look at the server: only what it shows as saved, the same size and version, goes from the phone.
        List<String> after = saved.isEmpty() ? names : r.names();
        // And what this phone sent this round is read back: the very bytes, before its own copy goes.
        Map<String, Boolean> readBack = new HashMap<>();
        java.util.function.Predicate<String> confirmed = n -> {
            String[] s = saved.get(n);
            if (s == null || s[1] == null || !after.contains(n)) return false;
            if (!String.valueOf(r.size(n)).equals(s[0]) || !s[1].equals(r.version(n))) return false;
            String want = sent.get(n);
            return want == null || readBack.computeIfAbsent(n, x -> readsBack(x, want));
        };
        for (String month : rewritten) {
            boolean archOk = confirmed.test(archiveName(device, month));
            List<JSONObject> mp = monthPrices.getOrDefault(month, new ArrayList<>());
            if (!archOk) {
                res.waiting += mp.size() + monthPhotos.getOrDefault(month, new ArrayList<>()).size();
                continue;
            }
            if (!mp.isEmpty()) {
                final int[] gone = { 0 };
                e.db.transaction(() -> {
                    for (JSONObject p : mp) {
                        // Only the price as it was sent (one changed on the phone meanwhile stays, for next round).
                        e.db.exec("DELETE FROM prices WHERE product_id = ? AND date = ? AND price = ? AND " + PRICE_OLD_DEL, p.getString("product_id"), p.getString("date"), p.get("price"), cutoff);
                        gone[0] += e.db.query("SELECT changes() AS n").get(0).optInt("n", 0);
                    }
                });
                res.prices += gone[0];
                if (gone[0] > 0) res.changed = true;
            }
            for (String[] ph : monthPhotos.getOrDefault(month, new ArrayList<>())) {
                String sha = shaOf.get(ph[0]);
                if (!confirmed.test(photoName(sha))) {
                    res.waiting++;
                    continue;
                }
                JSONObject v = new JSONObject();
                v.put("sha256", sha);
                v.put("size", e.photos.size(ph[0]));
                v.put("month", month);
                v.put("id", ph[1]);
                e.setMeta(OFF + ph[0], v.toString());
                e.photos.delete(ph[0]);
                res.photos++;
                res.changed = true;
            }
            clean.add(month);
        }
        // Photos whose receipt has gone, in months whose archive no longer lists them: their files go too.
        for (Map.Entry<String, JSONObject> s : stale.entrySet()) {
            if (!clean.contains(s.getValue().optString("month"))) continue;
            String sha = s.getValue().optString("sha256");
            // Another receipt here has the same photo: only the note goes.
            boolean mineToo = false;
            for (JSONObject k : kept.values()) if (sha.equals(k.optString("sha256"))) mineToo = true;
            // Another phone's file on the server lists it (it found this phone's copy and uses it): the
            // file stays, and so does this note (not in this phone's own file now), to try again later.
            if (!mineToo && !sha.isEmpty() && !e.db.query("SELECT 1 FROM sync_meta WHERE key LIKE 'server_photorefs:%' AND value LIKE ?", "%" + sha + "%").isEmpty()) continue;
            try {
                if (!mineToo && !sha.isEmpty()) r.delete(photoName(sha));
                e.setMeta(OFF + s.getKey(), null);
                res.changed = true;
            } catch (Exception ex) {
                res.problems++;
            }
        }
        return res;
    }

    /** A price's or receipt's month ("2026-08") from its date. */
    static String month(String date) {
        return date != null && date.length() >= 7 && date.substring(0, 7).matches("\\d{4}-\\d{2}") ? date.substring(0, 7) : "0000-00";
    }

    /**
     * Saves a photo on the server (or finds the same photo already there, from another phone).
     * Answers its sha256, or null if it couldn't.
     */
    private String uploadPhoto(String path, List<String> names, Map<String, String[]> saved, Map<String, String> sent) throws Exception {
        byte[] b = e.photos.read(path);
        if (b == null || b.length == 0) return null;
        String sha = ServerLink.hex(ServerLink.sha256(b));
        String name = photoName(sha);
        if (saved.containsKey(name)) return sha;
        if (names.contains(name)) {
            // Already there: use it if it really is this photo.
            JSONObject there = open(r.read(name));
            if (there != null && sha.equals(there.optString("sha256")) && sha.equals(shaOfData(there))) {
                saved.put(name, new String[] { String.valueOf(r.size(name)), r.version(name) });
                return sha;
            }
        }
        JSONObject m = new JSONObject();
        m.put("format", "restock-photo");
        m.put("v", 1);
        m.put("keyv", keyv);
        m.put("sha256", sha);
        m.put("type", "image/jpeg");
        m.put("data", java.util.Base64.getEncoder().encodeToString(b));
        byte[] sealed = SyncFolder.seal(key, m);
        putChecked(name, sealed, saved, sent);
        return sha;
    }

    /**
     * Saves a file and notes what a later listing must show: the size this phone sent (an answer
     * with another size, or with no version, can't be confirmed), and the version the server gave.
     */
    private void putChecked(String name, byte[] sealed, Map<String, String[]> saved, Map<String, String> sent) throws Exception {
        JSONObject ans = r.put(name, sealed);
        String version = ans.isNull("version") ? null : ans.optString("version", null);
        if (ans.optLong("size", -1) != sealed.length) version = null;
        saved.put(name, new String[] { String.valueOf(sealed.length), version });
        sent.put(name, ServerLink.hex(ServerLink.sha256(sealed)));
    }

    /** The server gives back exactly what was sent (checked by sha256). False if it doesn't, or can't be asked. */
    private boolean readsBack(String name, String sha) {
        try {
            byte[] b = r.read(name);
            return b != null && sha.equals(ServerLink.hex(ServerLink.sha256(b)));
        } catch (Exception ex) {
            return false;
        }
    }

    /** Two price rows with the same values (numbers compared as numbers: 5 and 5.0 are the same). */
    static boolean sameRow(JSONObject a, JSONObject b) {
        Set<String> keys = new HashSet<>();
        for (java.util.Iterator<String> i = a.keys(); i.hasNext(); ) keys.add(i.next());
        for (java.util.Iterator<String> i = b.keys(); i.hasNext(); ) keys.add(i.next());
        for (String k : keys) {
            Object x = a.isNull(k) ? null : a.opt(k), y = b.isNull(k) ? null : b.opt(k);
            if (x == null || y == null) {
                if (x != y) return false;
            } else if (x instanceof Number && y instanceof Number) {
                if (Double.compare(((Number) x).doubleValue(), ((Number) y).doubleValue()) != 0) return false;
            } else if (!String.valueOf(x).equals(String.valueOf(y))) return false;
        }
        return true;
    }

    private static String shaOfData(JSONObject photo) {
        try {
            return ServerLink.hex(ServerLink.sha256(java.util.Base64.getDecoder().decode(photo.getString("data"))));
        } catch (Exception e) {
            return "";
        }
    }

    // ---------- bringing photos back ----------

    /** A photo that's on the server, fetched and checked (it isn't saved on the phone). Null if it isn't there. */
    byte[] fetchPhoto(String path) throws Exception {
        String stored = e.meta(OFF + path);
        if (stored == null) return null;
        String sha = new JSONObject(stored).getString("sha256");
        byte[] there = r.read(photoName(sha));
        if (there == null) throw new SyncDav.Problem("That photo isn't on the server any more.");
        JSONObject m = open(there);
        if (m == null) throw new SyncDav.Problem("That photo is on the server, but this phone can't open it any more.");
        byte[] b = java.util.Base64.getDecoder().decode(m.getString("data"));
        if (!sha.equals(ServerLink.hex(ServerLink.sha256(b)))) throw new SyncDav.Problem("The server's copy of that photo doesn't match.");
        return b;
    }

    /**
     * Stop (or leaving the household): every photo this phone moved off comes back onto it. The server's
     * copies stay. Throws if one couldn't be brought back (the ones that did are back).
     */
    int bringBack() throws Exception {
        int n = 0;
        Exception last = null;
        for (JSONObject m : e.db.query("SELECT key FROM sync_meta WHERE key LIKE 'photo_off:%'")) {
            String path = m.getString("key").substring(OFF.length());
            try {
                if (e.db.query("SELECT 1 FROM receipts WHERE photo = ? OR pages LIKE ?", path, "%\"" + path + "\"%").isEmpty()) {
                    e.setMeta(OFF + path, null); // its receipt has gone
                    continue;
                }
                byte[] b = fetchPhoto(path);
                if (b != null) e.photos.write(path, b);
                e.setMeta(OFF + path, null);
                n++;
            } catch (Exception ex) {
                last = ex;
            }
        }
        if (last != null) throw last;
        return n;
    }

    /** The phone's offloaded photos for its own sync file: { path: sha256 } (not those whose receipt has gone). */
    static JSONObject photosMap(SyncEngine e) throws Exception {
        JSONObject out = new JSONObject();
        for (JSONObject m : e.db.query("SELECT key, value FROM sync_meta WHERE key LIKE 'photo_off:%'")) {
            try {
                String path = m.getString("key").substring(OFF.length());
                if (e.db.query("SELECT 1 FROM receipts WHERE photo = ? OR pages LIKE ?", path, "%\"" + path + "\"%").isEmpty()) continue;
                out.put(path, new JSONObject(m.getString("value")).getString("sha256"));
            } catch (Exception ignored) {
                // an odd value
            }
        }
        return out;
    }

    static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
