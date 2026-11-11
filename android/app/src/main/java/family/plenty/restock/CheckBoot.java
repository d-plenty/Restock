package family.plenty.restock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.database.sqlite.SQLiteDatabase;
import org.json.JSONObject;

/**
 * 0.9.6: sets the background price check up again after the phone restarts, Restock updates, or
 * the clock or time zone changes (so "5:00 am" stays 5:00 am where the phone now is).
 */
public class CheckBoot extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (a == null) return;
        try {
            SQLiteDatabase db = RestockDatabase.get(context);
            if (!RestockDatabase.ready(db)) return;
            JSONObject settings = PriceChecker.readKv(db, "settings");
            if (settings == null) return;
            JSONObject sync = settings.optJSONObject("sync");
            boolean on = sync == null || sync.optBoolean("backgroundActivity", true);
            if (on) PriceCheckWorker.schedule(context, true);
        } catch (Exception e) {
            android.util.Log.w("RestockCheck", "reschedule failed", e);
        }
    }
}
