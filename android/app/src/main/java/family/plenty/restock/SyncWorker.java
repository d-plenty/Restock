package family.plenty.restock;

import android.content.Context;
import android.util.Log;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Background sync about every 15 minutes (0.8.0), on Android's own scheduler. Also brings back
 * the "ready to sync" service if Android stopped it.
 *
 * 0.9.4: then Home Assistant's round, on the phone that does it (HomeAssistant.backgroundRound,
 * HaSync.java), so a voice add reaches Restock's list (and the household) with Restock closed. One
 * round at a time with the screens' (HaSync.LOCK). If anything came in from Home Assistant, the
 * household gets it straight away with a second sync, not 15 minutes later.
 */
public class SyncWorker extends Worker {
    public SyncWorker(Context context, WorkerParameters params) {
        super(context, params);
    }

    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        // 0.9.4: an upgrade to a v3 server during this sync can carry Home Assistant to the server.
        HomeAssistant.install(ctx);
        SyncHub hub = null;
        boolean paired = false;
        try {
            hub = SyncHub.get(ctx);
            paired = hub.paired();
            if (paired) {
                SyncService.startIfWanted(ctx);
                SyncHub.Summary s = hub.syncAll();
                Log.i("RestockSync", "background sync: " + s.reached + " phones, " + s.received + " in, " + s.sent + " out");
            }
        } catch (Exception e) {
            Log.w("RestockSync", "background sync failed", e);
        }
        try {
            HaSync.Outcome ha = HomeAssistant.backgroundRound(ctx);
            if (ha.ran) Log.i("RestockHa", "background round: " + ha.came + " in, " + ha.went + " out" + (ha.held ? " (held)" : "") + (ha.status.error != null ? " (failed)" : ""));
            if (ha.came > 0 && paired && hub != null) hub.syncAll();
            // Not in a household and Home Assistant off here: nothing for this job to do any more.
            if (!paired && !ha.busy && !HomeAssistant.wanted(ctx)) WorkManager.getInstance(ctx).cancelUniqueWork(SyncHub.WORK_NAME);
        } catch (Exception e) {
            Log.w("RestockHa", "background round failed", e);
        }
        return Result.success();
    }
}
