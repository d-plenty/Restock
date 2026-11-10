package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * 0.9.4: the shopping list both ways with a Home Assistant to-do list, in Java, so the phone that
 * does it also syncs in the background job (SyncWorker), where there's no JavaScript. A line-by-line
 * port of src/lib/haSync.ts (the reference, and what the server runs), checked on the same fixtures
 * (tools/sync-test/ha-fixtures.json: src/lib/haParity.test.ts and HaSyncTest.java). How the merge
 * works, and why, is written at the top of haSync.ts; it isn't repeated here.
 *
 * Every phone round goes through here (HomeAssistant.round, which keeps the token): while Restock is
 * open homeAssistant.ts asks for one (RestockNative.haRound) when it opens, every minute and just
 * after the list changes, and the background job asks after the household's sync. LOCK makes it one
 * round at a time, whoever asked. Plain Java (and org.json) so it runs on a computer against
 * Restock's real database layout (tools/sync-test).
 *
 * Also here, for the same reason: which phone does it (listPicks.ts haPhone, claimHaPhone), the
 * phone's settings and status for it (homeAssistant.ts), and what it hands to its server (payload).
 */
final class HaSync {
    private HaSync() {}

    /** One round at a time on this phone (the screens', the background job's). */
    static final ReentrantLock LOCK = new ReentrantLock();

    /**
     * The pairing was started afresh (homeAssistant.ts resetHaPairing: a new address or list, a
     * restore, Erase everything; told through RestockNative.haResetPairing). A round under way when
     * that happens stops before changing anything, or doesn't save its old pairing over the fresh one.
     */
    private static final AtomicInteger PAIRING = new AtomicInteger();

    static void resetPairing() {
        PAIRING.incrementAndGet();
    }

    static int pairingResets() {
        return PAIRING.get();
    }

    /** How long the safety catch waits before an empty Home Assistant list clears the paired lines. */
    static final long EMPTY_HOLD_MS = 2 * 60_000L;
    /** Looks further apart than this don't confirm each other (haSync.ts EMPTY_GAP_MS). */
    static final long EMPTY_GAP_MS = 30 * 60_000L;

    /** Home Assistant has to be at least this new (haSync.ts MIN_HA_VERSION). */
    static final String MIN_HA_VERSION = "2024.8";

    static final String HA_CONFIG = "homeAssistant";
    static final String HA_STATE = "homeAssistantState";
    static final String HA_STATUS = "homeAssistantStatus";
    static final String LIST_ALIASES = "listAliases";
    static final String DEFAULT_LIST = "todo.shopping_list";
    /** Lines made from Home Assistant's list start with this (listPicks.ts FROM_HA). */
    static final String FROM_HA = "ha-";

    /** The upgrade's sealed `ha` has the associated data "RSA3" + device (docs/server-protocol.md v3; ServerSync seals it). */
    static final String RSA3_AAD = "RSA3";

    // ---------- the shapes (haSync.ts) ----------

    /** A to-do item in Home Assistant. */
    static final class Item {
        final String uid;
        final String summary;
        final boolean completed;

        Item(String uid, String summary, boolean completed) {
            this.uid = uid;
            this.summary = summary;
            this.completed = completed;
        }
    }

    /** A line on Restock's grocery list, or General's (0.9.5). */
    static final class Line {
        String id;
        String text;
        double qty;
        boolean checked;
        String groupId;
        /** 0.9.5: the list a new line goes on (addLine); null for the grocery list. */
        String section;

        Line(String id, String text, double qty, boolean checked, String groupId) {
            this(id, text, qty, checked, groupId, null);
        }

        Line(String id, String text, double qty, boolean checked, String groupId, String section) {
            this.id = id;
            this.text = text;
            this.qty = qty;
            this.checked = checked;
            this.groupId = groupId;
            this.section = section;
        }
    }

    /** Tabs whose items a voice add is matched to, first to last (haSync.ts MATCH_ORDER). */
    private static final String[] MATCH_ORDER = { "pantry", "keg", "pharmacy" };

    static String tabOfItem(HaMatch.Named i) {
        return "keg".equals(i.section) || "pharmacy".equals(i.section) ? i.section : "pantry";
    }

    /** 0.9.5 (haSync.ts onHaList): a line on Home Assistant's list: on the grocery list or General, or made from Home Assistant's list. */
    static boolean onHaList(String id, String list) {
        return list == null || list.isEmpty() || "pantry".equals(list) || "general".equals(list) || id.startsWith(FROM_HA);
    }

    /** 0.9.5 (haSync.ts haListFor): the matches on the first tab with any, and the list it goes on (General for none). */
    static String haListFor(List<HaMatch.Named> found, List<HaMatch.Named> out) {
        for (String t : MATCH_ORDER) {
            for (HaMatch.Named i : found) if (tabOfItem(i).equals(t)) out.add(i);
            if (!out.isEmpty()) return t;
        }
        return "general";
    }

    /** One side as it was at the last round. */
    static final class Side {
        String s;
        boolean c;

        Side(String s, boolean c) {
            this.s = s;
            this.c = c;
        }

        boolean same(Side o) {
            return s.equals(o.s) && c == o.c;
        }
    }

    static final class Pair {
        final String id;
        final String uid;
        final Side r;
        final Side h;

        Pair(String id, String uid, Side r, Side h) {
            this.id = id;
            this.uid = uid;
            this.r = r;
            this.h = h;
        }
    }

    /** Kept on the Home Assistant phone only (never synced or backed up). */
    static final class State {
        List<Pair> pairs = new ArrayList<>();
        List<String> pick = new ArrayList<>();
        Long emptySince;
        Long emptyLast;

        State copy() {
            State s = new State();
            for (Pair p : pairs) s.pairs.add(new Pair(p.id, p.uid, new Side(p.r.s, p.r.c), new Side(p.h.s, p.h.c)));
            s.pick.addAll(pick);
            s.emptySince = emptySince;
            s.emptyLast = emptyLast;
            return s;
        }

