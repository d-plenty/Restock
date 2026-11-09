package family.plenty.restock;

import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.2: phones and a real Restock server (server/, protocol v2, started by run.sh), with the phones'
 * own code (ServerSync, ServerFolder, SyncFolder, ServerOffload, ServerLink). The browser's side is
 * tools/sync-test/server-web.mjs, which opens what the phones seal with the web app's own crypto.
 * Arguments: out dir, server address, the stand-in browser's state file, the server's data folder.
 */
public class SyncServerTest {
    static String url, state, data;
    static int fails = 0;
    static final String NOW = SyncFamily.NOW;
    static final long DAY = 86_400_000L;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    /** The stand-in browser (server-web.mjs): one line of output. */
    static String web(String cmd, String... more) throws Exception {
        return webAs(state, cmd, more);
    }

    static String webAs(String stateFile, String cmd, String... more) throws Exception {
        List<String> c = new ArrayList<>(Arrays.asList("node", "tools/sync-test/server-web.mjs", cmd, url, stateFile));
        c.addAll(Arrays.asList(more));
        Process p = new ProcessBuilder(c).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        String outText = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        if (p.waitFor() != 0) throw new Exception("server-web.mjs " + cmd + " failed");
        return outText;
    }

    static ServerSync s(SyncFamily.Phone p) {
        return new ServerSync(p.e, p.h);
    }

    static ServerSync.Round round(SyncFamily.Phone p) {
        return s(p).round(NOW, System.currentTimeMillis());
    }

    /** The phone's server, listed (so files can be read). */
    static ServerFolder listed(SyncFamily.Phone p) throws Exception {
        ServerFolder f = s(p).open();
        f.names();
        return f;
    }

    static SyncTest091.MapPhotos photos(SyncFamily.Phone p) {
        return (SyncTest091.MapPhotos) p.e.photos;
    }

    static int status(String method, String path, String auth) throws Exception {
        java.util.Map<String, String> h = new java.util.LinkedHashMap<>();
        if (auth != null) h.put("Authorization", auth);
        return SyncDav.request(method, URI.create(url + path), h, null, SyncDav.MAX_LIST).status;
    }

    static String iso(long ms) {
        return ServerOffload.iso(ms);
    }

    /** A server that answers like the real one, but lies or keeps quiet where told (for "never delete before it's confirmed"). */
    static final class Liar implements ServerOffload.Remote {
        final ServerFolder f;
        boolean wrongVersion, noVersion;
        int asked;

        Liar(ServerFolder f) {
            this.f = f;
        }

        public List<String> names() throws Exception {
            return f.names();
        }

        public long size(String n) {
            return f.size(n);
        }

        public String version(String n) {
            // A listing that never shows what was saved (a different version every time it's asked).
            return wrongVersion && (n.startsWith("archive/") || n.startsWith("photos/")) ? "not-what-it-said-" + (asked++) : f.version(n);
        }

        public byte[] read(String n) throws Exception {
            return f.read(n);
        }

        public JSONObject put(String n, byte[] d) throws Exception {
            JSONObject a = f.put(n, d);
            if (noVersion) a.remove("version");
            return a;
        }

        public void delete(String n) throws Exception {
            f.delete(n);
        }
    }

    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        url = args[1];
        state = args[2];
        data = args[3];
        long now = System.currentTimeMillis();

        SyncFamily.Phone[] p = SyncFamily.household("a1", "b2", "c3");
        SyncFamily.Phone a = p[0], b = p[1], c = p[2];
        for (SyncFamily.Phone x : p) x.e.photos = new SyncTest091.MapPhotos();

        // ---------- joining ----------
        String code = web("invite");
        String reached = s(a).join(code);
        String reuse = null;
        try {
            s(b).join(code);
        } catch (Exception e) {
            reuse = e.getMessage();
        }
        report("V1 a phone joins with the Add a phone code", !url.equals(reached) || !s(a).on() || a.e.meta("server_dev_priv") == null, "reached " + reached);
        report("V2 the same code can't add a second phone", reuse == null || !reuse.contains("used"), "second phone: " + reuse);
        s(b).join(web("invite"));
        s(c).join(web("invite"));
        String old = null;
        try {
            ServerFolder.parseInvite("restock-server:1?t=abcdefghijklmnopqrstuvwxyz&l=http%3A%2F%2F192.168.1.10%3A8787");
        } catch (IllegalArgumentException e) {
            old = e.getMessage();
        }
        ServerFolder.Invite in = ServerFolder.parseInvite("restock-server:2?h=http%3A%2F%2F192.168.1.10%3A8787%2F&a=https%3A%2F%2Frestock.example.com&i=abcdefghijklmnopqrstuvwxyz012345");
        report("V3 the code reads back (home, away, invite); an RC code says to update", !"http://192.168.1.10:8787".equals(in.home) || !"https://restock.example.com".equals(in.away) || old == null,
            in.home + " / " + in.away + "; old code: " + old);

