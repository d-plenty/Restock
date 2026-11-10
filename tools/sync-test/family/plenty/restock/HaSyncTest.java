package family.plenty.restock;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.4: Home Assistant's round in Java (HaSync.java, HaMatch.java) against haSync.ts.
 * - The shared fixtures (tools/sync-test/ha-fixtures.json): every scenario and word gives exactly
 *   what haSync.ts gives (the file's `expect`, checked on that side by src/lib/haParity.test.ts).
 * - haLineId and the upgrade's sealed `ha` (RSA3) against tools/sync-test/vectors-v3.json.
 * - On Restock's real database layout (TestDb): lines from an item get haLineId with INSERT OR
 *   IGNORE (a second runner doesn't double them), the triggers note the changes, only the groceries
 *   tab, a pairing started afresh mid-round, which phone does it, a house (never claimed, never run,
 *   the token gone once the server runs it), what's handed over, and one round at a time.
 * Run by tools/sync-test/ha-parity.sh.
 */
public class HaSyncTest {
    static int fails = 0;
    static String OUT;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + what);
        if (!ok) fails++;
    }

    public static void main(String[] args) throws Exception {
        String out = args[0];
        OUT = out;
        String fixturesFile = args.length > 1 ? args[1] : "tools/sync-test/ha-fixtures.json";
        String vectorsFile = args.length > 2 ? args[2] : "tools/sync-test/vectors-v3.json";
        JSONObject fx = new JSONObject(new String(Files.readAllBytes(Paths.get(fixturesFile)), StandardCharsets.UTF_8));
        System.out.println("Home Assistant fixtures (the same as haSync.ts):");
        fixtures(fx);
        System.out.println("Vectors:");
        vectors(new JSONObject(new String(Files.readAllBytes(Paths.get(vectorsFile)), StandardCharsets.UTF_8)));
        System.out.println("On Restock's database:");
        database(out);
        System.out.println(fails == 0 ? "HaSyncTest: all passed" : "HaSyncTest: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }

    // ---------- the fixtures ----------

    /** The pretend Home Assistant of haParity.test.ts. */
    static class FakeHa implements HaSync.Api {
        List<HaSync.Item> list = new ArrayList<>();
        List<HaSync.Item> aside;
        int n = 0;
        List<String> calls = new ArrayList<>();
        Integer failAddAfter;
        int adds = 0;
        boolean failUpdateOnce;

        @Override
        public List<HaSync.Item> items() {
            calls.add("items");
            return new ArrayList<>(list);
        }

        @Override
        public void add(String summary) throws Exception {
            calls.add("add " + summary);
            list.add(new HaSync.Item("u" + (++n), summary, false));
            if (failAddAfter != null && ++adds >= failAddAfter) {
                failAddAfter = null;
                throw new HaSync.HaError("The connection to Home Assistant broke off.");
            }
        }

        @Override
        public void update(String uid, String rename, String status) throws Exception {
            if (failUpdateOnce) {
                failUpdateOnce = false;
                throw new HaSync.HaError("Home Assistant had a problem (500).");
            }
            calls.add("update " + uid + " " + (rename != null ? "{\"rename\":" + HaSync.jsQuote(rename) + "}" : "{\"status\":" + HaSync.jsQuote(status) + "}"));
            for (int i = 0; i < list.size(); i++) {
                HaSync.Item h = list.get(i);
                if (!h.uid.equals(uid)) continue;
                list.set(i, new HaSync.Item(uid, rename != null ? rename : h.summary, status != null ? "completed".equals(status) : h.completed));
                return;
            }
            throw new HaSync.HaError("no such item");
        }

        @Override
        public void remove(List<String> uids) {
            calls.add("remove " + String.join(",", uids));
            list.removeIf(h -> uids.contains(h.uid));
        }
    }

    /** The store of haParity.test.ts: haLineId for a line from an item, INSERT OR IGNORE. */
    static final class MemStore implements HaSync.Store {
        final List<HaSync.Line>[] shared;
        final List<HaMatch.Named> pantry;
        final Map<String, String> alias;
        final String entity;
        final String prefix;
        HaSync.State state = new HaSync.State();
        int n = 0;

        MemStore(List<HaSync.Line>[] shared, List<HaMatch.Named> pantry, Map<String, String> alias, String entity, String prefix) {
            this.shared = shared;
            this.pantry = pantry;
            this.alias = alias;
            this.entity = entity;
            this.prefix = prefix;
        }

        static HaSync.Line copy(HaSync.Line l) {
            return new HaSync.Line(l.id, l.text, l.qty, l.checked, l.groupId, l.section);
        }

        @Override
        public List<HaSync.Line> lines() {
            List<HaSync.Line> o = new ArrayList<>();
            for (HaSync.Line l : shared[0]) o.add(copy(l));
            return o;
        }

        @Override
        public List<HaMatch.Named> items() {
            List<HaMatch.Named> o = new ArrayList<>();
            for (HaMatch.Named p : pantry) o.add(new HaMatch.Named(p.id, p.name, p.section));
            return o;
        }

        @Override
        public Map<String, String> aliases() {
            return new HashMap<>(alias);
        }

        @Override
        public String addLine(HaSync.Line l, String uid) {
            String id = uid != null ? HaSync.haLineId(entity, uid) : prefix + (++n);
            for (HaSync.Line x : shared[0]) if (x.id.equals(id)) return id;
            shared[0].add(new HaSync.Line(id, l.text, l.qty, l.checked, l.groupId, l.section));
            return id;
        }

        @Override
        public void updateLine(String id, String text, Double qty, Boolean checked) {
            for (HaSync.Line l : shared[0])
                if (l.id.equals(id)) {
                    if (text != null) l.text = text;
                    if (qty != null) l.qty = qty;
                    if (checked != null) l.checked = checked;
                    return;
                }
            throw new IllegalStateException("no line " + id);
        }

        @Override
        public void removeLines(List<String> ids) {
            shared[0].removeIf(l -> ids.contains(l.id));
        }

        @Override
        public HaSync.State loadState() {
            return state.copy();
        }

        @Override
        public void saveState(HaSync.State s) {
            state = s.copy();
        }
    }

    static List<HaMatch.Named> named(JSONArray a) throws Exception {
        List<HaMatch.Named> o = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            JSONObject x = a.getJSONObject(i);
            o.add(new HaMatch.Named(x.getString("id"), x.getString("name"), x.has("section") ? x.getString("section") : null));
        }
        return o;
    }

    static Map<String, String> map(JSONObject o) throws Exception {
        Map<String, String> m = new HashMap<>();
        if (o == null) return m;
        for (Iterator<String> it = o.keys(); it.hasNext(); ) {
            String k = it.next();
            m.put(k, o.getString(k));
        }
        return m;
    }

    static JSONObject stateOf(HaSync.State s) throws Exception {
        JSONArray pairs = new JSONArray();
        for (HaSync.Pair p : s.pairs) pairs.put(new JSONArray().put(p.id).put(p.uid).put(p.r.s).put(p.r.c).put(p.h.s).put(p.h.c));
        return new JSONObject().put("pairs", pairs).put("pick", new JSONArray(s.pick))
            .put("emptySince", s.emptySince == null ? JSONObject.NULL : s.emptySince)
            .put("emptyLast", s.emptyLast == null ? JSONObject.NULL : s.emptyLast);
    }

    @SuppressWarnings("unchecked")
    static JSONArray run(JSONObject fx, JSONObject sc) throws Exception {
        String entity = sc.optString("entity", "todo.shopping_list");
        List<HaMatch.Named> pantry = named(sc.has("pantry") ? sc.getJSONArray("pantry") : fx.getJSONArray("pantry"));
        Map<String, String> aliases = map(sc.optJSONObject("aliases"));
        List<HaSync.Line>[] shared = new List[] { new ArrayList<HaSync.Line>() };
        Map<String, MemStore> stores = new LinkedHashMap<>();
        stores.put("a", new MemStore(shared, pantry, aliases, entity, "r"));
        stores.put("b", new MemStore(shared, pantry, aliases, entity, "s"));
        FakeHa ha = new FakeHa();
        JSONArray out = new JSONArray();
        JSONArray steps = sc.getJSONArray("steps");
        int rounds = 0;
        for (int i = 0; i < steps.length(); i++) {
            JSONObject s = steps.getJSONObject(i);
            switch (s.getString("op")) {
                case "seed":
                    ha.list.add(new HaSync.Item("u" + (++ha.n), s.getString("summary"), "completed".equals(s.optString("status"))));
                    break;
                case "haPush":
                    ha.list.add(new HaSync.Item(s.getString("uid"), s.getString("summary"), "completed".equals(s.optString("status"))));
                    break;
                case "haSet":
                    for (int k = 0; k < ha.list.size(); k++) {
                        HaSync.Item h = ha.list.get(k);
                        if (!h.uid.equals(s.getString("uid"))) continue;
                        ha.list.set(k, new HaSync.Item(h.uid, s.has("summary") ? s.getString("summary") : h.summary, s.has("status") ? "completed".equals(s.getString("status")) : h.completed));
                    }
                    break;
                case "haRemove":
                    ha.list.removeIf(h -> h.uid.equals(s.optString("uid")));
                    break;
                case "haSwapOut":
                    ha.aside = ha.list;
                    ha.list = new ArrayList<>();
                    break;
                case "haSwapIn":
                    ha.list = ha.aside;
                    break;
                case "failAddAfter":
                    ha.failAddAfter = s.getInt("n");
                    break;
                case "failUpdateOnce":
                    ha.failUpdateOnce = true;
                    break;
                case "line": {
                    MemStore a = stores.get("a");
                    String id = s.has("id") ? s.getString("id") : s.has("idOf") ? HaSync.haLineId(entity, s.getString("idOf")) : "r" + (++a.n);
                    shared[0].add(new HaSync.Line(id, s.getString("text"), s.optDouble("qty", 1), s.optBoolean("checked", false), s.has("groupId") ? s.getString("groupId") : null, s.has("section") ? s.getString("section") : null));
                    break;
                }
                case "update": {
                    HaSync.Line l = find(shared[0], s);
                    JSONObject p = s.getJSONObject("patch");
                    if (p.has("text")) l.text = p.getString("text");
                    if (p.has("qty")) l.qty = p.getDouble("qty");
                    if (p.has("checked")) l.checked = p.getBoolean("checked");
                    break;
                }
                case "remove":
                    shared[0].remove(find(shared[0], s));
                    break;
                case "rename":
                    for (int k = 0; k < pantry.size(); k++)
                        if (pantry.get(k).id.equals(s.getString("groupId"))) pantry.set(k, new HaMatch.Named(pantry.get(k).id, s.getString("name"), pantry.get(k).section));
                    break;
                case "state": {
                    HaSync.State st = new HaSync.State();
                    JSONArray ps = s.getJSONArray("pairs");
                    for (int k = 0; k < ps.length(); k++) {
                        JSONObject p = ps.getJSONObject(k);
                        String id = p.has("idOf") ? HaSync.haLineId(entity, p.getString("idOf")) : p.getString("id");
                        JSONObject r = p.getJSONObject("r"), h = p.getJSONObject("h");
                        st.pairs.add(new HaSync.Pair(id, p.getString("uid"), new HaSync.Side(r.getString("s"), r.getBoolean("c")), new HaSync.Side(h.getString("s"), h.getBoolean("c"))));
                    }
                    stores.get("a").state = st;
                    break;
                }
                case "round": {
                    MemStore store = stores.get(s.optString("store", "a"));
                    long now = s.has("now") ? s.getLong("now") : 1_700_000_000_000L + rounds * 60_000L;
                    rounds++;
                    ha.calls = new ArrayList<>();
                    JSONObject r;
                    try {
                        HaSync.RoundResult got = HaSync.syncRound(ha, store, now);
                        r = new JSONObject().put("came", got.came).put("went", got.went).put("held", got.held);
                    } catch (Exception e) {
                        r = new JSONObject().put("error", e.getMessage());
                    }
                    JSONArray haList = new JSONArray();
                    for (HaSync.Item h : ha.list) haList.put(new JSONArray().put(h.uid).put(h.summary).put(h.completed ? "completed" : "needs_action"));
                    JSONArray lines = new JSONArray();
                    for (HaSync.Line l : shared[0]) lines.put(new JSONArray().put(l.id).put(l.text).put(l.qty).put(l.checked).put(l.groupId == null ? JSONObject.NULL : l.groupId).put(l.section == null ? JSONObject.NULL : l.section));
                    out.put(new JSONObject().put("r", r).put("calls", new JSONArray(ha.calls)).put("ha", haList).put("lines", lines).put("state", stateOf(store.state)));
                    break;
                }
                default:
                    throw new IllegalArgumentException("no such step " + s.getString("op"));
            }
        }
        return out;
    }

    static HaSync.Line find(List<HaSync.Line> list, JSONObject s) {
        for (HaSync.Line l : list) if (s.has("id") ? l.id.equals(s.optString("id")) : l.text.equals(s.optString("text"))) return l;
        throw new IllegalStateException("no such line " + s);
    }

    static JSONArray words(JSONObject fx) throws Exception {
        List<HaMatch.Named> pantry = named(fx.getJSONArray("pantry"));
        Map<String, String> aliases = map(fx.getJSONObject("wordAliases"));
        JSONArray out = new JSONArray();
        JSONArray ws = fx.getJSONArray("words");
        for (int i = 0; i < ws.length(); i++) {
            String w = ws.getString(i);
            HaMatch.Parsed p = HaMatch.parseLine(w);
            JSONArray c = new JSONArray();
            for (HaMatch.Named n : HaMatch.candidates(w, pantry, aliases)) c.put(n.id);
            out.put(new JSONObject().put("w", w).put("key", HaMatch.matchKey(w)).put("parsed", new JSONArray().put(p.qty).put(p.name).put(p.key))
                .put("summary", new JSONArray().put(HaMatch.lineSummary(w, 1)).put(HaMatch.lineSummary(w, 3))).put("candidates", c));
        }
        return out;
    }

    /** JSON values alike (numbers by value: 2 and 2.0 are the same). Answers where they differ, or null. */
    static String diff(Object a, Object b, String at) throws Exception {
        if (a == null) a = JSONObject.NULL;
        if (b == null) b = JSONObject.NULL;
        if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue() ? null : at + ": " + a + " ≠ " + b;
        if (a instanceof JSONArray && b instanceof JSONArray) {
            JSONArray x = (JSONArray) a, y = (JSONArray) b;
            if (x.length() != y.length()) return at + ": " + x + " ≠ " + y;
            for (int i = 0; i < x.length(); i++) {
                String d = diff(x.opt(i), y.opt(i), at + "[" + i + "]");
                if (d != null) return d;
            }
            return null;
        }
        if (a instanceof JSONObject && b instanceof JSONObject) {
            JSONObject x = (JSONObject) a, y = (JSONObject) b;
            if (!x.keySet().equals(y.keySet())) return at + ": keys " + x.keySet() + " ≠ " + y.keySet();
            for (String k : x.keySet()) {
                String d = diff(x.opt(k), y.opt(k), at + "." + k);
                if (d != null) return d;
            }
            return null;
        }
        return a.equals(b) ? null : at + ": " + a + " ≠ " + b;
    }

    static void fixtures(JSONObject fx) throws Exception {
        JSONObject expect = fx.optJSONObject("expect");
        check(expect != null, "the fixtures have haSync.ts's answers");
        if (expect == null) return;
        JSONArray w = words(fx);
        String d = diff(w, expect.getJSONArray("words"), "words");
        check(d == null, "words: matchKey, parseLine, lineSummary and candidates as haMatch.ts (" + w.length() + ")" + (d == null ? "" : ": " + d));
        JSONArray scs = fx.getJSONArray("scenarios");
        int same = 0;
        for (int i = 0; i < scs.length(); i++) {
            JSONObject sc = scs.getJSONObject(i);
            JSONArray got;
            try {
                got = run(fx, sc);
            } catch (Exception e) {
                check(false, sc.getString("name") + ": " + e);
                continue;
            }
            String dd = diff(got, expect.getJSONObject("scenarios").getJSONArray(sc.getString("name")), "round");
            check(dd == null, sc.getString("name") + (dd == null ? "" : ": " + dd));
            if (dd == null) same++;
        }
        check(same == scs.length(), same + " of " + scs.length() + " scenarios give exactly what haSync.ts gives");
    }

    // ---------- vectors ----------

    static PrivateKey priv(String pkcs8) throws Exception {
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(ServerLink.unb64(pkcs8)));
    }

    static PublicKey pub(String spki) throws Exception {
        return KeyFactory.getInstance("EC").generatePublic(new java.security.spec.X509EncodedKeySpec(ServerLink.unb64(spki)));
    }

    /** haLineId, and the `ha` this phone's payload becomes in the upgrade (ServerSync seals it with ServerLink, RSA3). */
    static void vectors(JSONObject v) throws Exception {
        JSONArray ids = v.getJSONArray("haLineId");
        boolean all = true;
        for (int i = 0; i < ids.length(); i++) {
            JSONObject o = ids.getJSONObject(i);
            all &= HaSync.haLineId(o.getString("entity"), o.getString("uid")).equals(o.getString("id"));
        }
        check(all, "haLineId gives the " + ids.length() + " vectors' ids (non-ASCII ones too)");
        JSONObject ha = v.getJSONObject("ha");
        JSONObject keys = v.getJSONObject("keys");
        PrivateKey phone = priv(keys.getJSONObject("phoneKex").getString("pkcs8"));
        PublicKey server = pub(keys.getJSONObject("serverKex").getString("pub"));
        byte[] key = ServerLink.v3Key(phone, server, ServerLink.unb64(ha.getString("n")), ServerLink.HA_INFO);
        check(ServerLink.b64u(key).equals(ha.getString("key")), "the upgrade's ha key as the vectors' (HKDF(ECDH(server kex, phone kex), salt n, restock-ha-v3))");
        String device = ha.getString("device");
        check(ServerLink.openAad(key, HaSync.RSA3_AAD + device, ServerLink.unb64(ha.getString("sealed"))).getString("token").equals("eyJhbGciOi.test.token"), "the vectors' sealed ha opens");
        // This phone's payload, as HomeAssistant.handoverPayload makes it (HaSync.payload plus the token), sealed as ServerSync does.
        TestDb db = fresh(OUT);
        config(db, true);
        JSONObject payload = HaSync.payload(db, true).put("token", "eyJhbGciOi.test.token");
        db.close();
        byte[] sealed = ServerLink.sealAad(key, HaSync.RSA3_AAD + device, payload, null);
        JSONObject opened = ServerLink.openAad(key, HaSync.RSA3_AAD + device, sealed);
        check(opened.keySet().equals(new JSONObject(ha.getString("plain")).keySet()), "the payload has exactly the fields of the vectors' ha: " + opened.keySet());
        check(!new String(sealed, StandardCharsets.ISO_8859_1).contains("eyJhbGciOi") && !ServerLink.b64u(sealed).contains("eyJhbGciOi"), "the token isn't readable in what's sent");
        boolean refused = false;
        try {
            ServerLink.openAad(key, HaSync.RSA3_AAD + "another0device00", sealed);
        } catch (Exception e) {
            refused = true;
        }
        check(refused, "sealed to one device: another device's associated data doesn't open it");
    }

    // ---------- on the database ----------

    static final String ME = "me00000000000000";

    static TestDb fresh(String dir) throws Exception {
        TestDb db = new TestDb(dir);
        db.exec("UPDATE sync_meta SET value = ? WHERE key = 'device'", ME);
        return db;
    }

    static void item(TestDb db, String id, String name, String section) throws Exception {
        db.exec("INSERT INTO items (id, name, section, created_at) VALUES (?, ?, ?, '2026-11-01T00:00:00.000Z')", id, name, section);
    }

    static void listLine(TestDb db, String id, String text, String section, String created) throws Exception {
        db.exec("INSERT INTO list_entries (id, text, section, checked, created_at) VALUES (?, ?, ?, 0, ?)", id, text, section, created);
    }

    static int count(TestDb db, String sql, Object... args) throws Exception {
        return db.query(sql, args).get(0).getInt("n");
    }

    /** A Host for tests: a pretend Home Assistant, a pretend token. */
    static class TestHost implements HaSync.Host {
        final FakeHa ha;
        boolean token = true;
        int transports = 0;
        int forgotten = 0;

        TestHost(FakeHa ha) {
            this.ha = ha;
        }

        @Override
        public boolean tokenSaved() {
            return token;
        }

        @Override
        public void forgetToken() {
            token = false;
            forgotten++;
        }

        @Override
        public HaSync.Transport transport(String address) {
            transports++;
            return fakeTransport(ha, "todo.shopping_list");
        }
    }

    /** Home Assistant's REST API in front of a FakeHa (as fake-ha.mjs answers). */
    static HaSync.Transport fakeTransport(FakeHa ha, String entity) {
        return (method, path, body) -> {
            JSONObject b = new JSONObject(body == null ? "{}" : body);
            if (path.equals("/api/services/todo/get_items?return_response")) {
                JSONArray items = new JSONArray();
                for (HaSync.Item h : ha.items()) items.put(new JSONObject().put("uid", h.uid).put("summary", h.summary).put("status", h.completed ? "completed" : "needs_action"));
                return new HaSync.Answer(200, new JSONObject().put("changed_states", new JSONArray()).put("service_response", new JSONObject().put(entity, new JSONObject().put("items", items))).toString());
            }
            if (path.equals("/api/services/todo/add_item")) ha.add(b.getString("item"));
            else if (path.equals("/api/services/todo/update_item")) ha.update(b.getString("item"), b.optString("rename", null), b.optString("status", null));
            else if (path.equals("/api/services/todo/remove_item")) {
                List<String> u = new ArrayList<>();
                for (int i = 0; i < b.getJSONArray("item").length(); i++) u.add(b.getJSONArray("item").getString(i));
                ha.remove(u);
            } else return new HaSync.Answer(404, "{}");
            return new HaSync.Answer(200, "[]");
        };
    }

    static void config(TestDb db, boolean enabled) throws Exception {
        HaSync.putKv(db, HaSync.HA_CONFIG, new JSONObject().put("enabled", enabled).put("address", "http://homeassistant.local:8123").put("entity", "todo.shopping_list").toString());
    }

    static void database(String dir) throws Exception {
        String entity = "todo.shopping_list";

        // Lines from items: haLineId, INSERT OR IGNORE, noted for sync; only the groceries tab.
        TestDb db = fresh(dir);
        item(db, "g-milk", "Milk", "pantry");
        item(db, "g-beer", "Beer", "keg");
        listLine(db, "keg-line", "Ice", "keg", "2026-11-01T00:00:01.000Z");
        listLine(db, "beer-line", "milk", null, "2026-11-01T00:00:02.000Z");
        db.exec("UPDATE list_entries SET item_id = 'g-beer' WHERE id = 'beer-line'");
        FakeHa ha = new FakeHa();
        ha.list.add(new HaSync.Item("u1", "2 milk", false));
        ha.list.add(new HaSync.Item("u2", "oat milk", false));
        HaSync.syncRound(HaSync.restApi(fakeTransport(ha, entity), entity), new HaSync.DbStore(db, entity, HaSync.pairingResets()), 1_000_000);
        List<JSONObject> lines = db.query("SELECT id, text, item_id, qty, section FROM list_entries WHERE section IN ('pantry', 'general') ORDER BY text");
        check(lines.size() == 2 && lines.get(0).getString("id").equals(HaSync.haLineId(entity, "u1")) && lines.get(0).getString("item_id").equals("g-milk") && lines.get(0).getInt("qty") == 2,
            "a voice add that's one pantry item: linked, 2 of it, id haLineId(entity, uid)");
        check(lines.get(1).getString("id").equals(HaSync.haLineId(entity, "u2")) && lines.get(1).isNull("item_id") && "general".equals(lines.get(1).optString("section")),
            "0.9.5: one that matches nothing: plain words on the General list, still haLineId");
        check("pantry".equals(lines.get(0).optString("section")), "the pantry item's line is on the grocery list");
        check(count(db, "SELECT COUNT(*) AS n FROM sync_log WHERE tbl = 'list_entries' AND pk = ? AND device = ?", HaSync.haLineId(entity, "u1"), ME) == 1, "the triggers noted the line as this phone's change (it goes to the household)");
        check(ha.calls.stream().noneMatch(c -> c.startsWith("add")), "keg lines (and a line linked to a keg item) aren't sent to Home Assistant");
        // A second runner (no pairing notes, the same database: a phone and the server before ha:phone settled).
        HaSync.syncRound(HaSync.restApi(fakeTransport(ha, entity), entity), new HaSync.DbStore(db, entity, HaSync.pairingResets()) {
            @Override
            public HaSync.State loadState() {
                return new HaSync.State();
            }
        }, 1_000_000);
        check(count(db, "SELECT COUNT(*) AS n FROM list_entries WHERE section IN ('pantry', 'general')") == 2, "a second runner pairs with the lines already there: nothing doubled");
        check(ha.list.size() == 2, "and nothing doubled in Home Assistant");
        // The state as saved, read back the same.
        HaSync.State st = HaSync.State.parse(HaSync.kv(db, HaSync.HA_STATE));
        check(st.pairs.size() == 2 && st.toJson().equals(HaSync.kv(db, HaSync.HA_STATE)), "the pairing is saved, and read back as it was written");
        // Aliases: the household's rows, and the old local ones.
        db.exec("INSERT INTO household_settings (k, v) VALUES ('alias:bread', '\"g-milk\"'), ('alias:BAD', '\"x\"'), ('keep:x', 'true')");
        HaSync.putKv(db, HaSync.LIST_ALIASES, "{\"loaf\":\"g-beer\",\"odd\":5}");
        Map<String, String> al = HaSync.aliases(db);
        check(al.size() == 2 && "g-milk".equals(al.get("bread")) && "g-beer".equals(al.get("loaf")), "aliases from the household's rows and the old local ones, checked");
        db.close();

        // 0.9.5: Keg on (switched on, a bottle shop picked): a voice add of a Keg item goes on the Keg
        // list, stays paired (its id says it came from Home Assistant), and its tick goes back.
        db = fresh(dir);
        HaSync.putKv(db, "settings", new JSONObject().put("sections", new JSONObject().put("keg", true).put("pharmacy", false))
            .put("enabledChains", new JSONArray().put("coles").put("danmurphys").put("chemistwarehouse")).toString());
        item(db, "g-milk", "Milk", "pantry");
        item(db, "k-ale", "Pale ale", "keg");
        item(db, "h-sun", "Sunscreen", "pharmacy");
        listLine(db, "keg-hand", "Ice", "keg", "2026-11-01T00:00:01.000Z");
        listLine(db, "gen-hand", "Batteries", "general", "2026-11-01T00:00:02.000Z");
        FakeHa hk = new FakeHa();
        hk.list.add(new HaSync.Item("u1", "pale ale", false));
        hk.list.add(new HaSync.Item("u2", "sunscreen", false));
        hk.n = 2;
        HaSync.syncRound(HaSync.restApi(fakeTransport(hk, entity), entity), new HaSync.DbStore(db, entity, HaSync.pairingResets()), 1_000_000);
        String aleId = HaSync.haLineId(entity, "u1"), sunId = HaSync.haLineId(entity, "u2");
        List<JSONObject> ale = db.query("SELECT item_id, section FROM list_entries WHERE id = ?", aleId);
        List<JSONObject> sun = db.query("SELECT item_id, section FROM list_entries WHERE id = ?", sunId);
        check(ale.size() == 1 && "k-ale".equals(ale.get(0).optString("item_id")) && "keg".equals(ale.get(0).optString("section")),
            "0.9.5: a voice add of a Keg item (Keg on): linked, on the Keg list");
        check(sun.size() == 1 && sun.get(0).isNull("item_id") && "general".equals(sun.get(0).optString("section")),
            "0.9.5: Health off: its item isn't matched, so it goes on General");
        check(hk.calls.contains("add Batteries") && hk.calls.stream().noneMatch(c -> c.equals("add Ice")),
            "0.9.5: a General line added by hand goes to Home Assistant; a Keg line added by hand still doesn't");
        db.exec("UPDATE list_entries SET checked = 1 WHERE id = ?", aleId);
        HaSync.syncRound(HaSync.restApi(fakeTransport(hk, entity), entity), new HaSync.DbStore(db, entity, HaSync.pairingResets()), 1_060_000);
        boolean aleDone = false;
        for (HaSync.Item h : hk.list) if (h.uid.equals("u1")) aleDone = h.completed;
        check(aleDone && count(db, "SELECT COUNT(*) AS n FROM list_entries WHERE id = ?", aleId) == 1, "0.9.5: ticked on the Keg list: completed in Home Assistant, still paired");
        db.close();

        // A pairing started afresh mid-round (a new list picked, a restore): the round changes nothing and doesn't save.
        db = fresh(dir);
        config(db, true);
        listLine(db, "r1", "apples", "pantry", "2026-11-01T00:00:01.000Z");
        FakeHa slow = new FakeHa() {
            @Override
            public List<HaSync.Item> items() {
                HaSync.resetPairing();
                return super.items();
            }
        };
        boolean restarted = false;
        try {
            HaSync.syncRound(slow, new HaSync.DbStore(db, entity, HaSync.pairingResets()), 1_000_000);
        } catch (HaSync.PairingRestarted e) {
            restarted = true;
        }
        check(restarted && slow.list.isEmpty() && HaSync.kv(db, HaSync.HA_STATE) == null, "pairing started afresh before it was read: the round stops, nothing changed either side");
        final int[] once = { 0 };
        FakeHa later = new FakeHa() {
            @Override
            public void add(String s) throws Exception {
                if (once[0]++ == 0) HaSync.resetPairing();
                super.add(s);
            }
        };
        HaSync.syncRound(later, new HaSync.DbStore(db, entity, HaSync.pairingResets()), 1_000_000);
        check(HaSync.kv(db, HaSync.HA_STATE) == null, "started afresh part-way: the round doesn't save its pairing over the fresh one");
        db.close();

        // Which phone: not in a household, in one, in a house.
        db = fresh(dir);
        config(db, true);
        FakeHa h1 = new FakeHa();
        TestHost host = new TestHost(h1);
        HaSync.Outcome o = HaSync.run(db, host, false, 1_000_000);
        check(o.ran && !o.house && count(db, "SELECT COUNT(*) AS n FROM household_settings WHERE k = 'ha:phone'") == 0, "not in a household: this phone runs it, and no row is written");
        db.exec("INSERT INTO household (k, v) VALUES ('owner', ?), ('member:" + ME + "', '{\"name\":\"Kitchen\"}'), ('member:alex000000000000', '{\"name\":\"Alex\"}')", ME);
        o = HaSync.run(db, host, false, 1_000_000);
        List<JSONObject> lg = db.query("SELECT stamp, device FROM sync_log WHERE tbl = 'household_settings' AND pk = 'ha:phone'");
        check(o.ran && HaSync.haPhone(db).mine && lg.size() == 1 && lg.get(0).getLong("stamp") == 1, "in a phone household, already on: takes ha:phone quietly (stamp 1)");
        JSONObject p = HaSync.payload(db, true);
        check(p != null && p.getString("address").equals("http://homeassistant.local:8123") && p.getBoolean("enabled") && p.getJSONObject("state").has("pairs") && !p.has("token"),
            "the handover payload: address, entity, enabled and the pairing (HomeAssistant.java adds the token)");
        check(HaSync.payload(db, false) == null, "no token saved: nothing to hand over");
        // Another phone takes it: this one stops, and has nothing to hand over.
        db.exec("INSERT INTO sync_meta (key, value) VALUES ('applying', '1')");
        db.exec("UPDATE household_settings SET v = '\"alex000000000000\"' WHERE k = 'ha:phone'");
        db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        int before = h1.calls.size();
        o = HaSync.run(db, host, false, 1_000_000);
        check(!o.ran && !HaSync.config(db).enabled && h1.calls.size() == before, "another phone named: Home Assistant goes off here, no request made");
        check(HaSync.payload(db, true) == null, "and this phone has nothing to hand over");
        db.close();

        // A house whose server doesn't run Home Assistant (yet): never claimed, never run; the settings and token stay for the upgrade.
        db = fresh(dir);
        config(db, true);
        db.exec("INSERT INTO household (k, v) VALUES ('owner', 'srv-k3x9q2'), ('name', 'Declan and Sarah'), ('member:srv-k3x9q2', '{\"name\":\"Declan and Sarah\"}'), ('member:" + ME + "', '{\"name\":\"Kitchen\"}')");
        db.exec("INSERT INTO household (k, v) VALUES ('server', ?)", new JSONObject().put("v", 3).put("sid", "k3x9q2").put("home", "http://192.168.1.20:8787").put("away", JSONObject.NULL).put("kex", "x").put("keepMonths", 12).toString());
        FakeHa h2 = new FakeHa();
        TestHost host2 = new TestHost(h2);
        check(!HaSync.claimHaPhone(db, false) && !HaSync.claimHaPhone(db, true) && count(db, "SELECT COUNT(*) AS n FROM household_settings WHERE k = 'ha:phone'") == 0, "in a house: ha:phone is never claimed, quietly or not");
        o = HaSync.run(db, host2, true, 1_000_000);
        HaSync.Phone who = HaSync.haPhone(db);
        check(o.house && !o.ran && host2.transports == 0 && h2.calls.isEmpty(), "in a house: no round, not even Sync now, and no request to Home Assistant");
        check(who.house && !who.serverRuns && "Declan and Sarah".equals(who.houseName) && "http://192.168.1.20:8787".equals(who.home) && who.away == null, "the page knows the house, its name and its server's page");
        check(HaSync.config(db).enabled && host2.token && host2.forgotten == 0, "until the server runs it, the settings and token stay (for the upgrade's payload)");
        // The phone was the household's Home Assistant phone before the handover: it can still hand it over.
        db.exec("INSERT INTO household_settings (k, v) VALUES ('ha:phone', ?)", JSONObject.quote(ME));
        check(HaSync.payload(db, true) != null, "the Home Assistant phone, in a house the server hasn't taken it in yet: hands it over");
        // The server takes it (its row arrives): the token goes, Home Assistant is off here, the pairing is dropped.
        HaSync.putKv(db, HaSync.HA_STATE, "{\"pairs\":[],\"pick\":[]}");
        db.exec("INSERT INTO sync_meta (key, value) VALUES ('applying', '1')");
        db.exec("UPDATE household_settings SET v = '\"srv-k3x9q2\"' WHERE k = 'ha:phone'");
        db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
        int resets = HaSync.pairingResets();
        o = HaSync.run(db, host2, false, 1_000_000);
        who = HaSync.haPhone(db);
        check(o.house && who.serverRuns && "your server".equals(who.name) && !who.mine, "the server runs it: the page says it's handled by the server");
        check(!host2.token && host2.forgotten == 1 && !HaSync.config(db).enabled && HaSync.kv(db, HaSync.HA_STATE) == null && HaSync.pairingResets() > resets,
            "the server runs it: this phone's token is deleted, Home Assistant off, the pairing dropped");
        check(HaSync.payload(db, true) == null, "and nothing is handed over again");
        o = HaSync.run(db, host2, false, 1_000_000);
        check(host2.forgotten == 1 && host2.transports == 0, "and nothing more to do on later rounds");
        db.close();

        // One round at a time: the background job doesn't run while the screens' round is going, and waits for nothing.
        final TestDb db3 = fresh(dir);
        config(db3, true);
        listLine(db3, "r1", "apples", "pantry", "2026-11-01T00:00:01.000Z");
        final CountDownLatch inside = new CountDownLatch(1), go = new CountDownLatch(1);
        final AtomicInteger rounds = new AtomicInteger();
        FakeHa held = new FakeHa() {
            @Override
            public List<HaSync.Item> items() {
                if (rounds.incrementAndGet() == 1) {
                    inside.countDown();
                    try {
                        go.await();
                    } catch (InterruptedException ignored) {
                        // carry on
                    }
                }
                return super.items();
            }
        };
        final TestHost host3 = new TestHost(held) {
            @Override
            public HaSync.Transport transport(String address) {
                return slowApi(held);
            }
        };
        final HaSync.Outcome[] fg = new HaSync.Outcome[1];
        Thread screens = new Thread(() -> {
            try {
                fg[0] = HaSync.runLocked(db3, host3, true, 90_000);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        screens.start();
        inside.await();
        HaSync.Outcome bg = HaSync.runLocked(db3, host3, false, 0);
        check(bg.busy && !bg.ran, "the background job's round is skipped while the screens' is going (one lock)");
        go.countDown();
        screens.join();
        check(fg[0].ran && fg[0].went == 1 && held.list.size() == 1, "the screens' round carried on and sent the line once");
        bg = HaSync.runLocked(db3, host3, false, 0);
        check(bg.ran && !bg.busy && held.list.size() == 1, "the next background round runs, and doubles nothing");
        db3.close();
    }

    /** The FakeHa as a REST API (its items() can be held up by the test). */
    static HaSync.Transport slowApi(FakeHa ha) {
        return fakeTransport(ha, "todo.shopping_list");
    }
}