        /** As JSON.stringify writes it from haSync.ts (the same keys in the same order). */
        String toJson() {
            StringBuilder b = new StringBuilder("{\"pairs\":[");
            for (int i = 0; i < pairs.size(); i++) {
                Pair p = pairs.get(i);
                if (i > 0) b.append(',');
                b.append("{\"id\":").append(jsQuote(p.id)).append(",\"uid\":").append(jsQuote(p.uid));
                b.append(",\"r\":{\"s\":").append(jsQuote(p.r.s)).append(",\"c\":").append(p.r.c).append('}');
                b.append(",\"h\":{\"s\":").append(jsQuote(p.h.s)).append(",\"c\":").append(p.h.c).append("}}");
            }
            b.append("],\"pick\":[");
            for (int i = 0; i < pick.size(); i++) b.append(i > 0 ? "," : "").append(jsQuote(pick.get(i)));
            b.append(']');
            if (emptySince != null) b.append(",\"emptySince\":").append(emptySince);
            if (emptyLast != null) b.append(",\"emptyLast\":").append(emptyLast);
            return b.append('}').toString();
        }

        /** A saved state as dbStore.loadState reads it (an odd one is an empty one). */
        static State parse(String raw) {
            State out = new State();
            if (raw == null) return out;
            try {
                Object v = new JSONTokener(raw).nextValue();
                if (!(v instanceof JSONObject)) return out;
                JSONObject o = (JSONObject) v;
                JSONArray ps = o.optJSONArray("pairs");
                if (ps == null) return out;
                for (int i = 0; i < ps.length(); i++) {
                    JSONObject p = ps.optJSONObject(i);
                    if (p == null) continue;
                    JSONObject r = p.optJSONObject("r"), h = p.optJSONObject("h");
                    if (!(p.opt("id") instanceof String) || !(p.opt("uid") instanceof String) || r == null || h == null) continue;
                    out.pairs.add(new Pair(p.getString("id"), p.getString("uid"), new Side(r.optString("s", ""), r.optBoolean("c")), new Side(h.optString("s", ""), h.optBoolean("c"))));
                }
                JSONArray pk = o.optJSONArray("pick");
                if (pk != null) for (int i = 0; i < pk.length(); i++) if (pk.opt(i) instanceof String) out.pick.add(pk.getString(i));
                out.emptySince = finite(o.opt("emptySince"));
                out.emptyLast = finite(o.opt("emptyLast"));
            } catch (Exception e) {
                return new State();
            }
            return out;
        }

        private static Long finite(Object v) {
            if (!(v instanceof Number)) return null;
            double d = ((Number) v).doubleValue();
            return Double.isNaN(d) || Double.isInfinite(d) ? null : ((Number) v).longValue();
        }
    }

