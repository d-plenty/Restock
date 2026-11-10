package family.plenty.restock;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.3: an older phone (0.9.0, 0.9.1 or 0.9.2: compiled against that version's own sync code and
 * database layout, see run.sh) reads a 0.9.3 phone's folder file, which carries household settings
 * (a table it doesn't know) and a settings summary (a field it doesn't know). It must take in the
 * rest as before, pass over the new data without a problem, and write its own file without it.
 *
 * Arguments: the old version's out dir (bridge.py, migrations.json), the dir SyncTest093 wrote
 * (phone.bin, key.txt), and the version's name for the report.
 */
public class OldReader {
    static int fails = 0;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "  ok   " : "  FAIL ") + what);
        if (!ok) fails++;
    }

    static final class MapFolder implements SyncFolder.Folder {
        final Map<String, byte[]> files = new TreeMap<>();

        public List<String> names() {
            return new ArrayList<>(files.keySet());
        }

        public byte[] read(String name) {
            return files.get(name);
        }

        public void write(String name, byte[] data) {
            files.put(name, data);
        }
    }

    public static void main(String[] args) throws Exception {
        String dir = args[0];
        File work = new File(args[1]);
        String which = args.length > 2 ? args[2] : "old";
        System.out.println("O1 a phone on " + which + " reads a 0.9.3 phone's file");
        byte[] key = java.util.Base64.getDecoder().decode(Files.readString(new File(work, "key.txt").toPath()).trim());
        byte[] file = Files.readAllBytes(new File(work, "phone.bin").toPath());
        JSONObject inside = SyncFolder.open(key, file);
        int settingsEntries = 0;
        JSONArray all = inside.getJSONArray("entries");
        for (int i = 0; i < all.length(); i++) if ("household_settings".equals(all.getJSONObject(i).optString("tbl"))) settingsEntries++;
        check(settingsEntries > 0 && inside.has("summary"), "the file has household settings (" + settingsEntries + ") and a summary");

        SyncEngine e = new SyncEngine(new TestDb(dir));
        e.setMeta("device", "old9");
        e.setMeta("name", "Old phone");
        e.setMeta("key", SyncWire.encodeKey(key));
        e.setMeta("secret", "not-used");
        SyncHousehold h = new SyncHousehold(e);
        MapFolder f = new MapFolder();
        f.files.put("restock-sync-a1.bin", file);
        String problem = null;
        SyncFolder.Result r = null;
        try {
            r = new SyncFolder(e, h).sync(f, "2026-11-10T00:00:00Z");
        } catch (Exception ex) {
            problem = String.valueOf(ex);
        }
        check(problem == null && r != null && r.received > 0, "it syncs without a problem (" + (problem != null ? problem : r.received + " changes taken in") + ")");
        check(!e.db.query("SELECT 1 FROM list_entries WHERE id = 'old1'").isEmpty(), "the rest comes in as before (a list line)");
        // 0.9.3: a line from Home Assistant is just a line here (its "ha-" id is only an id), and the
        // shopping list's rows (aliases, "Keep it as just", the Home Assistant phone) are passed over
        // with the rest of the household settings.
        check(!e.db.query("SELECT 1 FROM list_entries WHERE id = 'ha-old2' AND text = 'oat milk'").isEmpty(), "a line that came from Home Assistant comes in as a plain line");
        int listRows = 0;
        for (int i = 0; i < all.length(); i++) {
            JSONObject x = all.getJSONObject(i);
            String pk = x.optString("pk");
            if ("household_settings".equals(x.optString("tbl")) && (pk.startsWith("alias:") || pk.startsWith("keep:") || pk.equals("ha:phone"))) listRows++;
        }
        check(listRows == 3, "the file has the shopping list's rows too (" + listRows + "), passed over like the rest");
        check(e.db.query("SELECT 1 FROM sync_log WHERE tbl = 'household_settings'").isEmpty(), "household settings are passed over (not noted)");
        boolean noTable = e.db.query("SELECT 1 FROM sqlite_master WHERE name = 'household_settings'").isEmpty();
        check(noTable, "and nothing is made for them in the old database");
        byte[] own = f.files.get("restock-sync-old9.bin");
        JSONObject mine = own == null ? null : SyncFolder.open(key, own);
        boolean clean = mine != null && !mine.has("summary") && !mine.getJSONArray("entries").toString().contains("household_settings");
        check(clean, "its own file goes out as before, without them");
        System.out.println(fails == 0 ? "old phone (" + which + "): all passed" : "old phone (" + which + "): " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
