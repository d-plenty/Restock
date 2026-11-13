package family.plenty.restock;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.10.3: Deals.java's Always on special against the shared answers in
 * tools/sync-test/always-fixtures-0103.json, which src/lib/always0103.test.ts checks on the
 * TypeScript side. Run through tools/sync-test/always-parity.sh.
 */
public class AlwaysTest0103 {
    public static void main(String[] args) throws Exception {
        JSONObject f = new JSONObject(new String(Files.readAllBytes(Path.of(args[0])), "UTF-8"));
        long now = java.time.OffsetDateTime.parse(f.getString("now")).toInstant().toEpochMilli();
        JSONArray cases = f.getJSONArray("cases");
        int failures = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            List<Deals.Reading> rs = new ArrayList<>();
            JSONArray s = c.getJSONArray("series");
            for (int j = 0; j < s.length(); j++) {
                JSONArray r = s.getJSONArray(j);
                String date = java.time.Instant.ofEpochMilli(now - r.getLong(0) * 86_400_000L).toString();
                Double was = r.isNull(2) ? null : r.getDouble(2);
                rs.add(new Deals.Reading(date, r.getDouble(1), was, r.getBoolean(3), false));
            }
            Deals.Stats st = Deals.computeStats(rs, now);
            String kind = Deals.judge(st, true).name().toLowerCase();
            if (st.always != c.getInt("always") || !kind.equals(c.getString("kind"))) {
                failures++;
                System.out.println("FAIL " + c.getString("name") + ": want " + c.getString("kind") + "/" + c.getInt("always") + ", got " + kind + "/" + st.always);
            }
        }
        System.out.println(failures == 0 ? "always on special: all " + cases.length() + " agree" : failures + " failures");
        System.exit(failures == 0 ? 0 : 1);
    }
}
