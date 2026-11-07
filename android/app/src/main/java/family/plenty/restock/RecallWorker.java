package family.plenty.restock;

import android.content.Context;
import android.util.Log;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** The once-a-day recall check, on Android's own scheduler. Scheduled by RestockNativePlugin.scheduleRecalls(). */
public class RecallWorker extends Worker {
    static final String UNIQUE_NAME = "restock-recall-check";

    public RecallWorker(Context context, WorkerParameters params) {
        super(context, params);
    }

    @Override
    public Result doWork() {
        try {
            RecallChecker.Result r = RecallChecker.run(getApplicationContext(), true);
            Log.i("RestockRecalls", "daily check: " + r.checked + " notices, " + r.found + " possible, " + r.fresh + " new, errors " + r.errors);
            return r.checked == 0 && !r.errors.isEmpty() ? Result.retry() : Result.success();
        } catch (Exception e) {
            Log.w("RestockRecalls", "daily check failed", e);
            return Result.retry();
        }
    }
}