        // ---------- syncing ----------
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('s1', 'Milk', 0, 'x', 1, 'pantry')");
        round(a);
        round(b);
        round(c);
        String onB = b.one("SELECT text FROM list_entries WHERE id = 's1'");
        b.db.exec("UPDATE list_entries SET checked = 1 WHERE id = 's1'");
        round(b);
        round(a);
        String tick = a.one("SELECT checked FROM list_entries WHERE id = 's1'");
        report("V4 a line reaches the others through the server, and a tick comes back", !"Milk".equals(onB) || !"1".equals(tick), "B has " + onB + ", A sees checked=" + tick);

        a.db.exec("INSERT INTO items (id, name, created_at, section) VALUES ('i1', 'Beans', 'x', 'pantry')");
        round(a);
        round(b);
        round(c);
        a.db.exec("UPDATE items SET name = 'Baked beans' WHERE id = 'i1'");
        Thread.sleep(5);
        c.db.exec("UPDATE items SET name = 'Heinz beans' WHERE id = 'i1'");
        for (int i = 0; i < 2; i++) for (SyncFamily.Phone x : p) round(x);
        String na = a.one("SELECT name FROM items WHERE id = 'i1'"), nb = b.one("SELECT name FROM items WHERE id = 'i1'"), nc = c.one("SELECT name FROM items WHERE id = 'i1'");
        report("V5 offline edits to the same item end up the same on every phone", !(na.equals(nb) && nb.equals(nc) && nc.equals("Heinz beans")), "a=" + na + " b=" + nb + " c=" + nc);

        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('p1', 'coles', 'Heinz Baked Beans 420g', 'x')");
        a.db.exec("INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, source) VALUES ('p1', ?, 2.10, 3.50, 1, 0, 'check')", iso(now - DAY));
        round(a);
        round(b);
        String price = b.one("SELECT price FROM prices WHERE product_id = 'p1'");
        report("V6 recent prices sync through the server (the state file carries 60 days)", !"2.1".equals(price), "B has price " + price);

        // A web page's edits (restock-sync-web-<webId>.bin) merge like another phone's.
        byte[] sk = SyncFolder.serverKey(a.h.key());
        JSONObject row = new JSONObject().put("id", "w1").put("text", "From the web").put("checked", 0).put("created_at", "x").put("qty", 1).put("section", "pantry");
        JSONObject entry = new JSONObject().put("tbl", "list_entries").put("pk", "w1").put("stamp", now).put("device", "web-x").put("created", now).put("deleted", false).put("row", row);
        String put = web("webfile", ServerLink.b64u(sk), new JSONArray().put(entry).toString());
        round(b);
        report("V7 the web app's file merges like another phone's", !"From the web".equals(b.one("SELECT text FROM list_entries WHERE id = 'w1'")), "web file " + put + "; B has " + b.one("SELECT text FROM list_entries WHERE id = 'w1'"));

        // Home address down: away is used.
        ServerFolder twoWay = new ServerFolder(List.of("http://127.0.0.1:1", url), "a1", ServerLink.privateKey(a.e.meta("server_dev_priv")));
        twoWay.names();
        report("V8 home address out of reach: the away address is used", !url.equals(twoWay.reached()), "reached " + twoWay.reached());

        // Plain http only at home (SyncDav's rules).
        String far = null;
        try {
            new ServerFolder(List.of("http://8.8.8.8:8787"), "a1", ServerLink.privateKey(a.e.meta("server_dev_priv"))).names();
        } catch (Exception e) {
            far = e.getMessage();
        }
        report("V9 plain http only to a server at home or on Tailscale", far == null || !far.contains("http://"), String.valueOf(far));

