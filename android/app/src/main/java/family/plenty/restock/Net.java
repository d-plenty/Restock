package family.plenty.restock;

/** Small network helpers shared by the background code. */
final class Net {
    private Net() {}

    /**
     * A web address as a URL. Goes through URI (Java 20+ deprecates new URL(String)); an address
     * URI won't take, such as one with an unencoded space, falls back to the old way so nothing
     * that worked before stops working.
     */
    @SuppressWarnings("deprecation")
    static java.net.URL url(String s) throws java.net.MalformedURLException {
        try {
            return java.net.URI.create(s).toURL();
        } catch (IllegalArgumentException e) {
            return new java.net.URL(s);
        }
    }

    /**
     * 0.9.0: a web address read strictly, for deciding which site it's on, or null. A browser reads
     * some addresses differently from Java's old URL class (it takes "\" as "/", and quietly drops
     * tabs and line breaks anywhere and spaces at the ends), which could make an address look like
     * the shop's site to Restock while the browser goes somewhere else. So those, and any "user@"
     * part, are refused outright. Spaces inside it and a few other characters a browser would
     * encode itself (such as "|") are encoded first, and anything after "#" is left out (it never
     * changes the site).
     */
    static java.net.URI strictUri(String s) {
        if (s == null || s.isEmpty() || s.charAt(0) <= 0x20 || s.charAt(s.length() - 1) <= 0x20) return null;
        int hash = s.indexOf('#');
        if (hash >= 0) s = s.substring(0, hash);
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch < 0x20 || ch == 0x7f || ch == '\\') return null;
            if (" \"<>`{}|^".indexOf(ch) >= 0) b.append('%').append(Integer.toHexString(0x100 | ch).substring(1).toUpperCase(java.util.Locale.ROOT));
            else b.append(ch);
        }
        try {
            java.net.URI u = new java.net.URI(b.toString());
            return u.getRawUserInfo() != null ? null : u;
        } catch (java.net.URISyntaxException e) {
            return null;
        }
    }

    // ---------- 0.9.1: requests that don't go with the in-app browser's cookies ----------

    /**
     * Every plain request in the app (java.net.HttpURLConnection, which CapacitorHttp uses too) asks
     * one cookie handler, shared by the whole app, which cookies to send and where to keep the ones
     * that come back. Capacitor sets that to the in-app browser's own cookies (android.webkit.
     * CookieManager: the ones StoreWeb's hidden pages and "Open Woolworths" use, where you sign in).
     * So until 0.9.1 a barcode lookup at Woolworths went with the account you'd signed in to there,
     * and anything Woolworths set came back into the browser.
     *
     * This handler sits in front of Capacitor's. A request made inside {@link #anonymous}, on a
     * connection from {@link #open}, uses only the jar it was given (kept in memory, never the
     * browser's cookies). Every other request goes to Capacitor's handler, as before.
     */
    static final class Cookies extends java.net.CookieHandler {
        static final Cookies INSTANCE = new Cookies();
        /** The jar for requests on this thread, inside {@link #anonymous}; null outside. */
        static final ThreadLocal<java.net.CookieHandler> own = new ThreadLocal<>();
        /** Whatever handled cookies before (Capacitor's, the browser's cookies), or null. */
        volatile java.net.CookieHandler shared;

        private java.net.CookieHandler now() {
            java.net.CookieHandler h = own.get();
            return h != null ? h : shared;
        }

        @Override
        public java.util.Map<String, java.util.List<String>> get(java.net.URI uri, java.util.Map<String, java.util.List<String>> headers) throws java.io.IOException {
            java.net.CookieHandler h = now();
            return h == null ? java.util.Collections.emptyMap() : h.get(uri, headers);
        }

        @Override
        public void put(java.net.URI uri, java.util.Map<String, java.util.List<String>> headers) throws java.io.IOException {
            java.net.CookieHandler h = now();
            if (h != null) h.put(uri, headers);
        }
    }

    /** Sends no cookies and keeps none (for code with its own jar, such as StoreClient). */
    static final java.net.CookieHandler NO_COOKIES = new java.net.CookieHandler() {
        @Override
        public java.util.Map<String, java.util.List<String>> get(java.net.URI uri, java.util.Map<String, java.util.List<String>> headers) {
            return java.util.Collections.emptyMap();
        }

        @Override
        public void put(java.net.URI uri, java.util.Map<String, java.util.List<String>> headers) {
            // kept nowhere
        }
    };

    private static final java.util.Map<String, java.net.CookieManager> jars = new java.util.concurrent.ConcurrentHashMap<>();

    /** A named jar ("lookup"), in memory only: gone when Restock closes, or with {@link #forgetJars}. */
    static java.net.CookieHandler jar(String name) {
        return jars.computeIfAbsent(name, n -> new java.net.CookieManager(null, java.net.CookiePolicy.ACCEPT_ORIGINAL_SERVER));
    }

    /** Erase everything: the named jars too. */
    static void forgetJars() {
        jars.clear();
    }

    /** Puts {@link Cookies} in front of the app's cookie handler, if something has replaced it since. */
    static synchronized void installCookies() {
        java.net.CookieHandler now = java.net.CookieHandler.getDefault();
        if (now == Cookies.INSTANCE) return;
        Cookies.INSTANCE.shared = now;
        java.net.CookieHandler.setDefault(Cookies.INSTANCE);
    }

    /** Until closed, requests on this thread (on connections from {@link #open}) use only `jar`. */
    static final class Scope implements AutoCloseable {
        private final java.net.CookieHandler before = Cookies.own.get();

        Scope(java.net.CookieHandler jar) {
            Cookies.own.set(jar);
        }

        @Override
        public void close() {
            if (before == null) Cookies.own.remove();
            else Cookies.own.set(before);
        }
    }

    /** try (Net.Scope s = Net.anonymous(Net.jar("lookup"))) { c = Net.open(url); ... } */
    static Scope anonymous(java.net.CookieHandler jar) {
        return new Scope(jar);
    }

    /**
     * A connection that's sure to ask {@link Cookies}, so the thread's {@link Scope} applies.
     * Android's HttpURLConnection takes the app's cookie handler when it's opened, and Capacitor
     * sets its own again whenever Restock's screen is made afresh. So this puts ours back in front,
     * opens, and checks nothing swapped it in between (nothing has been sent yet if so).
     */
    static java.net.HttpURLConnection open(java.net.URL u) throws java.io.IOException {
        for (int i = 0; i < 3; i++) {
            synchronized (Net.class) {
                installCookies();
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) u.openConnection();
                if (java.net.CookieHandler.getDefault() == Cookies.INSTANCE) return c;
                c.disconnect();
            }
        }
        throw new java.io.IOException("Couldn't make the request on its own cookies. Try again.");
    }

    /** What {@link #plainFetch} got back. Set-Cookie is left out of the headers (it's in the jar). */
    static final class Answer {
        int status;
        String body;
        final java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
    }

    /**
     * A request with the named jar's cookies only (see {@link Cookies}). For RestockNativePlugin.
     * plainFetch: barcode lookups at the shops. A Cookie header from the caller is ignored.
     */
    static Answer plainFetch(String jarName, String method, String url, java.util.Map<String, String> headers, String body, int readTimeoutMs) throws Exception {
        try (Scope s = anonymous(jar(jarName))) {
            java.net.HttpURLConnection c = open(url(url));
            try {
                c.setRequestMethod(method);
                c.setConnectTimeout(15_000);
                c.setReadTimeout(readTimeoutMs);
                c.setInstanceFollowRedirects(true);
                c.setUseCaches(false);
                boolean typed = false;
                for (java.util.Map.Entry<String, String> e : headers.entrySet()) {
                    if (e.getKey() == null || e.getValue() == null || "cookie".equalsIgnoreCase(e.getKey())) continue;
                    c.setRequestProperty(e.getKey(), e.getValue());
                    typed |= "content-type".equalsIgnoreCase(e.getKey());
                }
                if (body != null) {
                    c.setDoOutput(true);
                    if (!typed) c.setRequestProperty("Content-Type", "application/json");
                    try (java.io.OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    }
                }
                Answer a = new Answer();
                a.status = c.getResponseCode();
                for (java.util.Map.Entry<String, java.util.List<String>> e : c.getHeaderFields().entrySet()) {
                    if (e.getKey() == null || e.getKey().toLowerCase(java.util.Locale.ROOT).startsWith("set-cookie")) continue;
                    a.headers.put(e.getKey(), String.join(", ", e.getValue()));
                }
                java.io.InputStream in = a.status >= 400 ? c.getErrorStream() : c.getInputStream();
                a.body = in == null ? "" : StoreClient.readAll(in);
                return a;
            } finally {
                c.disconnect();
            }
        }
    }
}
