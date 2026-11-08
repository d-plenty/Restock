package family.plenty.restock;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Java port of src/lib/verdict.ts and src/lib/units.ts, used by the background worker to
 * decide which deals deserve a notification. Plain Java on purpose (no Android classes), so
 * it can be unit-tested on a desktop JVM against the TypeScript results.
 * Keep the two in step: if a rule changes in verdict.ts, change it here too.
 */
public final class Deals {
    private Deals() {}

    static final long DAY = 86_400_000L;
    static final int HISTORY_DAYS = 183;
    static final double GOOD_SALE = 0.15;
    static final double GREAT_SALE = 0.30;
    /** Under this many days of its own history, a product is still learning (types.ts LEARNING_DAYS). */
    static final int LEARNING_DAYS = 25;
    /** A lower price that lasts longer than this is treated as the old shelf price, not a special. */
    static final int MAX_SALE_DAYS = 42;

    // ---------- data ----------

    public static final class Reading {
        public final String date; // ISO-8601
        public final double price;
        public final Double was;
        public final boolean special;
        public final boolean member;
        /** The store's promo text, e.g. "2 for $5". */
        public final String promo;

        public Reading(String date, double price, Double was, boolean special, boolean member) {
            this(date, price, was, special, member, null);
        }

        public Reading(String date, double price, Double was, boolean special, boolean member, String promo) {
            this.date = date;
            this.price = price;
            this.was = was;
            this.special = special;
            this.member = member;
            this.promo = promo;
        }

        long time() {
            return Instant.parse(date).toEpochMilli();
        }
    }

    public static final class Product {
        public final String id;
        public final String chain;
        public final String name;
        public final String size;
        public final Double qty;
        public final String qtyUnit;
        /** Online stock: true / false, or null when the store doesn't say. */
        public final Boolean inStock;
        /** Shared price history summary, when there is one (the market table). */
        public Market market;

        public Product(String id, String chain, String name, String size, Double qty, String qtyUnit) {
            this(id, chain, name, size, qty, qtyUnit, null);
        }

        public Product(String id, String chain, String name, String size, Double qty, String qtyUnit, Boolean inStock) {
            this.id = id;
            this.chain = chain;
            this.name = name;
            this.size = size;
            this.qty = qty;
            this.qtyUnit = qtyUnit;
            this.inStock = inStock;
        }
    }

    public static final class Item {
        public final String id;
        public final String name;
        public final String usual;
        public final List<String> same;
        public final List<String> alts;
        /** For alertLevel "custom": alert at this % off or more (threshold_pct column). */
        public final Double alertPct;
        public final String alertLevel;
        /** May bigger packs be suggested as swaps (allow_bulk column)? */
        public final boolean allowBulk;
        /** Do multi-buy deals count (allow_multi column)? */
        public boolean allowMulti = true;

        public Item(String id, String name, String usual, List<String> same, List<String> alts, Double alertPct, String alertLevel) {
            this(id, name, usual, same, alts, alertPct, alertLevel, true);
        }

        public Item(String id, String name, String usual, List<String> same, List<String> alts, Double alertPct, String alertLevel,
                    boolean allowBulk) {
            this.allowBulk = allowBulk;
            this.id = id;
            this.name = name;
            this.usual = usual;
            this.same = same;
            this.alts = alts;
            this.alertPct = alertPct;
            this.alertLevel = alertLevel;
        }
    }

    /** Summary of shared price history for one store product (MarketSummary in types.ts). */
    public static final class Market {
        public double normal;
        public Double sale;
        public double saleShare;
        public double low;
        public Integer cycleWeeks;
        public int days;
        /** Latest price in the shared history (to match it to local prices). */
        public Double latest;
    }

    public static final class Stats {
        public Reading current;
        public Double typical;
        public boolean typicalFromHistory;
        public Double low;
        public int readings;
        public int spanDays;
        public Integer cycleWeeks;
        public boolean fromMarket;
    }

    public enum Kind { GREAT, GOOD, SMALL, WAIT, FAKE, NORMAL, NODATA }

    public enum Action { BUY, ALT, SMALL, WAIT, SKIP, NONE }

    public static final class Option {
        public Product product;
        public String role; // main | alt
        public Stats stats;
        public Kind kind;
        public Double discount;
        public Double price;
        public Double unitPrice;
        public Double normalUnitPrice;
        public String unit;
    }