        // ---------- signed requests ----------
        int bare = status("GET", "/api/v2/files", null);
        String h = ServerFolder.authorization("a1", ServerLink.privateKey(a.e.meta("server_dev_priv")), "GET", "/api/v2/files", System.currentTimeMillis(), null);
        int first = status("GET", "/api/v2/files", h), again = status("GET", "/api/v2/files", h);
        String other = ServerFolder.authorization("a1", ServerLink.newKey().getPrivate(), "GET", "/api/v2/files", System.currentTimeMillis(), null);
        int forged = status("GET", "/api/v2/files", other);
        report("V10 requests are signed; unsigned and wrongly signed ones are refused", bare == 200 || first != 200 || forged != 401, "unsigned=" + bare + " signed=" + first + " other key=" + forged);
        report("V11 a request played again is refused", again != 401, "replay=" + again);
        ServerFolder.testClockOffset = -2 * 3600_000L;
        boolean skewOk;
        try {
            skewOk = !s(a).open().names().isEmpty();
        } catch (Exception e) {
            skewOk = false;
        } finally {
            ServerFolder.testClockOffset = 0;
        }
        report("V12 a phone whose clock is 2 hours out signs again with the server's time", !skewOk, "ok=" + skewOk);

        // ---------- what the server keeps ----------
        boolean plain = false;
        int sealed = 0;
        List<File> all = new ArrayList<>();
        java.util.ArrayDeque<File> dirs = new java.util.ArrayDeque<>(List.of(new File(data)));
        while (!dirs.isEmpty()) for (File f : dirs.pop().listFiles()) if (f.isDirectory()) dirs.push(f); else all.add(f);
        for (File f : all) {
            String t = new String(Files.readAllBytes(f.toPath()), StandardCharsets.ISO_8859_1);
            if (f.getName().startsWith("restock-sync-") && f.getName().endsWith(".bin")) {
                if (t.startsWith("RSF1")) sealed++;
                else plain = true;
            }
            if (t.contains("Milk") || t.contains("beans") || t.contains("From the web")) plain = true;
        }
        byte[] mine = listed(a).read("restock-sync-a1.bin");
        boolean opensWithServerKey, householdOpens;
        try {
            SyncFolder.open(sk, mine);
            opensWithServerKey = true;
        } catch (Exception e) {
            opensWithServerKey = false;
        }
        try {
            SyncFolder.open(a.h.key(), mine);
            householdOpens = true;
        } catch (Exception e) {
            householdOpens = false;
        }
        report("V13 the server only has sealed files (data folder, every file)", plain || sealed < 4, sealed + " sealed sync files; anything readable=" + plain);
        report("V14 server files use the serverKey, not the household's key", !opensWithServerKey || householdOpens, "serverKey opens=" + opensWithServerKey + ", household key opens=" + householdOpens);

        // ---------- the web page: link and QR sign-in ----------
        String link = web("link");
        JSONObject info = s(a).webCode(link);
        s(a).approveWeb(link);
        JSONObject got = new JSONObject(web("linkget", link.replaceAll(".*[?&]s=([^&]+).*", "$1")));
        JSONObject gift = got.optJSONObject("gift");
        String giftKey = gift == null ? null : gift.getJSONObject("keys").optString(String.valueOf(1), null);
        report("V15 link: the phone seals the serverKey to the browser; the web app's code opens it",
            gift == null || !ServerLink.b64u(sk).equals(giftKey) || !"House".equals(gift.getJSONObject("household").optString("name")) || !"link".equals(info.optString("kind")),
            "asked " + info + "; opened=" + (gift != null) + ", key matches=" + ServerLink.b64u(sk).equals(giftKey));
        String reused = null;
        try {
            s(b).approveWeb(link);
        } catch (Exception e) {
            reused = e.getMessage();
        }
        report("V16 a link code works once", reused == null, "second phone: " + reused);

        String qrState = new File(SyncFamily.dir, "qr-browser.json").getPath();
        String login = webAs(qrState, "qrlogin");
        JSONObject li = s(b).webCode(login);
        s(b).approveWeb(login);
        JSONObject q = new JSONObject(webAs(qrState, "qrget", login.replaceAll(".*[?&]s=([^&]+).*", "$1")));
        report("V17 QR sign-in: the browser gets a session and the keys", !"login".equals(li.optString("kind")) || !"done".equals(q.optString("status")) || q.optInt("files") != 200
            || !ServerLink.b64u(sk).equals(q.getJSONObject("gift").getJSONObject("keys").optString("1")), "asked " + li + "; " + q.optString("status") + ", files " + q.optInt("files"));

        String elsewhere = null;
        try {
            s(a).webCode(web("link", "http://evil.example:8787"));
        } catch (IllegalArgumentException e) {
            elsewhere = e.getMessage();
        }
        report("V18 a code from a page that isn't this server's is refused", elsewhere == null, String.valueOf(elsewhere));

