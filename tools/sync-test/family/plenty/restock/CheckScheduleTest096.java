package family.plenty.restock;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 0.9.6: CheckSchedule.java (price checks at a set time of day) against the shared answers in
 * tools/sync-test/schedule-fixtures.json, which src/lib/checkSchedule096.test.ts checks on the
 * TypeScript side. Run through tools/sync-test/schedule-parity.sh. Pass "gen" as the second
 * argument to print the answers for the fixture inputs instead of checking them.
 */
public class CheckScheduleTest096 {
    static int failures = 0;

    static CheckSchedule plan(JSONObject c) {
        return new CheckSchedule(c.getInt("interval"), CheckSchedule.parseTime(c.getString("time")), c.optInt("weekday", 3));
    }

    static String iso(Instant i) {
        return i == null ? null : i.toString();
    }

    static void eq(String what, Object want, Object got) {
        if (String.valueOf(want).equals(String.valueOf(got))) return;
        failures++;
        System.out.println("FAIL " + what + ": want " + want + ", got " + got);
    }

    public static void main(String[] args) throws Exception {
        JSONObject f = new JSONObject(new String(Files.readAllBytes(Path.of(args[0])), "UTF-8"));
        boolean gen = args.length > 1 && "gen".equals(args[1]);
        JSONArray cases = f.getJSONArray("cases");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            CheckSchedule cs = plan(c);
            ZoneId zone = ZoneId.of(c.getString("zone"));
            Instant now = Instant.parse(c.getString("now"));
            String next = iso(cs.nextSlot(now, zone));
            String latest = iso(cs.latestSlot(now, zone));
            String wake = iso(cs.nextWake(now, zone));
            if (gen) {
                c.put("next", next).put("latest", latest).put("wake", wake);
                continue;
            }
            String name = c.getString("name");
            eq(name + " next", c.getString("next"), next);
            eq(name + " latest", c.getString("latest"), latest);
            eq(name + " wake", c.getString("wake"), wake);
        }
        JSONArray dues = f.getJSONArray("due");
        for (int i = 0; i < dues.length(); i++) {
            JSONObject c = dues.getJSONObject(i);
            CheckSchedule cs = plan(c);
            ZoneId zone = ZoneId.of(c.getString("zone"));
            Instant now = Instant.parse(c.getString("now"));
            Instant served = c.isNull("served") ? null : Instant.parse(c.getString("served"));
            boolean due = cs.due(now, zone, served);
            if (gen) {
                c.put("due", due);
                continue;
            }
            eq(c.getString("name") + " due", c.getBoolean("due"), due);
        }
        // Signature: changes with the time, how often and the zone, so those start clean.
        eq("signature time", false, new CheckSchedule(24, 300, 3).signature(ZoneId.of("UTC")).equals(new CheckSchedule(24, 360, 3).signature(ZoneId.of("UTC"))));
        eq("signature zone", false, new CheckSchedule(24, 300, 3).signature(ZoneId.of("UTC")).equals(new CheckSchedule(24, 300, 3).signature(ZoneId.of("Australia/Brisbane"))));
        eq("signature weekday only weekly", true, new CheckSchedule(24, 300, 1).signature(ZoneId.of("UTC")).equals(new CheckSchedule(24, 300, 5).signature(ZoneId.of("UTC"))));
        // A time that isn't one, and settings with nothing in them, mean 5:00 am once a day.
        eq("bad time", 300, CheckSchedule.parseTime("25:99"));
        eq("no settings", 300, CheckSchedule.fromSettings(new JSONObject()).minuteOfDay);
        eq("no settings interval", 24, CheckSchedule.fromSettings(new JSONObject()).intervalHours);
        if (gen) {
            System.out.println(f.toString(1));
            return;
        }
        if (failures > 0) {
            System.out.println(failures + " failed");
            System.exit(1);
        }
        System.out.println("CheckSchedule096: all " + (cases.length() * 3 + dues.length() + 6) + " checks pass");
    }
}
