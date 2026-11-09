package family.plenty.restock;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.1 sync checks: receipts (on and off, deletes, photos over the Wi-Fi and their path checks),
 * WebDAV and Nextcloud sign-in against small stand-in servers, trying a folder out, tidying old
 * deletes, and secrets sealed (and a phone whose key store lost its key). Run by run.sh.
 */
public class SyncTest091 {
    static String dir;
    static int fails = 0;
    static final String NOW = "2026-11-09T00:00:00Z";

    static void check(boolean ok, String what) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + what);
        if (!ok) fails++;
    }

    static final class MapPhotos implements SyncEngine.Photos {
        final Map<String, byte[]> files = new TreeMap<>();

        public long size(String path) {
            byte[] b = files.get(path);
            return b == null ? -1 : b.length;
        }

        public byte[] read(String path) {
            return files.get(path);
        }

        public void write(String path, byte[] data) {
            if (!SyncEngine.isPhotoPath(path)) throw new SecurityException(path);
            files.put(path, data);
        }

        public void delete(String path) {
            files.remove(path);
        }
    }

    static final class Phone {
        final String id;
        final TestDb db;
        final SyncEngine e;
        final SyncHousehold h;
        final SyncFolder f;
        final MapPhotos photos = new MapPhotos();

        Phone(String id) throws Exception {
            this.id = id;
            db = new TestDb(dir);
            e = new SyncEngine(db);
            e.photos = photos;
            e.setMeta("device", id);
            e.setMeta("name", "Phone " + id);
            h = new SyncHousehold(e);
            f = new SyncFolder(e, h);
        }

        SyncEngine.Transport lan(Phone from) {
            return m -> {
                byte[] k = from.h.key();
                byte[] old = h.isOwner() ? h.oldKey() : null;
                int which = java.util.Arrays.equals(k, h.key()) ? SyncHousehold.CURRENT : old != null && java.util.Arrays.equals(k, old) ? SyncHousehold.OLD : -1;
                if (which < 0) throw new Exception("couldn't open it");
                return h.handle(m, "10.0.0." + id.charAt(0), which);
            };
        }

        SyncEngine.Transport pairing() {
            return m -> h.handle(m, "10.0.0." + id.charAt(0), SyncHousehold.PAIRING);
        }

        int count(String sql, Object... args) throws Exception {
            return db.query(sql, args).size();
        }

        String one(String sql, Object... args) throws Exception {
            List<JSONObject> r = db.query(sql, args);
            if (r.isEmpty()) return null;
            JSONObject o = r.get(0);
            String k = o.keys().next();
            return o.isNull(k) ? null : String.valueOf(o.get(k));
        }
    }

    static class MapFolder implements SyncFolder.Folder {
        final Map<String, byte[]> files = new TreeMap<>();

        public List<String> names() {
            return new ArrayList<>(files.keySet());
        }

        public byte[] read(String name) {
            return files.get(name);
        }

        public void write(String name, byte[] data) {
            files.put(name, data);
        }

        public void delete(String name) {
            files.remove(name);
        }
    }

    static SyncEngine.Result sync(Phone a, Phone b) throws Exception {
        SyncEngine.Result r = a.e.syncWith(b.lan(a), NOW, 0);
        if (r.rekey != null) {
            a.h.takeRekey(r.rekey);
            r = a.e.syncWith(b.lan(a), NOW, 0);
        }
        a.h.takeHandover();
        b.h.takeHandover();
        return r;
    }

    static void join(Phone owner, Phone p) throws Exception {
        owner.h.invite("10.0.0.1", 47461);
        p.h.pairingKeyUsed = owner.h.openPairingKey();
        p.h.join(owner.pairing(), false);
        sync(p, owner);
    }

    static Phone[] household(String... ids) throws Exception {
        Phone[] ps = new Phone[ids.length];
        for (int i = 0; i < ids.length; i++) ps[i] = new Phone(ids[i]);
        ps[0].h.create("House", "Owner");
        for (int i = 1; i < ids.length; i++) join(ps[0], ps[i]);
        for (int i = 1; i < ids.length; i++) sync(ps[i], ps[0]);
        return ps;
    }

    static byte[] jpeg(int size, int seed) {
        byte[] b = new byte[size];
        new java.util.Random(seed).nextBytes(b);
        b[0] = (byte) 0xff;
        b[1] = (byte) 0xd8;
        b[2] = (byte) 0xff;
        return b;
    }

    public static void main(String[] args) throws Exception {
        dir = args[0];
        receipts();
        photoPaths();
        webDav();
        nextcloud();
        folderCheck();
        compaction();
        secrets();
        System.out.println(fails == 0 ? "0.9.1: all passed" : "0.9.1: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    // ---------- receipts ----------

    static void receipts() throws Exception {
        System.out.println("receipts");
        Phone[] p = household("a1", "b2", "c3");
        Phone a = p[0], b = p[1], c = p[2];
        a.db.exec("INSERT INTO receipts (id, scanned_at, shop, section, total, photo, pages) VALUES ('r1', '2026-11-09', 'Coles Bohle Plains', 'pantry', 42.5, 'receipts/r1.jpg', '[\"receipts/r1-2.jpg\"]')");
        a.photos.files.put("receipts/r1.jpg", jpeg(5000, 1));
        a.photos.files.put("receipts/r1-2.jpg", jpeg(3000, 2));
        sync(b, a);
        check(b.count("SELECT 1 FROM receipts") == 0 && b.photos.files.isEmpty(), "off by default: a receipt stays on its phone");
        check(!a.e.shareReceipts(), "the household doesn't share receipts until the owner says so");
        try {
            b.h.setHouseholdReceipts(true);
            check(false, "only the owner can turn receipts on");
        } catch (IllegalStateException ex) {
            check(true, "only the owner can turn receipts on");
        }
        a.h.setHouseholdReceipts(true);
        SyncEngine.Result r = sync(b, a);
        check(b.e.shareReceipts() && b.count("SELECT 1 FROM receipts WHERE id = 'r1' AND total = 42.5") == 1, "turned on: the receipt comes across in the same sync");
        check(r.photos == 2 && java.util.Arrays.equals(b.photos.files.get("receipts/r1.jpg"), a.photos.files.get("receipts/r1.jpg"))
            && b.photos.files.containsKey("receipts/r1-2.jpg"), "its photos come across over the Wi-Fi: " + r.photos);
        // A member forging the setting is refused (it's signed by the owner).
        b.db.exec("INSERT OR REPLACE INTO household (k, v) VALUES ('receipts', '0')");
        sync(a, b);
        check(a.e.shareReceipts(), "a member can't turn receipts off for the household");
        b.db.exec("INSERT OR REPLACE INTO household (k, v) VALUES ('receipts', '1')");
        // Through the folder: the receipt, not its photos.
        MapFolder folder = new MapFolder();
        a.f.sync(folder, NOW);
        c.f.sync(folder, NOW);
        check(c.count("SELECT 1 FROM receipts WHERE id = 'r1'") == 1, "the receipt reaches a phone through the folder");
        check(c.photos.files.isEmpty(), "but not its photos (Wi-Fi only); it shows without them until then");
        // B edits the receipt's note after A deleted it, without knowing: the delete wins.
        a.db.exec("DELETE FROM receipts WHERE id = 'r1'");
        Thread.sleep(5);
        b.db.exec("INSERT OR REPLACE INTO receipts (id, scanned_at, shop, section, total, photo, pages, note) VALUES ('r1', '2026-11-09', 'Coles Bohle Plains', 'pantry', 42.5, 'receipts/r1.jpg', '[\"receipts/r1-2.jpg\"]', 'milk run')");
        sync(b, a);
        sync(a, b);
        check(a.count("SELECT 1 FROM receipts WHERE id = 'r1'") == 0 && b.count("SELECT 1 FROM receipts WHERE id = 'r1'") == 0, "a delete beats an edit made without knowing about it");
        check(b.photos.files.isEmpty(), "and the deleted receipt's photos go from the other phone too");
        a.f.sync(folder, NOW);
        c.f.sync(folder, NOW);
        check(c.count("SELECT 1 FROM receipts WHERE id = 'r1'") == 0, "the delete reaches the folder phone");
        // A phone that was still on 0.9.0 when receipts were turned on passed them over; once it
        // updates (it has no note of what it shared yet), it goes through everything once.
        Phone late = new Phone("d4");
        join(a, late);
        a.db.exec("INSERT INTO receipts (id, scanned_at, section) VALUES ('r5', '2026-11-09', 'pantry')");
        late.db.exec("UPDATE sync_peers SET got = (SELECT MAX(seq) FROM sync_log) * 10"); // as if it had passed them over
        late.db.exec("DELETE FROM sync_meta WHERE key = 'receipts_eff'");
        sync(late, a);
        check(late.count("SELECT 1 FROM receipts WHERE id = 'r5'") == 1, "a phone updated from 0.9.0 picks up the receipts it passed over");
        late.db.close();
        // Turned off again: new receipts stay put.
        a.h.setHouseholdReceipts(false);
        a.db.exec("INSERT INTO receipts (id, scanned_at, section) VALUES ('r4', '2026-11-09', 'pantry')");
        sync(b, a);
        check(!b.e.shareReceipts() && b.count("SELECT 1 FROM receipts WHERE id = 'r4'") == 0, "turned off: new receipts stay on their phone");
        for (Phone x : p) x.db.close();
    }

    static void photoPaths() throws Exception {
        System.out.println("receipt photos: which paths");
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        a.h.setHouseholdReceipts(true);
        a.db.exec("INSERT INTO receipts (id, scanned_at, section, photo) VALUES ('r1', 'x', 'pantry', 'receipts/r1.jpg')");
        a.db.exec("INSERT INTO receipts (id, scanned_at, section, photo) VALUES ('big', 'x', 'pantry', 'receipts/big.jpg')");
        a.db.exec("INSERT INTO receipts (id, scanned_at, section, photo) VALUES ('med', 'x', 'pharmacy', 'receipts/med.jpg')");
        a.db.exec("INSERT INTO receipts (id, scanned_at, section, photo) VALUES ('odd', 'x', 'pantry', '../databases/restock.db')");
        a.photos.files.put("receipts/r1.jpg", jpeg(2000, 3));
        a.photos.files.put("receipts/big.jpg", jpeg(SyncEngine.MAX_PHOTO + 1, 4));
        a.photos.files.put("receipts/med.jpg", jpeg(2000, 5));
        a.photos.files.put("receipts/loose.jpg", jpeg(2000, 6));
        SyncEngine.Transport t = a.lan(b);
        java.util.function.Function<String, JSONObject> ask = path -> {
            try {
                return t.send(new JSONObject().put("op", "photo").put("device", "b2").put("to", "a1").put("path", path).put("tabs", new JSONArray().put("pantry")));
            } catch (Exception ex) {
                return new JSONObject().put("error", ex.getMessage());
            }
        };
        check(ask.apply("receipts/r1.jpg").has("data"), "a shared receipt's photo is given");
        for (String bad : new String[] { "receipts/../kv.jpg", "../receipts/r1.jpg", "receipts/r1.png", "receipts/sub/r1.jpg", "/receipts/r1.jpg", "receipts/r1.jpg\u0000", "databases/restock.db",
            "../databases/restock.db", "receipts/" })
            check(ask.apply(bad).has("error"), "refused: " + bad.replace("\u0000", "\\0"));
        check(ask.apply("receipts/loose.jpg").has("error"), "refused: a photo no receipt has");
        check(ask.apply("receipts/med.jpg").has("error"), "refused: a receipt on a tab the asking phone doesn't share");
        check(ask.apply("receipts/big.jpg").optBoolean("tooBig"), "a photo over 8 MB isn't sent");
        a.h.setHouseholdReceipts(false);
        check(ask.apply("receipts/r1.jpg").has("error"), "refused once the household stops sharing receipts");
        a.h.setHouseholdReceipts(true);
        SyncEngine.Result r = sync(b, a);
        check(b.photos.files.containsKey("receipts/r1.jpg") && b.photos.files.containsKey("receipts/med.jpg") && !b.photos.files.containsKey("receipts/big.jpg")
            && b.photos.files.size() == 2, "the other phone fetches what it may have, and nothing else: " + b.photos.files.keySet() + " (" + r.photos + ")");
        // A receipt pointing its photo somewhere odd: the other phone never asks for (or saves) it.
        check(b.count("SELECT 1 FROM receipts WHERE id = 'odd'") == 1 && !b.photos.files.containsKey("../databases/restock.db"), "an odd photo path is never fetched");
        // A phone answering with something that isn't a JPEG for the path: not saved.
        b.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
        b.db.exec("INSERT INTO receipts (id, scanned_at, section, photo) VALUES ('fake', 'x', 'pantry', 'receipts/fake.jpg')");
        b.db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        SyncEngine.Transport liar = m -> new JSONObject().put("v", SyncEngine.VERSION).put("nonce", m.optString("nonce")).put("path", m.optString("path"))
            .put("data", java.util.Base64.getEncoder().encodeToString("<html>not a photo</html>".getBytes(StandardCharsets.UTF_8)));
        int got = b.e.fetchPhotos(liar, "a1", b.e.tabs());
        check(got == 0 && !b.photos.files.containsKey("receipts/fake.jpg"), "something that isn't a JPEG isn't saved as a photo");
        for (Phone x : p) x.db.close();
    }

    // ---------- WebDAV ----------

    /** A tiny WebDAV server: folders and files in memory, one user. */
    static final class FakeDav {
        final HttpServer server;
        final Map<String, byte[]> files = new TreeMap<>();
        final TreeSet<String> dirs = new TreeSet<>();
        final AtomicInteger requests = new AtomicInteger();
        String user = "declan", password = "s3cret pass";
        volatile String redirectTo;
        volatile boolean failReads;

        FakeDav() throws Exception {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            dirs.add("/");
            server.createContext("/", this::handle);
            server.start();
        }

        String url(String path) {
            return "http://127.0.0.1:" + server.getAddress().getPort() + path;
        }

        void stop() {
            server.stop(0);
        }

        private static byte[] body(InputStream in) throws java.io.IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return b.toByteArray();
        }

        private static String parent(String p) {
            String x = p.endsWith("/") ? p.substring(0, p.length() - 1) : p;
            return x.substring(0, x.lastIndexOf('/') + 1);
        }

        private void send(HttpExchange x, int code, byte[] b, boolean chunked) throws java.io.IOException {
            x.sendResponseHeaders(code, b == null ? -1 : chunked ? 0 : b.length);
            if (b != null) try (OutputStream o = x.getResponseBody()) {
                o.write(b);
            }
            x.close();
        }

        synchronized void handle(HttpExchange x) throws java.io.IOException {
            requests.incrementAndGet();
            String m = x.getRequestMethod();
            String path = x.getRequestURI().getPath(); // decoded
            byte[] in = body(x.getRequestBody());
            if (redirectTo != null) {
                x.getResponseHeaders().add("Location", redirectTo);
                send(x, 302, null, false);
                return;
            }
            String auth = x.getRequestHeaders().getFirst("Authorization");
            String want = "Basic " + java.util.Base64.getEncoder().encodeToString((user + ":" + password).getBytes(StandardCharsets.UTF_8));
            if (!want.equals(auth)) {
                send(x, 401, null, false);
                return;
            }
            String asDir = path.endsWith("/") ? path : path + "/";
            switch (m) {
                case "MKCOL":
                    if (dirs.contains(asDir) || files.containsKey(path)) send(x, 405, null, false);
                    else if (!dirs.contains(parent(asDir))) send(x, 409, null, false);
                    else {
                        dirs.add(asDir);
                        send(x, 201, null, false);
                    }
                    return;
                case "PROPFIND": {
                    if (!dirs.contains(asDir) && !files.containsKey(path)) {
                        send(x, 404, null, false);
                        return;
                    }
                    String depth = x.getRequestHeaders().getFirst("Depth");
                    StringBuilder b = new StringBuilder("<?xml version=\"1.0\"?>\n<D:multistatus xmlns:D=\"DAV:\" xmlns:oc=\"http://owncloud.org/ns\">");
                    if (files.containsKey(path)) entry(b, path, false);
                    else {
                        entry(b, asDir, true);
                        if ("1".equals(depth)) {
                            for (String d : dirs) if (!d.equals(asDir) && parent(d).equals(asDir)) entry(b, d, true);
                            for (String f : files.keySet()) if (parent(f).equals(asDir)) entry(b, f, false);
                        }
                    }
                    b.append("</D:multistatus>");
                    x.getResponseHeaders().add("Content-Type", "application/xml; charset=utf-8");
                    send(x, 207, b.toString().getBytes(StandardCharsets.UTF_8), true); // chunked, like many servers
                    return;
                }
                case "GET":
                    if (failReads || !files.containsKey(path)) send(x, 404, null, false);
                    else send(x, 200, files.get(path), false);
                    return;
                case "PUT":
                    if (!dirs.contains(parent(path))) {
                        send(x, 409, null, false);
                        return;
                    }
                    boolean had = files.containsKey(path);
                    files.put(path, in);
                    send(x, had ? 204 : 201, null, false);
                    return;
                case "DELETE":
                    send(x, files.remove(path) != null ? 204 : 404, null, false);
                    return;
                default:
                    send(x, 405, null, false);
            }
        }

        private void entry(StringBuilder b, String path, boolean dir) {
            StringBuilder href = new StringBuilder();
            for (String seg : path.split("/", -1)) href.append(href.length() == 0 && seg.isEmpty() ? "" : "/").append(SyncDav.encodeSegment(seg));
            String h = href.toString().replace("%40", "@"); // servers differ in what they encode
            if (dir && !h.endsWith("/")) h += "/";
            b.append("<D:response><D:href>").append(h.replace("&", "&amp;")).append("</D:href><D:propstat><D:prop>");
            if (dir) b.append("<D:resourcetype><D:collection/></D:resourcetype>");
            else {
                byte[] f = files.get(path);
                b.append("<D:resourcetype/><D:getcontentlength>").append(f.length).append("</D:getcontentlength>")
                    .append("<D:getetag>&quot;").append(java.util.Arrays.hashCode(f)).append("&quot;</D:getetag>")
                    .append("<D:getlastmodified>Mon, 09 Nov 2026 00:00:00 GMT</D:getlastmodified>");
            }
            b.append("</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>");
        }
    }

    static String problem(ThrowingRunnable r) {
        try {
            r.run();
            return null;
        } catch (Exception ex) {
            return ex.getMessage() == null ? ex.toString() : ex.getMessage();
        }
    }

    interface ThrowingRunnable {
        void run() throws Exception;
    }

    static void webDav() throws Exception {
        System.out.println("WebDAV");
        // Which addresses: https anywhere; plain http only at home or on Tailscale (checked without connecting).
        check(problem(() -> SyncDav.resolve(URI.create("http://8.8.8.8/dav/"))) != null, "plain http to a server on the internet is refused");
        check(problem(() -> SyncDav.resolve(URI.create("http://192.168.1.20/dav/"))) == null, "plain http at home (192.168.x) is fine");
        check(problem(() -> SyncDav.resolve(URI.create("http://10.0.0.5:8080/"))) == null, "plain http at home (10.x) is fine");
        check(problem(() -> SyncDav.resolve(URI.create("http://172.20.1.1/"))) == null, "plain http at home (172.16-31.x) is fine");
        check(problem(() -> SyncDav.resolve(URI.create("http://100.101.102.103/"))) == null, "plain http on Tailscale (100.64.0.0/10) is fine");
        check(problem(() -> SyncDav.resolve(URI.create("http://100.128.0.1/"))) != null, "but not just outside Tailscale's range");
        check(problem(() -> SyncDav.resolve(URI.create("http://[fd7a:115c:a1e0::1]/"))) == null, "plain http to a home IPv6 address (fd00::/8) is fine");
        check(problem(() -> SyncDav.resolve(URI.create("https://8.8.8.8/"))) == null, "https anywhere is fine");
        check(problem(() -> SyncDav.address("ftp://nas.local/")) != null, "only http and https");
        check(problem(() -> SyncDav.address("https://me@cloud.example.com/")) != null, "no user@ in the address");
        check("https://cloud.example.com/".equals(problem(() -> {
            throw new Exception(SyncDav.address("cloud.example.com").toString());
        })), "a bare name gets https://");
        check(problem(() -> SyncDav.folderName("a/b")) != null && problem(() -> SyncDav.folderName("..")) != null, "folder names can't have slashes or be ..");
        check("Restock".equals(SyncDav.folderName("  ")), "an empty folder name is Restock");
        check("https://cloud.example.com/remote.php/dav/files/d%40x.au/Our%20Restock/".equals(SyncDav.nextcloudFolderUrl("https://cloud.example.com/", "d@x.au", "Our Restock")),
            "Nextcloud's folder address: " + SyncDav.nextcloudFolderUrl("https://cloud.example.com/", "d@x.au", "Our Restock"));
        check("cloud.example.com · Our Restock".equals(SyncDav.describe("https://cloud.example.com/remote.php/dav/files/d/Our%20Restock/")), "shown as host · folder");

        FakeDav dav = new FakeDav();
        dav.dirs.add("/dav/");
        String url = SyncDav.folderUrl(dav.url("/dav"), "Restock");
        SyncDav.DavFolder wrong = new SyncDav.DavFolder(url, "declan", "nope");
        String why = problem(wrong::ensure);
        check(why != null && why.contains("user name or password"), "a wrong password says so: " + why);
        SyncDav.DavFolder fa = new SyncDav.DavFolder(url, dav.user, dav.password);
        fa.ensure();
        check(dav.dirs.contains("/dav/Restock/"), "the Restock folder is made");
        fa.ensure();
        check(true, "and it's fine when it's already there");
        check(problem(() -> SyncFolder.check(fa, "")) == null && dav.files.isEmpty(), "the setup test writes, reads back, lists and deletes a test file");
        String noParent = problem(() -> new SyncDav.DavFolder(SyncDav.folderUrl(dav.url("/missing"), "Restock"), dav.user, dav.password).ensure());
        check(noParent != null, "a folder whose parent isn't there: " + noParent);
        // Two phones syncing through the server, with the same sealed files as a folder.
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        SyncDav.DavFolder fb = new SyncDav.DavFolder(url, dav.user, dav.password);
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('l1', 'Milk', 0, 'x', 1, 'pantry')");
        SyncFolder.Result ra = a.f.sync(fa, NOW);
        check(ra.wrote && dav.files.containsKey("/dav/Restock/restock-sync-a1.bin"), "A writes its sealed file to the server");
        check(!new String(dav.files.get("/dav/Restock/restock-sync-a1.bin"), StandardCharsets.ISO_8859_1).contains("Milk"), "the server can't read it");
        SyncFolder.Result rb = b.f.sync(fb, NOW);
        check(rb.received > 0 && b.count("SELECT 1 FROM list_entries WHERE id = 'l1'") == 1, "B gets the list from the server");
        int before = dav.requests.get();
        SyncFolder.Result again = b.f.sync(fb, NOW);
        check(again.received == 0 && !again.wrote && dav.requests.get() - before == 1, "nothing new: one look at the folder, nothing read again (" + (dav.requests.get() - before) + " requests)");
        b.db.exec("UPDATE list_entries SET checked = 1 WHERE id = 'l1'");
        b.f.sync(fb, NOW);
        a.f.sync(fa, NOW);
        check(a.count("SELECT 1 FROM list_entries WHERE id = 'l1' AND checked = 1") == 1, "a tick on B reaches A through the server");
        // Redirects only on the same server.
        dav.redirectTo = "http://127.0.0.2:" + dav.server.getAddress().getPort() + "/dav/Restock/";
        String moved = problem(fa::names);
        check(moved != null && moved.contains("another server"), "a redirect to another server isn't followed (the password stays put): " + moved);
        dav.redirectTo = null;
        dav.stop();
        for (Phone x : p) x.db.close();
    }

    static void nextcloud() throws Exception {
        System.out.println("Nextcloud sign-in (Login Flow v2)");
        FakeDav nc = new FakeDav();
        nc.user = "declan";
        nc.password = "app-pass-123";
        for (String d : new String[] { "/remote.php/", "/remote.php/dav/", "/remote.php/dav/files/", "/remote.php/dav/files/declan/" }) nc.dirs.add(d);
        final AtomicInteger polls = new AtomicInteger();
        final String[] tokenSeen = { null };
        String base = nc.url("");
        HttpServer s = nc.server;
        s.createContext("/index.php/login/v2", x -> {
            byte[] out = new JSONObject().put("poll", new JSONObject().put("token", "tok-abc").put("endpoint", base + "/login/v2/poll"))
                .put("login", base + "/login/v2/flow/xyz").toString().getBytes(StandardCharsets.UTF_8);
            x.sendResponseHeaders("POST".equals(x.getRequestMethod()) ? 200 : 405, out.length);
            x.getResponseBody().write(out);
            x.close();
        });
        s.createContext("/login/v2/poll", x -> {
            tokenSeen[0] = new String(FakeDav.body(x.getRequestBody()), StandardCharsets.UTF_8);
            if (polls.incrementAndGet() < 3) {
                x.sendResponseHeaders(404, -1);
                x.close();
                return;
            }
            byte[] out = new JSONObject().put("server", base).put("loginName", "declan").put("appPassword", "app-pass-123").toString().getBytes(StandardCharsets.UTF_8);
            x.sendResponseHeaders(200, out.length);
            x.getResponseBody().write(out);
            x.close();
        });
        SyncDav.Login l = SyncDav.startLogin(base + "/index.php/apps/files/");
        check(l.login.toString().equals(base + "/login/v2/flow/xyz") && "tok-abc".equals(l.token), "starts with Nextcloud's sign-in page for the browser");
        SyncDav.Signin got = SyncDav.pollLogin(l, () -> false, 20, 10_000);
        check(got != null && "declan".equals(got.loginName) && "app-pass-123".equals(got.appPassword) && polls.get() == 3, "waits until the person has signed in, then gets an app password");
        check("token=tok-abc".equals(tokenSeen[0]), "asks with the poll token");
        String folder = SyncDav.nextcloudFolderUrl(got.server, got.loginName, "Restock");
        SyncDav.DavFolder f = new SyncDav.DavFolder(folder, got.loginName, got.appPassword);
        f.ensure();
        check(nc.dirs.contains("/remote.php/dav/files/declan/Restock/") && problem(() -> SyncFolder.check(f, "")) == null, "then makes and tries out its folder");
        polls.set(-1000);
        final AtomicInteger asked = new AtomicInteger();
        SyncDav.Signin none = SyncDav.pollLogin(l, () -> asked.incrementAndGet() > 3, 20, 10_000);
        check(none == null, "cancelling stops the wait");
        String slow = problem(() -> SyncDav.pollLogin(l, () -> false, 20, 100));
        check(slow != null && slow.contains("too long"), "and it gives up after the time limit: " + slow);
        // An answer pointing the password at another server's plain http address is refused.
        s.removeContext("/login/v2/poll");
        s.createContext("/login/v2/poll", x -> {
            byte[] out = new JSONObject().put("server", "http://8.8.8.8").put("loginName", "declan").put("appPassword", "x").toString().getBytes(StandardCharsets.UTF_8);
            x.sendResponseHeaders(200, out.length);
            x.getResponseBody().write(out);
            x.close();
        });
        SyncDav.Signin evil = SyncDav.pollLogin(l, () -> false, 20, 10_000);
        String used = problem(() -> new SyncDav.DavFolder(SyncDav.nextcloudFolderUrl(evil.server, evil.loginName, "Restock"), evil.loginName, evil.appPassword).ensure());
        check(used != null && used.contains("http://"), "a sign-in answer pointing at plain http on the internet isn't used: " + used);
        final String[] revoked = { null };
        s.createContext("/ocs/v2.php/core/apppassword", x -> {
            revoked[0] = x.getRequestMethod() + " " + x.getRequestHeaders().getFirst("OCS-APIRequest") + " " + x.getRequestHeaders().getFirst("Authorization");
            x.sendResponseHeaders(200, -1);
            x.close();
        });
        boolean bye = SyncDav.revokeNextcloud(folder, "declan", "app-pass-123");
        String wantAuth = "Basic " + java.util.Base64.getEncoder().encodeToString("declan:app-pass-123".getBytes(StandardCharsets.UTF_8));
        check(bye && ("DELETE true " + wantAuth).equals(revoked[0]), "letting go of the sign-in asks Nextcloud to delete Restock's app password");
        String notNc = problem(() -> SyncDav.startLogin(base + "/nothing-here"));
        check(notNc != null, "an address that isn't Nextcloud says so: " + notNc);
        nc.stop();
    }

    // ---------- trying a folder out ----------

    static void folderCheck() throws Exception {
        System.out.println("trying a folder out");
        MapFolder ok = new MapFolder();
        check(problem(() -> SyncFolder.check(ok, "no")) == null && ok.files.isEmpty(), "a folder that works passes, and the test file goes");
        SyncFolder.Folder forgetful = new MapFolder() {
            @Override
            public byte[] read(String name) {
                return null; // like a provider that only uploads later
            }
        };
        String why = problem(() -> SyncFolder.check(forgetful, "That app can't hold a folder for Restock. Try Nextcloud, Syncthing or a folder on this phone."));
        check(why != null && why.startsWith("That app can't hold a folder"), "one that can't read back is turned down: " + why);
        SyncFolder.Folder blind = new MapFolder() {
            @Override
            public List<String> names() {
                return new ArrayList<>();
            }
        };
        check(problem(() -> SyncFolder.check(blind, "no")) != null, "one that doesn't list what's in it is turned down");
        SyncFolder.Folder sticky = new SyncFolder.Folder() {
            final Map<String, byte[]> m = new TreeMap<>();

            public List<String> names() {
                return new ArrayList<>(m.keySet());
            }

            public byte[] read(String n) {
                return m.get(n);
            }

            public void write(String n, byte[] d) {
                m.put(n, d);
            }
        };
        check(problem(() -> SyncFolder.check(sticky, "no")) != null, "one that can't delete is turned down");
        FakeDav dav = new FakeDav();
        dav.failReads = true;
        SyncDav.DavFolder f = new SyncDav.DavFolder(dav.url("/"), dav.user, dav.password);
        check(problem(() -> SyncFolder.check(f, "no")) != null && dav.files.isEmpty(), "a WebDAV server that can't read back is turned down, and the test file is cleaned up");
        dav.stop();
    }

    // ---------- tidying old deletes ----------

    static void compaction() throws Exception {
        System.out.println("tidying old deletes");
        Phone[] p = household("a1", "b2", "c3");
        Phone a = p[0], b = p[1], c = p[2];
        for (String id : new String[] { "x1", "x2", "x3" }) a.db.exec("INSERT INTO items (id, name, created_at, section) VALUES (?, ?, 'x', 'pantry')", id, "Item " + id);
        long old = System.currentTimeMillis() - 100L * 24 * 3600 * 1000;
        // x1 and x2 were made 110 days ago and deleted 100 days ago; x3 is deleted just now.
        age(a, "x1", old - 10L * 24 * 3600 * 1000);
        age(a, "x2", old - 10L * 24 * 3600 * 1000);
        sync(b, a);
        sync(c, a);
        a.db.exec("DELETE FROM items WHERE id IN ('x1', 'x2')");
        a.db.exec("DELETE FROM items WHERE id = 'x3'");
        a.db.exec("UPDATE sync_log SET stamp = ? WHERE tbl = 'items' AND pk IN ('x1', 'x2')", old);
        sync(b, a);
        long top = Long.parseLong(a.one("SELECT MAX(seq) FROM sync_log"));
        int n = a.e.compact(System.currentTimeMillis());
        check(n == 0 && a.count("SELECT 1 FROM sync_log WHERE deleted = 1 AND tbl = 'items'") == 3, "C hasn't seen the deletes yet: nothing goes (" + n + ")");
        sync(c, a);
        check(c.count("SELECT 1 FROM items WHERE id IN ('x1','x2','x3')") == 0, "C gets the deletes");
        n = a.e.compact(System.currentTimeMillis());
        check(n == 2 && a.count("SELECT 1 FROM sync_log WHERE pk IN ('x1','x2')") == 0, "once every phone has seen them, the old ones go: " + n);
        check(a.count("SELECT 1 FROM sync_log WHERE pk = 'x3' AND deleted = 1") == 1, "a delete less than 90 days old stays");
        a.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('y', 'New', 'x', 'pantry')");
        check(Long.parseLong(a.one("SELECT seq FROM sync_log WHERE pk = 'y'")) > top, "change numbers never go back down");
        sync(b, a);
        check(b.count("SELECT 1 FROM items WHERE id = 'y'") == 1 && b.count("SELECT 1 FROM items WHERE id IN ('x1','x2')") == 0, "and syncing carries on as before");
        // Seen through the folder too: a phone only away from home.
        Phone[] q = household("d4", "e5");
        Phone d = q[0], e = q[1];
        MapFolder folder = new MapFolder();
        d.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('z1', 'Z', 'x', 'pantry')");
        age(d, "z1", old - 10L * 24 * 3600 * 1000);
        d.f.sync(folder, NOW);
        e.f.sync(folder, NOW);
        d.db.exec("DELETE FROM items WHERE id = 'z1'");
        d.db.exec("UPDATE sync_log SET stamp = ? WHERE pk = 'z1'", old);
        d.f.sync(folder, NOW);
        check(d.e.compact(System.currentTimeMillis()) == 0, "folder only: not before the other phone has read it");
        e.f.sync(folder, NOW); // reads d's delete; its file now says how far it got
        d.f.sync(folder, NOW); // d reads that
        check(e.count("SELECT 1 FROM items WHERE id = 'z1'") == 0 && d.e.compact(System.currentTimeMillis()) == 1, "folder only: once its file says it has seen it");
        // A delete older than the folder's half-year cut-off is left out of the file: so a phone
        // reading the file hasn't seen it, and it never goes until it has (on the Wi-Fi).
        Phone[] r = household("f6", "g7");
        Phone f = r[0], g = r[1];
        MapFolder f2 = new MapFolder();
        f.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('w1', 'W', 'x', 'pantry')");
        age(f, "w1", System.currentTimeMillis() - 210L * 24 * 3600 * 1000);
        sync(g, f);
        f.db.exec("DELETE FROM items WHERE id = 'w1'");
        f.db.exec("UPDATE sync_log SET stamp = ? WHERE pk = 'w1'", System.currentTimeMillis() - 200L * 24 * 3600 * 1000);
        f.f.sync(f2, NOW);
        g.f.sync(f2, NOW);
        g.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('w2', 'Something new', 'x', 'pantry')");
        g.f.sync(f2, NOW);
        f.f.sync(f2, NOW);
        check(g.count("SELECT 1 FROM items WHERE id = 'w1'") == 1 && f.e.compact(System.currentTimeMillis()) == 0 && f.count("SELECT 1 FROM sync_log WHERE pk = 'w1'") == 1,
            "a delete the folder file left out is never tidied before the other phone has it");
        sync(g, f);
        check(g.count("SELECT 1 FROM items WHERE id = 'w1'") == 0 && f.e.compact(System.currentTimeMillis()) == 1, "it gets it on the Wi-Fi, then it goes");
        for (Phone x : new Phone[] { a, b, c, d, e, f, g }) x.db.close();
    }

    /** Makes a record look as if it was made (and last changed) at `when`. */
    static void age(Phone p, String pk, long when) throws Exception {
        p.db.exec("UPDATE sync_log SET stamp = ?, created = ? WHERE pk = ?", when, when, pk);
    }

    // ---------- secrets ----------

    /** Stands in for Android's key store: "ks1:" + the value, reversed and encoded. */
    static final class FakeSeal implements SyncEngine.Secrets {
        final AtomicInteger sealedCount = new AtomicInteger();

        public String seal(String plain) {
            sealedCount.incrementAndGet();
            return "ks1:" + java.util.Base64.getEncoder().encodeToString(new StringBuilder(plain).reverse().toString().getBytes(StandardCharsets.UTF_8));
        }

        public String open(String stored) {
            if (!stored.startsWith("ks1:")) return stored;
            return new StringBuilder(new String(java.util.Base64.getDecoder().decode(stored.substring(4)), StandardCharsets.UTF_8)).reverse().toString();
        }

        public boolean sealed(String stored) {
            return stored.startsWith("ks1:");
        }
    }

    static void secrets() throws Exception {
        System.out.println("secrets");
        Phone[] p = household("a1", "b2");
        Phone a = p[0], b = p[1];
        // 0.9.0 kept them plain (and tests on a computer still do: the pass-through).
        String key = a.e.meta("key");
        check(key != null && key.equals(a.one("SELECT value FROM sync_meta WHERE key = 'key'")), "pass-through: stored as it is on a computer");
        a.e.setMeta("dav_pass", "hunter2");
        // Now the phone has Restock 0.9.1 and its key store.
        a.e.secrets = new FakeSeal();
        boolean lost = a.e.checkSecrets();
        check(!lost, "nothing lost");
        boolean allSealed = true;
        for (JSONObject r : a.db.query("SELECT key, value FROM sync_meta"))
            if (SyncEngine.SECRET_KEYS.contains(r.getString("key")) && !r.getString("value").startsWith("ks1:")) allSealed = false;
        check(allSealed && a.count("SELECT 1 FROM sync_meta WHERE value LIKE '%hunter2%'") == 0, "old plain secrets are sealed the first time they're read");
        check(key.equals(a.e.meta("key")) && "hunter2".equals(a.e.meta("dav_pass")) && a.h.paired() && a.h.isOwner(), "and read back the same");
        check(a.count("SELECT 1 FROM sync_meta WHERE key = 'device' AND value = 'a1'") == 1, "ordinary settings stay as they are");
        a.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('s1', 'Soap', 'x', 'pantry')");
        sync(b, a);
        check(b.count("SELECT 1 FROM items WHERE id = 's1'") == 1, "syncing works as before");
        a.h.remove("b2");
        check(a.one("SELECT value FROM sync_meta WHERE key = 'key'").startsWith("ks1:") && !key.equals(a.e.meta("key")), "a new key is sealed when it's saved");
        // Restored onto another phone: the key store's key isn't there.
        SyncEngine moved = new SyncEngine(a.db);
        moved.secrets = new SyncEngine.Secrets() {
            public String seal(String plain) {
                return "ks1:new";
            }

            public String open(String stored) throws Exception {
                if (stored.startsWith("ks1:")) throw new SyncEngine.SecretLost("no key", null);
                return stored;
            }

            public boolean sealed(String stored) {
                return stored.startsWith("ks1:");
            }
        };
        SyncHousehold mh = new SyncHousehold(moved);
        check(!mh.paired(), "a phone that can't open its secrets counts as not in a household");
        boolean gone = moved.checkSecrets();
        if (gone) {
            // As SyncHub does.
            mh.forget();
            moved.setMeta("notice", "keys");
        }
        check(gone && !mh.paired() && "keys".equals(moved.meta("notice")) && a.count("SELECT 1 FROM sync_meta WHERE value LIKE 'ks1:%'") == 0,
            "it forgets them and says to join again, without crashing");
        check(!moved.checkSecrets(), "and next time all is well");
        // A passing key store problem (busy) is never taken as lost: nothing is forgotten.
        Phone[] q = household("c3", "d4");
        Phone c = q[0];
        c.e.secrets = new FakeSeal();
        c.e.checkSecrets();
        SyncEngine busy = new SyncEngine(c.db);
        busy.secrets = new SyncEngine.Secrets() {
            public String seal(String plain) throws Exception {
                throw new java.security.ProviderException("key store busy");
            }

            public String open(String stored) throws Exception {
                throw new java.security.ProviderException("key store busy");
            }

            public boolean sealed(String stored) {
                return stored.startsWith("ks1:");
            }
        };
        String thrown = problem(busy::checkSecrets);
        SyncEngine back = new SyncEngine(c.db);
        back.secrets = new FakeSeal();
        check(thrown != null && !busy.secretsLost && new SyncHousehold(back).paired() && !back.checkSecrets(), "a passing key store problem forgets nothing: " + thrown);
        for (Phone x : q) x.db.close();
        for (Phone x : p) x.db.close();
    }
}