        // ---------- after a rekey: webkeys/ ----------
        round(a);
        String before = web("webkeys");
        a.h.remove("c3");
        round(a);
        round(b);
        round(a);
        JSONObject wk = new JSONObject(web("webkeys"));
        byte[] sk2 = SyncFolder.serverKey(a.h.key());
        boolean newKey = wk.optInt("status") == 200 && ServerLink.b64u(sk2).equals(wk.getJSONObject("keys").optString("2"));
        report("V19 after a rekey, webkeys/<webId>.bin holds the new serverKey for the linked browser", !newKey, "before: " + before + "; after: status " + wk.optInt("status") + ", has v2=" + newKey);
        a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('s8', 'Secret', 0, 'x', 1, 'pantry')");
        round(a);
        round(b);
        round(c);
        report("V20 the others carry on; the removed phone can't read new changes", !"Secret".equals(b.one("SELECT text FROM list_entries WHERE id = 's8'")) || c.one("SELECT text FROM list_entries WHERE id = 's8'") != null,
            "B has " + b.one("SELECT text FROM list_entries WHERE id = 's8'") + "; C has " + c.one("SELECT text FROM list_entries WHERE id = 's8'"));

        // A browser key the phones haven't seen proof of gets nothing; once its own sealed file names it, it does.
        String newWeb = new JSONObject(web("newweb")).getString("webId");
        round(a);
        int untrusted = new JSONObject(web("webkeys", newWeb)).optInt("status");
        web("webfile", ServerLink.b64u(sk2), "[]");
        round(a);
        round(a);
        JSONObject wk2 = new JSONObject(web("webkeys", newWeb));
        report("V21 webkeys only for a browser key the phone can trust", untrusted == 200 || wk2.optInt("status") != 200, "listed only: " + untrusted + "; after its own file: " + wk2.optInt("status"));

        // ---------- offload ----------
        // The household shares receipts; A keeps a year of prices for now (4 weeks from V22 on).
        ServerTestData.settings(a, 52);
        a.h.setHouseholdReceipts(true);
        SyncFamily.sync(b, a);
        a.e.noteTabs();
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('p2', 'coles', 'Weet-Bix 1.2kg', 'x')");
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('rx', 'chemistwarehouse', 'Panadol 20', 'x')");
        for (int d : new int[] { 200, 150, 90, 1 }) a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('p2', ?, ?, 0, 0, 'check')", iso(now - d * DAY), 5.0 + d / 100.0);
        for (int d : new int[] { 200, 1 }) a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('rx', ?, 4.5, 0, 0, 'check')", iso(now - d * DAY));
        a.e.setMeta("tabs", "pantry,keg"); // this phone doesn't share pharmacy
        byte[] jpg = new byte[3000];
        new java.util.Random(7).nextBytes(jpg);
        jpg[0] = (byte) 0xff;
        jpg[1] = (byte) 0xd8;
        photos(a).files.put("receipts/r1.jpg", jpg);
        a.db.exec("INSERT INTO receipts (id, scanned_at, shop, total, section, photo) VALUES ('r1', ?, 'Coles Newtown', 42.5, 'pantry', 'receipts/r1.jpg')", iso(now - 120 * DAY));
        round(a); // the receipt row goes out as usual; nothing is old enough to move yet
        ServerTestData.settings(a, 4);
        int pricesBefore = a.db.query("SELECT 1 FROM prices WHERE product_id = 'p2'").size();

        // Server out of reach: nothing deleted.
        ServerOffload.Result unreachable;
        try {
            unreachable = s(a).offloader(new Liar(new ServerFolder(List.of("http://127.0.0.1:1"), "a1", ServerLink.privateKey(a.e.meta("server_dev_priv")))), now).run(4);
        } catch (Exception e) {
            unreachable = null;
        }
        boolean keptAll = a.db.query("SELECT 1 FROM prices WHERE product_id = 'p2'").size() == pricesBefore && photos(a).files.containsKey("receipts/r1.jpg");
        report("V22 offload: nothing is deleted while the server is out of reach", !keptAll, "round " + (unreachable == null ? "failed (as it should)" : "ran") + "; prices " + pricesBefore + ", photo kept=" + photos(a).files.containsKey("receipts/r1.jpg"));