    public static final class Recommendation {
        public Item item;
        public Option best;
        public Option alt;
        public boolean outOfStock;
        public Option stockAlt;
        public Action action = Action.NONE;
        public String headline = "";
    }

    // ---------- sizes (units.ts) ----------

    public static final class Size {
        public final double qty;
        public final String unit; // g | ml | ea
        /** How many are in the pack, when it was worked out from a count and the size of each. */
        public final Integer count;

        Size(double qty, String unit) {
            this(qty, unit, null);
        }

        Size(double qty, String unit, Integer count) {
            this.qty = qty;
            this.unit = unit;
            this.count = count;
        }
    }

    /** A parsed size and what kind of label it came from (units.ts parseParts). */
    private static final class Parts {
        final double qty;
        final String unit;
        final String kind; // multi | single | count | each
        final String word;
        final Integer count;

        Parts(double qty, String unit, String kind, String word, Integer count) {
            this.qty = qty;
            this.unit = unit;
            this.kind = kind;
            this.word = word;
            this.count = count;
        }
    }

    private static final String NUM = "(\\d+(?:\\.\\d+)?)";
    private static final String MASS_VOL = "(kg|g|ml|l)";
    private static final Pattern MULTI_A = Pattern.compile("(\\d+)\\s*x\\s*" + NUM + "\\s*" + MASS_VOL + "\\b");
    private static final Pattern MULTI_B = Pattern.compile(NUM + "\\s*" + MASS_VOL + "\\s*x\\s*(\\d+)\\b");
    private static final Pattern SINGLE = Pattern.compile(NUM + "\\s*" + MASS_VOL + "\\b");
    private static final Pattern COUNT = Pattern.compile(
        "(\\d+)\\s*(packs?|pk|cans?|bottles?|sheets?|rolls?|ea|each|count|ct|tablets?|tabs|capsules?|pods?|bags?|pieces?|pce|wipes?)\\b");
    private static final Pattern EACH = Pattern.compile("\\b(each|ea)\\b");
    private static final Pattern SHEETS = Pattern.compile("\\bsheets?\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PACK_WORD = Pattern.compile("^(packs?|pk|cans?|bottles?)$");

    private static Size toBase(double amount, String unit) {
        switch (unit) {
            case "kg": return new Size(amount * 1000, "g");
            case "g": return new Size(amount, "g");
            case "l": return new Size(amount * 1000, "ml");
            default: return new Size(amount, "ml");
        }
    }

    private static Parts parseParts(String input) {
        if (input == null || input.isEmpty()) return null;
        String s = input.toLowerCase()
            .replaceAll("(\\d),(?=\\d{3}(?!\\d))", "$1") // "1,120 sheets" is 1120 (0.7.6)
            .replaceAll("litres?|liters?", "l")
            .replaceAll("millilitres?|milliliters?", "ml")
            .replaceAll("kilograms?|kilos?", "kg")
            .replaceAll("grams?", "g")
            .replace('\u00d7', 'x');
        Matcher m = MULTI_A.matcher(s);
        if (m.find()) {
            Size b = toBase(Double.parseDouble(m.group(2)), m.group(3));
            int n = Integer.parseInt(m.group(1));
            return new Parts(b.qty * n, b.unit, "multi", null, n);
        }
        m = MULTI_B.matcher(s);
        if (m.find()) {
            Size b = toBase(Double.parseDouble(m.group(1)), m.group(2));
            int n = Integer.parseInt(m.group(3));
            return new Parts(b.qty * n, b.unit, "multi", null, n);
        }
        m = SINGLE.matcher(s);
        if (m.find()) {
            Size b = toBase(Double.parseDouble(m.group(1)), m.group(2));
            return new Parts(b.qty, b.unit, "single", null, null);
        }
        m = COUNT.matcher(s);
        if (m.find()) return new Parts(Integer.parseInt(m.group(1)), "ea", "count", m.group(2), null);
        if (EACH.matcher(s).find()) return new Parts(1, "ea", "each", null, null);
        return null;
    }

    public static Size parseSize(String input) {
        Parts p = parseParts(input);
        return p == null ? null : new Size(p.qty, p.unit);
    }

    /** Is a measure in the name the size of each one in the pack? (units.ts measureIsEach) */
    private static boolean measureIsEach(Parts measure, double count) {
        if ("ml".equals(measure.unit)) return measure.qty <= 600 || measure.qty / count < 100;
        if ("g".equals(measure.unit)) return measure.qty / count < 15;
        return false;
    }

    private static final Pattern PACK_COUNT = Pattern.compile("(\\d+)\\s*(packs?|pk|cans?|bottles?)\\b");

    /** "24 Pack", "30 cans" or "6pk" anywhere in a name (units.ts packCountIn). */
    private static Integer packCountIn(String name) {
        if (name == null) return null;
        Matcher m = PACK_COUNT.matcher(name.toLowerCase());
        if (!m.find()) return null;
        int n = Integer.parseInt(m.group(1));
        return n > 1 ? n : null;
    }

    private static boolean packWord(String w) {
        return w != null && PACK_WORD.matcher(w).find();
    }

    /** The size from both the size and the name: "30 Pack" + "375ml" is 11,250 ml (units.ts packSize). */
    public static Size packSize(String size, String name) {
        Parts s = parseParts(size);
        Parts n = parseParts(name);
        if (s != null && "count".equals(s.kind) && s.qty > 1 && packWord(s.word) && n != null && !"ea".equals(n.unit)) {
            if ("multi".equals(n.kind)) return new Size(n.qty, n.unit, n.count);
            if ("single".equals(n.kind)) {
                return measureIsEach(n, s.qty) ? new Size(n.qty * s.qty, n.unit, (int) s.qty) : new Size(n.qty, n.unit, (int) s.qty);
            }
        }
        if (s != null && "single".equals(s.kind) && n != null && "multi".equals(n.kind) && n.unit.equals(s.unit) && n.qty > s.qty) {
            return new Size(n.qty, n.unit, n.count);
        }
        Integer named = packCountIn(name);
        if (s != null && "single".equals(s.kind) && "ml".equals(s.unit) && s.qty <= 600 && named != null && (n == null || !"multi".equals(n.kind))) {
            return new Size(s.qty * named, "ml", named);
        }
        // Size "1 each", name "… Tablets 70 Pack": the name has how many (units.ts packSize).
        if (s != null && "ea".equals(s.unit) && s.qty <= 1 && n != null && "count".equals(n.kind) && n.qty > 1) return new Size(n.qty, "ea");
        Parts p = s != null ? s : n;
        if (p == null) return null;
        return new Size(p.qty, p.unit, "multi".equals(p.kind) && p.count != null && p.count > 1 ? p.count : null);
    }

    static Size productQty(Product p) {
        if (p.qty != null && p.qty > 0 && p.qtyUnit != null) return new Size(p.qty, p.qtyUnit);
        return packSize(p.size, p.name);
    }

    // ---------- stats & verdicts (verdict.ts) ----------

    static Double median(List<Double> values) {
        if (values.isEmpty()) return null;
        List<Double> s = new ArrayList<>(values);
        Collections.sort(s);
        int mid = s.size() / 2;
        return s.size() % 2 == 1 ? s.get(mid) : (s.get(mid - 1) + s.get(mid)) / 2;
    }

    static List<Reading> normalise(List<Reading> raw, long now) {
        List<Reading> sorted = new ArrayList<>(raw);
        sorted.sort((a, b) -> a.date.compareTo(b.date));
        Map<String, Reading> byDay = new LinkedHashMap<>();
        for (Reading r : sorted) {
            if (now - r.time() > HISTORY_DAYS * DAY) continue;
            byDay.put(localDay(r.date), r);
        }
        return new ArrayList<>(byDay.values());
    }

    /**
     * The calendar day (yyyy-mm-dd) a time falls on where the phone is. Not the UTC day: in
     * Australia that runs 10am to 10am, so an evening price and the next morning's sale would
     * count as one day. Same as localDay in verdict.ts.
     */
    static String localDay(String iso) {
        try {
            return Instant.parse(iso).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString();
        } catch (Exception e) {
            return iso.length() >= 10 ? iso.substring(0, 10) : iso;
        }
    }

    public static Stats computeStats(List<Reading> raw, long now) {
        Stats st = new Stats();
        List<Reading> rs = normalise(raw, now);
        if (rs.isEmpty()) return st;
        Reading current = rs.get(rs.size() - 1);
        List<Reading> history = rs.subList(0, rs.size() - 1);

        List<Double> nonSpecial = new ArrayList<>();
        List<Double> was = new ArrayList<>();
        for (Reading r : rs) {
            if (!r.special) nonSpecial.add(r.price);
            if (r.was != null && r.was > 0) was.add(r.was);
        }
        Double fromHistory = median(nonSpecial);
        st.typicalFromHistory = fromHistory != null;
        st.typical = fromHistory != null ? fromHistory : median(was);

        for (Reading r : history) if (st.low == null || r.price < st.low) st.low = r.price;

        List<Long> starts = new ArrayList<>();
        for (int i = 0; i < rs.size(); i++) {
            if (rs.get(i).special && (i == 0 || !rs.get(i - 1).special)) starts.add(rs.get(i).time());
        }
        if (starts.size() >= 2) {
            double sum = 0;
            for (int i = 1; i < starts.size(); i++) sum += starts.get(i) - starts.get(i - 1);
            st.cycleWeeks = (int) Math.round(sum / (starts.size() - 1) / (7.0 * DAY));
        }
        st.current = current;
        st.readings = rs.size();
        st.spanDays = (int) Math.round((current.time() - rs.get(0).time()) / (double) DAY);
        return st;
    }

    /** Shared price history fills in for a product that's still learning. Mirrors withMarket in verdict.ts. */
    static Stats withMarket(Stats st, Market m) {
        if (m == null || st.current == null || st.spanDays >= LEARNING_DAYS || !(m.normal > 0) || m.days < LEARNING_DAYS) return st;
        double k = marketScale(st.current, m);
        double mLow = m.low * k;
        Stats out = new Stats();
        out.current = st.current;
        out.typical = m.normal * k;
        out.typicalFromHistory = true;
        out.low = st.low == null ? mLow : Math.min(st.low, mLow);
        out.cycleWeeks = st.cycleWeeks != null ? st.cycleWeeks : m.cycleWeeks;
        out.readings = Math.max(st.readings, 4);
        out.spanDays = Math.max(st.spanDays, m.days);
        out.fromMarket = true;
        return out;
    }

    /** Scale shared history to local prices. Mirrors marketScale in verdict.ts. */
    static double marketScale(Reading cur, Market m) {
        Double ratio = null;
        if (cur.special) {
            if (cur.was != null && cur.was > 0) ratio = cur.was / m.normal;
        } else if (m.latest != null && m.latest > 0 && m.latest >= m.normal * 0.97) {
            ratio = cur.price / m.latest;
        } else {
            ratio = cur.price / m.normal;
        }
        if (ratio == null || ratio < 0.8 || ratio > 1.25) return 1;
        return Math.abs(ratio - 1) < 0.01 ? 1 : ratio;
    }

    /**
     * Summarises a product's price history (change points: each price holds until the next date)
     * over the last windowDays. Normal = the price it sat at longest among the higher half of its
     * prices; on sale = 3% or more below normal for at most MAX_SALE_DAYS. Returns null with under
     * LEARNING_DAYS of history.
     */
    public static Market summarise(List<String> dates, List<Double> prices, long now, int windowDays) {
        int n = Math.min(dates.size(), prices.size());
        if (n == 0) return null;
        long[] start = new long[n];
        double[] price = new double[n];
        Integer[] order = new Integer[n];
        for (int i = 0; i < n; i++) {
            start[i] = dayStart(dates.get(i));
            price[i] = prices.get(i);
            order[i] = i;
        }
        java.util.Arrays.sort(order, (a, b) -> Long.compare(start[a], start[b]));
        long from = now - windowDays * DAY;
        List<double[]> segs = new ArrayList<>(); // {price, days}
        for (int k = 0; k < n; k++) {
            int i = order[k];
            long s0 = Math.max(start[i], from);
            long s1 = k + 1 < n ? start[order[k + 1]] : now;
            if (s1 > now) s1 = now;
            if (s1 <= s0 || !(price[i] > 0)) continue;
            segs.add(new double[] {price[i], (s1 - s0) / (double) DAY});
        }
        double total = 0;
        for (double[] sg : segs) total += sg[1];
        if (segs.isEmpty() || total < LEARNING_DAYS) return null;

        // Duration-weighted median, then the longest-held price at or above it.
        List<double[]> byPrice = new ArrayList<>(segs);
        byPrice.sort((a, b) -> Double.compare(a[0], b[0]));
        double acc = 0, mid = byPrice.get(byPrice.size() - 1)[0];
        for (double[] sg : byPrice) {
            acc += sg[1];
            if (acc >= total / 2) {
                mid = sg[0];
                break;
            }
        }
        Map<Long, Double> held = new HashMap<>();
        for (double[] sg : segs) {
            if (sg[0] < mid - 1e-9) continue;
            long cents = Math.round(sg[0] * 100);
            held.put(cents, held.getOrDefault(cents, 0.0) + sg[1]);
        }
        long bestCents = -1;
        double bestDays = -1;
        for (Map.Entry<Long, Double> e : held.entrySet()) {
            if (e.getValue() > bestDays + 1e-9 || (Math.abs(e.getValue() - bestDays) <= 1e-9 && e.getKey() > bestCents)) {
                bestCents = e.getKey();
                bestDays = e.getValue();
            }
        }
        double normal = bestCents / 100.0;

        double saleDays = 0, low = Double.MAX_VALUE;
        int runs = 0;
        boolean inSale = false;
        List<double[]> salePrices = new ArrayList<>();
        for (double[] sg : segs) {
            low = Math.min(low, sg[0]);
            // Specials last weeks. A lower price held for longer is an old shelf price, not a sale.
            boolean sale = sg[0] <= normal * 0.97 && sg[1] <= MAX_SALE_DAYS;
            if (sale) {
                saleDays += sg[1];
                salePrices.add(sg);
                if (!inSale) runs++;
            }
            inSale = sale;
        }
        Market m = new Market();
        m.normal = normal;
        m.low = low;
        m.saleShare = saleDays / total;
        m.days = (int) Math.round(total);
        m.latest = segs.get(segs.size() - 1)[0];
        if (!salePrices.isEmpty()) {
            salePrices.sort((a, b) -> Double.compare(a[0], b[0]));
            double half = saleDays / 2, a2 = 0;
            for (double[] sg : salePrices) {
                a2 += sg[1];
                if (a2 >= half) {
                    m.sale = sg[0];
                    break;
                }
            }
        }
        if (runs >= 2) m.cycleWeeks = (int) Math.max(1, Math.round(total / runs / 7.0));
        return m;
    }

    /** "2026-11-05" or a full ISO time → milliseconds at the start of that day (UTC). */
    static long dayStart(String date) {
        String d = date.length() >= 10 ? date.substring(0, 10) : date;
        return java.time.LocalDate.parse(d).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli();
    }

    /** The price this shopper actually pays: member prices only count with the card. */
    static final double HALF_PRICE = 0.45;
    private static final java.util.regex.Pattern MULTI = java.util.regex.Pattern.compile(
        "(\\d{1,2})\\s*for\\s*\\$\\s*(\\d+(?:\\.\\d{1,2})?)", java.util.regex.Pattern.CASE_INSENSITIVE);

    /** Multi-buy "2 for $5" → {2, 5}, or null. Mirrors multiBuy in verdict.ts. */
    static double[] multiBuy(String promo) {
        if (promo == null) return null;
        java.util.regex.Matcher m = MULTI.matcher(promo);
        if (!m.find()) return null;
        int n = Integer.parseInt(m.group(1));
        double total = Double.parseDouble(m.group(2));
        if (n < 2 || n > 12 || !(total > 0)) return null;
        return new double[] {n, total};
    }

    static double effectivePrice(Reading r, boolean hasCard) {
        return effectivePrice(r, hasCard, true);
    }

    static double effectivePrice(Reading r, boolean hasCard, boolean allowMulti) {
        if (r.member && !hasCard) return r.was != null ? r.was : r.price;
        double[] mb = allowMulti ? multiBuy(r.promo) : null;
        if (mb != null && mb[1] / mb[0] < r.price - 0.004) return mb[1] / mb[0];
        return r.price;
    }

    /** Returns the verdict kind; fills in o.discount when there's a price to compare with. */
    static Kind judge(Stats st, boolean hasCard, Option o) {
        return judge(st, hasCard, o, true);
    }

    /** Mirrors judge in verdict.ts, with the item's multi-buy setting. */
    static Kind judge(Stats st, boolean hasCard, Option o, boolean allowMulti) {
        Reading cur = st.current;
        if (cur == null) return Kind.NODATA;
        boolean locked = cur.member && !hasCard;
        double p = effectivePrice(cur, hasCard, allowMulti);
        boolean multi = !locked && allowMulti && multiBuy(cur.promo) != null && p < cur.price - 0.004;
        boolean multiOnly = !allowMulti && multiBuy(cur.promo) != null && !(cur.was != null && cur.was > cur.price + 0.004);
        boolean special = ((cur.special && !multiOnly) || multi) && !locked;
        Double ref = st.typical != null ? st.typical : cur.was;
        if (locked) return Kind.NORMAL;
        if (ref == null) return special ? Kind.SMALL : Kind.NORMAL;
        double discount = 1 - p / ref;
        if (o != null) o.discount = discount;
        if (ref - p < 0.005) return special ? Kind.FAKE : Kind.NORMAL;
        boolean enough = st.readings >= 4 && st.spanDays >= 21;
        if (enough && st.low != null && st.low < p * 0.95 && discount < HALF_PRICE) return Kind.WAIT;
        return discount >= GREAT_SALE ? Kind.GREAT : discount >= GOOD_SALE ? Kind.GOOD : Kind.SMALL;
    }

    public static Kind judge(Stats st, boolean hasCard) {
        return judge(st, hasCard, null);
    }

    /** A bigger pack than your own product (over 1.5 times). Mirrors isBulk in verdict.ts. */
    static boolean isBulk(Option o, List<Option> options, Item item) {
        Option ref = null;
        for (Option x : options) {
            Size s = productQty(x.product);
            if (x.product.id.equals(item.usual) && s != null && s.qty > 0) {
                ref = x;
                break;
            }
        }
        if (ref == null) {
            for (Option x : options) {
                Size s = productQty(x.product);
                if ("main".equals(x.role) && s != null && s.qty > 0) {
                    ref = x;
                    break;
                }
            }
        }
        if (ref == null || ref == o) return false;
        Size a = productQty(o.product);
        Size b = productQty(ref.product);
        return a != null && b != null && a.qty > 0 && b.qty > 0 && a.unit.equals(b.unit) && a.qty > b.qty * 1.5;
    }

    static boolean gone(Option o) {
        return Boolean.FALSE.equals(o.product.inStock);
    }

    static boolean onSale(Option o) {
        return o != null && (o.kind == Kind.GREAT || o.kind == Kind.GOOD || o.kind == Kind.SMALL);
    }

    public static Recommendation recommend(Item item, Map<String, Product> products, Map<String, List<Reading>> readings,
                                           Set<String> cardChains, long now) {
        List<String[]> ids = new ArrayList<>();
        if (item.usual != null) ids.add(new String[] {item.usual, "main"});
        for (String id : item.same) ids.add(new String[] {id, "main"});
        for (String id : item.alts) ids.add(new String[] {id, "alt"});

        List<Option> options = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String[] pair : ids) {
            Product product = products.get(pair[0]);
            if (product == null || !seen.add(pair[0])) continue;
            Option o = new Option();
            o.product = product;
            o.role = pair[1];
            List<Reading> rs = readings.get(product.id);
            o.stats = withMarket(computeStats(rs != null ? rs : Collections.<Reading>emptyList(), now), product.market);
            boolean hasCard = cardChains.contains(product.chain);
            o.kind = judge(o.stats, hasCard, o, item.allowMulti);
            Size size = productQty(product);
            o.unit = size != null ? size.unit : null;
            if (o.stats.current != null) o.price = effectivePrice(o.stats.current, hasCard, item.allowMulti);
            if (size != null && size.qty > 0) {
                if (o.price != null) o.unitPrice = o.price / size.qty;
                if (o.stats.typical != null) o.normalUnitPrice = o.stats.typical / size.qty;
            }
            options.add(o);
        }

        Recommendation rec = new Recommendation();
        rec.item = item;
        List<Option> priced = new ArrayList<>();
        for (Option o : options) if (o.price != null) priced.add(o);
        if (priced.isEmpty()) return rec;

        Set<String> units = new HashSet<>();
        boolean allUnitPrices = true;
        for (Option o : priced) {
            // Sheets and packs both count, but not the same thing (verdict.ts, 0.8.9).
            boolean sheets = o.product.qty == null && o.product.size != null && SHEETS.matcher(o.product.size).find();
            units.add(sheets ? "sheet" : o.unit);
            if (o.unitPrice == null) allUnitPrices = false;
        }
        final boolean byUnit = units.size() == 1 && !units.contains(null) && allUnitPrices;

        // Out-of-stock products only count when nothing else is available.
        Option best = null;
        Option bestAny = null;
        for (Option o : priced) {
            if (!"main".equals(o.role)) continue;
            if (bestAny == null || cost(o, byUnit) < cost(bestAny, byUnit)) bestAny = o;
            if (!gone(o) && (best == null || cost(o, byUnit) < cost(best, byUnit))) best = o;
        }
        if (best == null) best = bestAny;
        boolean outOfStock = best != null && gone(best);
        Option alt = null;
        Option stockAlt = null;
        for (Option o : priced) {
            if (!"alt".equals(o.role) || gone(o)) continue;
            if (!item.allowBulk && isBulk(o, options, item)) continue;
            if (outOfStock && (stockAlt == null || cost(o, byUnit) < cost(stockAlt, byUnit))) stockAlt = o;
            if (!onSale(o)) continue;
            if (best != null && !outOfStock && !(cost(o, byUnit) < cost(best, byUnit))) continue;
            if (alt == null || cost(o, byUnit) < cost(alt, byUnit)) alt = o;
        }
        rec.best = best;
        rec.alt = alt;
        rec.outOfStock = outOfStock;
        rec.stockAlt = stockAlt;

        if (best != null && !outOfStock && (best.kind == Kind.GREAT || best.kind == Kind.GOOD)) {
            rec.action = Action.BUY;
            rec.headline = (best.kind == Kind.GREAT ? "Great deal at " : "On sale at ") + chainName(best.product.chain);
            return rec;
        }
        if (alt != null) {
            rec.action = Action.ALT;
            rec.headline = "Swap & save at " + chainName(alt.product.chain);
            return rec;
        }
        if (best == null) return rec;
        if (outOfStock) {
            rec.action = Action.NONE;
            rec.headline = "Out of stock online";
            return rec;
        }
        String where = chainName(best.product.chain);
        switch (best.kind) {
            case SMALL:
                rec.action = Action.SMALL;
                rec.headline = "Small saving at " + where;
                break;
            case WAIT:
                rec.action = Action.WAIT;
                rec.headline = "Wait for a better sale";
                break;
            case FAKE:
                rec.action = Action.SKIP;
                rec.headline = "Fake sale";
                break;
            default:
                rec.action = Action.NONE;
                rec.headline = "Cheapest at " + where;
        }
        return rec;
    }

