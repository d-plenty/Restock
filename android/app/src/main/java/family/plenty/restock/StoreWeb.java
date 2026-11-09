package family.plenty.restock;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.view.View;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * Talks to a store through a hidden copy of Android's own web browser (Android System WebView).
 *
 * Bot protection (Coles especially) turns away plain app requests, but lets a real browser
 * through once the page's own checks have run. So this opens the store's website out of sight,
 * lets it settle, then makes the store's own data requests from inside that page, exactly as
 * the website does. Coles always goes this way; Woolworths and Aldi use it as a backup when a
 * direct request fails, or always if the user picks that in Settings.
 *
 * If a store still wants a person to prove they're human, {@link #showUnblock} opens the same
 * site on screen so the user can clear it; the cookies it leaves are then used here too.
 */
final class StoreWeb implements StoreClient.WebFetcher {
    private static final String TAG = "RestockWeb";
    private static final long FRESH_MS = 25 * 60_000L;
    private static final Map<String, StoreWeb> instances = new java.util.HashMap<>();

    static String home(String chain) {
        String site = Shops.website(chain);
        if (site == null) return "https://www.aldi.com.au/";
        return site.endsWith("/") ? site : site + "/";
    }

    // ---------- 0.9.0: staying on the shop's own site ----------

    /**
     * Other sites of the same shop that its pages may go to (signing in, its rewards program).
     * Each also covers its subdomains.
     */
    private static String[] alsoAllowed(String chain) {
        if ("woolworths".equals(chain)) return new String[] {"everyday.com.au", "woolworthsrewards.com.au"};
        if ("coles".equals(chain)) return new String[] {"flybuys.com.au"};
        return new String[0];
    }

    /** The shop's website without "www." ("coles.com.au"), or null for a shop Restock doesn't know. */
    private static String siteHost(String chain) {
        java.net.URI u = Net.strictUri(Shops.website(chain));
        String h = u == null ? null : u.getHost();
        return h == null ? null : h.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
    }

