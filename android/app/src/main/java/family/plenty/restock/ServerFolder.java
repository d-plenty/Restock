package family.plenty.restock;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Sync through a Restock server (0.9.2, protocol v2: docs/server-protocol.md): a small container the
 * household runs itself (server/ in the repo). To the phone it's another sync folder (SyncFolder):
 * the server keeps each phone's file, sealed on the phone, and can't open any of them.
 *
 * - Joining: the server's Add a phone page shows restock-server:2?h=HOME&a=AWAY&i=INVITE. The phone
 *   makes an ECDSA P-256 key of its own and sends the server its public key with the invite (which
 *   works once, for 10 minutes). The server only ever has the public key.
 * - Every request after that is signed with the phone's key (method, path, time, a one-off number,
 *   the body's hash), so a recorded request can't be played again, and nothing the server stores can
 *   be used to pose as the phone. A phone whose clock is out is told the server's time and signs again.
 * - Two addresses: home (tried first) and away. The first that answers is used for the whole round.
 * - The HTTP itself is SyncDav's (0.9.1): plain http only to an address at home or on Tailscale, the
 *   name looked up once, certificates checked, timeouts and size limits on everything. Nothing in the
 *   app allows plain http otherwise.
 *
 * No Android classes here, so it's tested on a computer too (tools/sync-test).
 */
final class ServerFolder implements SyncFolder.Folder, ServerOffload.Remote {
    static final String API = "/api/v2";
    /** 0.9.4: protocol v3, where the server is the household's owner (docs/server-protocol.md "v3"). */
    static final String API3 = "/api/v3";
    static final String INVITE_PREFIX = "restock-server:2?";
    static final String INVITE3_PREFIX = "restock-server:3?";
    /** File names the phone uses (and the server allows). */
    private static final java.util.regex.Pattern NAME = java.util.regex.Pattern.compile("[A-Za-z0-9._-]{1,120}(/[A-Za-z0-9._-]{1,120}){0,2}");

    private final List<String> bases;
    private final String device;
    private final PrivateKey key;
    /** "/api/v2" or (0.9.4) "/api/v3". */
    final String api;
    private String base;
    private final Map<String, String> versions = new HashMap<>();
    private final Map<String, Long> sizes = new HashMap<>();

    ServerFolder(List<String> bases, String device, PrivateKey key) {
        this(bases, device, key, API);
    }

    ServerFolder(List<String> bases, String device, PrivateKey key, String api) {
        this.bases = bases;
        this.device = device;
        this.key = key;
        this.api = api;
    }

    /** The address that answered this round (after names()), or null. */
    String reached() {
        return base;
    }

    // ---------- the server's Add a phone code ----------

    static final class Invite {
        String home;
        String away;
        String invite;
        /** 0.9.4: 3 for a v3 server's code (it names the server's kex key, k=), else 2. */
        int v = 2;
        /** 0.9.4: the server's ECDH key (SPKI, base64url), pinned from the code. */
        String kex;
    }

    /** A scanned Add a phone code, or an IllegalArgumentException saying what's wrong. */
    static Invite parseInvite(String text) {
        String t = text == null ? "" : text.trim();
        if (t.regionMatches(true, 0, "restock-server:1?", 0, 17))
            throw new IllegalArgumentException("That code is from an older Restock server. Update the server, then scan the code on its Add a phone page.");
        boolean v3 = t.regionMatches(true, 0, INVITE3_PREFIX, 0, INVITE3_PREFIX.length());
        if (!v3 && !t.regionMatches(true, 0, INVITE_PREFIX, 0, INVITE_PREFIX.length()))
            throw new IllegalArgumentException("That isn't a Restock server code. On a computer, sign in to your server's page and choose Add a phone.");
        Invite in = new Invite();
        in.v = v3 ? 3 : 2;
        for (String part : t.substring(INVITE_PREFIX.length()).split("&")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String k = part.substring(0, eq);
            String v = ServerLink.decode(part.substring(eq + 1)).trim();
            if (v.isEmpty()) continue;
            if (k.equals("h")) in.home = v;
            else if (k.equals("a")) in.away = v;
            else if (k.equals("i")) in.invite = v;
            else if (k.equals("k")) in.kex = v;
        }
        if (v3) {
            try {
                in.kex = ServerLink.b64u(ServerLink.publicKey(ServerLink.unb64(in.kex)).getEncoded());
            } catch (Exception e) {
                throw new IllegalArgumentException("That code is damaged. Make a new one on the server's Add a phone page.");
            }
        }
        if (in.invite == null || !in.invite.matches("[A-Za-z0-9_-]{20,128}")) throw new IllegalArgumentException("That code is damaged. Make a new one on the server's Add a phone page.");
        in.home = cleanAddress(in.home);
        in.away = cleanAddress(in.away);
        if (in.home == null && in.away == null) throw new IllegalArgumentException("That code has no address for the server. Make a new one on its Add a phone page.");
        return in;
    }

