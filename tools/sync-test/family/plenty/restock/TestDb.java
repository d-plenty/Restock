package family.plenty.restock;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** A SyncEngine.Db for tests: a fresh SQLite database with Restock's schema, through Python. */
final class TestDb implements SyncEngine.Db {
    private final Process p;
    private final BufferedWriter w;
    private final BufferedReader r;
    private int depth = 0;

    TestDb(String dir) throws Exception {
        p = new ProcessBuilder("python3", dir + "/bridge.py", ":memory:", dir + "/migrations.json").redirectError(ProcessBuilder.Redirect.INHERIT).start();
        w = new BufferedWriter(new OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8));
        r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
    }

    private JSONObject call(String op, String sql, Object... args) throws Exception {
        JSONObject m = new JSONObject();
        m.put("op", op);
        m.put("sql", sql);
        JSONArray a = new JSONArray();
        for (Object o : args) a.put(o == null ? JSONObject.NULL : o);
        m.put("args", a);
        w.write(m.toString());
        w.write("\n");
        w.flush();
        JSONObject res = new JSONObject(r.readLine());
        if (res.has("error")) throw new Exception(res.getString("error") + " in " + sql);
        return res;
    }

    public List<JSONObject> query(String sql, Object... args) throws Exception {
        JSONArray rows = call("query", sql, args).getJSONArray("rows");
        List<JSONObject> l = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) l.add(rows.getJSONObject(i));
        return l;
    }

    public void exec(String sql, Object... args) throws Exception {
        call("exec", sql, args);
    }

    public void transaction(Body body) throws Exception {
        if (depth++ == 0) exec("BEGIN");
        try {
            body.run();
            if (depth == 1) exec("COMMIT");
        } catch (Exception e) {
            if (depth == 1) exec("ROLLBACK");
            throw e;
        } finally {
            depth--;
        }
    }

    void close() {
        p.destroy();
    }
}