    /**
     * Is `url` a secure page on the shop's own site: its website's domain or one under it
     * ("api.coles.com.au"), or one of {@link #alsoAllowed}? Compares the address's real host, so
     * "https://www.coles.com.au.example.net/" or "https://www.coles.com.au@example.net/" isn't Coles.
     */
    static boolean onShopSite(String chain, String url) {
        java.net.URI u = Net.strictUri(url);
        if (u == null || !"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null) return false;
        String host = u.getHost().toLowerCase(Locale.ROOT);
        String site = siteHost(chain);
        if (site != null && (host.equals(site) || host.endsWith("." + site))) return true;
        for (String h : alsoAllowed(chain)) if (host.equals(h) || host.endsWith("." + h)) return true;
        return false;
    }

    /**
     * `url` (a full address, or a path such as "/api/...") as a full address on the shop's own
     * site, or null if it isn't one. A path is read against the shop's home page, so "//elsewhere"
     * and "/\elsewhere" (which a browser reads as another site) are refused.
     */
    static String onSite(String chain, String url) {
        if (url == null || url.startsWith("//")) return null;
        java.net.URI u = Net.strictUri(url);
        java.net.URI base = Net.strictUri(home(chain));
        if (u == null || base == null) return null;
        try {
            String full = base.resolve(u).toString();
            return onShopSite(chain, full) ? full : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** The host part of an address, for showing it ("www.coles.com.au"), or "" when there isn't one. */
    static String hostOf(String url) {
        java.net.URI u = Net.strictUri(url);
        return u == null || u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
    }

    private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();

    /**
     * A new random code for one request into the page. Only the answer carrying it is accepted, so
     * other scripts on the page (or an ad in a frame, which can see RestockWeb too) can't answer for it.
     */
    private static String token() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        StringBuilder s = new StringBuilder(32);
        for (byte x : b) s.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
        return s.toString();
    }

    /** A hidden page left alone this long is blanked, so the shop's scripts don't keep running. */
    private static final long IDLE_MS = 2 * 60_000L;

    private final Context app;
    private final String chain;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, String[]> results = new ConcurrentHashMap<>();
    private final Map<String, CountDownLatch> waiting = new ConcurrentHashMap<>();
    private WebView web;
    private volatile CountDownLatch pageLatch;
    private volatile long loadedAt;
    /** HTTP status of the last page opened (0 when Android doesn't say). */
    private volatile int pageStatus;
    /** 0.9.0: the address the hidden page is at, as last reported by the page itself. */
    private volatile String pageUrl;
    /** 0.9.0: requests under way (changed only while holding this object's lock). */
    private volatile int busy;
    /** 0.9.0: blanks the hidden page (on the main thread), unless a request is under way. */
    private final Runnable idle = () -> {
        if (busy > 0 || web == null) return;
        loadedAt = 0;
        web.loadUrl("about:blank");
    };

    private StoreWeb(Context app, String chain) {
        this.app = app;
        this.chain = chain;
    }

    /** 0.9.0: a request is starting (call holding the lock). */
    private void begin() {
        busy++;
        main.removeCallbacks(idle);
    }

    /** 0.9.0: a request is over (call holding the lock): blank the page if nothing else comes along. */
    private void end() {
        busy--;
        main.removeCallbacks(idle);
        main.postDelayed(idle, IDLE_MS);
    }

    /** 0.9.0: blanks every hidden shop page now (after Check now, and when everything is erased). */
    static void blankAll() {
        java.util.List<StoreWeb> all;
        synchronized (StoreWeb.class) {
            all = new java.util.ArrayList<>(instances.values());
        }
        for (StoreWeb w : all) {
            w.main.removeCallbacks(w.idle);
            w.main.post(w.idle);
        }
    }

    static synchronized StoreWeb get(Context context, String chain) {
        StoreWeb w = instances.get(chain);
        if (w == null) {
            w = new StoreWeb(context.getApplicationContext(), chain);
            instances.put(chain, w);
        }
        return w;
    }

    /** For StoreClient: picks the right store's page. */
    static StoreClient.WebFetcher forAll(Context context) {
        final Context app = context.getApplicationContext();
        return new StoreClient.WebFetcher() {
            @Override
            public String[] fetch(String chain, String method, String url, String body) throws Exception {
                return get(app, chain).get(method, url, body);
            }

            @Override
            public String[] productPage(String chain, String url) throws Exception {
                return get(app, chain).productPage(url);
            }
        };
    }

    /** Forget the loaded page, so the next request starts fresh (e.g. after the user clears a "are you human" check). */
    void reset() {
        loadedAt = 0;
    }

    @Override
    public String[] fetch(String chain, String method, String url, String body) throws Exception {
        return get(app, chain).get(method, url, body);
    }

    @Override
    public String[] productPage(String chain, String url) throws Exception {
        return get(app, chain).productPage(url);
    }

    /** Opens a product page and reads its price there. Returns {status, product JSON}. */
    synchronized String[] productPage(String url) throws Exception {
        begin();
        try {
            String[] page = render(url);
            String[] product = productHere();
            return new String[] {page[0], product[1]};
        } finally {
            end();
        }
    }

    /**
     * Make a request from inside the store's page, from a background thread. `url` is a path on
     * the store's site ("/api/...") or a full address the site itself uses. For Coles the
     * subscription key is added inside the page. Returns {status, body}.
     */
    synchronized String[] get(String method, String url, String body) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("StoreWeb.get must not run on the main thread");
        begin();
        try {
            ensurePage(false);
            String[] r = run(method, url, body);
            if (looksBlocked(r)) {
                Log.i(TAG, chain + ": first try blocked (" + r[0] + "), reloading and trying again");
                ensurePage(true);
                r = run(method, url, body);
            }
            return r;
        } finally {
            end();
        }
    }

    static boolean looksBlocked(String[] r) {
        int status = Integer.parseInt(r[0]);
        String body = r[1] == null ? "" : r[1].trim();
        return status == 403 || status == 429 || status <= 0 || body.startsWith("<");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private static void setUp(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setBlockNetworkImage(true);
        // 0.9.0: a shop's page has no business reading the phone's content (content://) or files.
        s.setAllowContentAccess(false);
        s.setAllowFileAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
    }

    private void ensurePage(boolean force) throws Exception {
        if (!force && loadedAt > 0 && System.currentTimeMillis() - loadedAt < FRESH_MS) return;
        ensureWebView();
        final CountDownLatch latch = new CountDownLatch(1);
        pageLatch = latch;
        final String home = home(chain);
        main.post(() -> web.loadUrl(home));
        if (!latch.await(40, TimeUnit.SECONDS)) Log.w(TAG, chain + " page slow to load; trying anyway");
        loadedAt = System.currentTimeMillis();
    }

    private String[] run(String method, String url, String body) throws Exception {
        final String id = token();
        CountDownLatch done = new CountDownLatch(1);
        waiting.put(id, done);
        boolean coles = "coles".equals(chain);
        final String js = "(function(){var id=" + JSONObject.quote(id) + ";"
            + "try{var url=" + JSONObject.quote(url) + ";"
            + (coles
                ? "var key=window.__restockKey;"
                    + "if(!key){var m=document.documentElement.innerHTML.match(/BFF_API_SUBSCRIPTION_KEY[\"']?\\s*:\\s*[\"']([^\"']+)[\"']/);if(m){key=m[1];window.__restockKey=key;}}"
                    + "if(!key){try{key=window.__NEXT_DATA__.runtimeConfig.BFF_API_SUBSCRIPTION_KEY;window.__restockKey=key;}catch(e){}}"
                    + "if(!key){RestockWeb.done(id,0,'no key: '+document.title);return;}"
                    + "url+=(url.indexOf('?')<0?'?':'&')+'subscription-key='+encodeURIComponent(key);"
                : "")
            + "var o={method:" + JSONObject.quote(method) + ",headers:{Accept:'application/json, text/plain, */*'}};"
            + (body != null ? "o.body=" + JSONObject.quote(body) + ";o.headers['Content-Type']='application/json';" : "")
            + "fetch(url,o)"
            + ".then(function(r){return r.text().then(function(t){RestockWeb.done(id,r.status,t);});})"
            + ".catch(function(e){RestockWeb.done(id,-1,String(e));});"
            + "}catch(e){RestockWeb.done(id,-1,String(e));}})();";
        main.post(() -> web.evaluateJavascript(js, null));
        boolean ok = done.await(30, TimeUnit.SECONDS);
        waiting.remove(id);
        String[] r = results.remove(id);
        if (!ok || r == null) return new String[] {"-1", "The store took too long to answer"};
        return r;
    }

    /**
     * Opens `url` (a page on this shop's website) in the hidden browser, waits for the page's
     * scripts to draw its products, and returns {status, html, finalUrl}. Used for shop websites
     * that build their pages with scripts, or that turn away plain requests.
     */
    synchronized String[] render(String url) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("StoreWeb.render must not run on the main thread");
        // 0.9.0: read strictly (onShopSite), so an address can't look like the shop's to Restock
        // while the browser reads it as another site.
        if (!onShopSite(chain, url)) throw new IllegalArgumentException("Not a page on " + chain + "'s website");
        begin();
        try {
            return renderHere(url);
        } finally {
            end();
        }
    }

    private String[] renderHere(String url) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        pageLatch = latch;
        pageStatus = 200;
        ensureWebView();
        main.post(() -> web.loadUrl(url));
        if (!latch.await(40, TimeUnit.SECONDS)) Log.w(TAG, chain + " page slow to load; reading what's there");
        loadedAt = System.currentTimeMillis();
        // A bot check ("Just a moment…", "Checking your browser") usually clears itself and then
        // loads the real page. Give it up to about 15 seconds before reading anything.
        for (int i = 0; i < 15 && looksLikeCheck(evalForText(CHECK_JS)[1]); i++) Thread.sleep(1000);
        // Let the page draw: scroll down through it (so pictures and results that load as you
        // scroll appear), and wait until its prices stop changing (up to about 12 seconds).
        String last = "";
        int steady = 0;
        for (int i = 0; i < 16; i++) {
            String[] probe = evalForText(
                "(function(){var h=document.body?document.body.scrollHeight:0;window.scrollTo(0,Math.min(h," + (i + 1) + "*1200));"
                    + "var t=document.body?document.body.innerText:'';var m=t.match(/\\$\\s?\\d/g);"
                    + "var ld=document.querySelectorAll('script[type=\"application/ld+json\"]').length;"
                    + "var im=document.images.length;"
                    + "return (m?m.length:0)+':'+ld+':'+t.length+':'+im;})()");
            String now = probe[1];
            String[] parts = now.split(":");
            boolean hasPrices = parts.length > 1 && (!parts[0].equals("0") || !parts[1].equals("0"));
            steady = now.equals(last) ? steady + 1 : 0;
            if (hasPrices && steady >= 2) break;
            last = now;
            Thread.sleep(700);
        }
        // Back to the top and copy each lazy picture's real address into src, so it's in the HTML.
        evalForText("(function(){window.scrollTo(0,0);var n=0;document.querySelectorAll('img').forEach(function(i){"
            + "var c=i.currentSrc||'';if(c&&c.indexOf('data:')!==0&&(!i.getAttribute('src')||i.getAttribute('src').indexOf('data:')===0)){i.setAttribute('src',c);n++;}});return n;})()");
        String[] html = evalForText("document.documentElement.outerHTML");
        String[] where = evalForText("location.href");
        return new String[] {String.valueOf(pageStatus), html[1], where[1]};
    }

