package family.plenty.restock;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reading the official Australian recall lists, and matching them against what you have.
 * Plain Java (no Android), so it can be tested on a computer; RecallChecker does the fetching.
 *
 * Sources: FSANZ food recall alerts (a web page; FSANZ coordinates food recalls in Australia),
 * Product Safety Australia's recalls feed (ACCC, consumer goods including pharmacy, cosmetics
 * and cleaning products), and the TGA's alerts feed for medicines where it answers.
 *
 * Matching is cautious: recall notices name a company, brand and product but rarely a barcode,
 * so a match is only a "possible recall" and needs the brand plus a product word to line up.
 */
public final class Recalls {
    private Recalls() {}

    public static final class Recall {
        public String id;
        public String source;
        public String title;
        public String url;
        public String date;
        public String reason;
        public String dates;
        public String whatToDo;

        public Recall(String source, String title, String url, String date) {
            this.source = source;
            this.title = title;
            this.url = url;
            this.date = date;
            this.id = source + ":" + url;
        }
    }

    /** Something you have: a pantry/keg/pharmacy item, one of its products, a list line, or a receipt line. */
    public static final class Thing {
        public final String kind;
        public final String name;
        public final String brand;

        public Thing(String kind, String name, String brand) {
            this.kind = kind;
            this.name = name;
            this.brand = brand;
        }
    }

    // ---------- reading the lists ----------

    private static final Pattern FSANZ_LINK = Pattern.compile("<a[^>]+href=\"(/food-recalls/recall-alert/[^\"#?]+)\"[^>]*>\\s*([^<]{6,300}?)\\s*</a>", Pattern.CASE_INSENSITIVE);
    private static final Pattern DATE = Pattern.compile("\\b(\\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \\d{4})\\b");

    /** The FSANZ recall alerts page: each alert's title, link and date. */
    public static List<Recall> parseFsanzList(String html) {
        Map<String, Recall> out = new LinkedHashMap<>();
        Matcher m = FSANZ_LINK.matcher(html);
        while (m.find()) {
            String path = m.group(1);
            String title = text(m.group(2));
            if (title.length() < 6 || out.containsKey(path)) continue;
            // The date follows the title in the listing.
            Matcher d = DATE.matcher(html.substring(m.end(), Math.min(html.length(), m.end() + 600)));
            out.put(path, new Recall("FSANZ", title, "https://www.foodstandards.gov.au" + path, d.find() ? d.group(1) : null));
        }
        return new ArrayList<>(out.values());
    }

    private static final Pattern ITEM = Pattern.compile("<item\\b[^>]*>([\\s\\S]*?)</item>", Pattern.CASE_INSENSITIVE);

    /** An RSS feed (Product Safety Australia, TGA): title, link, date and description of each item. */
    public static List<Recall> parseRss(String xml, String source) {
        List<Recall> out = new ArrayList<>();
        Matcher m = ITEM.matcher(xml);
        while (m.find()) {
            String item = m.group(1);
            String title = text(tag(item, "title"));
            String link = text(tag(item, "link"));
            if (title.isEmpty() || link.isEmpty()) continue;
            Recall r = new Recall(source, title, link, text(tag(item, "pubDate")));
            String desc = text(tag(item, "description"));
            if (!desc.isEmpty()) r.reason = first(desc, 280);
            out.add(r);
        }
        return out;
    }

    /** From an FSANZ recall page: the problem, the date markings and what to do. */
    public static void readFsanzPage(Recall r, String html) {
        String t = text(html.replaceAll("(?is)<(script|style)[^>]*>.*?</\\1>", " "));
        r.reason = after(t, "(?:Problem|Food safety hazard|Reason for recall)\\s*:?", 260, r.reason);
        r.dates = after(t, "(?:Date markings?|Best before|Use by)\\s*:?", 200, r.dates);
        r.whatToDo = after(t, "What (?:to do|should consumers do)\\s*:?", 260, r.whatToDo);
    }