    /** A string as JSON.stringify writes it (org.json's quote also escapes "/" after "<" and U+2000–U+20FF). */
    static String jsQuote(String v) {
        StringBuilder b = new StringBuilder(v.length() + 2).append('"');
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    boolean lone = Character.isSurrogate(c)
                        && !(Character.isHighSurrogate(c) && i + 1 < v.length() && Character.isLowSurrogate(v.charAt(i + 1)))
                        && !(Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(v.charAt(i - 1)));
                    if (c < 0x20 || lone) b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    static final class RoundResult {
        int came;
        int went;
        boolean held;
    }

    /** What Restock asks of Home Assistant's list. */
    interface Api {
        List<Item> items() throws Exception;

        void add(String summary) throws Exception;

        /** One of rename and status (the other null). */
        void update(String uid, String rename, String status) throws Exception;

        void remove(List<String> uids) throws Exception;
    }

    /** Restock's side. */
    interface Store {
        List<Line> lines() throws Exception;

        List<HaMatch.Named> items() throws Exception;

        Map<String, String> aliases() throws Exception;

        /** Adds a line and returns its id; `uid`: the item it's made from (haLineId, INSERT OR IGNORE). */
        String addLine(Line l, String uid) throws Exception;

        /** Only the fields that aren't null change. */
        void updateLine(String id, String text, Double qty, Boolean checked) throws Exception;

        void removeLines(List<String> ids) throws Exception;

        State loadState() throws Exception;

        void saveState(State s) throws Exception;
    }

    /** Home Assistant's answer to one request. */
    static final class Answer {
        final int status;
        final String body;

        Answer(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    /** One request to Home Assistant (path starts /api/). Throws in words when it can't be reached at all. */
    interface Transport {
        Answer send(String method, String path, String body) throws Exception;
    }

    /** A problem talking to Home Assistant, in words for the person. `auth`: the token was turned down. */
    static final class HaError extends Exception {
        final boolean auth;

        HaError(String message) {
            this(message, false);
        }

        HaError(String message, boolean auth) {
            super(message);
            this.auth = auth;
        }
    }

    /** The pairing was started afresh after this round began: it stops before changing anything. */
    static final class PairingRestarted extends Exception {
        PairingRestarted() {
            super("Home Assistant’s pairing was started afresh. Trying again.");
        }
    }

    static final String TOKEN_REFUSED =
        "Home Assistant didn't accept the token. Make a new long-lived access token in Home Assistant (your profile → Security), then paste it in here with Change.";

    // ---------- line ids ----------

    /** "ha-" + the first 24 hex characters of sha256("restock-ha-v1\n" + entity + "\n" + uid) (haSync.ts haLineId). */
    static String haLineId(String entity, String uid) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(("restock-ha-v1\n" + entity + "\n" + uid).getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder(FROM_HA);
            for (int i = 0; i < 12; i++) b.append(String.format(Locale.ROOT, "%02x", h[i] & 0xff));
            return b.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------- Home Assistant's REST API ----------

    private static final Pattern RESPONSES = Pattern.compile("return_response|responses", Pattern.CASE_INSENSITIVE);
    private static final Pattern ITEM_GONE = Pattern.compile("unable to find|item_not_found", Pattern.CASE_INSENSITIVE);

    /** Words for an answer that wasn't a yes (haSync.ts haProblem). */
    static HaError haProblem(int status, String text, String doing, String entity) {
        String said = text.length() > 300 ? text.substring(0, 300) : text;
        if (status == 401) return new HaError(TOKEN_REFUSED, true);
        if (status == 403)
            return new HaError("Home Assistant turned Restock away. If a wrong token was tried a few times, Home Assistant may have blocked this phone: check its notifications, then try again.", true);
        if (status == 404) return new HaError("That address doesn't look like Home Assistant. Check it's the one you open Home Assistant with, like http://homeassistant.local:8123.");
        if (status == 400 && RESPONSES.matcher(said).find())
            return new HaError("Restock needs Home Assistant " + MIN_HA_VERSION + " or newer for the shopping list. Update Home Assistant, then try again.");
        if (status == 400 && ITEM_GONE.matcher(said).find())
            return new HaError("Something on the list changed in Home Assistant while Restock was syncing. Restock will try again in a minute.");
        if (status == 400 && entity != null && !entity.isEmpty()) return new HaError("Home Assistant couldn't find the list " + entity + ". Pick the list again below.");
        if (status >= 300 && status < 400) return new HaError("Home Assistant sent Restock somewhere else. Check the address (maybe it needs https://).");
        if (status >= 500) return new HaError("Home Assistant had a problem (" + status + "). Restock will try again in a minute.");
        return new HaError("Home Assistant answered " + status + " when Restock tried to " + doing + ".");
    }

    private static Object json(Answer r, String doing, String entity) throws HaError {
        if (r.status < 200 || r.status >= 300) throw haProblem(r.status, r.body == null ? "" : r.body, doing, entity);
        try {
            JSONTokener t = new JSONTokener(r.body == null ? "" : r.body);
            Object v = t.nextValue();
            if (t.more()) throw new Exception("more after the value");
            return v;
        } catch (Exception e) {
            throw new HaError("That address answered, but not like Home Assistant does. Check it's the address you open Home Assistant with.");
        }
    }

    /** The to-do list `entity` through Home Assistant's REST API (haSync.ts restApi). */
    static Api restApi(final Transport t, final String entity) {
        return new Api() {
            private void call(String service, JSONObject body, String doing) throws Exception {
                body.put("entity_id", entity);
                Answer r = t.send("POST", "/api/services/todo/" + service, body.toString());
                if (r.status < 200 || r.status >= 300) throw haProblem(r.status, r.body == null ? "" : r.body, doing, entity);
            }

            @Override
            public List<Item> items() throws Exception {
                JSONObject body = new JSONObject();
                body.put("entity_id", entity);
                Object out = json(t.send("POST", "/api/services/todo/get_items?return_response", body.toString()), "read the list", entity);
                JSONObject sr = out instanceof JSONObject ? ((JSONObject) out).optJSONObject("service_response") : null;
                JSONObject list = sr == null ? null : sr.optJSONObject(entity);
                JSONArray raw = list == null ? null : list.optJSONArray("items");
                if (raw == null) throw new HaError("Home Assistant didn't send the list " + entity + ". Pick the list again below.");
                List<Item> items = new ArrayList<>();
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject o = raw.optJSONObject(i);
                    if (o == null || !(o.opt("uid") instanceof String) || !(o.opt("summary") instanceof String)) continue;
                    items.add(new Item(o.getString("uid"), o.getString("summary"), "completed".equals(o.opt("status"))));
                }
                return items;
            }

            @Override
            public void add(String summary) throws Exception {
                JSONObject b = new JSONObject();
                b.put("item", summary);
                call("add_item", b, "add to the list");
            }

            @Override
            public void update(String uid, String rename, String status) throws Exception {
                JSONObject b = new JSONObject();
                b.put("item", uid);
                if (rename != null) b.put("rename", rename);
                if (status != null) b.put("status", status);
                call("update_item", b, "change the list");
            }

            @Override
            public void remove(List<String> uids) throws Exception {
                JSONObject b = new JSONObject();
                b.put("item", new JSONArray(uids));
                call("remove_item", b, "take something off the list");
            }
        };
    }

    // ---------- the merge (haSync.ts syncRound) ----------

    /** What Home Assistant shows for a Restock line: its pantry item's name (or its words), with how many. */
    static String summaryOf(Line l, Map<String, String> names) {
        String n = l.groupId != null ? names.get(l.groupId) : null;
        return HaMatch.lineSummary(n != null ? n : l.text, l.qty);
    }

    /** The key a line or item pairs on by its words (haSync.ts pairKey). */
    private static final Pattern SPACES = Pattern.compile(HaMatch.JS_SPACE + "+");

    static String pairKey(String text) {
        HaMatch.Parsed p = HaMatch.parseLine(text);
        if (!p.key.isEmpty()) return p.key;
        return HaMatch.jsTrim(SPACES.matcher(p.name.toLowerCase(Locale.ROOT)).replaceAll(" "));
    }

    /** One round: haSync.ts syncRound, line by line. `now`: the clock for the safety catch (ms). */
    static RoundResult syncRound(final Api api, final Store store, final long now) throws Exception {
        final List<Item> items = new ArrayList<>(api.items());
        final List<Line> lines = store.lines();
        final List<HaMatch.Named> pantry = store.items();
        final Map<String, String> aliases = store.aliases();
        final State before = store.loadState();
        // The safety catch: an empty list from Home Assistant while lines on Restock's list are paired with it.
        Set<String> onList = new HashSet<>();
        for (Line l : lines) onList.add(l.id);
        boolean anyPaired = false;
        for (Pair p : before.pairs) if (onList.contains(p.id)) anyPaired = true;
        if (items.isEmpty() && anyPaired) {
            Long since = before.emptySince;
            Long last = before.emptyLast != null ? before.emptyLast : since;
            if (since == null || last == null || since > now || last > now || now - last > EMPTY_GAP_MS) {
                State s = before.copy();
                s.emptySince = now;
                s.emptyLast = now;
                store.saveState(s);
                RoundResult r = new RoundResult();
                r.held = true;
                return r;
            }
            if (now - since < EMPTY_HOLD_MS) {
                State s = before.copy();
                s.emptyLast = now;
                store.saveState(s);
                RoundResult r = new RoundResult();
                r.held = true;
                return r;
            }
            // Still empty 2 minutes or more later: it was emptied (the round below clears the paired lines).
        }
        final Map<String, String> names = new HashMap<>();
        for (HaMatch.Named g : pantry) names.put(g.id, g.name);
        final Map<String, Line> byId = new LinkedHashMap<>();
        for (Line l : lines) byId.put(l.id, l);
        final Map<String, Item> byUid = new LinkedHashMap<>();
        for (Item h : items) byUid.put(h.uid, h);
        final State state = new State();
        state.pick.addAll(before.pick);
        final RoundResult out = new RoundResult();
        final Set<String> pairedIds = new HashSet<>();
        final Set<String> pairedUids = new HashSet<>();
        // Pairs not looked at yet stay as they were, so a round that stops part-way loses nothing.
        final List<Pair> rest = new ArrayList<>(before.pairs);

        final class Round {
            void keep(Pair p) {
                state.pairs.add(p);
                pairedIds.add(p.id);
                pairedUids.add(p.uid);
            }

            void save() throws Exception {
                Set<String> seen = new HashSet<>();
                for (Pair p : state.pairs) seen.add(p.id);
                State s = new State();
                s.pairs.addAll(state.pairs);
                for (Pair p : rest) if (!seen.contains(p.id) && !pairedUids.contains(p.uid)) s.pairs.add(p);
                Set<String> live = new HashSet<>();
                for (Line l : store.lines()) if (l.groupId == null) live.add(l.id);
                for (String id : new LinkedHashSet<>(state.pick)) if (live.contains(id)) s.pick.add(id);
                store.saveState(s);
            }

            List<Item> looseItems() {
                List<Item> o = new ArrayList<>();
                for (Item h : items) if (!pairedUids.contains(h.uid) && byUid.containsKey(h.uid)) o.add(h);
                return o;
            }

            List<Line> looseLines() {
                List<Line> o = new ArrayList<>();
                for (Line l : byId.values()) if (!pairedIds.contains(l.id)) o.add(l);
                return o;
            }

            void pairUp(Item h, Line r) throws Exception {
                Side rs = new Side(summaryOf(r, names), r.checked);
                Side hs = new Side(h.summary, h.completed);
                if (rs.c != hs.c) {
                    // Still to buy on either side: still to buy on both.
                    if (rs.c) {
                        store.updateLine(r.id, null, null, false);
                        r.checked = rs.c = false;
                        out.came++;
                    } else {
                        api.update(h.uid, null, "needs_action");
                        hs.c = false;
                        out.went++;
                    }
                }
                keep(new Pair(r.id, h.uid, rs, hs));
            }

            void byWords() throws Exception {
                for (boolean sameTick : new boolean[] { true, false }) {
                    for (Item h : looseItems()) {
                        String k = pairKey(h.summary);
                        if (k.isEmpty()) continue;
                        Line r = null;
                        for (Line l : looseLines())
                            if (pairKey(summaryOf(l, names)).equals(k) && (!sameTick || l.checked == h.completed)) {
                                r = l;
                                break;
                            }
                        if (r != null) pairUp(h, r);
                    }
                }
            }
        }
        final Round w = new Round();

        try {
            // 1. Lines paired before.
            while (!rest.isEmpty()) {
                Pair p = rest.get(0);
                Line r = byId.get(p.id);
                Item h = byUid.get(p.uid);
                if (r == null && h == null) {
                    rest.remove(0);
                    continue;
                }
                if (r == null) {
                    // Gone from Restock. Off Home Assistant's list too, unless it changed there since.
                    if (new Side(h.summary, h.completed).same(p.h)) {
                        List<String> one = new ArrayList<>();
                        one.add(h.uid);
                        api.remove(one);
                        byUid.remove(h.uid);
                        out.went++;
                    }
                    rest.remove(0);
                    continue;
                }
                if (h == null) {
                    // Gone from Home Assistant. Off Restock's list too, unless it changed here since.
                    if (new Side(summaryOf(r, names), r.checked).same(p.r)) {
                        List<String> one = new ArrayList<>();
                        one.add(r.id);
                        store.removeLines(one);
                        byId.remove(r.id);
                        out.came++;
                    }
                    rest.remove(0);
                    continue;
                }
                Side rs = new Side(summaryOf(r, names), r.checked);
                Side hs = new Side(h.summary, h.completed);
                // Ticks.
                boolean rTick = rs.c != p.r.c;
                boolean hTick = hs.c != p.h.c;
                if (hTick && !rTick && hs.c != rs.c) {
                    store.updateLine(r.id, null, null, hs.c);
                    r.checked = rs.c = hs.c;
                    out.came++;
                } else if (rs.c != hs.c) {
                    api.update(h.uid, null, rs.c ? "completed" : "needs_action");
                    hs.c = rs.c;
                    out.went++;
                }
                // Words.
                boolean rText = !rs.s.equals(p.r.s);
                boolean hText = !hs.s.equals(p.h.s);
                if (hText && !rText) {
                    HaMatch.Parsed said = HaMatch.parseLine(hs.s);
                    String item = r.groupId != null ? names.get(r.groupId) : null;
                    if (r.groupId == null || item == null) {
                        if (!said.name.equals(r.text) || said.qty != r.qty) {
                            store.updateLine(r.id, said.name, (double) said.qty, null);
                            r.text = said.name;
                            r.qty = said.qty;
                            out.came++;
                        }
                        rs.s = summaryOf(r, names);
                    } else if (said.key.equals(HaMatch.matchKey(item))) {
                        if (said.qty != r.qty) {
                            store.updateLine(r.id, null, (double) said.qty, null);
                            r.qty = said.qty;
                            out.came++;
                        }
                        rs.s = summaryOf(r, names);
                    } else {
                        // Linked to a pantry item: it keeps the item's name.
                        api.update(h.uid, rs.s, null);
                        hs.s = rs.s;
                        out.went++;
                    }
                } else if (rText && !rs.s.equals(hs.s)) {
                    api.update(h.uid, rs.s, null);
                    hs.s = rs.s;
                    out.went++;
                }
                w.keep(new Pair(r.id, h.uid, rs, hs));
                rest.remove(0);
            }

            // 2. Lines nobody has paired: pair the same words first (open with open, ticked with ticked first).
            w.byWords();

            // 3. New in Home Assistant (still to buy): onto Restock's list, linked to a pantry item if it's clearly one.
            for (Item h : w.looseItems()) {
                if (h.completed || HaMatch.jsTrim(h.summary).isEmpty()) continue;
                HaMatch.Parsed said = HaMatch.parseLine(h.summary);
                // 0.9.5: or a Keg or Health item; on the list of the tab it matched, and General when nothing did.
                List<HaMatch.Named> found = new ArrayList<>();
                String section = haListFor(HaMatch.candidates(h.summary, pantry, aliases), found);
                HaMatch.Named one = found.size() == 1 ? found.get(0) : null;
                // "2 Minute Noodles" is an item, not two of "Minute Noodles".
                boolean whole = one != null && HaMatch.matchKey(one.name).equals(HaMatch.matchKey(h.summary));
                Line line = one != null ? new Line(null, one.name, whole ? 1 : said.qty, false, one.id, section) : new Line(null, said.name, said.qty, false, null, section);
                String id = store.addLine(line, h.uid);
                // 0.9.4: its line was there already (another runner made it from the same item): pair with that.
                Line there = byId.get(id);
                if (there != null && !pairedIds.contains(id)) {
                    w.pairUp(h, there);
                    continue;
                }
                // Taken by a line already paired with another item (paired by its words): a line of its own.
                if (there != null) id = store.addLine(line, null);
                Line added = new Line(id, line.text, line.qty, line.checked, line.groupId, line.section);
                byId.put(id, added);
                w.keep(new Pair(id, h.uid, new Side(summaryOf(added, names), false), new Side(h.summary, false)));
                out.came++;
            }

            // 4. New in Restock (still to buy): onto Home Assistant's list. Its new item is paired by its words afterwards.
            List<Line> sent = new ArrayList<>();
            for (Line l : w.looseLines()) {
                if (l.checked || HaMatch.jsTrim(summaryOf(l, names)).isEmpty()) continue;
                api.add(summaryOf(l, names));
                sent.add(l);
                out.went++;
            }
            if (!sent.isEmpty()) {
                for (Item h : api.items()) {
                    if (!byUid.containsKey(h.uid)) {
                        byUid.put(h.uid, h);
                        items.add(h);
                    }
                }
                w.byWords();
            }
        } finally {
            w.save();
        }
        return out;
    }

    // ---------- Restock's side, in the database (homeAssistant.ts dbStore) ----------

    static String asSection(Object v) {
        return "keg".equals(v) || "pharmacy".equals(v) ? (String) v : "pantry";
    }

    /** 0.9.5: a list line's section as stored (General too; anything else is the grocery list). */
    static String asListSection(Object v) {
        return "general".equals(v) ? "general" : asSection(v);
    }

    /**
     * 0.9.5: the tabs that are on (shops.ts activeSections): the pantry, and Keg and Health when
     * switched on with a shop picked (a built-in one, or one added in settings for that tab).
     */
    static Set<String> tabsOn(SyncEngine.Db db) throws Exception {
        Set<String> on = new HashSet<>();
        on.add("pantry");
        String raw = kv(db, "settings");
        if (raw == null) return on;
        JSONObject st;
        try {
            st = new JSONObject(raw);
        } catch (Exception bad) {
            return on;
        }
        JSONObject secs = st.optJSONObject("sections");
        JSONArray chains = st.optJSONArray("enabledChains");
        JSONArray custom = st.optJSONArray("customShops");
        for (String t : new String[] { "keg", "pharmacy" }) {
            if (secs == null || !secs.optBoolean(t, false) || chains == null) continue;
            for (int i = 0; i < chains.length() && !on.contains(t); i++) {
                String c = chains.optString(i, "");
                if (Shops.known(c) && t.equals(Shops.section(c))) on.add(t);
                else if (custom != null)
                    for (int k = 0; k < custom.length(); k++) {
                        JSONObject x = custom.optJSONObject(k);
                        if (x != null && c.equals(x.optString("id")) && t.equals(x.optString("section"))) on.add(t);
                    }
            }
        }
        return on;
    }

    static String kv(SyncEngine.Db db, String key) throws Exception {
        List<JSONObject> r = db.query("SELECT value FROM kv WHERE key = ?", key);
        if (r.isEmpty() || r.get(0).isNull("value")) return null;
        return r.get(0).getString("value");
    }

    static void putKv(SyncEngine.Db db, String key, String json) throws Exception {
        db.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, json);
    }

    static String nowIso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    /**
     * The grocery list's lines and the Pantry tab's items in Restock's database. `resets`: the
     * pairing count when the round began (pairingResets()); if it's started afresh after that, the
     * round stops before changing anything and doesn't save its pairing over the fresh one.
     */
    static class DbStore implements Store {
        private final SyncEngine.Db db;
        private final String entity;
        private final int resets;

        DbStore(SyncEngine.Db db, String entity, int resets) {
            this.db = db;
            this.entity = entity;
            this.resets = resets;
        }

        @Override
        public List<Line> lines() throws Exception {
            Map<String, String> groups = new HashMap<>();
            for (JSONObject g : db.query("SELECT id, section FROM items")) groups.put(g.getString("id"), asSection(g.opt("section")));
            List<Line> out = new ArrayList<>();
            for (JSONObject e : db.query("SELECT * FROM list_entries ORDER BY created_at")) {
                String group = e.isNull("item_id") ? null : e.optString("item_id", null);
                String section = group != null ? groups.get(group) : null;
                if (section == null) section = e.isNull("section") ? "pantry" : asListSection(e.opt("section"));
                // 0.9.5: the grocery list's and General's, and lines made from Home Assistant's list.
                if (!onHaList(e.getString("id"), section)) continue;
                double q = e.isNull("qty") ? 1 : e.optDouble("qty", 1);
                if (Double.isNaN(q) || q == 0) q = 1;
                out.add(new Line(e.getString("id"), e.optString("text", ""), Math.max(1, q), e.optLong("checked", 0) == 1, group));
            }
            return out;
        }

        @Override
        public List<HaMatch.Named> items() throws Exception {
            List<HaMatch.Named> out = new ArrayList<>();
            // 0.9.5: the items of every tab that's on, with their tab.
            Set<String> on = tabsOn(db);
            for (JSONObject g : db.query("SELECT * FROM items ORDER BY name COLLATE NOCASE")) {
                String tab = asSection(g.opt("section"));
                if (on.contains(tab)) out.add(new HaMatch.Named(g.getString("id"), g.optString("name", ""), tab));
            }
            return out;
        }

        @Override
        public Map<String, String> aliases() throws Exception {
            return HaSync.aliases(db);
        }

        @Override
        public String addLine(Line l, String uid) throws Exception {
            // Made from Home Assistant's list: the "ha-" says so on every phone and the web (listPicks.ts).
            String id = uid != null ? haLineId(entity, uid) : FROM_HA + UUID.randomUUID();
            long now = System.currentTimeMillis();
            db.exec(
                "INSERT OR IGNORE INTO list_entries (id, text, item_id, chain, category_id, qty, price, section, product, checked, created_at, checked_at, qty_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?)",
                id, l.text, l.groupId, (long) Math.max(1, l.qty), l.section == null ? "pantry" : l.section, l.checked ? 1 : 0, nowIso(now), now, now);
            return id;
        }

        @Override
        public void updateLine(String id, String text, Double qty, Boolean checked) throws Exception {
            List<String> sets = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            long now = System.currentTimeMillis();
            if (text != null) {
                sets.add("text = ?");
                args.add(text);
            }
            if (qty != null) {
                sets.add("qty = ?");
                args.add(qty.longValue());
            }
            if (checked != null) {
                sets.add("checked = ?");
                args.add(checked ? 1 : 0);
            }
            if (sets.isEmpty()) return;
            // 0.9.0: when the tick and the amount changed (db.ts updateEntryOp).
            if (checked != null) sets.add("checked_at = " + now);
            if (qty != null) sets.add("qty_at = " + now);
            args.add(id);
            db.exec("UPDATE list_entries SET " + String.join(", ", sets) + " WHERE id = ?", args.toArray());
        }

        @Override
        public void removeLines(List<String> ids) throws Exception {
            if (ids.isEmpty()) return;
            StringBuilder q = new StringBuilder();
            for (int i = 0; i < ids.size(); i++) q.append(i > 0 ? "," : "").append('?');
            db.exec("DELETE FROM list_entries WHERE id IN (" + q + ")", ids.toArray());
        }

        @Override
        public State loadState() throws Exception {
            String raw = kv(db, HA_STATE);
            if (resets != pairingResets()) throw new PairingRestarted();
            return State.parse(raw);
        }

        @Override
        public void saveState(State s) throws Exception {
            String was = kv(db, HA_STATE);
            if (resets != pairingResets()) return;
            String now = s.toJson();
            if (!now.equals(was == null ? null : canonical(was))) putKv(db, HA_STATE, now);
        }
    }

    /** A saved state written the way State.toJson writes it (one homeAssistant.ts saved, say), to tell whether anything changed. */
    private static String canonical(String raw) {
        try {
            Object v = new JSONTokener(raw).nextValue();
            if (!(v instanceof JSONObject) || !(((JSONObject) v).opt("pairs") instanceof JSONArray)) return raw;
            return State.parse(raw).toJson();
        } catch (Exception e) {
            return raw;
        }
    }

    /** The saved aliases (matchKey words → item id): any kept the old way, then the household's rows (listPicks.ts getAliases). */
    static Map<String, String> aliases(SyncEngine.Db db) throws Exception {
        Map<String, String> out = new HashMap<>();
        String legacy = kv(db, LIST_ALIASES);
        if (legacy != null) {
            try {
                Object v = new JSONTokener(legacy).nextValue();
                if (v instanceof JSONObject) {
                    JSONObject o = (JSONObject) v;
                    for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                        String k = it.next();
                        Object id = SharedSettings.checkListRow(SharedSettings.ALIAS_PREFIX + k, o.opt(k));
                        if (id instanceof String) out.put(k, (String) id);
                    }
                }
            } catch (Exception ignored) {
                // an odd entry
            }
        }
        for (JSONObject r : db.query("SELECT k, v FROM household_settings WHERE k LIKE 'alias:%'")) {
            String k = r.getString("k");
            Object id = SharedSettings.checkListRow(k, SharedSettings.decode(r.optString("v", null)));
            if (id instanceof String) out.put(k.substring(SharedSettings.ALIAS_PREFIX.length()), (String) id);
        }
        return out;
    }

    // ---------- the one Home Assistant phone (listPicks.ts) ----------

    /** Which phone syncs with Home Assistant, as this phone sees it (listPicks.ts HaPhone). */
    static final class Phone {
        boolean inHousehold;
        String me = "";
        /** The phone (or server) the household's row names. */
        String device;
        String name;
        boolean mine;
        boolean left;
        /**
         * 0.9.4: the household is a house (its owner is a Restock server, srv-…). Home Assistant then
         * runs only on the server (D12): this phone never claims it or runs its own.
         */
        boolean house;
        /** The house's name ("Declan and Sarah"). */
        String houseName;
        /** The row names the server: it runs Home Assistant for every phone and browser. */
        boolean serverRuns;
        /** Where the server's page is (its signed `server` row), or null. */
        String home;
        String away;
    }

    private static String householdValue(List<JSONObject> rows, String k) {
        for (JSONObject r : rows) if (k.equals(r.optString("k"))) return r.optString("v", null);
        return null;
    }

    static Phone haPhone(SyncEngine.Db db) throws Exception {
        Phone out = new Phone();
        List<JSONObject> meRow = db.query("SELECT value FROM sync_meta WHERE key = 'device'");
        out.me = meRow.isEmpty() ? "" : meRow.get(0).optString("value", "");
        List<JSONObject> household = db.query("SELECT k, v FROM household WHERE k IN ('owner', 'name', 'server') OR k LIKE 'member:%' OR k LIKE 'removed:%'");
        String owner = householdValue(household, "owner");
        out.inHousehold = owner != null;
        if (!out.inHousehold) {
            out.mine = true;
            return out;
        }
        out.house = owner.startsWith("srv-");
        if (out.house) {
            out.houseName = householdValue(household, "name");
            try {
                JSONObject s = new JSONObject(householdValue(household, "server"));
                if (s.optInt("v") == 3) {
                    out.home = s.opt("home") instanceof String ? s.getString("home") : null;
                    out.away = s.opt("away") instanceof String ? s.getString("away") : null;
                }
            } catch (Exception ignored) {
                // no server row yet
            }
        }
        List<JSONObject> row = db.query("SELECT v FROM household_settings WHERE k = ?", SharedSettings.HA_PHONE);
        Object device = row.isEmpty() ? null : SharedSettings.checkListRow(SharedSettings.HA_PHONE, SharedSettings.decode(row.get(0).optString("v", null)));
        if (!(device instanceof String)) return out;
        String d = (String) device;
        out.serverRuns = out.house && d.startsWith("srv-");
        String member = householdValue(household, "member:" + d);
        if (member == null && !d.startsWith("srv-")) {
            List<JSONObject> del = db.query("SELECT COUNT(*) AS n FROM sync_log WHERE tbl = 'household' AND pk = ? AND deleted = 1", "member:" + d);
            boolean removed = householdValue(household, "removed:" + d) != null;
            if (removed || (!del.isEmpty() && del.get(0).optLong("n", 0) > 0)) {
                out.left = true;
                return out;
            }
        }
        String name = "another phone";
        if (d.startsWith("srv-")) name = "your server";
        else if (member != null) {
            try {
                Object n = new JSONObject(member).opt("name");
                if (n instanceof String && !HaMatch.jsTrim((String) n).isEmpty()) name = HaMatch.jsTrim((String) n);
            } catch (Exception ignored) {
                // an odd entry
            }
        }
        out.device = d;
        out.name = name;
        out.mine = d.equals(out.me);
        return out;
    }

    /**
     * This phone becomes the household's Home Assistant phone (listPicks.ts claimHaPhone). 0.9.4:
     * never in a house (its server does it, or nobody does). Answers whether it may (false in a house).
     */
    static boolean claimHaPhone(final SyncEngine.Db db, boolean quietly) throws Exception {
        final Phone who = haPhone(db);
        if (who.house) return false;
        if (!who.inHousehold || who.me.isEmpty() || who.me.startsWith("web-") || who.mine) return true;
        final String v = JSONObject.quote(who.me);
        long noted = 1;
        if (quietly) {
            List<JSONObject> n = db.query("SELECT COUNT(*) AS n FROM sync_log WHERE tbl = ? AND pk = ?", "household_settings", SharedSettings.HA_PHONE);
            noted = n.isEmpty() ? 1 : n.get(0).optLong("n", 1);
        }
        if (!quietly || who.device != null || who.left || noted > 0) {
            if (who.device != null && quietly) return true;
            db.exec("INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)", SharedSettings.HA_PHONE, v);
            return true;
        }
        // Quietly, as the oldest possible change (like the owner's seed), so a phone named elsewhere still wins.
        db.transaction(() -> {
            db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
            db.exec("INSERT OR IGNORE INTO household_settings (k, v) VALUES (?, ?)", SharedSettings.HA_PHONE, v);
            db.exec(
                "INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq, sig, created) VALUES (?, ?, 1, ?, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log), NULL, 1)",
                "household_settings", SharedSettings.HA_PHONE, who.me);
            db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        });
        return true;
    }

    // ---------- this phone's settings and status (homeAssistant.ts) ----------

    private static final Pattern ENTITY = Pattern.compile("todo\\.[a-z0-9_]+");

    static final class Config {
        boolean enabled;
        String address = "";
        String entity = DEFAULT_LIST;
        /** What was saved, to save it back with only `enabled` changed. */
        JSONObject raw = new JSONObject();
    }

    static Config config(SyncEngine.Db db) throws Exception {
        Config c = new Config();
        String raw = kv(db, HA_CONFIG);
        if (raw == null) return c;
        try {
            Object v = new JSONTokener(raw).nextValue();
            if (!(v instanceof JSONObject)) return c;
            JSONObject o = (JSONObject) v;
            c.raw = o;
            c.enabled = Boolean.TRUE.equals(o.opt("enabled"));
            c.address = o.opt("address") instanceof String ? o.getString("address") : "";
            c.entity = o.opt("entity") instanceof String && ENTITY.matcher(o.getString("entity")).matches() ? o.getString("entity") : DEFAULT_LIST;
        } catch (Exception ignored) {
            // an odd entry: off
        }
        return c;
    }

    /** Home Assistant off on this phone (as saveHaConfig({ enabled: false }): the status starts afresh). */
    static void turnOff(SyncEngine.Db db, Config c) throws Exception {
        JSONObject o = new JSONObject(c.raw.toString());
        o.put("enabled", false);
        o.put("address", c.address);
        o.put("entity", c.entity);
        putKv(db, HA_CONFIG, o.toString());
        if (c.enabled) putKv(db, HA_STATUS, "{}");
    }

    static final class Status {
        String okAt;
        String error;
        boolean auth;
        boolean held;

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                if (okAt != null) o.put("okAt", okAt);
                if (error != null) o.put("error", error);
                if (auth) o.put("auth", true);
                if (held) o.put("held", true);
            } catch (Exception ignored) {
                // never
            }
            return o;
        }

