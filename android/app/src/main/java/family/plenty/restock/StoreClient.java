package family.plenty.restock;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Fetches today's price for a tracked product, straight from each store's website data.
 * The Java twin of src/stores/*.ts (which the app uses for searching). Only standard Java
 * and org.json, so the parsing can be tested on a desktop JVM.
 */
final class StoreClient {

    static final class Quote {
        double price;
        Double was;
        boolean special;
        boolean member;
        String promo;
        String imageUrl;
        /** Online stock, or null when the store doesn't say. Same rules as the app's store adapters. */
        Boolean inStock;
    }

    /** Makes a request from inside a store's own web page (StoreWeb on Android). Returns {status, body}. */
    interface WebFetcher {
        String[] fetch(String chain, String method, String url, String body) throws Exception;

        /** Opens a product page of the shop's website and reads its price there. Returns {status, product JSON}. */
        String[] productPage(String chain, String url) throws Exception;
    }

    private WebFetcher web;
    private boolean browserOnly;
    /** Signed in to Woolworths in Restock (0.6.12): ask from inside its website, as you, for your store. */
    private boolean wooliesAccount;

    void useWoolworthsAccount(boolean on) {
        wooliesAccount = on;
    }

    /** The backup connection. Coles always uses it; the others when a direct request fails. */
    void setWebFetcher(WebFetcher f, boolean alwaysUseIt) {
        web = f;
        browserOnly = alwaysUseIt;
    }

    private Resp viaWeb(String chain, String method, String url, String body) throws Exception {
        String[] r = web.fetch(chain, method, url, body);
        Resp resp = new Resp();
        resp.status = Integer.parseInt(r[0]);
        resp.body = r[1] == null ? "" : r[1];
        return resp;
    }

    static final String COLES_UNBLOCK = "needs a quick check: tap Open Coles in the app";

    static final class BlockedException extends Exception {
        private static final long serialVersionUID = 1L;

        BlockedException(String store, String detail) {
            super(store + " blocked the price check (" + detail + "). Try again later, or add the price by hand.");
        }
    }

    static final String UA =
        "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
    /** An honest app identity. Some stores' bot protection rejects "Chrome" that isn't really Chrome. */
    static final String APP_UA = "Restock/0.3 (Android; grocery price tracker)";
    private static final String WOOLIES = "https://www.woolworths.com.au";
    private static final String COLES = "https://www.coles.com.au";
    private static final String ALDI_API = "https://api.aldi.com.au/v3/product-search";
    private static final String COLES_DEFAULT_STORE = "0584";

    private final Map<String, Map<String, String>> cookies = new HashMap<>();
    private boolean wooliesSession;
    private String colesKey;

    /** Returns null when the product can't be found any more (discontinued, renamed). */
    Quote refresh(String chain, String storeProductId, String name, String storeId) throws Exception {
        switch (chain) {
            case "woolworths":
                if (wooliesAccount && web != null) return woolworthsWeb(storeProductId);
                return directThenWeb(() -> woolworths(storeProductId), () -> woolworthsWeb(storeProductId));
            case "coles":
                return coles(storeProductId, name, storeId);
            case "aldi":
                return directThenWeb(() -> aldi(storeProductId, name, storeId), () -> aldiWeb(storeProductId, name, storeId));
            default:
                break;
        }
        String kind = Shops.kind(chain);
        boolean page = storeProductId != null && storeProductId.startsWith("http") && storeProductId.indexOf('#') < 0;
        if ("endeavour".equals(kind) && !page) return directThenWeb(() -> endeavour(chain, storeProductId, false), () -> endeavour(chain, storeProductId, true));
        // A product page on the shop's website. Products found without one are refreshed by the app instead.
        if (("endeavour".equals(kind) || "web".equals(kind)) && page) return webProduct(chain, storeProductId);
        return null;
    }

    /** A shop-website product with no product page (check.ts isPageless): the app refreshes those by searching. */
    static boolean pageless(String chain, String storeProductId) {
        return "web".equals(Shops.kind(chain)) && storeProductId != null && !storeProductId.matches("^https?://[^#]+$");
    }

    // ---------- Dan Murphy's and BWS (endeavour.ts) ----------