    private static String after(String text, String heading, int max, String fallback) {
        Matcher m = Pattern.compile(heading + "\\s+(.{10," + max + "}?)(?=\\s+(?:Problem|Food safety hazard|Date markings?|What to do|Country of origin|Where the product|Packaging description|Product information|For further information|Recalling company)\\b|$)", Pattern.CASE_INSENSITIVE).matcher(text);
        return m.find() ? first(m.group(1).trim(), max) : fallback;
    }

    // ---------- matching ----------

    /** Words that don't tell products apart (and company words in recall titles). */
    private static final Set<String> STOP = new HashSet<>(Arrays.asList(
        "the", "and", "with", "for", "from", "pack", "packs", "each", "original", "classic", "fresh", "range", "variety", "assorted", "flavour",
        "flavours", "flavor", "new", "pty", "ltd", "limited", "stores", "store", "group", "foods", "food", "company", "australia", "australian",
        "trading", "international", "products", "product", "brand", "brands", "recall", "recalls", "various", "selected", "multiple", "including",
        "also", "sold", "packet", "bottle", "bottles", "can", "cans", "jar", "bag", "box", "tub", "pouch", "tray"));

    public static List<String> tokens(String s) {
        List<String> out = new ArrayList<>();
        if (s == null) return out;
        for (String w : s.toLowerCase(Locale.ROOT).replace("’", "'").replaceAll("'s\\b", "").split("[^a-z0-9]+")) {
            if (w.length() < 3 || STOP.contains(w) || w.matches("\\d+[a-z]{0,2}")) continue;
            out.add(w);
        }
        return out;
    }

    /**
     * Does a recall look like it's about this thing? Needs the brand in the recall's title and at
     * least one product word as well, or most of the thing's name.
     */
    public static boolean matches(Recall r, Thing t) {
        Set<String> recall = new HashSet<>(tokens(r.title));
        List<String> name = tokens(t.name);
        if (name.isEmpty()) return false;
        List<String> brand = t.brand != null && !t.brand.trim().isEmpty() ? tokens(t.brand) : name.subList(0, 1);
        boolean brandHit = !brand.isEmpty() && recall.containsAll(brand);
        int shared = 0;
        for (String w : name) if (recall.contains(w) && !brand.contains(w)) shared++;
        if (brandHit && shared >= 1) return true;
        // Without a clear brand, most of the name has to be there.
        int all = 0;
        for (String w : name) if (recall.contains(w)) all++;
        return name.size() >= 3 && all >= Math.ceil(name.size() * 0.75);
    }

    /** The names of your things a recall might affect (each at most once). */
    public static List<String> affected(Recall r, List<Thing> things) {
        Set<String> seen = new HashSet<>();
        List<String> out = new ArrayList<>();
        for (Thing t : things) {
            if (matches(r, t) && seen.add(t.name.toLowerCase(Locale.ROOT))) out.add(t.name);
        }
        return out;
    }

    // ---------- text ----------

    private static String tag(String xml, String name) {
        Matcher m = Pattern.compile("<" + name + "\\b[^>]*>([\\s\\S]*?)</" + name + ">", Pattern.CASE_INSENSITIVE).matcher(xml);
        if (!m.find()) return "";
        String v = m.group(1);
        Matcher cdata = Pattern.compile("<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>").matcher(v);
        return cdata.find() ? cdata.group(1) : v;
    }

    static String text(String html) {
        if (html == null) return "";
        return html.replaceAll("<[^>]+>", " ")
            .replace("&amp;", "&").replace("&#039;", "'").replace("&#39;", "'").replace("&quot;", "\"").replace("&rsquo;", "’")
            .replace("&lsquo;", "‘").replace("&nbsp;", " ").replace("&ndash;", "–").replace("&mdash;", "—").replace("&lt;", "<").replace("&gt;", ">")
            .replaceAll("\\s+", " ").trim();
    }

    private static String first(String s, int max) {
        if (s.length() <= max) return s;
        String cut = s.substring(0, max);
        int dot = cut.lastIndexOf(". ");
        return (dot > max / 2 ? cut.substring(0, dot + 1) : cut.replaceAll("\\s+\\S*$", "") + "…");
    }
}
