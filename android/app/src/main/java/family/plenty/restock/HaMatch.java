package family.plenty.restock;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 0.9.4: src/lib/haMatch.ts in Java, line by line (as Deals.java is verdict.ts), for the Home
 * Assistant round in the background job (HaSync.java). Matching a shopping list line's words
 * ("milk", "2 eggs") to a pantry item. No database or network here. The two are checked on the same
 * fixtures (tools/sync-test/ha-fixtures.json: src/lib/haParity.test.ts and HaSyncTest.java).
 *
 * JavaScript's regular expressions differ from Java's in a few places that matter here, so they're
 * spelled out: JavaScript's \s (and trim) is Unicode white space (JS_SPACE below), its "." matches
 * everything but line terminators (all already turned into spaces here, so DOTALL is the same), "$"
 * without the m flag is only the end ("\\z"), and the i flag on [a-z] is ASCII only (as Java's
 * CASE_INSENSITIVE).
 */
final class HaMatch {
    private HaMatch() {}

    /** A line's words read for matching (haMatch.ts ParsedLine). */
    static final class Parsed {
        final int qty;
        final String name;
        final String key;

        Parsed(int qty, String name, String key) {
            this.qty = qty;
            this.name = name;
            this.key = key;
        }
    }

    /** A pantry item (haMatch.ts NamedItem). */
    static final class Named {
        final String id;
        final String name;
        /** 0.9.5: the item's tab ("pantry", "keg" or "pharmacy"; null is the pantry). */
        final String section;

        Named(String id, String name) {
            this(id, name, null);
        }

        Named(String id, String name, String section) {
            this.id = id;
            this.name = name;
            this.section = section;
        }
    }

