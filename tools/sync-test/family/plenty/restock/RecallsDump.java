package family.plenty.restock;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Prints what Recalls.java makes of the fixtures, for comparing with the iPhone's TypeScript port (recalls-parity.test.ts). */
public final class RecallsDump {
    static JSONObject j(Recalls.Recall r) throws Exception {
        return new JSONObject().put("id", r.id).put("source", r.source).put("title", r.title).put("url", r.url)
            .put("date", r.date == null || r.date.isEmpty() ? JSONObject.NULL : r.date)
            .put("reason", r.reason == null ? JSONObject.NULL : r.reason)
            .put("dates", r.dates == null ? JSONObject.NULL : r.dates)
            .put("whatToDo", r.whatToDo == null ? JSONObject.NULL : r.whatToDo);
    }
    static JSONArray list(List<Recalls.Recall> l) throws Exception {
        JSONArray a = new JSONArray();
        for (Recalls.Recall r : l) a.put(j(r));
        return a;
    }
    public static void main(String[] args) throws Exception {
        JSONObject f = new JSONObject(new String(Files.readAllBytes(Paths.get(args[0])), "UTF-8"));
        JSONObject out = new JSONObject();
        out.put("fsanz", list(Recalls.parseFsanzList(f.getString("fsanz"))));
        out.put("rss", list(Recalls.parseRss(f.getString("rss"), "Product Safety Australia")));
        Recalls.Recall page = new Recalls.Recall("FSANZ", "t", "https://www.foodstandards.gov.au/x", null);
        Recalls.readFsanzPage(page, f.getString("page"));
        out.put("page", j(page));
        JSONArray links = new JSONArray();
        for (int i = 0; i < f.getJSONArray("links").length(); i++) {
            JSONArray l = f.getJSONArray("links").getJSONArray(i);
            links.put(Recalls.safeLink(l.getString(0), l.getString(1)));
        }
        out.put("links", links);
        JSONArray tokens = new JSONArray();
        for (int i = 0; i < f.getJSONArray("tokens").length(); i++) tokens.put(new JSONArray(Recalls.tokens(f.getJSONArray("tokens").getString(i))));
        out.put("tokens", tokens);
        JSONArray match = new JSONArray();
        for (int i = 0; i < f.getJSONArray("match").length(); i++) {
            JSONArray m = f.getJSONArray("match").getJSONArray(i);
            match.put(Recalls.matches(new Recalls.Recall("s", m.getString(0), "u", null), new Recalls.Thing("k", m.getString(1), m.isNull(2) ? null : m.getString(2))));
        }
        out.put("match", match);
        System.out.println(out.toString());
    }
}
