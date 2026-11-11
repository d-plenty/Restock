package family.plenty.restock;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * 0.9.6: when price checks run. At a set time of day on the phone's own clock (default 5:00 am),
 * not "every N hours from the last check". Pure maths on a clock and a time zone (no Android), so it
 * is tested on a computer; src/lib/checkSchedule.ts is the TypeScript twin and
 * tools/sync-test/schedule-fixtures.json holds the shared answers for both.
 *
 * A "slot" is one scheduled moment. Every 6 or 12 hours means the set time and every 6 or 12 hours
 * from it, all day. Once a day is the set time. Every 2 days is the set time on every second
 * calendar day. Once a week is the set time on the chosen weekday. Slots are wall-clock times in the
 * phone's time zone, so a daylight saving change keeps 5:00 am at 5:00 am. A time that does not
 * exist on a day the clocks go forward (2:30 am) is run later by the length of the gap; one that
 * happens twice is run the first time.
 */
final class CheckSchedule {
    static final int DEFAULT_MINUTE = 5 * 60;

    final int intervalHours;
    final int minuteOfDay;
    /** 0 = Sunday, as in the app. Only used when checking weekly. */
    final int weekday;

    CheckSchedule(int intervalHours, int minuteOfDay, int weekday) {
        this.intervalHours = intervalHours == 6 || intervalHours == 12 || intervalHours == 48 || intervalHours == 168 ? intervalHours : 24;
        this.minuteOfDay = minuteOfDay >= 0 && minuteOfDay < 1440 ? minuteOfDay : DEFAULT_MINUTE;
        this.weekday = weekday >= 0 && weekday <= 6 ? weekday : 3;
    }

    /** From the phone's settings JSON (a missing or unreadable time means 5:00 am). */
    static CheckSchedule fromSettings(JSONObject settings) {
        if (settings == null) return new CheckSchedule(24, DEFAULT_MINUTE, 3);
        return new CheckSchedule(settings.optInt("checkIntervalHours", 24), parseTime(settings.optString("checkTime", "")), settings.optInt("checkWeekday", 3));
    }

    /** "05:00" to minutes after midnight, or 5:00 am when it isn't a time. */
    static int parseTime(String t) {
        if (t == null || !t.matches("([01]\\d|2[0-3]):[0-5]\\d")) return DEFAULT_MINUTE;
        return Integer.parseInt(t.substring(0, 2)) * 60 + Integer.parseInt(t.substring(3, 5));
    }

    /** Minutes after midnight of the check slots on a day when this schedule checks (not looking at which day). */
    private List<Integer> minutesInDay() {
        List<Integer> out = new ArrayList<>();
        if (intervalHours == 6 || intervalHours == 12) {
            int step = intervalHours * 60;
            for (int m = minuteOfDay % step; m < 1440; m += step) out.add(m);
        } else {
            out.add(minuteOfDay);
        }
        return out;
    }

    /** Does a check happen on this calendar day? */
    boolean checksOn(LocalDate d) {
        if (intervalHours == 48) return Math.floorMod(d.toEpochDay(), 2L) == 0;
        if (intervalHours == 168) return d.getDayOfWeek().getValue() % 7 == weekday;
        return true;
    }

    private static Instant at(LocalDate d, int minute, ZoneId zone) {
        // ZonedDateTime.of keeps a time that happens twice at its first time and moves one that
        // does not exist forward by the gap.
        return ZonedDateTime.of(LocalDateTime.of(d, LocalTime.of(minute / 60, minute % 60)), zone).toInstant();
    }

    /** Check slots on a day, in order. */
    List<Instant> slotsOn(LocalDate d, ZoneId zone) {
        List<Instant> out = new ArrayList<>();
        if (!checksOn(d)) return out;
        for (int m : minutesInDay()) out.add(at(d, m, zone));
        return out;
    }

    /** The first check slot after `after`. */
    Instant nextSlot(Instant after, ZoneId zone) {
        LocalDate d = after.atZone(zone).toLocalDate().minusDays(1);
        for (int i = 0; i < 20; i++, d = d.plusDays(1)) {
            for (Instant s : slotsOn(d, zone)) if (s.isAfter(after)) return s;
        }
        return after.plusSeconds(86_400);
    }

    /** The latest check slot at or before `now`, or null. */
    Instant latestSlot(Instant now, ZoneId zone) {
        LocalDate d = now.atZone(zone).toLocalDate().plusDays(1);
        for (int i = 0; i < 20; i++, d = d.minusDays(1)) {
            List<Instant> s = slotsOn(d, zone);
            for (int k = s.size() - 1; k >= 0; k--) if (!s.get(k).isAfter(now)) return s.get(k);
        }
        return null;
    }

    /**
     * When the background job should next wake. The same as nextSlot, but weekly checks wake every
     * day so the catalogue day summary can still go out on the days nothing is checked.
     */
    Instant nextWake(Instant after, ZoneId zone) {
        if (intervalHours != 168) return nextSlot(after, zone);
        Instant day = at(after.atZone(zone).toLocalDate(), minuteOfDay, zone);
        if (!day.isAfter(after)) day = at(after.atZone(zone).toLocalDate().plusDays(1), minuteOfDay, zone);
        return day;
    }

    /**
     * Is a check owed? The latest slot has passed and no check was run for it (`served` is the slot
     * the last scheduled check was run for, or null). Once per slot, however many times this is asked.
     */
    boolean due(Instant now, ZoneId zone, Instant served) {
        Instant latest = latestSlot(now, zone);
        return latest != null && (served == null || served.isBefore(latest));
    }

    /** What the schedule is, so a change of settings or time zone can start from a clean slate. */
    String signature(ZoneId zone) {
        return intervalHours + "|" + minuteOfDay + "|" + (intervalHours == 168 ? weekday : 0) + "|" + zone.getId();
    }
}