    /** JavaScript's \s: its WhiteSpace and LineTerminator characters. */
    static final String JS_SPACE = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
    private static final String JS_NOT_SPACE = "[^\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
    private static final Pattern SPACES = Pattern.compile(JS_SPACE + "+");
    private static final Pattern COMBINING = Pattern.compile("[\\u0300-\\u036f]");
    private static final Pattern NOT_WORD = Pattern.compile("[^\\p{L}\\p{N}\\p{M}]+");
    /** Words at the start a voice add can have that aren't the thing ("some milk"). */
    private static final Pattern LEADING = Pattern.compile("^(?:a|an|some|more|the)" + JS_SPACE + "+", Pattern.CASE_INSENSITIVE);
    private static final Pattern END_PUNCT = Pattern.compile("[.!?,;:]+\\z");
    private static final Pattern LEAD_X = Pattern.compile("^(\\d{1,2})" + JS_SPACE + "*[x×*]" + JS_SPACE + "+(" + JS_NOT_SPACE + ".*)\\z", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern LEAD = Pattern.compile("^(\\d{1,2})" + JS_SPACE + "+(" + JS_NOT_SPACE + ".*)\\z", Pattern.DOTALL);
    private static final Pattern TAIL = Pattern.compile("^(" + JS_NOT_SPACE + ".*?)" + JS_SPACE + "+[x×*]" + JS_SPACE + "*(\\d{1,2})\\z", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern WORD = Pattern.compile("^([a-z]+)" + JS_SPACE + "+(" + JS_NOT_SPACE + ".*)\\z", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern ES_END = Pattern.compile("(ch|sh|x|z|ss)es\\z");

    private static final Map<String, Integer> NUMBER_WORDS = new HashMap<>();

    static {
        String[] w = { "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve" };
        for (int i = 0; i < w.length; i++) NUMBER_WORDS.put(w[i], i + 1);
    }

    private static boolean jsSpace(char c) {
        return c == '\t' || c == '\n' || c == 0x0B || c == '\f' || c == '\r' || c == ' ' || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A)
            || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
    }

    /** JavaScript's String.prototype.trim (Java's trim only takes off what's at or below a space). */
    static String jsTrim(String s) {
        int a = 0, b = s.length();
        while (a < b && jsSpace(s.charAt(a))) a++;
        while (b > a && jsSpace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    /** One form for a word's singular and plural, so "eggs" and "egg", "berries" and "berry" match. Not a real singular. */
    static String wordKey(String w) {
        String s = w;
        if (s.length() > 3 && !(s.endsWith("ss") || s.endsWith("us") || s.endsWith("is"))) {
            if (s.endsWith("ies") && s.length() > 4) s = s.substring(0, s.length() - 3) + "i";
            else if (s.endsWith("oes") && s.length() > 4) s = s.substring(0, s.length() - 2);
            else if (ES_END.matcher(s).find()) s = s.substring(0, s.length() - 2);
            else if (s.endsWith("s")) s = s.substring(0, s.length() - 1);
        }
        if (s.length() > 2 && s.endsWith("ie")) s = s.substring(0, s.length() - 1);
        else if (s.length() > 2 && s.endsWith("y")) s = s.substring(0, s.length() - 1) + "i";
        return s;
    }

    /** The key a name matches on: case, accents, punctuation and extra spaces don't count, nor do plurals. */
    static String matchKey(String text) {
        String t = Normalizer.normalize(text, Normalizer.Form.NFKD);
        t = COMBINING.matcher(t).replaceAll("");
        t = t.toLowerCase(Locale.ROOT);
        t = t.replace("&", " and ");
        // Letters and numbers of any language ("Молоко", "牛奶"), not just a to z.
        t = NOT_WORD.matcher(t).replaceAll(" ");
        t = jsTrim(t);
        t = LEADING.matcher(t).replaceFirst("");
        StringBuilder out = new StringBuilder();
        for (String w : t.split(" ", -1)) {
            if (w.isEmpty()) continue;
            if (out.length() > 0) out.append(' ');
            out.append(wordKey(w));
        }
        return out.toString();
    }

    /** "2 milk", "2 x milk", "2× milk", "milk x2", "two milks", "some milk": how many, and what. */
    static Parsed parseLine(String text) {
        String t = SPACES.matcher(text == null ? "" : text).replaceAll(" ");
        t = jsTrim(t);
        t = END_PUNCT.matcher(t).replaceFirst("");
        t = jsTrim(t);
        int qty = 1;
        // "2 x milk", "2x milk", "2 milk"; "milk x2", "milk x 2". Not "2xl" or "box 2".
        Matcher lead = LEAD_X.matcher(t);
        if (!lead.matches()) {
            lead = LEAD.matcher(t);
            if (!lead.matches()) lead = null;
        }
        Matcher tail = TAIL.matcher(t);
        boolean hasTail = tail.matches();
        Matcher word = WORD.matcher(t);
        boolean hasWord = word.matches();
        if (lead != null && Integer.parseInt(lead.group(1)) > 0) {
            qty = Integer.parseInt(lead.group(1));
            t = lead.group(2);
        } else if (hasTail && Integer.parseInt(tail.group(2)) > 0) {
            qty = Integer.parseInt(tail.group(2));
            t = tail.group(1);
        } else if (hasWord && NUMBER_WORDS.containsKey(word.group(1).toLowerCase(Locale.ROOT))) {
            qty = NUMBER_WORDS.get(word.group(1).toLowerCase(Locale.ROOT));
            t = word.group(2);
        }
        String bare = jsTrim(LEADING.matcher(t).replaceFirst(""));
        t = bare.isEmpty() ? t : bare;
        return new Parsed(qty, t, matchKey(t));
    }

    /** What Home Assistant's list shows for a line: "Milk", or "2 × Milk". */
    static String lineSummary(String name, double qty) {
        double f = Math.floor(qty);
        long n = Double.isNaN(f) || f == 0 ? 1 : Math.max(1, (long) f);
        String t = jsTrim(SPACES.matcher(name).replaceAll(" "));
        return n > 1 ? n + " × " + t : t;
    }

    /**
     * The pantry items a line's words could be. A saved alias wins ("Always use this for milk");
     * then items whose name matches exactly (case, spaces and plurals aside). The whole text is tried
     * before the text without its number, so "2 minute noodles" still finds "2 Minute Noodles".
     */
    static List<Named> candidates(String text, List<Named> items, Map<String, String> aliases) {
        Parsed p = parseLine(text);
        Set<String> keys = new LinkedHashSet<>();
        String whole = matchKey(text);
        if (!whole.isEmpty()) keys.add(whole);
        if (!p.key.isEmpty()) keys.add(p.key);
        Map<String, Named> byId = new HashMap<>();
        for (Named i : items) byId.put(i.id, i);
        for (String k : keys) {
            Named a = aliases != null && aliases.containsKey(k) ? byId.get(aliases.get(k)) : null;
            if (a != null) {
                List<Named> one = new ArrayList<>();
                one.add(a);
                return one;
            }
        }
        for (String k : keys) {
            List<Named> hits = new ArrayList<>();
            for (Named i : items) if (matchKey(i.name).equals(k)) hits.add(i);
            if (!hits.isEmpty()) return hits;
        }
        return new ArrayList<>();
    }

    /** The one pantry item a line is, or null when there's none or more than one. */
    static Named matchOne(String text, List<Named> items, Map<String, String> aliases) {
        List<Named> c = candidates(text, items, aliases);
        return c.size() == 1 ? c.get(0) : null;
    }
}
