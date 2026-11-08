package family.plenty.restock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After the phone restarts or Restock updates, be ready to sync again (0.8.0). */
public class SyncBoot extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            SyncService.startIfWanted(context);
        }
    }
}