    /** An address as the phone keeps it (no trailing "/"), or an IllegalArgumentException saying what's wrong. */
    static String cleanAddress(String s) {
        if (s == null || s.trim().isEmpty()) return null;
        String t = s.trim();
        if (!t.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) t = "http://" + t;
        try {
            String a = SyncDav.address(t).toString();
            while (a.endsWith("/")) a = a.substring(0, a.length() - 1);
            return a;
        } catch (SyncDav.Problem p) {
            throw new IllegalArgumentException("The server's address doesn't look right (" + s.trim() + "): " + p.getMessage());
        }
    }

    // ---------- refusals ----------

    /** The server didn't accept this phone (removed from its list, or the request wasn't accepted). */
    static final class AccessException extends Exception {
        /** True: the phone isn't on the server's list (removed there, or never joined). */
        final boolean gone;

        AccessException(String m, boolean gone) {
            super(m);
            this.gone = gone;
        }
    }

    static final class MissingException extends Exception {
        MissingException() {
            super("not there");
        }
    }

    /**
     * 0.9.4: a v2 request answered 403 { error: "update", api: 3 }: the household was handed to the
     * server (a v3 server now), and this phone carries on with POST /api/v3/upgrade.
     */
    static final class UpdateException extends Exception {
        UpdateException(String m) {
            super(m);
        }
    }

    static final String GONE = "This phone isn't on your Restock server's list any more (it was removed there). To use the server again, scan a new code from its Add a phone page.";
    static final String CLOCK = "This phone's date or time looks wrong, so the server turned it down. Turn on the automatic date and time in Android's settings.";

    // ---------- joining ----------

    /**
     * Joins the server with an invite: the first of `bases` that answers gets this phone's public key.
     * Answers the address that took it. Throws with words for the person.
     */
    static String join(List<String> bases, String invite, String device, String name, PublicKey pub) throws Exception {
        JSONObject body = new JSONObject();
        body.put("invite", invite);
        body.put("device", device);
        body.put("name", name);
        body.put("pub", ServerLink.b64u(pub.getEncoded()));
        byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
        Exception last = null;
        for (String a : bases) {
            if (a == null) continue;
            SyncDav.Response r;
            try {
                Map<String, String> h = new LinkedHashMap<>();
                h.put("Content-Type", "application/json");
                r = SyncDav.request("POST", URI.create(a + API + "/devices"), h, b, SyncDav.MAX_SMALL);
            } catch (Exception e) {
                last = e;
                continue; // not reachable from here: the other address
            }
            if (r.status >= 200 && r.status < 300) return a;
            String err = errorOf(r);
            // The server already has this phone, with another key (it didn't come off the list at Stop, or
            // this phone lost its keys): the server says what to do, as it says it.
            if ("device-taken".equals(err) || r.status == 409) {
                String said = messageOf(r);
                throw new SyncDav.Problem(said.isEmpty() ? "That phone is already on this server. Remove it on the Phones page first, then add it again." : said);
            }
            if ("invite".equals(err)) throw new SyncDav.Problem("That code isn't from this server. Make a new one on the server's Add a phone page.");
            if (r.status == 403 || r.status == 410 || "used".equals(err) || "expired".equals(err))
                throw new SyncDav.Problem("That code has been used or has run out. Make a new one on the server's Add a phone page (each code works once, for 10 minutes).");
            if (r.status == 507) throw new SyncDav.Problem("The server already has as many phones as it takes.");
            if (r.status == 404) throw new SyncDav.Problem("That address isn't a Restock server (or the server needs updating).");
            if (r.status == 429) throw new SyncDav.Problem("The server is busy. Try again in a minute.");
            last = SyncDav.problem(r.status, "join");
        }
        if (last instanceof SyncDav.Problem) throw last;
        throw new SyncDav.Problem("Couldn't reach the Restock server. Check this phone is on the same network as the server (or the server's away address works), then try again.", last);
    }

