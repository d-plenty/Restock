package family.plenty.restock;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.time.Instant;
import java.time.ZoneId;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs the price check in the background on Android's own scheduler (WorkManager, part of
 * AndroidX, no Google Play services).
 *
 * 0.9.6: at a set time of day (CheckSchedule), not every N hours. One job waits until the next
 * time (an initial delay; Android may run it a few minutes late to save battery, and no exact-alarm
 * permission is needed). When it wakes it queues the next one, then checks if one is owed. If the
 * phone was off through the time, the job runs soon after it is back and the check is made then,
 * once for that time and never twice. Two job names are used in turn, so a job can queue the next
 * without cancelling itself.
 *
 * Scheduled by RestockNativePlugin.scheduleChecks() (when Restock opens and when the setting
 * changes) and by CheckBoot (restart, update, clock or time zone change). "Check now" does not
 * touch any of this.
 */
public class PriceCheckWorker extends Worker {
    static final String UNIQUE_NAME = "restock-price-check";
    static final String UNIQUE_NAME_B = "restock-price-check-b";
    /** 0.9.6: the one catch-up job for a set time that was missed (phone off, restart, update, clock change). */
    static final String UNIQUE_NAME_CATCHUP = "restock-price-check-catchup";
    private static final long CATCHUP_DELAY_MS = 60_000L;
    private static final String TAG = "RestockCheck";
    private static final String KEY = "checkSlot";

    public PriceCheckWorker(Context context, WorkerParameters params) {
        super(context, params);
    }

    private Instant runSlot;
    private Instant runStart;

