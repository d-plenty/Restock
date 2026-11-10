package family.plenty.restock;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 0.9.4: a phone still on Restock 0.9.3 (compiled against the v093 tag's own sync code, see run.sh),
 * driven line by line by SyncServerV3Test, so it can take part in a household that's handed to a
 * 0.9.4 server. It answers one JSON line per command:
 *
 *   pair <RESTOCK:3:… code>   joins the household from the owner phone, over a real SyncWire link
 *   server <restock-server:2 code>   joins the (v2) Restock server
 *   round                     a round with the server: { error, on, paired }
 *   wifi <host> <port>        syncs with another phone over the Wi-Fi link: { received, sent }
 *   item <id> <name>          adds a pantry item
 *   has <id>                  { name } of an item, or null
 *   quit
 *
 * Argument: the out dir (bridge.py, migrations.json).
 */
public class OldServerPhone {
    public static void main(String[] args) throws Exception {
        SyncEngine e = new SyncEngine(new TestDb(args[0]));
        e.setMeta("device", "q9old");
        e.setMeta("name", "Old phone");
        SyncHousehold h = new SyncHousehold(e);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            String[] p = line.trim().split(" ", 3);
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
                            e.syncWith(cl, "2026-11-10T00:00:00Z", 0);
                        }
                        out.put("paired", h.paired());
                        break;
                    }
                    case "server":
                        out.put("reached", new ServerSync(e, h).join(p[1]));
                        break;
                    case "round": {
                        ServerSync.Round r = new ServerSync(e, h).round("2026-11-10T00:00:00Z", System.currentTimeMillis());
                        out.put("error", r.error == null ? JSONObject.NULL : r.error);
                        out.put("on", new ServerSync(e, h).on());
                        out.put("paired", h.paired());
                        break;
                    }
                    case "wifi": {
                        try (SyncWire.Client cl = new SyncWire.Client(h.key(), p[1], Integer.parseInt(p[2]), 5000)) {
                            SyncEngine.Result r = e.syncWith(cl, "2026-11-10T00:00:00Z", 0);
                            out.put("received", r.received);
                            out.put("sent", r.sent);
                        }
                        break;
                    }
                    case "item":
                        e.db.exec("INSERT OR REPLACE INTO items (id, name, created_at, section) VALUES (?, ?, 'x', 'pantry')", p[1], p[2]);
                        break;
                    case "has": {
                        java.util.List<JSONObject> r = e.db.query("SELECT name FROM items WHERE id = ?", p[1]);
                        out.put("name", r.isEmpty() ? JSONObject.NULL : r.get(0).get("name"));
                        break;
                    }
                    case "quit":
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
