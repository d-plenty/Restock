package family.plenty.restock;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.5: a phone still on Restock 0.9.4 (compiled against the v094 tag's own sync code, see run.sh),
 * driven line by line by SyncTest095 and SyncServerV3Test, for the General shopping list (list lines
 * with section 'general', which 0.9.4 doesn't know). Its database is a file, so the phone can be
 * "updated" afterwards: the test opens the same file with this version's code. One JSON line per command:
 *
 *   pair <RESTOCK:3:… code>   joins the household from the owner phone, over a real SyncWire link
 *   wifi <host> <port>        syncs with another phone over the Wi-Fi link: { received, sent }
 *   join3 <code>              joins a v3 server's house with an Add a phone code
 *   round                     a round with the server: { error }
 *   line <id> <section> <text>   adds a list line (section "-" for none)
 *   tick <id>                 ticks a line
 *   lines                     { lines: [[id, text, section, checked], …] }
 *   quit
 *
 * Arguments: the out dir (bridge.py, migrations.json), the database file, this phone's device id.
 */
public class OldPhone094 {
    public static void main(String[] args) throws Exception {
        TestDb db = new TestDb(args[0], args[1], false);
        SyncEngine e = new SyncEngine(db);
        e.setMeta("device", args[2]);
        e.setMeta("name", "Old phone");
        SyncHousehold h = new SyncHousehold(e);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        String now = "2026-11-10T00:00:00Z";
        while ((line = in.readLine()) != null) {
            String[] p = line.trim().split(" ", 4);
            JSONObject out = new JSONObject();
            try {
                switch (p[0]) {
                    case "pair": {
                        String[] c = SyncHousehold.parseCode(p[1]);
                        h.pairingKeyUsed = SyncHousehold.pairingKey(SyncWire.unbase32(c[0]));
                        try (SyncWire.Client cl = new SyncWire.Client(h.pairingKeyUsed, c[1], Integer.parseInt(c[2]), 5000)) {
                            h.join(cl, false);
                        }
                        try (SyncWire.Client cl = new SyncWire.Client(h.key(), c[1], Integer.parseInt(c[2]), 5000)) {
                            e.syncWith(cl, now, 0);
                        }
                        out.put("paired", h.paired());
                        break;
                    }
                    case "wifi": {
                        try (SyncWire.Client cl = new SyncWire.Client(h.key(), p[1], Integer.parseInt(p[2]), 5000)) {
                            SyncEngine.Result r = e.syncWith(cl, now, 0);
                            out.put("received", r.received);
                            out.put("sent", r.sent);
                        }
                        break;
                    }
                    case "join3":
                        new ServerSync(e, h).join3(p[1], false);
                        out.put("joined", true);
                        break;
                    case "round": {
                        ServerSync.Round r = new ServerSync(e, h).round(now, System.currentTimeMillis());
                        out.put("error", r.error == null ? JSONObject.NULL : r.error);
                        break;
                    }
                    case "line":
                        db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES (?, ?, 0, 1, 'x', ?)", p[1], p[3], "-".equals(p[2]) ? null : p[2]);
                        break;
                    case "tick":
                        db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = ?", System.currentTimeMillis(), p[1]);
                        break;
                    case "lines": {
                        JSONArray a = new JSONArray();
                        List<JSONObject> rows = db.query("SELECT id, text, section, checked FROM list_entries ORDER BY id");
                        for (JSONObject r : rows)
                            a.put(new JSONArray().put(r.getString("id")).put(r.optString("text")).put(r.isNull("section") ? JSONObject.NULL : r.getString("section")).put(r.optLong("checked")));
                        out.put("lines", a);
                        break;
                    }
                    case "quit":
                        db.close();
                        System.out.println("{}");
                        System.exit(0);
                        break;
                    default:
                        out.put("problem", "unknown command");
                }
            } catch (Exception ex) {
                out.put("problem", String.valueOf(ex));
            }
            System.out.println(out);
            System.out.flush();
        }
    }
}