    static final String CHECK_JS = "(document.title||'')+' | '+(document.body?document.body.innerText.slice(0,600):'')";

    /** True for the holding pages bot-protection services show while they check the browser. */
    static boolean looksLikeCheck(String text) {
        if (text == null) return false;
        String t = text.toLowerCase(java.util.Locale.ROOT);
        return t.contains("just a moment") || t.contains("checking your browser") || t.contains("verify you are human")
            || t.contains("are you a robot") || t.contains("pardon our interruption") || t.contains("please wait while we")
            || t.contains("enable javascript and cookies") || t.contains("request unsuccessful");
    }

    /** The current page's product price, read from its search-engine data, meta tags or price labels. */
    synchronized String[] productHere() throws Exception {
        begin();
        try {
            return evalForText(PRODUCT_JS);
        } finally {
            end();
        }
    }

    /**
     * Reads one product's price from the page it's on: schema.org JSON-LD first, then
     * price meta tags, then itemprop="price", then the most prominent price label.
     * Returns JSON {price, was, name, image, inStock} or {} when there's no price.
     */
    static final String PRODUCT_JS = "(function(){"
        + "function num(v){if(v==null)return null;if(typeof v==='object')return num(v.value||v.price||v.amount);var n=parseFloat(String(v).replace(/[^0-9.]/g,''));return isFinite(n)&&n>0?n:null;}"
        + "var out={};"
        + "var blocks=document.querySelectorAll('script[type=\"application/ld+json\"]');"
        + "function visit(o,d){if(!o||d>6||out.price)return;if(Array.isArray(o)){o.forEach(function(x){visit(x,d+1)});return;}if(typeof o!=='object')return;"
        + "var t=o['@type'];if(t==='Product'||(Array.isArray(t)&&t.indexOf('Product')>=0)){var of=o.offers;if(Array.isArray(of))of=of[0];if(of){var p=num(of.price)||num(of.lowPrice)||(of.priceSpecification&&num(of.priceSpecification.price));"
        + "if(p){out.price=p;out.name=o.name;out.image=typeof o.image==='string'?o.image:(o.image&&(o.image[0]&&(o.image[0].url||o.image[0])||o.image.url));"
        + "var av=String(of.availability||'');if(/OutOfStock|SoldOut|Discontinued/i.test(av))out.inStock=false;else if(/InStock|Limited/i.test(av))out.inStock=true;"
        + "var sp=[].concat(of.priceSpecification||[]);sp.forEach(function(s){if(/Strikethrough|ListPrice/i.test(String(s.priceType||''))){var w=num(s.price);if(w&&w>p)out.was=w;}});}}return;}"
        + "if(o['@graph'])visit(o['@graph'],d+1);if(o.mainEntity)visit(o.mainEntity,d+1);}"
        + "for(var i=0;i<blocks.length;i++){try{visit(JSON.parse(blocks[i].textContent),0)}catch(e){}}"
        + "if(!out.price){var m=document.querySelector('meta[property=\"product:price:amount\"],meta[property=\"og:price:amount\"],meta[itemprop=\"price\"]');if(m)out.price=num(m.getAttribute('content'));}"
        + "if(!out.price){var ip=document.querySelector('[itemprop=\"price\"]');if(ip)out.price=num(ip.getAttribute('content')||ip.textContent);}"
        + "if(!out.price){var c=document.querySelectorAll('[class*=\"price\" i]');for(var j=0;j<c.length&&!out.price;j++){var tx=c[j].textContent||'';if(tx.length<30&&/\\$\\s?\\d/.test(tx)&&!c[j].closest('s,del,[class*=\"was\" i],[class*=\"old\" i]'))out.price=num(tx.match(/\\$\\s?([\\d,]+(\\.\\d{2})?)/)[1]);}}"
        + "if(out.price&&!out.was){var w=document.querySelector('s,del,[class*=\"was\" i] ,[class*=\"strike\" i]');if(w){var wv=num((w.textContent||'').match(/\\$\\s?([\\d,]+(\\.\\d{2})?)/)&&RegExp.$1);if(wv&&wv>out.price)out.was=wv;}}"
        + "if(!out.name){var h=document.querySelector('h1');if(h)out.name=h.textContent.trim();}"
        + "if(!out.image){var og=document.querySelector('meta[property=\"og:image\"]');if(og)out.image=og.getAttribute('content');}"
        + "if(out.inStock===undefined&&/out of stock|sold out/i.test((document.querySelector('main')||document.body).innerText.slice(0,4000)))out.inStock=false;"
        + "return JSON.stringify(out);})()";