        static Status parse(String raw) {
            Status s = new Status();
            if (raw == null) return s;
            try {
                JSONObject o = new JSONObject(raw);
                s.okAt = o.opt("okAt") instanceof String ? o.getString("okAt") : null;
                s.error = o.opt("error") instanceof String ? o.getString("error") : null;
                s.auth = Boolean.TRUE.equals(o.opt("auth"));
                s.held = Boolean.TRUE.equals(o.opt("held"));
            } catch (Exception ignored) {
                // none
            }
            return s;
        }
    }

    /** The status for the screens: kept in memory, saved when it changes or every 10 minutes (homeAssistant.ts setStatus). */
    private static volatile Status lastStatus;

    static Status status(SyncEngine.Db db) throws Exception {
        Status s = lastStatus;
        return s != null ? s : Status.parse(kv(db, HA_STATUS));
    }

    static void setStatus(SyncEngine.Db db, Status s) throws Exception {
        Status saved = Status.parse(kv(db, HA_STATUS));
        lastStatus = s;
        boolean stale = saved.okAt == null || s.okAt == null || iso(s.okAt) - iso(saved.okAt) > 600_000;
        boolean changed = !eq(saved.error, s.error) || saved.auth != s.auth || saved.held != s.held || (!eq(s.okAt, saved.okAt) && stale);
        if (changed) putKv(db, HA_STATUS, s.toJson().toString());
    }

    /** Forgets the status kept in memory (the screens set one afresh: a new token, Remove). */
    static void statusChanged() {
        lastStatus = null;
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    private static long iso(String t) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.parse(t).getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    /** Words for what Java couldn't do (homeAssistant.ts reachText). */
    static String reachText(Throwable e) {
        String m = e == null || e.getMessage() == null ? String.valueOf(e) : e.getMessage();
        String l = m.toLowerCase(Locale.ROOT);
        if (l.contains("only uses http://"))
            return "Restock only uses http:// for a Home Assistant at home (like http://192.168.1.50:8123 or homeassistant.local) or on Tailscale. Away from home, use its https:// address, such as your Nabu Casa one.";
        if (l.contains("couldn't find that server"))
            return "Couldn't find Home Assistant at that address. If homeassistant.local doesn't work on this phone, use its IP address instead, like http://192.168.1.50:8123.";
        if (l.contains("couldn't reach") || l.contains("broke off") || l.contains("took too long"))
            return "Couldn't reach Home Assistant. Check the address, and that this phone is on your home Wi-Fi (or use your Nabu Casa or Tailscale address).";
        if (l.contains("certificate")) return "Home Assistant's security certificate wasn't accepted, so Restock didn't connect. Check the https:// address.";
        if (l.contains("token")) return m;
        String out = m.replaceAll("\\bthe server\\b", "Home Assistant").replaceAll("\\bThe server\\b", "Home Assistant");
        return out.isEmpty() ? "Couldn't reach Home Assistant." : out;
    }

    // ---------- one round on this phone (homeAssistant.ts runHaSync) ----------

    /** What the round needs from Android: the token (HomeAssistant.java). */
    interface Host {
        boolean tokenSaved();

        /** The server runs Home Assistant now: the token goes from this phone. */
        void forgetToken();

        Transport transport(String address);
    }

    static final class Outcome {
        /** A round ran (Home Assistant on for this phone, and it's the one). */
        boolean ran;
        /** The pairing was started afresh mid-round: another round in a moment. */
        boolean restarted;
        /** Didn't run: another round was going (the background job only). */
        boolean busy;
        /** 0.9.4: this phone is in a house, so it doesn't run its own. */
        boolean house;
        int came;
        int went;
        boolean held;
        Status status = new Status();

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("ran", ran);
                o.put("restarted", restarted);
                o.put("busy", busy);
                o.put("house", house);
                o.put("came", came);
                o.put("went", went);
                o.put("held", held);
                o.put("status", status.toJson());
            } catch (Exception ignored) {
                // never
            }
            return o;
        }
    }

    /**
     * Whether this phone is still the household's Home Assistant phone (homeAssistant.ts
     * stillTheHaPhone): no phone named yet, it takes it quietly; another named, Home Assistant goes off
     * here (the token stays, for Move it here). 0.9.4: never in a house.
     */
    static boolean stillTheHaPhone(SyncEngine.Db db, Config c) throws Exception {
        Phone who = haPhone(db);
        if (who.house) return false;
        if (who.mine) return true;
        if (who.device != null) {
            turnOff(db, c);
            statusChanged();
            return false;
        }
        claimHaPhone(db, true);
        return haPhone(db).mine;
    }

    /**
     * 0.9.4, in a house (D12): this phone doesn't run its own Home Assistant. Once the server runs it
     * (its `ha:phone` row), this phone's token goes, Home Assistant is off here and the pairing is
     * dropped (the server took it over, sealed in the handover or upgrade). Until then (the server
     * doesn't run it, or hasn't read the payload yet) the settings and token stay as they are, so
     * the upgrade can still hand them over.
     */
    static void inHouse(SyncEngine.Db db, Phone who, Config c, Host host) throws Exception {
        if (!who.serverRuns) return;
        if (host.tokenSaved()) host.forgetToken();
        if (c.enabled || kv(db, HA_STATE) != null) {
            turnOff(db, c);
            db.exec("DELETE FROM kv WHERE key = ?", HA_STATE);
            resetPairing();
            statusChanged();
        }
    }

    /**
     * One round, if Home Assistant is on for this phone and it's the one. The caller holds LOCK.
     * `manual` (Sync now, Try again) also runs after the token was turned down, which the automatic
     * ones don't, so a wrong token isn't tried over and over.
     */
    static Outcome run(SyncEngine.Db db, Host host, boolean manual, long now) throws Exception {
        Outcome out = new Outcome();
        int resets = pairingResets();
        Config c = config(db);
        Phone who = haPhone(db);
        if (who.house) {
            out.house = true;
            inHouse(db, who, c, host);
            out.status = status(db);
            return out;
        }
        if (!c.enabled || c.address.isEmpty()) {
            out.status = status(db);
            return out;
        }
        if (!stillTheHaPhone(db, c)) {
            out.status = status(db);
            return out;
        }
        Status st = status(db);
        if (st.auth && !manual) {
            out.status = st;
            return out;
        }
        out.ran = true;
        try {
            RoundResult r = syncRound(restApi(host.transport(c.address), c.entity), new DbStore(db, c.entity, resets), now);
            out.came = r.came;
            out.went = r.went;
            out.held = r.held;
            Status s = new Status();
            // Held (Home Assistant's list came back empty): not counted as synced, nothing went wrong either.
            if (r.held) {
                s.okAt = st.okAt;
                s.held = true;
            } else s.okAt = nowIso(now);
            setStatus(db, s);
        } catch (PairingRestarted e) {
            out.restarted = true;
        } catch (HaError e) {
            Status s = new Status();
            s.okAt = st.okAt;
            s.error = e.getMessage();
            s.auth = e.auth;
            setStatus(db, s);
        } catch (Exception e) {
            Status s = new Status();
            s.okAt = st.okAt;
            s.error = reachText(e);
            setStatus(db, s);
        }
        out.status = status(db);
        return out;
    }

    /**
     * A round with LOCK held: waiting up to `waitMs` for one already going (the screens), or not at
     * all (0: the background job, which skips a round while the screens' is going). `busy` when it
     * didn't get to run.
     */
    static Outcome runLocked(SyncEngine.Db db, Host host, boolean manual, long waitMs) throws Exception {
        boolean got;
        try {
            got = waitMs > 0 ? LOCK.tryLock(waitMs, java.util.concurrent.TimeUnit.MILLISECONDS) : LOCK.tryLock();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            got = false;
        }
        if (!got) {
            Outcome busy = new Outcome();
            busy.busy = true;
            busy.status = status(db);
            return busy;
        }
        try {
            return run(db, host, manual, System.currentTimeMillis());
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * 0.9.4: what goes to the server when this phone hands Home Assistant over (section 9): `{ address,
     * entity, enabled, state }` (HomeAssistant.java adds the token), or null when this phone isn't the
     * one that does it (no address, not on, or the household's row names another).
     */
    static JSONObject payload(SyncEngine.Db db, boolean tokenSaved) throws Exception {
        Config c = config(db);
        if (!tokenSaved || !c.enabled || c.address.isEmpty()) return null;
        Phone who = haPhone(db);
        if (who.serverRuns || !(who.mine || (who.device != null && who.device.equals(who.me)))) return null;
        JSONObject o = new JSONObject();
        o.put("address", c.address);
        o.put("entity", c.entity);
        o.put("enabled", true);
        String raw = kv(db, HA_STATE);
        Object state = null;
        try {
            state = raw == null ? null : new JSONTokener(raw).nextValue();
        } catch (Exception ignored) {
            // an odd one: start afresh
        }
        o.put("state", state instanceof JSONObject ? state : new JSONObject(new State().toJson()));
        return o;
    }
}
