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
        /** pantry | keg | pharmacy | baby | pets: its own tab (0.10.3: settings.shopTabs can add more). */
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
        // 0.9.6: Costco is read by the app on a phone, only when Search is pressed: never by a background check.
        add("costco", "pantry", "costco", "https://www.costco.com.au", null);
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
        // My Chemist is part of Chemist Warehouse and is priced from its website (shops.ts).
        add("mychemist", "pharmacy", "web", "https://www.chemistwarehouse.com.au", "chemistwarehouse");
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
        // 0.10.3 (beta): IGA, and the baby, pet and big box shops, read from their websites.
        add("iga", "pantry", "web", "https://www.igashop.com.au", null);
        add("babybunting", "baby", "web", "https://www.babybunting.com.au", null);
        add("petbarn", "pets", "web", "https://www.petbarn.com.au", null);
        add("petstock", "pets", "web", "https://www.petstock.com.au", null);
        add("petcircle", "pets", "web", "https://www.petcircle.com.au", null);
        add("bigw", "baby", "web", "https://www.bigw.com.au", null);
        add("kmart", "baby", "web", "https://www.kmart.com.au", null);
        add("target", "baby", "web", "https://www.target.com.au", null);
        add("bunnings", "pets", "web", "https://www.bunnings.com.au", null);
        // 0.11.3 (beta): more shops (shops.ts).
        add("foodworks", "pantry", "web", "https://www.foodworks.com.au", null);
        add("drakes", "pantry", "web", "https://www.drakes.com.au", null);
        add("harrisfarm", "pantry", "web", "https://www.harrisfarm.com.au", null);
        add("spudshed", "pantry", "web", "https://www.spudshed.com.au", null);
        add("foodland", "pantry", "web", "https://www.foodlandsa.com.au", null);
        add("nqr", "pantry", "web", "https://www.nqr.com.au", null);
        add("supabarn", "pantry", "web", "https://www.supabarn.com.au", null);
        add("liquorlegends", "keg", "web", "https://liquorlegends.com.au", null);
        add("bottlemart", "keg", "web", "https://www.bottlemart.com.au", null);
        add("babykingdom", "baby", "web", "https://www.babykingdom.com.au", null);
        add("babyland", "baby", "web", "https://www.babyland.com.au", null);
        add("babyvillage", "baby", "web", "https://www.babyvillage.com.au", null);
        add("bestfriendspets", "pets", "web", "https://www.bestfriendspets.com.au", null);
        add("peto", "pets", "web", "https://peto.com.au", null);
        add("budgetpet", "pets", "web", "https://www.budgetpetproducts.com.au", null);
        add("petquarters", "pets", "web", "https://www.petquarters.com.au", null);
        add("supercheap", "pets", "web", "https://www.supercheapauto.com.au", null);
        add("repco", "pets", "web", "https://www.repco.com.au", null);
        add("autobarn", "pets", "web", "https://www.autobarn.com.au", null);
        add("autopro", "pets", "web", "https://autopro.com.au", null);
        add("burson", "pets", "web", "https://www.burson.com.au", null);
        add("mitre10", "pets", "web", "https://www.mitre10.com.au", null);
        add("totaltools", "pets", "web", "https://www.totaltools.com.au", null);
        add("sydneytools", "pets", "web", "https://sydneytools.com.au", null);
        add("homehardware", "pets", "web", "https://www.homehardware.com.au", null);
        add("bcf", "pets", "web", "https://www.bcf.com.au", null);
        add("anaconda", "pets", "web", "https://www.anacondastores.com", null);
        add("kings", "pets", "web", "https://www.4wdsupacentre.com.au", null);
        add("tentworld", "pets", "web", "https://www.tentworld.com.au", null);
        add("kathmandu", "pets", "web", "https://www.kathmandu.com.au", null);
        add("rebel", "pets", "web", "https://www.rebelsport.com.au", null);
        add("decathlon", "pets", "web", "https://www.decathlon.com.au", null);
        add("jbhifi", "pets", "web", "https://www.jbhifi.com.au", null);
        add("officeworks", "pets", "web", "https://www.officeworks.com.au", null);
        add("goodguys", "pets", "web", "https://www.thegoodguys.com.au", null);
        add("harveynorman", "pets", "web", "https://www.harveynorman.com.au", null);
        add("binglee", "pets", "web", "https://www.binglee.com.au", null);
        add("spotlight", "pets", "web", "https://www.spotlightstores.com", null);
        add("lincraft", "pets", "web", "https://www.lincraft.com.au", null);
        add("ikea", "pets", "web", "https://www.ikea.com/au/en/", null);
        add("adairs", "pets", "web", "https://www.adairs.com.au", null);
        add("pillowtalk", "pets", "web", "https://www.pillowtalk.com.au", null);
        add("mecca", "pets", "web", "https://www.mecca.com/en-au/", null);
        add("adorebeauty", "pets", "web", "https://www.adorebeauty.com.au", null);
        add("rejectshop", "pets", "web", "https://www.rejectshop.com.au", null);
        add("cheapaschips", "pets", "web", "https://www.cheapaschips.com.au", null);
        add("reddot", "pets", "web", "https://www.reddot.com.au", null);
    }

    /** 0.10.3: every tab, in order (shops.ts SECTIONS). */
    static final String[] SECTIONS = { "pantry", "keg", "pharmacy", "baby", "pets", "c1", "c2", "c3", "c4", "c5", "c6" };
    /** 0.10.7: the custom sections (shops.ts CUSTOM_SECTIONS): Baby, Pets and c1–c6. */
    static final String[] CUSTOM_SECTIONS = { "baby", "pets", "c1", "c2", "c3", "c4", "c5", "c6" };

    static boolean isCustom(String section) {
        for (String c : CUSTOM_SECTIONS) if (c.equals(section)) return true;
        return false;
    }

    /** 0.13.0: every tab but Pantry is one you made (shops.ts MADE_SECTIONS): Bottle shop and Chemist have a name, colour and icon too. */
    static final String[] MADE_SECTIONS = { "keg", "pharmacy", "baby", "pets", "c1", "c2", "c3", "c4", "c5", "c6" };

    static boolean isMade(String section) {
        for (String c : MADE_SECTIONS) if (c.equals(section)) return true;
        return false;
    }

    /** 0.10.3: the tab a section's records are shared with: Baby and Pets with Groceries (shops.ts shareTab). 0.10.7: every custom section. */
    static String shareTab(String section) {
        return isCustom(section) ? "pantry" : section;
    }

    /**
     * 0.10.3: the tabs a shop is in (shops.ts tabsOf): settings.shopTabs's list for it (known tabs,
     * in order), or its own tab.
     */
    static java.util.List<String> tabsOf(org.json.JSONObject settings, String id) {
        java.util.List<String> out = new java.util.ArrayList<>();
        org.json.JSONObject m = settings == null ? null : settings.optJSONObject("shopTabs");
        org.json.JSONArray a = m == null ? null : m.optJSONArray(id);
        if (a != null) {
            java.util.Set<String> has = new java.util.HashSet<>();
            for (int i = 0; i < a.length(); i++) has.add(a.optString(i));
            for (String s : SECTIONS) if (has.contains(s)) out.add(s);
        }
        if (out.isEmpty()) out.add(section(id));
        return out;
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
            String a = Net.url(site).getHost().replaceFirst("^www\\.", "");
            java.net.URL u = Net.url(url);
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