    /** Runs a script in the page and returns {"200", its text result} (through the bridge, so long pages come back whole). */
    private String[] evalForText(String expr) throws Exception {
        final String id = token();
        CountDownLatch done = new CountDownLatch(1);
        waiting.put(id, done);
        final String js = "(function(){var id=" + JSONObject.quote(id) + ";try{var v=" + expr + ";RestockWeb.done(id,200,String(v));}catch(e){RestockWeb.done(id,-1,String(e));}})();";
        main.post(() -> web.evaluateJavascript(js, null));
        boolean ok = done.await(20, TimeUnit.SECONDS);
        waiting.remove(id);
        String[] r = results.remove(id);
        if (!ok || r == null) return new String[] {"-1", ""};
        return r;
    }

    /** Makes the hidden WebView if there isn't one yet (without loading anything). */
    private void ensureWebView() throws Exception {
        if (web != null) return;
        final CountDownLatch made = new CountDownLatch(1);
        main.post(() -> {
            if (web == null) {
                web = new WebView(app);
                setUp(web);
                // A phone-sized page, so the site lays out (and lazy-loads) as it would on screen.
                web.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2340, View.MeasureSpec.EXACTLY));
                web.layout(0, 0, 1080, 2340);
                web.addJavascriptInterface(new Bridge(), "RestockWeb");
                web.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onReceivedHttpError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceResponse response) {
                        if (request.isForMainFrame()) pageStatus = response.getStatusCode();
                    }

                    // 0.9.0: the hidden page stays on the shop's own site. Frames inside the page
                    // (a "you're a person" check, say) load as the page asks.
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                        if (!request.isForMainFrame()) return false;
                        String to = request.getUrl() == null ? null : request.getUrl().toString();
                        if (onShopSite(chain, to)) return false;
                        Log.w(TAG, chain + ": kept the hidden page off " + hostOf(to));
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                        pageUrl = url;
                        // A way off the site that doesn't ask first (a form sent elsewhere): blank it.
                        if (url != null && !"about:blank".equals(url) && !onShopSite(chain, url)) {
                            Log.w(TAG, chain + ": the hidden page went to " + hostOf(url) + "; blanking it");
                            view.stopLoading();
                            view.loadUrl("about:blank");
                        }
                    }