    /**
     * 0.10.2: the background checks' own log, for Advanced → Diagnostics and the Home screen's
     * "didn't run" line: the last 12 scheduled checks, newest first, in the "checkLog" store entry
     * (this phone's only). Outcome: running, done, stopped (Android's time ran out), failed, or app
     * (Restock had just checked, so that counted). A set time with no entry never ran at all.
     */
    static synchronized void noteRun(SQLiteDatabase db, Instant slot, Instant start, String outcome, JSONObject counts) {
        try {
            JSONObject log = PriceChecker.readKv(db, "checkLog");
            JSONArray runs = log == null ? null : log.optJSONArray("runs");
            JSONArray next = new JSONArray();
            JSONObject me = new JSONObject().put("slot", slot.toString()).put("start", start.toString()).put("outcome", outcome);
            if (!"running".equals(outcome)) me.put("end", Instant.now().toString());
            if (counts != null) for (java.util.Iterator<String> k = counts.keys(); k.hasNext(); ) {
                String key = k.next();
                me.put(key, counts.get(key));
            }
            next.put(me);
            if (runs != null) {
                for (int i = 0; i < runs.length() && next.length() < 12; i++) {
                    JSONObject r = runs.optJSONObject(i);
                    // The same run, written again when it finishes: only the newest stays.
                    if (r == null || (start.toString().equals(r.optString("start")) && slot.toString().equals(r.optString("slot")))) continue;
                    next.put(r);
                }
            }
            PriceChecker.writeKv(db, "checkLog", new JSONObject().put("runs", next));
        } catch (Exception e) {
            Log.w(TAG, "check log not saved", e);
        }
    }

    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        try {
            SQLiteDatabase db = RestockDatabase.get(ctx);
            if (!RestockDatabase.ready(db)) return Result.success();
            JSONObject settings = PriceChecker.readKv(db, "settings");
            if (settings == null) return Result.success();
            JSONObject sync = settings.optJSONObject("sync");
            if (sync != null && !sync.optBoolean("backgroundActivity", true)) return Result.success();

            CheckSchedule cs = CheckSchedule.fromSettings(settings);
            ZoneId zone = ZoneId.systemDefault();
            Instant now = Instant.now();

            // Queue the next one first, so one failed check never ends the schedule. An old
            // repeating job from 0.9.5 (no name) is replaced by the new kind of job instead.
            Data in = getInputData();
            String me = in == null ? null : in.getString("name");
            if (me == null) schedule(ctx, true);
            else if (UNIQUE_NAME_CATCHUP.equals(me)) { /* the scheduled job is already queued */ }
            else enqueue(ctx, cs, zone, now, UNIQUE_NAME.equals(me) ? UNIQUE_NAME_B : UNIQUE_NAME);

            Instant latest = cs.latestSlot(now, zone);
            Instant served = servedFor(db, cs, zone, now);
            if (!cs.due(now, zone, served)) {
                PriceChecker.summaryOnly(ctx); // nothing owed (weekly checks wake daily)
                return Result.success();
            }
            if (PriceChecker.recentlyChecked(settings, now)) {
                // A check ran moments ago (the app's): that one counts, don't run another.
                markServed(db, cs, zone, latest);
                noteRun(db, latest, now, "app", null);
                PriceChecker.summaryOnly(ctx);
                return Result.success();
            }
            runSlot = latest;
            runStart = now;
            noteRun(db, latest, now, "running", null);
            PriceChecker.Result r = PriceChecker.run(ctx, null, true);
            markServed(db, cs, zone, latest);
            noteRun(db, latest, now, "done", new JSONObject().put("checked", r.checked).put("updated", r.updated).put("errors", r.errors.size()));
            Log.i(TAG, "background check: " + r.checked + " checked, " + r.updated + " updated, errors " + r.errors);
            return Result.success();
        } catch (Exception e) {
            Log.w(TAG, "background check failed", e);
            // 0.10.2: Android stopped it (its time ran out), or it failed: either way, say so.
            if (runSlot != null) {
                try {
                    noteRun(RestockDatabase.get(ctx), runSlot, runStart, isStopped() ? "stopped" : "failed", null);
                } catch (Exception ignored) {
                    // the note is only a note
                }
            }
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
        } finally {
            // 0.9.0: no shop page keeps running in the background after the check.
            StoreWeb.blankAll();
        }
    }

    // ---------- the schedule ----------

    /**
     * Sets the next background check up (or cancels it). Returns whether a check is owed right now
     * (the latest set time has passed and none was run for it), so the app can run it when it opens.
     * Safe to call as often as you like.
     */
    static synchronized boolean schedule(Context ctx, boolean enabled) {
        try {
            SQLiteDatabase db = RestockDatabase.get(ctx);
            if (!RestockDatabase.ready(db)) return false;
            JSONObject settings = PriceChecker.readKv(db, "settings");
            CheckSchedule cs = CheckSchedule.fromSettings(settings);
            ZoneId zone = ZoneId.systemDefault();
            Instant now = Instant.now();
            boolean due = cs.due(now, zone, servedFor(db, cs, zone, now));
            WorkManager wm = WorkManager.getInstance(ctx);
            if (enabled) {
                // One scheduled job at most. If one of the two is running right now, it queues the
                // next itself; only make sure the other name has one (KEEP never doubles it).
                boolean aRunning = running(wm, UNIQUE_NAME);
                boolean bRunning = running(wm, UNIQUE_NAME_B);
                if (aRunning || bRunning) {
                    enqueue(ctx, cs, zone, now, aRunning ? UNIQUE_NAME_B : UNIQUE_NAME, ExistingWorkPolicy.KEEP, 0);
                } else {
                    enqueue(ctx, cs, zone, now, UNIQUE_NAME, ExistingWorkPolicy.REPLACE, 0);
                    wm.cancelUniqueWork(UNIQUE_NAME_B);
                }
                // A check is owed (missed set time): one catch-up soon, once for that set time.
                if (due) enqueue(ctx, cs, zone, now, UNIQUE_NAME_CATCHUP, ExistingWorkPolicy.KEEP, CATCHUP_DELAY_MS);
            } else {
                wm.cancelUniqueWork(UNIQUE_NAME);
                wm.cancelUniqueWork(UNIQUE_NAME_B);
                wm.cancelUniqueWork(UNIQUE_NAME_CATCHUP);
            }
            return due;
        } catch (Exception e) {
            Log.w(TAG, "schedule failed", e);
            return false;
        }
    }

    private static boolean running(WorkManager wm, String name) {
        try {
            for (androidx.work.WorkInfo wi : wm.getWorkInfosForUniqueWork(name).get(3, TimeUnit.SECONDS)) {
                if (wi.getState() == androidx.work.WorkInfo.State.RUNNING) return true;
            }
        } catch (Exception ignored) {
            // can't tell: treat as not running
        }
        return false;
    }

    private static void enqueue(Context ctx, CheckSchedule cs, ZoneId zone, Instant now, String name) {
        enqueue(ctx, cs, zone, now, name, ExistingWorkPolicy.REPLACE, 0);
    }

    /** fixedDelayMs > 0 is a catch-up (soon); otherwise the job waits for the next set time. */
    private static void enqueue(Context ctx, CheckSchedule cs, ZoneId zone, Instant now, String name,
                                ExistingWorkPolicy policy, long fixedDelayMs) {
        long delay = fixedDelayMs > 0 ? fixedDelayMs
            : Math.max(1_000L, cs.nextWake(now, zone).toEpochMilli() - now.toEpochMilli());
        // Only on a network connection and when the battery isn't low (as before). Doze may hold it
        // a little; it then runs when Android next allows.
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(PriceCheckWorker.class)
            .setConstraints(constraints)
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .setInputData(new Data.Builder().putString("name", name).build())
            .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork(name, policy, req);
    }

    // ---------- which set time was last checked for ----------

    /**
     * The set time the last scheduled check was for. When the schedule changed (a new time, how
     * often, or the phone's time zone) or was never recorded (the update from 0.9.5), it starts
     * clean: the latest set time counts as done, so changing the time at 10 am to 9 am doesn't
     * check straight away, and nothing is checked twice.
     */
    static Instant servedFor(SQLiteDatabase db, CheckSchedule cs, ZoneId zone, Instant now) {
        String sig = cs.signature(zone);
        JSONObject saved = PriceChecker.readKv(db, KEY);
        if (saved != null && sig.equals(saved.optString("sig", ""))) {
            String at = saved.optString("served", "");
            try {
                return at.isEmpty() ? null : Instant.parse(at);
            } catch (Exception ignored) {
                return null;
            }
        }
        Instant latest = cs.latestSlot(now, zone);
        write(db, sig, latest);
        return latest;
    }

    static void markServed(SQLiteDatabase db, CheckSchedule cs, ZoneId zone, Instant slot) {
        write(db, cs.signature(zone), slot);
    }

    private static void write(SQLiteDatabase db, String sig, Instant served) {
        try {
            JSONObject o = new JSONObject().put("sig", sig);
            if (served != null) o.put("served", served.toString());
            PriceChecker.writeKv(db, KEY, o);
        } catch (Exception e) {
            Log.w(TAG, "check slot not saved", e);
        }
    }

    /** "Check now" from the app when a set time was missed: run it, then count the set time as done. */
    static Instant owedSlot(Context ctx) {
        try {
            SQLiteDatabase db = RestockDatabase.get(ctx);
            JSONObject settings = PriceChecker.readKv(db, "settings");
            CheckSchedule cs = CheckSchedule.fromSettings(settings);
            return cs.latestSlot(Instant.now(), ZoneId.systemDefault());
        } catch (Exception e) {
            return null;
        }
    }

    static void markServedNow(Context ctx, Instant slot) {
        try {
            SQLiteDatabase db = RestockDatabase.get(ctx);
            JSONObject settings = PriceChecker.readKv(db, "settings");
            markServed(db, CheckSchedule.fromSettings(settings), ZoneId.systemDefault(), slot);
        } catch (Exception e) {
            Log.w(TAG, "check slot not saved", e);
        }
    }
}
