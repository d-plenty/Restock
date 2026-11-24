package family.plenty.restock;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.List;
import org.json.JSONObject;

/**
 * 0.14.0: an Android phone on the Wi-Fi, for the iPhone's side of phone-to-phone sync
 * (src/ios/wire.ts) to talk to over real sockets (tools/sync-test/wire-parity.test.ts drives it).
 * It runs the phones' own code: SyncWire's listener and client, SyncHousehold, SyncEngine.
 *
 * Arguments: the out dir, the device id, and "owner" (it starts a household) or "joiner".
 * Commands on stdin, one a line; each answers one line starting "OK" or "ERR":
 *   INVITE              the owner's code (RESTOCK:3:TOKEN:127.0.0.1:port)
 *   ITEM id name        adds a pantry item
 *   ITEMS               the items' names, sorted, "|" between
 *   MEMBERS             the household's phones' ids, sorted
 *   SYNC host port      syncs with the phone listening there, as a client
 *   JOIN code           joins a household with its code
 *   REMOVE device       the owner removes a phone
 *   KEYV                the household key's number
 *   QUIT
 */
public class WirePeer {
    public static void main(String[] args) throws Exception {
        SyncFamily.dir = args[0];
        final SyncFamily.Phone p = new SyncFamily.Phone(args[1]);
        final Object lock = new Object();
        if ("owner".equals(args[2])) p.h.create("Java house", "Android " + args[1]);
        SyncWire.Server server = null;
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        System.out.println("READY");
        for (String line; (line = in.readLine()) != null; ) {
            String[] c = line.trim().split(" ", 3);
            try {
                synchronized (lock) {
                    if (server == null && p.h.paired()) {
                        server = new SyncWire.Server(p.h::serverKeys, new SyncWire.Handler() {
                            public JSONObject handle(JSONObject m, String host, int which) throws Exception {
                                synchronized (lock) {
                                    return p.h.handle(m, host, which);
                                }
                            }
                        }, java.net.InetAddress.getByName("127.0.0.1"));
                    }
                    switch (c[0]) {
                        case "INVITE":
                            System.out.println("OK " + p.h.invite("127.0.0.1", server.port()));
                            break;
                        case "PORT":
                            System.out.println("OK " + server.port());
                            break;
                        case "ITEM":
                            p.db.exec("INSERT INTO items (id, name, created_at, section) VALUES (?, ?, 'x', 'pantry')", c[1], c[2]);
                            System.out.println("OK");
                            break;
                        case "ITEMS": {
                            StringBuilder b = new StringBuilder();
                            for (JSONObject r : p.db.query("SELECT name FROM items ORDER BY name")) b.append(b.length() == 0 ? "" : "|").append(r.getString("name"));
                            System.out.println("OK " + b);
                            break;
                        }
                        case "MEMBERS": {
                            StringBuilder b = new StringBuilder();
                            for (JSONObject r : p.db.query("SELECT k FROM household WHERE k LIKE 'member:%' ORDER BY k")) b.append(b.length() == 0 ? "" : "|").append(r.getString("k").substring(7));
                            System.out.println("OK " + b);
                            break;
                        }
                        case "KEYV":
                            System.out.println("OK " + p.h.keyv());
                            break;
                        case "REMOVE":
                            p.h.remove(c[1]);
                            System.out.println("OK");
                            break;
                        case "JOIN": {
                            String[] code = SyncHousehold.parseCode(c[1]);
                            byte[] pk = SyncHousehold.pairingKey(SyncWire.unbase32(code[0]));
                            p.h.pairingKeyUsed = pk;
                            try (SyncWire.Client cl = new SyncWire.Client(pk, code[1], Integer.parseInt(code[2]), 3000)) {
                                JSONObject got = p.h.join(cl, false);
                                p.e.yieldToHousehold();
                                if (got.has("household")) p.e.setMeta("household", got.optString("household"));
                            }
                            System.out.println("OK");
                            break;
                        }
                        case "SYNC": {
                            String out = "";
                            for (int attempt = 0; attempt < 2; attempt++) {
                                SyncEngine.Result r;
                                try (SyncWire.Client cl = new SyncWire.Client(p.h.key(), c[1], Integer.parseInt(c[2]), 3000)) {
                                    r = p.e.syncWith(cl, SyncFamily.NOW, server == null ? 0 : server.port());
                                }
                                out = "received=" + r.received + " sent=" + r.sent + " removed=" + r.removed + " rekey=" + (r.rekey != null);
                                if (r.rekey == null) break;
                                p.h.takeRekey(r.rekey);
                            }
                            p.h.ensureKeys();
                            System.out.println("OK " + out);
                            break;
                        }
                        case "QUIT":
                            System.out.println("OK");
                            System.exit(0);
                            break;
                        default:
                            System.out.println("ERR unknown");
                    }
                }
            } catch (Throwable e) {
                System.out.println("ERR " + e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }
    }
}
