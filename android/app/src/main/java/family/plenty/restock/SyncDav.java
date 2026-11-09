package family.plenty.restock;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONObject;

/**
 * Sync away from home through a WebDAV server (0.9.1): Nextcloud (signed in with Nextcloud's own
 * Login Flow v2, so Restock gets an app password of its own and never sees the person's main
 * password), or any other WebDAV server (ownCloud, Synology, QNAP, TrueNAS, Koofr, pCloud, kDrive,
 * Box and the like) with a user name and password.
 *
 * DavFolder is a SyncFolder.Folder: the same sealed one-file-per-phone format as a picked folder,
 * so everything in SyncFolder works the same. Only files named restock-sync-… are listed, read
 * or written, all inside the one folder.
 *
 * - https only, except for servers at home: an address on the local network (192.168.x.x, 10.x.x.x,
 *   172.16–31.x.x, a *.local name and the like) or on Tailscale (100.64.0.0/10). The name is looked
 *   up once and that address is the one connected to, so a name can't point somewhere else between
 *   the check and the connection. The certificate is checked as the phone checks any other.
 * - Each request has a connection timeout, a read timeout and an overall deadline, and every
 *   answer has a size limit (a sync file at most 32 MB, a folder list 4 MB, the rest 64 KB).
 * - Redirects are followed (three at most) only on the same server, so the password never goes
 *   anywhere else.
 *
 * Java's HttpURLConnection won't send WebDAV's PROPFIND and MKCOL (and Android's refuses plain
 * http to home servers by default), so this speaks HTTP/1.1 itself: one request per connection.
 *
 * No Android classes here, so it's tested on a computer too (tools/sync-test).
 */
final class SyncDav {
    static final int CONNECT_MS = 15_000;
    static final int READ_MS = 30_000;
    static final long REQUEST_MS = 120_000;
    static final int MAX_FILE = 32 * 1024 * 1024;
    static final int MAX_LIST = 4 * 1024 * 1024;
    static final int MAX_SMALL = 64 * 1024;
    private static final int MAX_HEADERS = 64 * 1024;
    /** Nextcloud names the app password after this (Settings → Security → Devices & sessions). */
    static final String USER_AGENT = "Restock (Android)";
    static final String DEFAULT_FOLDER = "Restock";

    private SyncDav() {}

    /** A problem in words for the person. */
    static final class Problem extends IOException {
        Problem(String m) {
            super(m);
        }

        Problem(String m, Throwable cause) {
            super(m, cause);
        }
    }

    // ---------- which servers ----------

    /** An address at home (or on Tailscale), where plain http is allowed. */
    static boolean privateAddress(InetAddress a) {
        if (a == null) return false;
        if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress()) return true;
        byte[] b = a.getAddress();
        if (a instanceof Inet4Address) {
            // Tailscale (and other carrier-grade NAT addresses): 100.64.0.0/10.
            return (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64;
        }
        if (a instanceof Inet6Address) {
            // Unique local addresses (fc00::/7), which home routers and Tailscale hand out.
            return (b[0] & 0xfe) == 0xfc;
        }
        return false;
    }

