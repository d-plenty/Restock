package family.plenty.restock;

import android.content.Context;
import android.util.Log;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Background sync about every 15 minutes (0.8.0), on Android's own scheduler. Also brings back
 * the "ready to sync" service if Android stopped it.
 */
public class SyncWorker extends Worker {
    public SyncWorker(Context context, WorkerParameters params) {
        super(context, params);
    }

    @Override
    public Result doWork() {
        try {
            SyncHub hub = SyncHub.get(getApplicationContext());
            if (!hub.paired()) return Result.success();
            SyncService.startIfWanted(getApplicationContext());
            SyncHub.Summary s = hub.syncAll();
            Log.i("RestockSync", "background sync: " + s.reached + " phones, " + s.received + " in, " + s.sent + " out");
        } catch (Exception e) {
            Log.w("RestockSync", "background sync failed", e);
        }
        return Result.success();
    }
}