    static String endeavourApi(String chain) {
        return "bws".equals(chain) ? "https://api.bws.com.au/apis/ui" : "https://api.danmurphys.com.au/apis/ui";
    }

    private Quote endeavour(String chain, String stockcode, boolean viaBrowser) throws Exception {
        String url = endeavourApi(chain) + "/Product/" + enc(stockcode);
        String name = "bws".equals(chain) ? "BWS" : "Dan Murphy's";
        Resp r;
        if (viaBrowser) r = viaWeb(chain, "GET", url, null);
        else {
            Map<String, String> h = json(Shops.website(chain) + "/");
            h.put("Origin", Shops.website(chain));
            r = request("GET", url, h, null);
        }
        if (r.status == 404) return null;
        JSONObject data = parse(name, r);
        JSONObject p = data;
        JSONArray list = data.optJSONArray("Products");
        if (list != null && list.length() > 0) {
            JSONObject first = list.optJSONObject(0);
            JSONArray inner = first != null ? first.optJSONArray("Products") : null;
            p = inner != null && inner.length() > 0 ? inner.optJSONObject(0) : first;
        } else if (data.optJSONObject("Product") != null) p = data.optJSONObject("Product");
        return p == null ? null : mapEndeavour(p);
    }

    /** One thing from AdditionalDetails [{Name, Value}]. */
    private static String detail(JSONObject p, String... names) {
        JSONArray list = p.optJSONArray("AdditionalDetails");
        if (list == null) return null;
        for (String n : names) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject d = list.optJSONObject(i);
                if (d == null || !n.equalsIgnoreCase(d.optString("Name", ""))) continue;
                String v = str(d, "Value");
                if (v != null) return v;
            }
        }
        return null;
    }

    private static Double valueOf(JSONObject prices, String key) {
        if (prices == null) return null;
        Object o = prices.opt(key);
        if (o instanceof JSONObject) return num(((JSONObject) o).opt("Value"));
        return num(o);
    }

    static Quote mapEndeavour(JSONObject p) {
        JSONObject prices = p.optJSONObject("Prices");
        Double single = valueOf(prices, "singleprice");
        if (single == null) single = num(p.opt("Price"));
        Double promo = valueOf(prices, "promoprice");
        Double member = valueOf(prices, "memberprice");
        Double price = promo != null ? promo : single;
        if (price == null) return null;
        Double was = valueOf(prices, "wasprice");
        if (was == null) was = num(p.opt("WasPrice"));
        if (was == null && promo != null && single != null && single > promo) was = single;
        Quote q = new Quote();
        String promoText = null;
        if (prices != null && prices.optJSONObject("promoprice") != null) promoText = str(prices.optJSONObject("promoprice"), "Message");
        if (promoText == null) promoText = str(p, "PromotionDescription");
        q.member = (member != null && member < price) || (promoText != null && MEMBER_TEXT.matcher(promoText).find()) || p.optBoolean("IsMemberOffer");
        q.price = member != null && member < price ? member : price;
        q.was = was != null && was > q.price ? was : null;
        q.special = promo != null || q.was != null || p.optBoolean("IsOnSpecial");
        q.promo = promoText;
        q.imageUrl = detail(p, "image1", "webimage1");
        if (q.imageUrl == null) q.imageUrl = str(p, "MediumImageFile");
        q.inStock = Boolean.FALSE.equals(bool(p, "IsPurchasable")) ? Boolean.FALSE : first(bool(p, "IsInStock"), bool(p, "IsAvailable"));
        return q;
    }

    // ---------- any shop website (webPage.ts) ----------

    private static final Pattern LD_JSON = Pattern.compile("<script[^>]*type=[\"']application/ld\\+json[\"'][^>]*>([\\s\\S]*?)</script>", Pattern.CASE_INSENSITIVE);
    private static final Pattern META_PRICE = Pattern.compile(
        "<meta[^>]+(?:property|itemprop|name)=[\"'](?:product:price:amount|og:price:amount|price)[\"'][^>]*content=[\"']([\\d.,]+)[\"']", Pattern.CASE_INSENSITIVE);
    private static final Pattern META_PRICE_B = Pattern.compile(
        "<meta[^>]+content=[\"']([\\d.,]+)[\"'][^>]*(?:property|itemprop|name)=[\"'](?:product:price:amount|og:price:amount|price)[\"']", Pattern.CASE_INSENSITIVE);

    /** Today's price from a product page: Shopify's product data, JSON-LD, price meta tags; the hidden browser if those fail. */
    private Quote webProduct(String chain, String url) throws Exception {
        String store = Shops.website(chain) != null ? Net.url(Shops.website(chain)).getHost() : chain;
        Quote q = null;
        boolean blocked = false;
        if (!browserOnly) {
            try {
                Resp r = request("GET", url, html(), null);
                if (r.status == 404 || r.status == 410) return null;
                blocked = r.status == 403 || r.status == 429 || r.status == 503;
                if (r.status < 400) {
                    q = fromProductPage(r.body);
                    if (q == null && r.body.contains("cdn.shopify.com")) q = shopify(url);
                }
            } catch (Exception e) {
                blocked = true;
            }
        }
        if (q == null && web != null) {
            String[] r = web.productPage(chain, url);
            int status = Integer.parseInt(r[0]);
            if (status == 404 || status == 410) return null;
            if (r[1] != null && r[1].trim().startsWith("{")) q = fromProductJson(new JSONObject(r[1]));
            if (q == null && status >= 400) blocked = true;
        }
        if (q == null && blocked) throw new BlockedException(store, "the page didn't load");
        if (q == null) throw new Exception(store + " page has no price Restock can read");
        return q;
    }

    private Quote shopify(String url) throws Exception {
        String base = url.split("[?#]")[0];
        Resp r = request("GET", base + ".js", json(base), null);
        if (r.status >= 400) return null;
        JSONObject p = new JSONObject(r.body);
        Double cents = num(p.opt("price"));
        if (cents == null) return null;
        Quote q = new Quote();
        q.price = Math.round(cents) / 100.0;
        Double was = num(p.opt("compare_at_price"));
        q.was = was != null && was / 100.0 > q.price ? Math.round(was) / 100.0 : null;
        q.special = q.was != null;
        q.inStock = bool(p, "available");
        return q;
    }

    /** Price from a product page's JSON-LD or meta tags; null when it has neither. */
    static Quote fromProductPage(String html) {
        Matcher m = LD_JSON.matcher(html);
        while (m.find()) {
            try {
                Object v = new org.json.JSONTokener(m.group(1).trim()).nextValue();
                Quote q = ldProduct(v, 0);
                if (q != null) return q;
            } catch (Exception e) {
                // a broken block; try the next
            }
        }
        Matcher mp = META_PRICE.matcher(html);
        Matcher mb = META_PRICE_B.matcher(html);
        String found = mp.find() ? mp.group(1) : mb.find() ? mb.group(1) : null;
        Double price = found != null ? num(found) : null;
        if (price == null || price <= 0) return null;
        Quote q = new Quote();
        q.price = price;
        return q;
    }

    private static boolean isType(JSONObject o, String type) {
        Object t = o.opt("@type");
        if (type.equals(t)) return true;
        if (t instanceof JSONArray) for (int i = 0; i < ((JSONArray) t).length(); i++) if (type.equals(((JSONArray) t).opt(i))) return true;
        return false;
    }

    private static Quote ldProduct(Object v, int depth) {
        if (v == null || depth > 6) return null;
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            for (int i = 0; i < a.length(); i++) {
                Quote q = ldProduct(a.opt(i), depth + 1);
                if (q != null) return q;
            }
            return null;
        }
        if (!(v instanceof JSONObject)) return null;
        JSONObject o = (JSONObject) v;
        if (isType(o, "Product")) {
            Object offers = o.opt("offers");
            JSONObject offer = offers instanceof JSONArray ? ((JSONArray) offers).optJSONObject(0) : offers instanceof JSONObject ? (JSONObject) offers : null;
            if (offer == null) return null;
            Double price = num(offer.opt("price"));
            if (price == null) price = num(offer.opt("lowPrice"));
            Object spec = offer.opt("priceSpecification");
            if (price == null && spec instanceof JSONObject) price = num(((JSONObject) spec).opt("price"));
            if (price == null || price <= 0) return null;
            Quote q = new Quote();
            q.price = price;
            JSONArray specs = spec instanceof JSONArray ? (JSONArray) spec : spec instanceof JSONObject ? new JSONArray().put(spec) : new JSONArray();
            for (int i = 0; i < specs.length(); i++) {
                JSONObject sp = specs.optJSONObject(i);
                if (sp == null) continue;
                String type = sp.optString("priceType", "");
                Double w = num(sp.opt("price"));
                if (type.matches("(?i).*(Strikethrough|ListPrice|SRP).*") && w != null && w > price) q.was = w;
            }
            q.special = q.was != null;
            String av = offer.optString("availability", "");
            if (av.matches("(?i).*(OutOfStock|SoldOut|Discontinued).*")) q.inStock = Boolean.FALSE;
            else if (av.matches("(?i).*(InStock|LimitedAvailability).*")) q.inStock = Boolean.TRUE;
            Object img = o.opt("image");
            if (img instanceof String) q.imageUrl = (String) img;
            else if (img instanceof JSONArray && ((JSONArray) img).opt(0) instanceof String) q.imageUrl = ((JSONArray) img).optString(0);
            return q;
        }
        Quote q = ldProduct(o.opt("@graph"), depth + 1);
        if (q == null) q = ldProduct(o.opt("mainEntity"), depth + 1);
        return q;
    }

    /** What StoreWeb.PRODUCT_JS read off the page: {price, was, image, inStock}. */
    static Quote fromProductJson(JSONObject o) {
        Double price = num(o.opt("price"));
        if (price == null || price <= 0) return null;
        Quote q = new Quote();
        q.price = price;
        Double was = num(o.opt("was"));
        q.was = was != null && was > price ? was : null;
        q.special = q.was != null;
        q.imageUrl = str(o, "image");
        q.inStock = bool(o, "inStock");
        return q;
    }

    private interface Attempt {
        Quote run() throws Exception;
    }

    /** Direct first; if that fails (blocked, changed, unreadable), the backup browser connection. */
    private Quote directThenWeb(Attempt direct, Attempt viaBrowser) throws Exception {
        if (web == null) return direct.run();
        if (browserOnly) return viaBrowser.run();
        try {
            return direct.run();
        } catch (Exception e) {
            return viaBrowser.run();
        }
    }

    private Quote woolworthsWeb(String stockcode) throws Exception {
        Resp r = viaWeb("woolworths", "GET", "/apis/ui/product/detail/" + enc(stockcode), null);
        if (r.status == 404) return null;
        JSONObject data = parse("Woolworths", r);
        JSONObject p = data.optJSONObject("Product");
        return mapWoolworths(p != null ? p : data);
    }

    private Quote aldiWeb(String sku, String name, String storeId) throws Exception {
        return findAldi(parse("Aldi", viaWeb("aldi", "GET", aldiUrl(name, storeId), null)), sku);
    }

    // ---------- Woolworths ----------

    private Quote woolworths(String stockcode) throws Exception {
        if (!wooliesSession) {
            request("GET", WOOLIES + "/", html(), null);
            wooliesSession = true;
        }
        Map<String, String> h = json(WOOLIES + "/shop/productdetails/" + stockcode);
        h.put("Origin", WOOLIES);
        Resp r = request("GET", WOOLIES + "/apis/ui/product/detail/" + enc(stockcode), h, null);
        if (r.status == 404) return null;
        JSONObject data = parse("Woolworths", r);
        JSONObject p = data.optJSONObject("Product");
        return mapWoolworths(p != null ? p : data);
    }

    static Quote mapWoolworths(JSONObject p) {
        Double price = num(p.opt("Price"));
        if (price == null) price = num(p.opt("InstorePrice"));
        if (price == null) return null;
        Double was = num(p.opt("WasPrice"));
        if (was == null) was = num(p.opt("InstoreWasPrice"));
        Quote q = new Quote();
        q.price = price;
        q.was = was != null && was > price ? was : null;
        q.special = p.optBoolean("IsOnSpecial") || p.optBoolean("IsHalfPrice") || p.optBoolean("InstoreIsOnSpecial") || q.was != null;
        String promo = str(p, "PromotionDescription");
        if (promo == null && p.optBoolean("IsHalfPrice")) promo = "1/2 price";
        q.promo = promo;
        q.member = p.optBoolean("IsMemberPrice") || (q.promo != null && MEMBER_TEXT.matcher(q.promo).find());
        String img = str(p, "MediumImageFile");
        q.imageUrl = img != null ? img : str(p, "SmallImageFile");
        q.inStock = Boolean.FALSE.equals(bool(p, "IsInStock")) || Boolean.FALSE.equals(bool(p, "IsAvailable")) ? Boolean.FALSE : first(bool(p, "IsInStock"), bool(p, "IsAvailable"));
        return q;
    }

    // ---------- Coles ----------

    private static final Pattern COLES_KEY = Pattern.compile("BFF_API_SUBSCRIPTION_KEY[\"']?\\s*:\\s*[\"']([^\"']+)[\"']");

    static String extractColesKey(String html) {
        Matcher m = COLES_KEY.matcher(html);
        return m.find() ? m.group(1) : null;
    }

    private Quote coles(String id, String name, String storeId) throws Exception {
        if (web != null) return colesOnce(id, name, storeId); // StoreWeb already retries.
        try {
            return colesOnce(id, name, storeId);
        } catch (BlockedException e) {
            // Often a stale session. Start fresh, pause, and try once more.
            cookies.remove("www.coles.com.au");
            colesKey = null;
            Thread.sleep(1500);
            return colesOnce(id, name, storeId);
        }
    }

    static String colesSearchPath(String term, String storeId) throws Exception {
        return "/api/bff/products/search?storeId=" + enc(storeId != null && !storeId.isEmpty() ? storeId : COLES_DEFAULT_STORE)
            + "&searchTerm=" + enc(term) + "&start=0&sortBy=salesDescending&excludeAds=true&authenticated=false";
    }

    private Quote colesOnce(String id, String name, String storeId) throws Exception {
        if (web != null) {
            Resp resp = viaWeb("coles", "GET", colesSearchPath(name, storeId), null);
            if (resp.status <= 0) throw new BlockedException("Coles", COLES_UNBLOCK);
            return findColes(parse("Coles", resp), id);
        }
        if (colesKey == null) {
            Resp home = request("GET", COLES + "/", html(), null);
            colesKey = extractColesKey(home.body);
            if (colesKey == null) throw new BlockedException("Coles", "bot protection");
        }
        String url = COLES + "/api/bff/products/search?storeId=" + enc(storeId != null && !storeId.isEmpty() ? storeId : COLES_DEFAULT_STORE)
            + "&searchTerm=" + enc(name) + "&start=0&sortBy=salesDescending&excludeAds=true&authenticated=false&subscription-key=" + enc(colesKey);
        Resp r = request("GET", url, json(COLES + "/search/products?q=" + enc(name)), null);
        return findColes(parse("Coles", r), id);
    }

    private static Quote findColes(JSONObject data, String id) {
        JSONArray results = data.optJSONArray("results");
        if (results == null) return null;
        for (int i = 0; i < results.length(); i++) {
            JSONObject p = results.optJSONObject(i);
            if (p != null && id.equals(String.valueOf(p.opt("id")))) return mapColes(p);
        }
        return null;
    }

    static Quote mapColes(JSONObject p) {
        JSONObject pricing = p.optJSONObject("pricing");
        if (pricing == null) return null;
        Double price = num(pricing.opt("now"));
        if (price == null) return null;
        Double was = num(pricing.opt("was"));
        Quote q = new Quote();
        q.price = price;
        q.was = was != null && was > price ? was : null;
        String promo = firstText(pricing, "offerDescription", "promotionDescription", "specialType");
        String type = str(pricing, "promotionType");
        // A shop code ("PERCENT_OFF") isn't worth showing; a collectables promotion gets a name.
        if (promo != null && promo.matches("[A-Z0-9_]{4,}")) promo = null;
        if (promo == null && type != null && "BONUSCOLLECTABLE".equalsIgnoreCase(type)) promo = "Bonus collectable";
        q.promo = promo;
        // Most Coles promotion types aren't sales ("EVERYDAY" is the ordinary price). Mirrors colesOnSale in coles.ts.
        q.special = q.was != null
            || pricing.optBoolean("onlineSpecial")
            || (type != null && type.toUpperCase().matches("SPECIAL|MULTI_?SAVE|MULTIBUY|HALF_?PRICE"))
            || (promo != null && promo.matches("(?is).*\\d+\\s*for\\s*\\$.*"));
        q.member = hasMemberFlag(pricing)
            || (promo != null && MEMBER_TEXT.matcher(promo).find())
            || (str(pricing, "promotionType") != null && MEMBER_TEXT.matcher(str(pricing, "promotionType")).find());
        JSONArray images = p.optJSONArray("imageUris");
        if (images != null && images.length() > 0) {
            String uri = images.optJSONObject(0) != null ? str(images.optJSONObject(0), "uri") : null;
            if (uri != null) q.imageUrl = "https://productimages.coles.com.au/productimages" + uri;
        }
        q.inStock = bool(p, "availability");
        return q;
    }

    // ---------- Aldi ----------

    /** Which request style Aldi last accepted: 0 = app identity, 1 = browser style. Same as aldi.ts. */
    private static int aldiStyle = 0;

    static Map<String, String> aldiHeaders(int style) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Accept", "application/json");
        if (style == 0) {
            h.put("User-Agent", APP_UA);
        } else {
            h.put("Origin", "https://www.aldi.com.au");
            h.put("Referer", "https://www.aldi.com.au/");
        }
        return h;
    }

    static String aldiUrl(String name, String storeId) throws Exception {
        return ALDI_API + "?currency=AUD&serviceType=walk-in&q=" + enc(name) + "&limit=24&offset=0&sort=relevance"
            + (storeId != null && !storeId.isEmpty() ? "&servicePoint=" + enc(storeId) : "");
    }

    private Quote aldi(String sku, String name, String storeId) throws Exception {
        String url = aldiUrl(name, storeId);
        JSONObject data = null;
        BlockedException last = null;
        for (int attempt = 0; attempt < 3 && data == null; attempt++) {
            int style = (aldiStyle + attempt) % 2;
            try {
                data = parse("Aldi", request("GET", url, aldiHeaders(style), null));
                aldiStyle = style;
            } catch (BlockedException e) {
                last = e;
                Thread.sleep(1200L * (attempt + 1));
            }
        }
        if (data == null) throw last;
        return findAldi(data, sku);
    }

    private static Quote findAldi(JSONObject data, String sku) {
        JSONArray items = data.optJSONArray("data");
        if (items == null) return null;
        for (int i = 0; i < items.length(); i++) {
            JSONObject p = items.optJSONObject(i);
            if (p != null && sku.equals(String.valueOf(p.opt("sku")))) return mapAldi(p);
        }
        return null;
    }

    static Quote mapAldi(JSONObject p) {
        JSONObject priceObj = p.optJSONObject("price");
        if (priceObj == null) priceObj = new JSONObject();
        Double cents = num(priceObj.opt("amountRelevant"));
        if (cents == null) cents = num(priceObj.opt("amount"));
        if (cents == null) cents = num(p.opt("priceAmountCents"));
        Double price = cents != null ? cents / 100.0 : num(priceObj.opt("amountRelevantDisplay"));
        if (price == null) return null;
        Object wasDisplay = priceObj.opt("wasPriceDisplay");
        if (wasDisplay == null || wasDisplay == JSONObject.NULL) wasDisplay = priceObj.opt("strikePriceDisplay");
        Double was = num(wasDisplay);
        StringBuilder badges = new StringBuilder();
        JSONArray b = p.optJSONArray("badges");
        if (b != null) {
            for (int i = 0; i < b.length(); i++) {
                JSONObject badge = b.optJSONObject(i);
                if (badge == null) continue;
                String t = str(badge, "displayText");
                if (t == null) t = str(badge, "text");
                if (t != null) badges.append(badges.length() > 0 ? ", " : "").append(t);
            }
        }
        Quote q = new Quote();
        q.price = price;
        q.was = was != null && was > price ? was : null;
        q.promo = badges.length() > 0 ? badges.toString() : null;
        q.special = q.was != null || (q.promo != null && ALDI_SPECIAL.matcher(q.promo).find());
        q.member = false; // Aldi has no loyalty program
        // Aldi Australia has no online grocery shopping, so "notForSale" is true for everything: stock unknown.
        q.inStock = null;
        return q;
    }

    // ---------- helpers ----------

    private static final Pattern MEMBER_TEXT = Pattern.compile("member|flybuys|everyday rewards", Pattern.CASE_INSENSITIVE);
    private static final Pattern ALDI_SPECIAL = Pattern.compile("super saver|special|price drop|lower price", Pattern.CASE_INSENSITIVE);
    private static final Pattern NUMBER = Pattern.compile("-?\\d+(\\.\\d+)?");

    static Double num(Object v) {
        if (v == null || v == JSONObject.NULL) return null;
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            return Double.isNaN(d) || Double.isInfinite(d) ? null : d;
        }
        Matcher m = NUMBER.matcher(String.valueOf(v).replace(",", ""));
        return m.find() ? Double.parseDouble(m.group()) : null;
    }

    /** A non-empty string value, or null (org.json's optString turns JSON null into "null"). */
    static String str(JSONObject o, String key) {
        Object v = o.opt(key);
        if (v == null || v == JSONObject.NULL) return null;
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? null : s;
    }

    private static String firstText(JSONObject o, String... keys) {
        for (String k : keys) {
            String v = str(o, k);
            if (v != null) return v;
        }
        return null;
    }

    private static boolean hasMemberFlag(JSONObject o) {
        Iterator<String> keys = o.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (k.toLowerCase().contains("member") && o.optBoolean(k)) return true;
        }
        return false;
    }

    static Boolean bool(JSONObject o, String key) {
        Object v = o.opt(key);
        return v instanceof Boolean ? (Boolean) v : null;
    }

    private static Boolean first(Boolean a, Boolean b) {
        return a != null ? a : b;
    }

    private static String enc(String s) throws Exception {
        return URLEncoder.encode(s, "UTF-8");
    }

    private static Map<String, String> html() {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Accept", "text/html");
        return h;
    }

    private static Map<String, String> json(String referer) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Accept", "application/json, text/plain, */*");
        h.put("Referer", referer);
        return h;
    }

    static final class Resp {
        int status;
        String body;
    }

    static JSONObject parse(String store, Resp r) throws Exception {
        String t = r.body.trim();
        if (r.status == 403 || r.status == 429) throw new BlockedException(store, "Coles".equals(store) ? COLES_UNBLOCK : "HTTP " + r.status);
        if (t.startsWith("<")) throw new BlockedException(store, "Coles".equals(store) ? COLES_UNBLOCK : "got a web page instead of data");
        if (r.status <= 0) throw new Exception("Couldn't reach " + store + " just now. Check your internet, then try again.");
        if (r.status >= 400) throw new Exception(store + " returned HTTP " + r.status);
        if (!t.startsWith("{")) throw new Exception(store + " sent back something Restock couldn't read. Try again in a minute.");
        return new JSONObject(t);
    }

    private Resp request(String method, String url, Map<String, String> headers, String body) throws Exception {
        URL u = Net.url(url);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(15_000);
            c.setReadTimeout(20_000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept-Language", "en-AU,en;q=0.9");
            for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
            Map<String, String> jar = cookies.get(u.getHost());
            if (jar != null && !jar.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                for (Map.Entry<String, String> e : jar.entrySet()) sb.append(sb.length() > 0 ? "; " : "").append(e.getKey()).append('=').append(e.getValue());
                c.setRequestProperty("Cookie", sb.toString());
            }
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            Resp r = new Resp();
            r.status = c.getResponseCode();
            remember(u.getHost(), c.getHeaderFields());
            InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
            r.body = in == null ? "" : readAll(in);
            return r;
        } finally {
            c.disconnect();
        }
    }

    private void remember(String host, Map<String, List<String>> headers) {
        for (Map.Entry<String, List<String>> e : headers.entrySet()) {
            if (e.getKey() == null || !e.getKey().equalsIgnoreCase("Set-Cookie")) continue;
            Map<String, String> jar = cookies.get(host);
            if (jar == null) {
                jar = new LinkedHashMap<>();
                cookies.put(host, jar);
            }
            for (String v : e.getValue()) {
                String pair = v.split(";", 2)[0];
                int eq = pair.indexOf('=');
                if (eq > 0) jar.put(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
            }
        }
    }

    private static String readAll(InputStream in) throws Exception {
        try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16_384];
            int n;
            while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }
}