    private static double cost(Option o, boolean byUnit) {
        return byUnit ? o.unitPrice : o.price;
    }

    static String chainName(String chain) {
        switch (chain) {
            case "woolworths": return "Woolworths";
            case "coles": return "Coles";
            case "aldi": return "Aldi";
            default: return "other store";
        }
    }

    /** The option a deal is about: the alternative for ALT, your product for BUY / SMALL. */
    public static Option dealOption(Recommendation rec) {
        if (rec.action == Action.ALT) return rec.alt;
        if (rec.action == Action.BUY || rec.action == Action.SMALL) return rec.best;
        return null;
    }

    /** Same rule as worthAlerting() in verdict.ts. */
    public static boolean worthAlerting(Recommendation rec) {
        Option o = dealOption(rec);
        String level = rec.item.alertLevel;
        if (o == null || level == null || "never".equals(level) || o.product.id.startsWith("demo-")) return false;
        switch (level) {
            case "any": return o.kind == Kind.GREAT || o.kind == Kind.GOOD || o.kind == Kind.SMALL;
            case "good": return o.kind == Kind.GREAT || o.kind == Kind.GOOD;
            case "great": return o.kind == Kind.GREAT;
            case "custom": {
                double want = (rec.item.alertPct != null ? rec.item.alertPct : 30) / 100.0;
                return (o.discount != null ? o.discount : 0) >= want - 1e-9;
            }
            default: return false;
        }
    }
}
