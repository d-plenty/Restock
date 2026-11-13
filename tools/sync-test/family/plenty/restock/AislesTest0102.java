package family.plenty.restock;

import java.nio.file.Files;
import java.nio.file.Paths;
import org.json.JSONArray;
import org.json.JSONObject;

/** 0.10.2: Aisles.coles against tools/sync-test/aisle-fixtures-0102.json (aisles0102.test.ts checks the TypeScript). */
public class AislesTest0102 {
    public static void main(String[] args) throws Exception {
        JSONArray cases = new JSONObject(new String(Files.readAllBytes(Paths.get(args[0])), "UTF-8")).getJSONArray("cases");
        int bad = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            JSONObject got = Aisles.coles(c.getJSONObject("product"));
            Object want = c.get("want");
            boolean ok = want == JSONObject.NULL ? got == null : got != null && new JSONObject(got.toString()).similar(want);
            System.out.println((ok ? "  ok   " : "  FAIL ") + c.getString("name") + (ok ? "" : " : got " + got + ", want " + want));
            if (!ok) bad++;
        }
        System.out.println(bad == 0 ? "aisles: all " + cases.length() + " agree" : "aisles: " + bad + " differ");
        if (bad > 0) System.exit(1);
    }
}