    // ---------- the folder ----------

    @Override
    public List<String> names() throws Exception {
        versions.clear();
        sizes.clear();
        base = null;
        Exception last = null;
        for (String b : bases) {
            if (b == null) continue;
            try {
                SyncDav.Response r = send(b, "GET", api + "/files", null, SyncDav.MAX_LIST);
                if (r.status != 200) throw failure(r, "list the files");
                JSONArray files = new JSONObject(r.text()).getJSONArray("files");
                List<String> out = new ArrayList<>();
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    String n = f.getString("name");
                    out.add(n);
                    versions.put(n, f.isNull("version") ? null : f.optString("version", null));
                    sizes.put(n, f.optLong("size", -1));
                }
                base = b;
                return out;
            } catch (AccessException | UpdateException e) {
                // On another network something else could be at the home address: try away too, but
                // a refusal from the real server is what's said.
                last = e;
            } catch (Exception e) {
                if (!(last instanceof AccessException) && !(last instanceof UpdateException)) last = e;
            }
        }
        throw last != null ? last : new Exception("no server address");
    }

    @Override
    public String version(String name) {
        return versions.get(name);
    }

    @Override
    public long size(String name) {
        Long s = sizes.get(name);
        return s == null ? -1 : s;
    }

    private String path(String name) {
        if (name == null || !NAME.matcher(name).matches() || name.contains("..")) throw new IllegalArgumentException("not a server file name: " + name);
        return api + "/files/" + name;
    }

    @Override
    public byte[] read(String name) throws Exception {
        SyncDav.Response r = send(base(), "GET", path(name), null, SyncDav.MAX_FILE);
        if (r.status == 404) return null;
        if (r.status != 200) throw failure(r, "read " + name);
        return r.body;
    }

    @Override
    public void write(String name, byte[] data) throws Exception {
        put(name, data);
    }

    /** Saves a file; answers the server's { name, size, version } (version may be missing). */
    @Override
    public JSONObject put(String name, byte[] data) throws Exception {
        SyncDav.Response r = send(base(), "PUT", path(name), data, SyncDav.MAX_SMALL);
        if (r.status != 200 && r.status != 201 && r.status != 204) throw failure(r, "save " + name);
        try {
            return new JSONObject(r.text());
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    @Override
    public void delete(String name) throws Exception {
        SyncDav.Response r = send(base(), "DELETE", path(name), null, SyncDav.MAX_SMALL);
        if (r.status != 200 && r.status != 204 && r.status != 404) throw failure(r, "delete " + name);
    }

    /** A signed JSON request to the server (after names()). */
    JSONObject call(String method, String path, JSONObject body) throws Exception {
        SyncDav.Response r = send(base(), method, api + path, body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8), SyncDav.MAX_SMALL);
        if (r.status < 200 || r.status >= 300) {
            String said = messageOf(r);
            if (r.status == 409 || r.status == 400) {
                String err = errorOf(r);
                throw new Refused(err, said.isEmpty() ? "The server turned that down." : said);
            }
            throw failure(r, "do that");
        }
        try {
            return r.body.length == 0 ? new JSONObject() : new JSONObject(r.text());
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** The status of a signed request (after names()), for things that answer 404 or 410 when a code ran out. */
    int status(String method, String path, JSONObject body) throws Exception {
        return send(base(), method, api + path, body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8), SyncDav.MAX_SMALL).status;
    }

    /** Takes this phone off the server's list (Stop). Best effort: the server may be out of reach. */
    void leave() throws Exception {
        names();
        call("DELETE", "/devices/" + device, null);
    }

    // ---------- 0.9.4: protocol v3 ----------

    /**
     * GET /api/v3/health at the first address that answers: { ok, version, api: 3, mode, house? }, or
     * null when no address answered as a v3 server (a 0.9.3 server, or none reachable).
     */
    static JSONObject health(List<String> bases) {
        for (String a : bases) {
            if (a == null) continue;
            try {
                SyncDav.Response r = SyncDav.request("GET", URI.create(a + API3 + "/health"), new LinkedHashMap<>(), null, SyncDav.MAX_SMALL);
                if (r.status != 200) continue;
                JSONObject o = new JSONObject(r.text());
                o.put("_reached", a);
                return o;
            } catch (Exception e) {
                // the next address
            }
        }
        return null;
    }

    /**
     * POST /api/v3/join (no signature: the invite, or the member signature inside, is what counts) at
     * the first address that answers. Answers { sealed, _reached }. Throws with words.
     */
    static JSONObject join3(List<String> bases, JSONObject body) throws Exception {
        byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
        Exception last = null;
        for (String a : bases) {
            if (a == null) continue;
            SyncDav.Response r;
            try {
                Map<String, String> h = new LinkedHashMap<>();
                h.put("Content-Type", "application/json");
                r = SyncDav.request("POST", URI.create(a + API3 + "/join"), h, b, SyncDav.MAX_SMALL);
            } catch (Exception e) {
                last = e;
                continue;
            }
            if (r.status >= 200 && r.status < 300) {
                JSONObject o = new JSONObject(r.text());
                o.put("_reached", a);
                return o;
            }
            String err = errorOf(r);
            String said = messageOf(r);
            if ("not-empty".equals(err)) throw new NotEmptyException(said);
            if ("device-taken".equals(err))
                throw new SyncDav.Problem(said.isEmpty() ? "That phone is already on this server. Remove it on the server's Phones page first, then add it again." : said);
            if ("invite".equals(err)) throw new SyncDav.Problem("That code isn't from this server. Make a new one on the server's Add a phone page.");
            if (r.status == 410 || "used".equals(err) || "expired".equals(err))
                throw new SyncDav.Problem("That code has been used or has run out. Make a new one on the server's Add a phone page (each code works once, for 10 minutes).");
            if ("member".equals(err) || "removed".equals(err) || (body.optBoolean("member", false) && (r.status == 401 || r.status == 403)))
                throw new NotMember(said.isEmpty() ? "The server doesn't have this phone in its household. Add it on the server's Add a phone page instead." : said);
            if (r.status == 404) throw new SyncDav.Problem("That server needs updating to Restock server 0.9.4 for this code.");
            if (r.status == 429) throw new SyncDav.Problem("The server is busy. Try again in a minute.");
            if (!said.isEmpty()) throw new SyncDav.Problem(said);
            last = SyncDav.problem(r.status, "join");
        }
        if (last instanceof SyncDav.Problem) throw last;
        throw new SyncDav.Problem("Couldn't reach the Restock server. Check this phone is on the same network as the server (or the server's away address works), then try again.", last);
    }

    /** 0.9.4: a member join (no code) the server turned down: this phone isn't in its household (or was removed from it). */
    static final class NotMember extends Exception {
        NotMember(String m) {
            super(m);
        }
    }

    /** 0.9.4: a join that tried to bring a household onto a server whose house isn't empty (409 not-empty). */
    static final class NotEmptyException extends Exception {
        NotEmptyException(String m) {
            super(m == null || m.isEmpty() ? "That server already has a household." : m);
        }
    }

    /**
     * 0.9.4: a signed request to a full path (/api/v3/…) at the first address that answers, without a
     * listing first (an upgrade or a handover, which the v2 listing would turn down). Refusals from
     * the server itself are thrown as usual; the answer is given whatever its status.
     */
    SyncDav.Response first(String method, String fullPath, JSONObject body) throws Exception {
        byte[] b = body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8);
        Exception last = null;
        for (String a : bases) {
            if (a == null) continue;
            try {
                SyncDav.Response r = send(a, method, fullPath, b, SyncDav.MAX_SMALL);
                if (r.status == 404 && a != bases.get(bases.size() - 1)) {
                    last = failure(r, "do that");
                    continue;
                }
                base = a;
                return r;
            } catch (AccessException | UpdateException e) {
                throw e;
            } catch (Exception e) {
                last = e;
            }
        }
        throw last != null ? last : new Exception("no server address");
    }

    private String base() throws Exception {
        if (base == null) throw new Exception("the server wasn't reached");
        return base;
    }

    // ---------- signed requests ----------

    /** How far this device's clock is from each server's (ms), learnt when a request is turned down for it. */
    private static final Map<String, Long> SKEW = new java.util.concurrent.ConcurrentHashMap<>();
    private static final SecureRandom RANDOM = new SecureRandom();
    /** Tests only: pretend this device's clock is this far out. */
    static long testClockOffset = 0;

    private static long now() {
        return System.currentTimeMillis() + testClockOffset;
    }

    /** The Authorization header for a request (docs/server-protocol.md, Signed requests). */
    static String authorization(String device, PrivateKey key, String method, String pathAndQuery, long t, byte[] body) throws Exception {
        byte[] n = new byte[16];
        RANDOM.nextBytes(n);
        String nonce = ServerLink.b64u(n);
        String bodyHash = ServerLink.hex(ServerLink.sha256(body == null ? new byte[0] : body));
        String msg = method + "\n" + pathAndQuery + "\n" + t + "\n" + nonce + "\n" + bodyHash;
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(key);
        s.update(msg.getBytes(StandardCharsets.UTF_8));
        return "Restock2 d=" + device + ", t=" + t + ", n=" + nonce + ", s=" + java.util.Base64.getEncoder().encodeToString(s.sign());
    }

    private SyncDav.Response send(String b, String method, String path, byte[] body, int max) throws Exception {
        SyncDav.Response r = sendOnce(b, method, path, body, max);
        if (r.status == 401 && "clock".equals(errorOf(r))) {
            // The phone's clock is off: sign with the server's time instead (once).
            long server = 0;
            try {
                server = Long.parseLong(String.valueOf(r.header("x-restock-time")).trim());
            } catch (NumberFormatException ignored) {
                // no time given
            }
            if (server <= 0) throw new AccessException(CLOCK, false);
            SKEW.put(b, server - now());
            r = sendOnce(b, method, path, body, max);
            if (r.status == 401 && "clock".equals(errorOf(r))) throw new AccessException(CLOCK, false);
        }
        return r;
    }

    private SyncDav.Response sendOnce(String b, String method, String path, byte[] body, int max) throws Exception {
        URI u = URI.create(b + path);
        String target = u.getRawPath() + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
        Long skew = SKEW.get(b);
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Authorization", authorization(device, key, method, target, now() + (skew == null ? 0 : skew), body));
        if (body != null) h.put("Content-Type", path.startsWith(api + "/files/") ? (path.endsWith(".json") ? "application/json" : "application/octet-stream") : "application/json");
        SyncDav.Response r = SyncDav.request(method, u, h, body, max);
        if (r.status == 401 || r.status == 403) {
            String err = errorOf(r);
            if (err.equals("clock")) return r;
            if (err.equals("removed") || err.equals("device")) throw new AccessException(GONE, true);
            // 0.9.4: the household was handed to the server; this phone upgrades to v3 (ServerSync).
            if (err.equals("update") && api.equals(API)) throw new UpdateException(messageOf(r));
            String said = messageOf(r);
            throw new AccessException("The Restock server didn't accept this phone" + (said.isEmpty() ? "." : ": " + said) + " If it keeps happening, scan a new code from its Add a phone page.", false);
        }
        return r;
    }

    /** A request the server turned down with a reason (409, 400): its error code and words. */
    static final class Refused extends Exception {
        final String error;

        Refused(String error, String m) {
            super(m);
            this.error = error;
        }
    }

    /** The "error" in an answer's JSON, or "". */
    static String errorOf(SyncDav.Response r) {
        try {
            return new JSONObject(r.text()).optString("error", "");
        } catch (Exception e) {
            return "";
        }
    }

    /** The server's own words for a refusal ("message"), or "". */
    static String messageOf(SyncDav.Response r) {
        try {
            String m = new JSONObject(r.text()).optString("message", "").trim();
            return m.length() > 200 ? m.substring(0, 200) : m;
        } catch (Exception e) {
            return "";
        }
    }

    private static Exception failure(SyncDav.Response r, String doing) {
        if (r.status == 404) return new SyncDav.Problem("That address isn't a Restock server (or the server needs updating).");
        if (r.status == 413) return new SyncDav.Problem("The server says a file is too big, or it's full.");
        if (r.status == 429) return new SyncDav.Problem("The server is busy; Restock will try again.");
        if (r.status == 507) return new SyncDav.Problem("The server is full. Make room on it, or raise its size limit.");
        if (r.status >= 300 && r.status < 400) return new SyncDav.Problem("The server sent Restock somewhere else. Check its address (maybe https://).");
        return SyncDav.problem(r.status, doing);
    }
}
