package family.plenty.restock;

import android.content.Context;
import android.util.Log;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Runs the price check in the background on Android's own scheduler (WorkManager, part of
 * AndroidX — no Google Play services). Scheduled by RestockNativePlugin.scheduleChecks().
 */
public class PriceCheckWorker extends Worker {
    static final String UNIQUE_NAME = "restock-price-check";

    public PriceCheckWorker(Context context, WorkerParameters params) {
        super(context, params);
    }

    @Override
    public Result doWork() {
        try {
            PriceChecker.Result r = PriceChecker.run(getApplicationContext(), null, true);
            Log.i("RestockCheck", "background check: " + r.checked + " checked, " + r.updated + " updated, errors " + r.errors);
            return Result.success();
        } catch (Exception e) {
            Log.w("RestockCheck", "background check failed", e);
            return Result.retry();
        } finally {
            // 0.9.0: no shop page keeps running in the background after the check.
            StoreWeb.blankAll();
        }
    }
}