                    @Override
                    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                        super.doUpdateVisitedHistory(view, url, isReload);
                        pageUrl = url;
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        pageUrl = url;
                        // Give the site's own bot check a moment to finish (it may reload the page).
                        final CountDownLatch l = pageLatch;
                        main.postDelayed(() -> {
                            if (l != null) l.countDown();
                        }, 2500);
                    }
                });
            }
            made.countDown();
        });
        made.await(10, TimeUnit.SECONDS);
    }

    private final class Bridge {
        /**
         * 0.9.0: only an answer to a request Restock is waiting for (it carries that request's random
         * code), while the page is on the shop's own site. Anything else is ignored.
         */
        @JavascriptInterface
        public void done(String id, int status, String body) {
            CountDownLatch l = id == null ? null : waiting.get(id);
            if (l == null) return;
            if (onShopSite(chain, pageUrl)) results.put(id, new String[] {String.valueOf(status), body});
            else results.put(id, new String[] {"-1", "The page wasn't on " + chain + "'s website"});
            l.countDown();
        }
    }

    /**
     * Shows the store's website full screen so the user can clear its "are you human" check.
     * Must be called on the main thread. onDone runs when they close it.
     */
    static void showUnblock(Activity activity, String chain, Runnable onDone) {
        showUnblock(activity, chain, null, null, onDone);
    }

    /**
     * The shop's website, full screen, for ticking a "you're a person" box or signing in to your
     * account. `path` opens a page on the shop's own site (its sign-in page, say); `message` replaces
     * the note in the bar.
     */
    static void showUnblock(Activity activity, String chain, String path, String message, Runnable onDone) {
        showUnblock(activity, chain, path, message, false, result -> onDone.run());
    }

    /** Gets the recording (a JSON list, or null) when the page is closed. */
    interface Recorded {
        void done(String json);
    }

    /**
     * Records what the shop's own page asks its servers while you use it (0.6.13): for working out
     * how its trolley works, from one item you add yourself. Kept in the page's session storage
     * across page loads, read back when you tap Done. Only the shop's own site; nothing is sent
     * anywhere, and the app trims and checks it before you share it.
     */
    static final String RECORDER = "(function(){if(window.__rsRec)return;window.__rsRec=1;var K='__restockRec';"
        + "function save(e){try{var a=JSON.parse(sessionStorage.getItem(K)||'[]');e.at=Date.now();e.page=location.pathname;a.push(e);if(a.length>300)a.shift();sessionStorage.setItem(K,JSON.stringify(a));}catch(x){}}"
        + "function cut(s,n){s=s==null?'':String(s);return s.length>n?s.slice(0,n)+'...':s;}"
        + "var f=window.fetch;if(f){window.fetch=function(i,o){var u=(typeof i==='string')?i:(i&&i.url)||'';var m=(o&&o.method)||(i&&i.method)||'GET';var b=o&&o.body;"
        + "return f.apply(this,arguments).then(function(r){try{r.clone().text().then(function(t){save({kind:'fetch',method:m,url:u,status:r.status,body:cut(typeof b==='string'?b:'',3000),response:cut(t,4000)});});}catch(x){}return r;});};}"
        + "var X=XMLHttpRequest.prototype,op=X.open,sd=X.send;X.open=function(m,u){this.__m=m;this.__u=u;return op.apply(this,arguments);};"
        + "X.send=function(b){var x=this;x.addEventListener('loadend',function(){try{save({kind:'xhr',method:x.__m,url:String(x.__u),status:x.status,body:cut(typeof b==='string'?b:'',3000),response:cut((x.responseType===''||x.responseType==='text')?x.responseText:'',4000)});}catch(e){}});return sd.apply(this,arguments);};"
        + "})();";

    static void showUnblock(Activity activity, String chain, String path, String message, boolean record, Recorded onDone) {
        showUnblock(activity, chain, path, message, record, false, onDone);
    }

    /** A Coles store page: ".../find-stores/coles/qld/kirwan-0844". Its number is the last part. */
    static final java.util.regex.Pattern COLES_STORE_PAGE = java.util.regex.Pattern.compile("/find-stores/[^?#]*?-(\\d{3,5})/?(?:[?#].*)?$", java.util.regex.Pattern.CASE_INSENSITIVE);

    /**
     * With pickStore (0.7.2), the page closes by itself as soon as you open a store's own page on
     * the shop's site, and hands that page's address back (Coles keeps the store number in it).
     */
    @SuppressWarnings("deprecation") // getSystemWindowInset* is only used before Android 11
    static void showUnblock(Activity activity, String chain, String path, String message, boolean record, boolean pickStore, Recorded onDone) {
        final Dialog dialog = new Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar);
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#17643F"));
        // Android draws full-screen windows behind the status and navigation bars; keep our bar
        // and the page clear of them.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top;
            int bottom;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(0, top, 0, bottom);
            return insets;
        });

        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = (int) (12 * activity.getResources().getDisplayMetrics().density);
        bar.setPadding(pad, pad, pad, pad);
        bar.setBackgroundColor(Color.parseColor("#17643F"));

        TextView note = new TextView(activity);
        note.setText(message != null && !message.isEmpty() ? message : "Let the page load. If it asks, tick the box to show you're a person. Then tap Done.");
        note.setTextColor(Color.WHITE);
        note.setTextSize(14);
        // 0.9.0: under the note, the site the page is on right now ("www.coles.com.au"), so you can
        // see who you're signing in to.
        final TextView where = new TextView(activity);
        where.setTextColor(Color.argb(0xCC, 0xFF, 0xFF, 0xFF));
        where.setTextSize(12);
        LinearLayout texts = new LinearLayout(activity);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.addView(note, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        texts.addView(where, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        bar.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button doneBtn = new Button(activity);
        doneBtn.setText("Done");
        doneBtn.setAllCaps(false);
        doneBtn.setTextColor(Color.parseColor("#17643F"));
        doneBtn.setBackgroundColor(Color.WHITE);
        doneBtn.setMinHeight((int) (44 * activity.getResources().getDisplayMetrics().density));
        bar.addView(doneBtn, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final WebView w = new WebView(activity);
        setUp(w);
        w.setBackgroundColor(Color.WHITE);
        w.getSettings().setBlockNetworkImage(false);
        final String[] recording = {null};
        final boolean[] picked = {false};
        w.setWebViewClient(new WebViewClient() {
            // 0.9.0: links stay on the shop's own site (and its sign-in pages); a link anywhere
            // else isn't opened. Frames inside the page (a "you're a person" check) load as asked.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                String to = request.getUrl() == null ? null : request.getUrl().toString();
                if (onShopSite(chain, to)) return false;
                String host = hostOf(to);
                Toast.makeText(activity, host.isEmpty() ? "Restock only opens the shop's own website here." : "Restock only opens the shop's own website here, not " + host + ".",
                    Toast.LENGTH_SHORT).show();
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                showWhere(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                showWhere(url);
                // 0.9.0: the recorder only goes into the shop's own pages.
                if (record) {
                    if (onShopSite(chain, url)) view.evaluateJavascript(RECORDER, null);
                } else if (pickStore) {
                    spot(url);
                }
            }

            // The store finder changes page without loading a new one; this still sees it.
            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                showWhere(url);
                if (pickStore) spot(url);
            }

            private void showWhere(String url) {
                String host = hostOf(url);
                where.setText(host.isEmpty() ? "" : onShopSite(chain, url) ? host : host + " (not the shop's site)");
            }

            private void spot(String url) {
                // 0.9.0: the shop's own site by its real host, not by how the address starts.
                if (picked[0] || url == null || !onShopSite(chain, url)) return;
                if (!COLES_STORE_PAGE.matcher(url).find()) return;
                picked[0] = true;
                recording[0] = url;
                note.setText("Got it. Going back to Restock…");
                w.postDelayed(dialog::dismiss, 700);
            }
        });
        root.addView(w, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        dialog.setContentView(root);
        Window win = dialog.getWindow();
        if (win != null) win.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        doneBtn.setOnClickListener(v -> {
            if (!record) {
                dialog.dismiss();
                return;
            }
            // Read the recording back before the page goes. 0.9.0: only from the shop's own site
            // (another site's page could have put anything there).
            if (!onShopSite(chain, w.getUrl())) {
                dialog.dismiss();
                return;
            }
            w.evaluateJavascript("sessionStorage.getItem('__restockRec')||'[]'", value -> {
                recording[0] = value;
                dialog.dismiss();
            });
        });
        dialog.setOnDismissListener(d -> {
            CookieManager.getInstance().flush();
            w.destroy();
            get(activity, chain).reset();
            onDone.done(recording[0]);
        });
        // Only a page on the shop's own site: a path, never another address. 0.9.0: the path is read
        // against the shop's home page and has to land on its site (onSite), or the home page opens.
        String start = home(chain);
        String at = path != null && path.startsWith("/") ? onSite(chain, path) : null;
        if (at != null) start = at;
        w.loadUrl(start);
        dialog.show();
        root.requestApplyInsets();
    }
}