    /**
     * A typed server or folder address, tidied: "cloud.example.com" becomes https://cloud.example.com.
     * Throws a Problem for one Restock won't use (not http or https, a "user@" part, plain http to a
     * server that isn't at home is checked when connecting).
     */
    static URI address(String typed) throws Problem {
        String t = typed == null ? "" : typed.trim();
        if (t.isEmpty()) throw new Problem("Type the server's address.");
        if (!t.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) t = "https://" + t;
        URI u = Net.strictUri(t);
        if (u == null || u.getHost() == null || u.getHost().isEmpty()) throw new Problem("That doesn't look like a web address.");
        String scheme = u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) throw new Problem("Use an https:// address.");
        if (u.getRawQuery() != null) throw new Problem("Leave out anything after a \"?\" in the address.");
        try {
            String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
            return new URI(scheme + "://" + u.getRawAuthority() + path);
        } catch (Exception e) {
            throw new Problem("That doesn't look like a web address.");
        }
    }

    /** Where to connect for `u`: looked up once; for plain http, only an address at home. */
    static InetAddress resolve(URI u) throws Problem {
        String host = u.getHost().replace("[", "").replace("]", "");
        InetAddress[] all;
        try {
            all = InetAddress.getAllByName(host);
        } catch (java.net.UnknownHostException e) {
            throw new Problem("Couldn't find that server. Check the address and your connection.", e);
        }
        if (!"http".equalsIgnoreCase(u.getScheme())) return all[0];
        for (InetAddress a : all) if (privateAddress(a)) return a;
        throw new Problem("Restock only uses http:// for a server at home (like 192.168.1.20) or on Tailscale. Use the server's https:// address.");
    }

    // ---------- HTTP/1.1, one request per connection ----------

    static final class Response {
        int status;
        final Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];

        String header(String name) {
            return headers.get(name.toLowerCase(Locale.ROOT));
        }

        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    private static boolean android() {
        String vm = System.getProperty("java.vm.name", "");
        return vm.toLowerCase(Locale.ROOT).contains("dalvik") || System.getProperty("java.vendor", "").toLowerCase(Locale.ROOT).contains("android");
    }

    private static int port(URI u) {
        return u.getPort() > 0 ? u.getPort() : "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    private static boolean sameServer(URI a, URI b) {
        if (b.getHost() == null || !a.getHost().equalsIgnoreCase(b.getHost())) return false;
        if (a.getScheme().equalsIgnoreCase(b.getScheme())) return port(a) == port(b);
        // http → https on the same server is fine; the other way isn't.
        return "http".equalsIgnoreCase(a.getScheme()) && "https".equalsIgnoreCase(b.getScheme());
    }

    /** A request, following up to three redirects on the same server. */
    static Response request(String method, URI uri, Map<String, String> headers, byte[] body, int max) throws IOException {
        URI at = uri;
        for (int hop = 0; hop < 4; hop++) {
            Response r = once(method, at, headers, body, max);
            if (r.status != 301 && r.status != 302 && r.status != 307 && r.status != 308) return r;
            String loc = r.header("location");
            if (loc == null || hop == 3) return r;
            URI next;
            try {
                next = at.resolve(loc.trim());
            } catch (Exception e) {
                return r;
            }
            if (!sameServer(at, next)) throw new Problem("The server sent Restock to another server (" + next.getHost() + "). Use that address instead.");
            at = next;
        }
        throw new Problem("The server kept sending Restock somewhere else.");
    }

    private static Response once(String method, URI u, Map<String, String> headers, byte[] body, int max) throws IOException {
        InetAddress addr = resolve(u);
        long deadline = System.nanoTime() + REQUEST_MS * 1_000_000L;
        String host = u.getHost();
        int port = port(u);
        boolean tls = "https".equalsIgnoreCase(u.getScheme());
        Socket raw = new Socket();
        Socket s = raw;
        try {
            try {
                raw.connect(new InetSocketAddress(addr, port), CONNECT_MS);
                raw.setSoTimeout(READ_MS);
                if (tls) {
                    SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host.replace("[", "").replace("]", ""), port, true);
                    SSLParameters p = ssl.getSSLParameters();
                    p.setEndpointIdentificationAlgorithm("HTTPS");
                    ssl.setSSLParameters(p);
                    ssl.startHandshake();
                    // Android checks the name here too, as its own web requests do.
                    if (android() && !javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier().verify(host.replace("[", "").replace("]", ""), ssl.getSession()))
                        throw new SSLException("the certificate is for another name");
                    s = ssl;
                }
            } catch (SSLException e) {
                throw new Problem("The server's security certificate wasn't accepted, so Restock didn't connect.", e);
            } catch (Problem e) {
                throw e;
            } catch (IOException e) {
                throw new Problem("Couldn't reach the server. Check the address and your connection.", e);
            }
            String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
            StringBuilder req = new StringBuilder();
            req.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            boolean v6 = host.contains(":") && !host.startsWith("[");
            req.append("Host: ").append(v6 ? "[" + host + "]" : host);
            if (u.getPort() > 0) req.append(':').append(u.getPort());
            req.append("\r\n");
            req.append("User-Agent: ").append(USER_AGENT).append("\r\n");
            req.append("Connection: close\r\n");
            req.append("Accept-Encoding: identity\r\n");
            if (headers != null) for (Map.Entry<String, String> h : headers.entrySet()) {
                if (h.getValue().indexOf('\r') >= 0 || h.getValue().indexOf('\n') >= 0) throw new Problem("That can't be sent to the server.");
                req.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
            }
            if (body != null || "PUT".equals(method) || "POST".equals(method)) req.append("Content-Length: ").append(body == null ? 0 : body.length).append("\r\n");
            req.append("\r\n");
            try {
                OutputStream out = s.getOutputStream();
                out.write(req.toString().getBytes(StandardCharsets.UTF_8));
                if (body != null) out.write(body);
                out.flush();
                return readResponse(new BufferedInputStream(s.getInputStream()), method, max, deadline);
            } catch (Problem e) {
                throw e;
            } catch (IOException e) {
                throw new Problem("The connection to the server broke off. Try again.", e);
            }
        } finally {
            try {
                s.close();
            } catch (IOException ignored) {
                // closed
            }
            try {
                raw.close();
            } catch (IOException ignored) {
                // closed
            }
        }
    }

    private static String line(InputStream in, int[] budget) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (--budget[0] < 0) throw new Problem("The server's answer was too big.");
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        if (c < 0 && b.size() == 0) throw new IOException("ended early");
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static void check(long deadline) throws Problem {
        if (System.nanoTime() > deadline) throw new Problem("The server took too long to answer.");
    }

    static Response readResponse(InputStream in, String method, int max, long deadline) throws IOException {
        Response r = new Response();
        int[] budget = { MAX_HEADERS };
        String status;
        do {
            status = line(in, budget);
            String[] p = status.split(" ", 3);
            if (p.length < 2 || !p[0].startsWith("HTTP/")) throw new Problem("That isn't a web server's answer.");
            try {
                r.status = Integer.parseInt(p[1]);
            } catch (NumberFormatException e) {
                throw new Problem("That isn't a web server's answer.");
            }
            r.headers.clear();
            for (String h; !(h = line(in, budget)).isEmpty(); ) {
                int colon = h.indexOf(':');
                if (colon > 0) r.headers.put(h.substring(0, colon).trim().toLowerCase(Locale.ROOT), h.substring(colon + 1).trim());
            }
            check(deadline);
        } while (r.status >= 100 && r.status < 200);
        if ("HEAD".equals(method) || r.status == 204 || r.status == 304) return r;
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        String te = r.header("transfer-encoding");
        if (te != null && te.toLowerCase(Locale.ROOT).contains("chunked")) {
            while (true) {
                String sz = line(in, budget).trim();
                int semi = sz.indexOf(';');
                if (semi >= 0) sz = sz.substring(0, semi);
                long n;
                try {
                    n = Long.parseLong(sz, 16);
                } catch (NumberFormatException e) {
                    throw new Problem("The server's answer was garbled.");
                }
                if (n == 0) {
                    while (!line(in, budget).isEmpty()) {
                        // trailers
                    }
                    break;
                }
                if (body.size() + n > max) throw new Problem("The server's answer was too big.");
                long left = n;
                while (left > 0) {
                    int got = in.read(buf, 0, (int) Math.min(buf.length, left));
                    if (got < 0) throw new IOException("ended early");
                    body.write(buf, 0, got);
                    left -= got;
                    check(deadline);
                }
                line(in, budget); // the chunk's line break
            }
        } else {
            String cl = r.header("content-length");
            long n = -1;
            if (cl != null) {
                try {
                    n = Long.parseLong(cl.trim());
                } catch (NumberFormatException e) {
                    throw new Problem("The server's answer was garbled.");
                }
                if (n > max) throw new Problem("The server's answer was too big.");
            }
            long left = n < 0 ? Long.MAX_VALUE : n;
            while (left > 0) {
                int got = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (got < 0) {
                    if (n >= 0) throw new IOException("ended early");
                    break;
                }
                if (body.size() + got > max) throw new Problem("The server's answer was too big.");
                body.write(buf, 0, got);
                left -= got;
                check(deadline);
            }
        }
        r.body = body.toByteArray();
        return r;
    }

    /** Words for an answer that wasn't what Restock asked for. */
    static Problem problem(int status, String doing) {
        switch (status) {
            case 401:
                return new Problem("The server didn't accept the user name or password.");
            case 403:
                return new Problem("The server didn't let Restock " + doing + ".");
            case 404:
                return new Problem("That folder isn't on the server.");
            case 405:
                return new Problem("That address isn't a WebDAV folder.");
            case 409:
                return new Problem("The folder above that one isn't on the server.");
            case 413:
                return new Problem("The server said the file is too big.");
            case 423:
                return new Problem("That folder is locked on the server. Try again later.");
            case 507:
                return new Problem("The server is full.");
            default:
                if (status >= 500) return new Problem("The server had a problem (" + status + "). Try again later.");
                return new Problem("The server answered " + status + " when Restock tried to " + doing + ".");
        }
    }

    // ---------- names in addresses ----------

    /** One part of a path, encoded for an address. */
    static String encodeSegment(String s) {
        StringBuilder b = new StringBuilder();
        for (byte x : s.getBytes(StandardCharsets.UTF_8)) {
            int c = x & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~') b.append((char) c);
            else b.append('%').append(String.format("%02X", c));
        }
        return b.toString();
    }

    static String decodePath(String s) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < s.length()) {
                try {
                    b.write(Integer.parseInt(s.substring(i + 1, i + 3), 16));
                    i += 2;
                    continue;
                } catch (NumberFormatException ignored) {
                    // a plain "%"
                }
            }
            byte[] x = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
            b.write(x, 0, x.length);
        }
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }

    /** A folder name the person typed: one name, no slashes. Empty: "Restock". */
    static String folderName(String typed) throws Problem {
        String f = typed == null ? "" : typed.trim();
        if (f.isEmpty()) return DEFAULT_FOLDER;
        if (f.length() > 100) throw new Problem("That folder name is too long.");
        if (f.contains("/") || f.contains("\\") || f.equals(".") || f.equals("..")) throw new Problem("Use a folder name without slashes, like Restock.");
        for (char c : f.toCharArray()) if (c < 0x20 || c == 0x7f) throw new Problem("That folder name has a character Restock can't use.");
        return f;
    }

    /** The folder's address: `url` (a WebDAV address) with `folder` inside it ("" for the address itself). */
    static String folderUrl(String url, String folder) throws Problem {
        URI u = address(url);
        String base = u.toString();
        if (!base.endsWith("/")) base += "/";
        String f = folder == null ? DEFAULT_FOLDER : folder.trim();
        if (f.isEmpty()) return base;
        return base + encodeSegment(folderName(f)) + "/";
    }

    /** Nextcloud's WebDAV folder for a signed-in user: {server}/remote.php/dav/files/{loginName}/{folder}/. */
    static String nextcloudFolderUrl(String server, String loginName, String folder) throws Problem {
        String base = address(server).toString();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/remote.php/dav/files/" + encodeSegment(loginName) + "/" + encodeSegment(folderName(folder)) + "/";
    }

    /** "cloud.example.com · Restock", for the Sync screen. */
    static String describe(String url) {
        try {
            URI u = new URI(url);
            String p = u.getRawPath() == null ? "" : u.getRawPath();
            while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
            String last = p.substring(p.lastIndexOf('/') + 1);
            return u.getHost() + (last.isEmpty() ? "" : " · " + decodePath(last));
        } catch (Exception e) {
            return url;
        }
    }

    // ---------- the folder ----------

    private static final String FIELD = "<(?:[A-Za-z0-9_.-]+:)?%1$s\\b[^>]*>(.*?)</(?:[A-Za-z0-9_.-]+:)?%1$s\\s*>";
    private static final Pattern RESPONSE = Pattern.compile(String.format(FIELD, "response"), Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern HREF = Pattern.compile(String.format(FIELD, "href"), Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern ETAG = Pattern.compile(String.format(FIELD, "getetag"), Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern MODIFIED = Pattern.compile(String.format(FIELD, "getlastmodified"), Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern LENGTH = Pattern.compile(String.format(FIELD, "getcontentlength"), Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern COLLECTION = Pattern.compile("<(?:[A-Za-z0-9_.-]+:)?collection\\b", Pattern.CASE_INSENSITIVE);

    static String unescapeXml(String s) {
        Matcher m = Pattern.compile("&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);").matcher(s);
        StringBuffer b = new StringBuffer();
        while (m.find()) {
            String e = m.group(1);
            String r;
            switch (e) {
                case "lt": r = "<"; break;
                case "gt": r = ">"; break;
                case "amp": r = "&"; break;
                case "quot": r = "\""; break;
                case "apos": r = "'"; break;
                default:
                    int cp = e.startsWith("#x") ? Integer.parseInt(e.substring(2), 16) : Integer.parseInt(e.substring(1));
                    r = new String(Character.toChars(cp));
            }
            m.appendReplacement(b, Matcher.quoteReplacement(r));
        }
        m.appendTail(b);
        return b.toString().trim();
    }

    private static String field(Pattern p, String in) {
        Matcher m = p.matcher(in);
        return m.find() ? unescapeXml(m.group(1)) : null;
    }

    private static final String PROPFIND = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        + "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>";

    /** A folder on a WebDAV server, as SyncFolder needs it. */
    static final class DavFolder implements SyncFolder.Folder {
        final URI base;
        private final String auth;
        private final Map<String, String> versions = new HashMap<>();

        /** `url`: the folder's own address (ending in "/"). */
        DavFolder(String url, String user, String password) throws Problem {
            String u = url.endsWith("/") ? url : url + "/";
            this.base = address(u);
            this.auth = user == null || user.isEmpty() ? null
                : "Basic " + Base64.getEncoder().encodeToString((user + ":" + (password == null ? "" : password)).getBytes(StandardCharsets.UTF_8));
        }

        private Map<String, String> headers() {
            Map<String, String> h = new LinkedHashMap<>();
            if (auth != null) h.put("Authorization", auth);
            return h;
        }

        private URI file(String name) {
            if (!name.startsWith(SyncFolder.PREFIX) || name.contains("/") || name.contains("\\")) throw new IllegalArgumentException("not a sync file");
            return base.resolve(encodeSegment(name));
        }

        /** Makes the folder if it isn't there yet, then checks it's a WebDAV folder Restock may use. */
        void ensure() throws IOException {
            Response mk = request("MKCOL", base, headers(), null, MAX_SMALL);
            // 201: made. 405: already there. Anything else is looked at below.
            if (mk.status == 401) throw problem(401, "open the folder");
            if (mk.status == 409) throw problem(409, "make the folder");
            if (mk.status == 507) throw problem(507, "make the folder");
            Map<String, String> h = headers();
            h.put("Depth", "0");
            h.put("Content-Type", "application/xml; charset=utf-8");
            Response pf = request("PROPFIND", base, h, PROPFIND.getBytes(StandardCharsets.UTF_8), MAX_SMALL);
            if (pf.status != 207) throw problem(pf.status, "open the folder");
            if (!COLLECTION.matcher(pf.text()).find()) throw new Problem("That address is a file, not a folder.");
        }

        @Override
        public List<String> names() throws Exception {
            Map<String, String> h = headers();
            h.put("Depth", "1");
            h.put("Content-Type", "application/xml; charset=utf-8");
            Response r = request("PROPFIND", base, h, PROPFIND.getBytes(StandardCharsets.UTF_8), MAX_LIST);
            if (r.status != 207) throw problem(r.status, "look in the folder");
            versions.clear();
            List<String> out = new ArrayList<>();
            String self = trimSlash(decodePath(base.getRawPath()));
            Matcher m = RESPONSE.matcher(r.text());
            while (m.find()) {
                String part = m.group(1);
                String href = field(HREF, part);
                if (href == null || COLLECTION.matcher(part).find()) continue;
                String path;
                try {
                    path = URI.create(href.replace(" ", "%20")).getRawPath();
                } catch (Exception bad) {
                    continue;
                }
                if (path == null) continue;
                String p = trimSlash(decodePath(path));
                if (p.equals(self)) continue;
                String name = p.substring(p.lastIndexOf('/') + 1);
                if (!name.startsWith(SyncFolder.PREFIX) || out.contains(name)) continue;
                out.add(name);
                String etag = field(ETAG, part);
                String mod = field(MODIFIED, part);
                String len = field(LENGTH, part);
                versions.put(name, etag != null && !etag.isEmpty() ? "e:" + etag : mod != null && len != null ? mod + ":" + len : null);
            }
            return out;
        }

        private static String trimSlash(String p) {
            String x = p;
            while (x.endsWith("/")) x = x.substring(0, x.length() - 1);
            return x;
        }

        @Override
        public String version(String name) {
            return versions.get(name);
        }

        @Override
        public byte[] read(String name) throws Exception {
            Response r = request("GET", file(name), headers(), null, MAX_FILE);
            if (r.status == 404) return null;
            if (r.status != 200) throw problem(r.status, "read " + name);
            return r.body;
        }

        @Override
        public void write(String name, byte[] data) throws Exception {
            Map<String, String> h = headers();
            h.put("Content-Type", name.endsWith(".json") ? "application/json" : "application/octet-stream");
            Response r = request("PUT", file(name), h, data, MAX_SMALL);
            if (r.status != 200 && r.status != 201 && r.status != 204) throw problem(r.status, "save " + name);
        }

        @Override
        public void delete(String name) throws Exception {
            Response r = request("DELETE", file(name), headers(), null, MAX_SMALL);
            if (r.status != 200 && r.status != 204 && r.status != 404) throw problem(r.status, "delete " + name);
        }
    }

    // ---------- Nextcloud Login Flow v2 ----------

    /** A sign-in under way: the page to open in the browser, and where to ask whether it's done. */
    static final class Login {
        final URI server;
        final URI login;
        final URI endpoint;
        final String token;

        Login(URI server, URI login, URI endpoint, String token) {
            this.server = server;
            this.login = login;
            this.endpoint = endpoint;
            this.token = token;
        }
    }

    /** What Nextcloud gave Restock: its address, the user's login name and an app password just for Restock. */
    static final class Signin {
        String server;
        String loginName;
        String appPassword;
    }

    /** The server part of a typed Nextcloud address (anything from /index.php or /apps/ on is dropped). */
    static URI nextcloudServer(String typed) throws Problem {
        URI u = address(typed);
        String p = u.getRawPath() == null ? "" : u.getRawPath();
        for (String cut : new String[] { "/index.php", "/apps/", "/remote.php", "/login" }) {
            int i = p.indexOf(cut);
            if (i >= 0) p = p.substring(0, i);
        }
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        try {
            return new URI(u.getScheme() + "://" + u.getRawAuthority() + p);
        } catch (Exception e) {
            throw new Problem("That doesn't look like a web address.");
        }
    }

    private static URI checked(String s, URI server) throws Problem {
        URI u = address(s);
        if ("http".equalsIgnoreCase(u.getScheme()) && !"http".equalsIgnoreCase(server.getScheme())) throw new Problem("Nextcloud answered with an address Restock won't use.");
        return u;
    }

    /** Starts signing in: Nextcloud makes a sign-in page for Restock (open `login` in the browser). */
    static Login startLogin(String typed) throws IOException {
        URI server = nextcloudServer(typed);
        Response r = request("POST", URI.create(server + "/index.php/login/v2"), new LinkedHashMap<>(), new byte[0], MAX_SMALL);
        // Nextcloud's sign-in start never asks for a password, and is always there.
        if (r.status == 404 || r.status == 401 || r.status == 403 || r.status == 405) throw new Problem("That doesn't look like a Nextcloud server. Check the address.");
        if (r.status != 200) throw problem(r.status, "start signing in");
        try {
            JSONObject j = new JSONObject(r.text());
            JSONObject poll = j.getJSONObject("poll");
            String token = poll.getString("token");
            if (token.isEmpty() || token.length() > 1000) throw new Problem("Nextcloud's answer was garbled.");
            return new Login(server, checked(j.getString("login"), server), checked(poll.getString("endpoint"), server), token);
        } catch (Problem p) {
            throw p;
        } catch (Exception e) {
            throw new Problem("That doesn't look like a Nextcloud server (its answer wasn't what Nextcloud sends).");
        }
    }

    /**
     * Tells Nextcloud to delete Restock's app password (Restock let go of it: Stop, signing in
     * again, leaving the household, Erase everything). Best effort: true if Nextcloud said done.
     */
    static boolean revokeNextcloud(String folderUrl, String loginName, String appPassword) {
        try {
            int i = folderUrl == null ? -1 : folderUrl.indexOf("/remote.php/dav/files/");
            if (i < 0 || appPassword == null || appPassword.isEmpty()) return false;
            Map<String, String> h = new LinkedHashMap<>();
            h.put("Authorization", "Basic " + Base64.getEncoder().encodeToString((loginName + ":" + appPassword).getBytes(StandardCharsets.UTF_8)));
            h.put("OCS-APIRequest", "true");
            Response r = request("DELETE", address(folderUrl.substring(0, i) + "/ocs/v2.php/core/apppassword"), h, null, MAX_SMALL);
            return r.status == 200;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Waits for the person to finish signing in in the browser: asks every `everyMs` (2 s on the
     * phone), for up to `maxMs` (20 minutes). Null if `cancelled` says stop.
     */
    static Signin pollLogin(Login l, java.util.function.BooleanSupplier cancelled, long everyMs, long maxMs) throws Exception {
        long until = System.currentTimeMillis() + maxMs;
        byte[] body = ("token=" + java.net.URLEncoder.encode(l.token, "UTF-8")).getBytes(StandardCharsets.UTF_8);
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Content-Type", "application/x-www-form-urlencoded");
        int failures = 0;
        while (true) {
            if (cancelled.getAsBoolean()) return null;
            Response r = null;
            try {
                r = request("POST", l.endpoint, h, body, MAX_SMALL);
                failures = 0;
            } catch (Problem p) {
                // A blip on the connection: keep trying for a while.
                if (++failures >= 15) throw p;
            }
            if (r != null && r.status == 200) {
                JSONObject j;
                try {
                    j = new JSONObject(r.text());
                } catch (Exception e) {
                    throw new Problem("Nextcloud's answer was garbled. Try signing in again.");
                }
                Signin s = new Signin();
                s.server = checked(j.optString("server", ""), l.server).toString();
                s.loginName = j.optString("loginName", "");
                s.appPassword = j.optString("appPassword", "");
                if (s.loginName.isEmpty() || s.appPassword.isEmpty()) throw new Problem("Nextcloud didn't finish signing Restock in. Try again.");
                while (s.server.endsWith("/")) s.server = s.server.substring(0, s.server.length() - 1);
                return s;
            }
            if (r != null && r.status != 404) throw problem(r.status, "finish signing in");
            if (System.currentTimeMillis() > until) throw new Problem("Signing in took too long. Try again.");
            for (long waited = 0; waited < everyMs; waited += 100) {
                if (cancelled.getAsBoolean()) return null;
                Thread.sleep(Math.min(100, everyMs));
            }
        }
    }
}