        // The server's listing doesn't show what it said it saved, or it gave no version: nothing deleted.
        ServerFolder fa = s(a).open();
        fa.names();
        Liar liar = new Liar(fa);
        liar.noVersion = true;
        ServerOffload.Result quiet = s(a).offloader(liar, now).run(4);
        boolean kept2 = a.db.query("SELECT 1 FROM prices WHERE product_id = 'p2'").size() == pricesBefore && photos(a).files.containsKey("receipts/r1.jpg");
        liar.noVersion = false;
        liar.wrongVersion = true;
        ServerOffload.Result lied = s(a).offloader(liar, now).run(4);
        boolean kept1 = a.db.query("SELECT 1 FROM prices WHERE product_id = 'p2'").size() == pricesBefore && photos(a).files.containsKey("receipts/r1.jpg");
        report("V23 offload: never deleted before the server's listing confirms size and version", !kept1 || !kept2 || lied.prices + quiet.prices + lied.photos + quiet.photos > 0,
            "wrong version: waiting " + lied.waiting + ", kept=" + kept1 + "; no version: waiting " + quiet.waiting + ", kept=" + kept2);

        // The real thing: confirmed, then deleted on the phone.
        ServerSync.Round r = round(a);
        List<String> left = new ArrayList<>();
        for (JSONObject x : a.db.query("SELECT product_id, date FROM prices WHERE product_id IN ('p2', 'rx') ORDER BY product_id, date")) left.add(x.getString("product_id") + "@" + x.getString("date").substring(0, 10));
        ServerFolder fs = s(a).open();
        List<String> names = fs.names();
        String month200 = ServerOffload.month(iso(now - 200 * DAY)), month120 = ServerOffload.month(iso(now - 120 * DAY));
        JSONObject arch = SyncFolder.open(sk2, fs.read(ServerOffload.archiveName("a1", month200)));
        JSONObject arch120 = SyncFolder.open(sk2, fs.read(ServerOffload.archiveName("a1", month120)));
        String sha = ServerLink.hex(ServerLink.sha256(jpg));
        boolean archOk = arch.getJSONArray("prices").length() >= 1 && arch.getJSONArray("prices").toString().contains("\"p2\"") && !arch.getJSONArray("prices").toString().contains("\"rx\"");
        boolean photoOk = names.contains("photos/" + sha + ".bin") && !photos(a).files.containsKey("receipts/r1.jpg") && a.e.meta("photo_off:receipts/r1.jpg") != null
            && sha.equals(arch120.getJSONObject("photos").optString("receipts/r1.jpg")) && arch120.getJSONArray("receipts").toString().contains("Coles Newtown");
        report("V24 offload: old prices go to archive/<device>/<month>.bin and only then off the phone", r.offload == null || r.offload.prices != 3 || !left.equals(List.of("p2@" + iso(now - DAY).substring(0, 10), "rx@" + iso(now - DAY).substring(0, 10))) || !archOk,
            "moved " + (r.offload == null ? "?" : r.offload.prices) + "; left " + left + "; archive " + month200 + " ok=" + archOk + "; pharmacy (not shared) tidied=" + (r.offload == null ? "?" : r.offload.pruned));
        byte[] back = s(a).photo("receipts/r1.jpg");
        report("V25 offload: an old receipt's photo goes to photos/<sha256>.bin; the receipt stays and can fetch it back",
            !photoOk || !Arrays.equals(back, jpg) || a.db.query("SELECT 1 FROM receipts WHERE id = 'r1'").isEmpty(), "photo on server=" + photoOk + ", fetched back=" + Arrays.equals(back, jpg));
        round(a);
        JSONObject state = SyncFolder.open(sk2, listed(a).read("restock-sync-a1.bin"));
        report("V26 the phone's own file lists its photos on the server (for the web)", !sha.equals(state.optJSONObject("photos") == null ? null : state.getJSONObject("photos").optString("receipts/r1.jpg")),
            "photos " + state.optJSONObject("photos"));

        // B has the same photo of the same receipt: it finds the server's copy and uses it.
        ServerTestData.settings(b, 4);
        photos(b).files.put("receipts/r1.jpg", jpg.clone());
        ServerSync.Round rb = round(b);
        report("V27 a second phone with the same photo uses the server's copy", rb.offload == null || rb.offload.photos != 1 || photos(b).files.containsKey("receipts/r1.jpg"),
            "moved " + (rb.offload == null ? "?" : rb.offload.photos) + (rb.error == null ? "" : " " + rb.error));

