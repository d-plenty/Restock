package family.plenty.restock;

import java.util.HashMap;
import java.util.Map;

/**
 * Every shop Restock knows, for background price checks: how to talk to it and its website.
 * The Java twin of src/shops.ts (checked by the desktop tests). Shops people add themselves
 * come from settings.customShops and are registered with {@link #addCustom}.
 */
final class Shops {
    static final class Shop {
        final String id;
        /** pantry | keg | pharmacy */
        final String section;
        /** woolworths | coles | aldi | endeavour | web */
        final String kind;
        final String website;
        /** Another shop whose website has this shop's prices, or null. */
        final String pricesFrom;

        Shop(String id, String section, String kind, String website, String pricesFrom) {
            this.id = id;
            this.section = section;
            this.kind = kind;
            this.website = website;
            this.pricesFrom = pricesFrom;
        }
    }

    private static final Map<String, Shop> ALL = new HashMap<>();

    private static void add(String id, String section, String kind, String website, String pricesFrom) {
        ALL.put(id, new Shop(id, section, kind, website, pricesFrom));
    }

    static {
        add("woolworths", "pantry", "woolworths", "https://www.woolworths.com.au", null);
        add("coles", "pantry", "coles", "https://www.coles.com.au", null);
        add("aldi", "pantry", "aldi", "https://www.aldi.com.au", null);
        add("danmurphys", "keg", "endeavour", "https://www.danmurphys.com.au", null);
        add("bws", "keg", "endeavour", "https://bws.com.au", null);
        add("liquorland", "keg", "web", "https://www.liquorland.com.au", null);
        add("liquorlandwarehouse", "keg", "web", "https://www.liquorland.com.au", "liquorland");
        add("liquorlandcellars", "keg", "web", "https://www.liquorland.com.au", "liquorland");
        add("bottleo", "keg", "web", "https://www.thebottle-o.com.au", null);
        add("cellarbrations", "keg", "web", "https://www.cellarbrations.com.au", null);
        add("thirstycamel", "keg", "web", "https://www.thirstycamel.com.au", null);
        add("porters", "keg", "web", "https://www.portersliquor.com.au", null);
        add("chemistwarehouse", "pharmacy", "web", "https://www.chemistwarehouse.com.au", null);
        add("mychemist", "pharmacy", "web", "https://www.mychemist.com.au", null);
        add("amcal", "pharmacy", "web", "https://www.amcal.com.au", null);
        add("discountdrug", "pharmacy", "web", "https://www.discountdrugstores.com.au", null);
        add("guardian", "pharmacy", "web", "https://www.guardianpharmacies.com.au", null);
        add("priceline", "pharmacy", "web", "https://www.priceline.com.au", null);
        add("soulpattinson", "pharmacy", "web", "https://www.soulpattinson.com.au", null);
        add("terrywhite", "pharmacy", "web", "https://terrywhitechemmart.com.au", null);
        add("blooms", "pharmacy", "web", "https://www.bloomsthechemist.com.au", null);
        add("goodprice", "pharmacy", "web", "https://www.goodpricepharmacy.com.au", null);
        add("pharmacy4less", "pharmacy", "web", "https://www.pharmacy4less.com.au", null);
        add("directchemist", "pharmacy", "web", "https://www.directchemistoutlet.com.au", null);
        add("stardiscount", "pharmacy", "web", "https://www.stardiscountchemist.com.au", null);
        add("capitalchemist", "pharmacy", "web", "https://www.capitalchemist.com.au", null);
        add("nationalpharmacies", "pharmacy", "web", "https://www.nationalpharmacies.com.au", null);
        add("chempro", "pharmacy", "web", "https://www.chempro.com.au", null);
    }

    private Shops() {}

    static synchronized Shop get(String id) {
        return id == null ? null : ALL.get(id);
    }

    /** A shop the person added: read like any website. */
    static synchronized void addCustom(String id, String section, String website) {
        if (id == null || !id.startsWith("custom-") || website == null || !website.startsWith("http")) return;
        add(id, section == null ? "pantry" : section, "web", website, null);
    }

    static synchronized void addCustom(String id, String website) {
        Shop had = ALL.get(id);
        addCustom(id, had != null ? had.section : null, website);
    }

    /** The person's own shops from settings.customShops. */
    static void addCustoms(org.json.JSONArray list) {
        if (list == null) return;
        for (int i = 0; i < list.length(); i++) {
            org.json.JSONObject c = list.optJSONObject(i);
            if (c != null) addCustom(c.optString("id"), c.optString("section", "pantry"), c.optString("website"));
        }
    }

    static String section(String id) {
        Shop s = get(id);
        return s == null ? "pantry" : s.section;
    }

    static String kind(String id) {
        Shop s = get(id);
        return s == null ? null : s.kind;
    }

    static String website(String id) {
        Shop s = get(id);
        return s == null ? null : s.website;
    }

    /** The shop whose website has this shop's prices (itself, or Liquorland for its Warehouse and Cellars). */
    static String priceSource(String id) {
        Shop s = get(id);
        return s != null && s.pricesFrom != null ? s.pricesFrom : id;
    }

    static boolean known(String id) {
        return get(id) != null;
    }

    /** Is `url` on the same website as the shop (so the hidden browser only ever opens that shop's pages)? */
    static boolean sameSite(String id, String url) {
        String site = website(id);
        if (site == null || url == null) return false;
        try {
            String a = new java.net.URL(site).getHost().replaceFirst("^www\\.", "");
            java.net.URL u = new java.net.URL(url);
            if (!"https".equals(u.getProtocol()) && !"http".equals(u.getProtocol())) return false;
            String b = u.getHost().replaceFirst("^www\\.", "");
            return b.equals(a) || b.endsWith("." + a);
        } catch (Exception e) {
            return false;
        }
    }

    /** All built-in ids, for the desktop parity check. */
    static synchronized java.util.Set<String> ids() {
        return new java.util.TreeSet<>(ALL.keySet());
    }
}