        // The receipt deleted: its photo and its archive line go from the server (once B, which uses
        // the same photo file, has taken in the delete too).
        a.db.exec("DELETE FROM receipts WHERE id = 'r1'");
        round(a);
        boolean keptForB = listed(a).names().contains("photos/" + sha + ".bin");
        round(b);
        round(a);
        fs = s(a).open();
        names = fs.names();
        JSONObject arch120b = SyncFolder.open(sk2, fs.read(ServerOffload.archiveName("a1", month120)));
        report("V28 a deleted receipt's photo and archive line go from the server", !keptForB || names.contains("photos/" + sha + ".bin") || arch120b.getJSONArray("receipts").length() != 0
            || a.e.meta("photo_off:receipts/r1.jpg") != null || b.e.meta("photo_off:receipts/r1.jpg") != null,
            "kept while B used it=" + keptForB + "; then photo there=" + names.contains("photos/" + sha + ".bin") + ", archive receipts " + arch120b.getJSONArray("receipts").length() + ", notes a=" + a.e.meta("photo_off:receipts/r1.jpg") + " b=" + b.e.meta("photo_off:receipts/r1.jpg"));

        // Stop, bringing the photos back.
        byte[] jpg2 = jpg.clone();
        jpg2[100] ^= 1;
        photos(a).files.put("receipts/r2.jpg", jpg2);
        a.db.exec("INSERT INTO receipts (id, scanned_at, shop, total, section, photo) VALUES ('r2', ?, 'Woolies', 10, 'pantry', 'receipts/r2.jpg')", iso(now - 100 * DAY));
        round(a);
        boolean off = !photos(a).files.containsKey("receipts/r2.jpg");
        String priv = a.e.meta("server_dev_priv");
        s(a).stop(true);
        String gone = null;
        try {
            new ServerFolder(List.of(url), "a1", ServerLink.privateKey(priv)).names();
        } catch (ServerFolder.AccessException e) {
            gone = e.gone ? "gone" : e.getMessage();
        }
        report("V29 Stop brings the photos back, then takes the phone off the server's list",
            !off || !Arrays.equals(photos(a).files.get("receipts/r2.jpg"), jpg2) || s(a).offloadedPhotos() != 0 || s(a).on() || !"gone".equals(gone), "moved first=" + off + ", back=" + photos(a).files.containsKey("receipts/r2.jpg") + ", server says " + gone);

        // Without a server: nothing of this runs (pruneHistory in db.ts tidies as in 0.9.1; vitest checks it).
        ServerSync.Round none = round(a);
        report("V30 without a server, a round does nothing", none.result.wrote || none.error != null || none.offload != null, "wrote=" + none.result.wrote);

        review(a, b, sk2, jpg2, now);

        System.out.println(fails == 0 ? "server scenarios: all passed" : "server scenarios: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    /** 0.9.2 review: more ways to lose data, or to take in what shouldn't come. */
    static void review(SyncFamily.Phone a, SyncFamily.Phone b, byte[] sk2, byte[] jpg2, long now) throws Exception {
        s(a).join(web("invite"));
        round(a);
        round(b);
        String photo2 = "photos/" + ServerLink.hex(ServerLink.sha256(jpg2)) + ".bin";

        // R1 A browser's file can't change loyalty cards or prices, and can't pose as a phone.
        b.db.exec("INSERT INTO cards (id, program, label, number, created_at) VALUES ('k9', 'flybuys', 'Flybuys', '6008943212345678', 'x')");
        long t = System.currentTimeMillis() + 60_000;
        JSONObject line = new JSONObject().put("id", "w2").put("text", "Web line").put("checked", 0).put("created_at", "x").put("qty", 1).put("section", "pantry");
        JSONArray bad = new JSONArray()
            .put(new JSONObject().put("tbl", "list_entries").put("pk", "w2").put("stamp", t).put("device", "web-x").put("created", t).put("deleted", false).put("row", line))
            .put(new JSONObject().put("tbl", "cards").put("pk", "k9").put("stamp", t).put("device", "web-x").put("created", t).put("deleted", true))
            .put(new JSONObject().put("tbl", "prices").put("pk", "p1|" + iso(now - DAY)).put("stamp", t).put("device", "web-x").put("created", t).put("deleted", false)
                .put("row", new JSONObject().put("product_id", "p1").put("date", iso(now - DAY)).put("price", 0.01).put("is_special", 0).put("member_only", 0).put("source", "check")));
        web("webfile", ServerLink.b64u(sk2), bad.toString());
        round(b);
        String card = b.one("SELECT number FROM cards WHERE id = 'k9'"), price = b.one("SELECT price FROM prices WHERE product_id = 'p1'");
        JSONObject posing = new JSONObject().put("id", "w3").put("text", "Posing as a1").put("checked", 0).put("created_at", "x").put("qty", 1).put("section", "pantry");
        web("webfile", ServerLink.b64u(sk2), new JSONArray().put(new JSONObject().put("tbl", "list_entries").put("pk", "w3").put("stamp", t).put("device", "a1").put("created", t).put("deleted", false).put("row", posing)).toString(), "a1");
        round(b);
        report("R1 a browser's file can't change cards or prices, or pose as a phone", !"Web line".equals(b.one("SELECT text FROM list_entries WHERE id = 'w2'")) || card == null || !"2.1".equals(price)
            || b.one("SELECT text FROM list_entries WHERE id = 'w3'") != null, "line " + b.one("SELECT text FROM list_entries WHERE id = 'w2'") + "; card " + card + "; price " + price + "; posing " + b.one("SELECT text FROM list_entries WHERE id = 'w3'"));

        // R2 A photo moved to the server isn't fetched back over the Wi-Fi (it would go up and come back every round).
        boolean offA = !photos(a).files.containsKey("receipts/r2.jpg") && a.e.meta("photo_off:receipts/r2.jpg") != null;
        photos(b).files.put("receipts/r2.jpg", jpg2.clone());
        SyncFamily.sync(a, b);
        boolean fetched = photos(a).files.containsKey("receipts/r2.jpg");
        round(a);
        report("R2 a photo on the server isn't fetched back over the Wi-Fi", !offA || fetched || a.e.meta("photo_off:receipts/r2.jpg") == null || !listed(a).names().contains(photo2),
            "moved=" + offA + ", fetched back=" + fetched);

        // R3 B uses the same file; A's copy comes back (a backup put back): A just has it, the server's file stays for B.
        round(b);
        boolean bUses = !photos(b).files.containsKey("receipts/r2.jpg") && b.e.meta("photo_off:receipts/r2.jpg") != null;
        round(b); // B's own file now lists it
        photos(a).files.put("receipts/r2.jpg", jpg2.clone());
        ServerSync.Round back = round(a);
        boolean stays = listed(a).names().contains(photo2);
        byte[] forB;
        try {
            forB = s(b).photo("receipts/r2.jpg");
        } catch (Exception ex) {
            forB = null;
        }
        report("R3 a photo back on the phone: the server's file stays for the phone that uses it", !bUses || !stays || !Arrays.equals(forB, jpg2) || back.error != null,
            "B uses it=" + bUses + ", file stays=" + stays + ", B can fetch=" + Arrays.equals(forB, jpg2));
        round(a); // moved again (it's old)

        // R4 A month file the listing misses isn't written over (its earlier prices are only there).
        a.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('p5', 'coles', 'Oats 1kg', 'x')");
        for (int d : new int[] { 300, 1 }) a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('p5', ?, 3.0, 0, 0, 'check')", iso(now - d * DAY));
        round(a);
        String m300 = ServerOffload.month(iso(now - 300 * DAY));
        String arch = ServerOffload.archiveName("a1", m300);
        a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('p5', ?, 3.2, 0, 0, 'check')", ServerOffload.month(iso(now - 300 * DAY)) + "-02T00:00:00.000Z");
        a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('p5', ?, 3.1, 0, 0, 'check')", iso(now - 300 * DAY).substring(0, 7) + "-01T00:00:00.000Z");
        ServerFolder fa = s(a).open();
        fa.names();
        Odd blind = new Odd(fa);
        blind.hide.add(arch);
        s(a).offloader(blind, now).run(4);
        JSONObject m = SyncFolder.open(sk2, listed(a).read(arch));
        String all = m.getJSONArray("prices").toString();
        report("R4 a month file the listing missed isn't written over", m.getJSONArray("prices").length() < 3 || !all.contains("3.2") || !all.contains("3.1"), m.getJSONArray("prices").length() + " prices in " + m300);

        // R5 Nothing's deleted when the server answers with another size, or hands back other bytes than it was sent.
        round(a);
        String d250 = iso(now - 250 * DAY), d200 = iso(now - 200 * DAY), d230 = iso(now - 230 * DAY);
        a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('p5', ?, 2.9, 0, 0, 'check')", d250);
        fa.names();
        Odd big = new Odd(fa);
        big.sayBytes = 1;
        s(a).offloader(big, now).run(4);
        boolean keptBig = a.one("SELECT price FROM prices WHERE product_id = 'p5' AND date = '" + d250 + "'") != null;
        a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('p5', ?, 2.8, 0, 0, 'check')", d200);
        fa.names();
        Odd garbled = new Odd(fa);
        garbled.garbleAfterPut = true;
        s(a).offloader(garbled, now).run(4);
        boolean keptGarbled = a.one("SELECT price FROM prices WHERE product_id = 'p5' AND date = '" + d200 + "'") != null;
        report("R5 nothing's deleted when the server's size or bytes aren't what was sent", !keptBig || !keptGarbled, "another size: kept=" + keptBig + "; other bytes: kept=" + keptGarbled);

        // R6 A price changed on the phone while it was being saved stays (the archive gets the new one next round).
        a.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('p5', ?, 2.7, 0, 0, 'check')", d230);
        fa.names();
        Odd busy = new Odd(fa);
        busy.afterPut = () -> {
            try {
                a.db.exec("UPDATE prices SET price = 2.75 WHERE product_id = 'p5' AND date = ?", d230);
            } catch (Exception ex) {
                throw new RuntimeException(ex);
            }
        };
        s(a).offloader(busy, now).run(4);
        String still = a.one("SELECT price FROM prices WHERE product_id = 'p5' AND date = '" + d230 + "'");
        round(a);
        JSONObject m230 = SyncFolder.open(sk2, listed(a).read(ServerOffload.archiveName("a1", ServerOffload.month(d230))));
        boolean has = m230.getJSONArray("prices").toString().contains("2.75");
        report("R6 a price changed while it was being saved isn't lost", !"2.75".equals(still) || !has || a.one("SELECT price FROM prices WHERE product_id = 'p5' AND date = '" + d230 + "'") != null,
            "on the phone meanwhile " + still + "; then in the archive=" + has);

        // R7 A phone still on the server's list joining again (a new key) is told what to do, in the server's
        // words, and keeps working with the key it has. (Stop takes it off the list first: A re-joined above.)
        String taken = null;
        try {
            s(b).join(web("invite"));
        } catch (Exception ex) {
            taken = ex.getMessage();
        }
        ServerSync.Round still2 = round(b);
        report("R7 joining again while still on the server's list says so, and changes nothing", taken == null || !taken.contains("Phones page") || still2.error != null,
            "said: " + taken + "; next round " + (still2.error == null ? "fine" : still2.error));
    }
}

/** A server that does what the real one does, with ways to go wrong where told (the 0.9.2 review checks). */
final class Odd implements ServerOffload.Remote {
    final ServerFolder f;
    /** Names left out of every listing (a listing that misses files). */
    final java.util.Set<String> hide = new java.util.HashSet<>();
    /** Answer a PUT with this size instead of the real one. */
    long sayBytes = -1;
    /** Hand back other bytes for these names (a server that kept something else). */
    final java.util.Set<String> garble = new java.util.HashSet<>();
    /** Hand back other bytes for any file read after it was saved this time. */
    boolean garbleAfterPut;
    final java.util.Set<String> putNames = new java.util.HashSet<>();
    /** Run just after a file is saved (another change on the phone meanwhile). */
    Runnable afterPut;

    Odd(ServerFolder f) {
        this.f = f;
    }

    public List<String> names() throws Exception {
        List<String> out = new ArrayList<>(f.names());
        out.removeAll(hide);
        return out;
    }

    public long size(String n) {
        return f.size(n);
    }

    public String version(String n) {
        return f.version(n);
    }

    public byte[] read(String n) throws Exception {
        byte[] b = f.read(n);
        if (b != null && (garble.contains(n) || (garbleAfterPut && putNames.contains(n)))) {
            b = b.clone();
            b[b.length - 1] ^= 1;
        }
        return b;
    }

    public JSONObject put(String n, byte[] d) throws Exception {
        JSONObject a = f.put(n, d);
        putNames.add(n);
        if (sayBytes >= 0) a.put("size", sayBytes);
        if (afterPut != null) afterPut.run();
        return a;
    }

    public void delete(String n) throws Exception {
        f.delete(n);
    }
}

/** Small helpers for the server check. */
final class ServerTestData {
    /** The phone's "Keep price history for", in weeks. */
    static void settings(SyncFamily.Phone p, int weeks) throws Exception {
        p.db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('settings', ?)", new JSONObject().put("historyWeeks", weeks).toString());
    }
}
