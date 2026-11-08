package family.plenty.restock;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * "Ready to sync" (0.8.0): keeps Restock listening for the household's other phones while it's
 * closed, so they can sync with this one any time both are on the same Wi-Fi, and syncs every
 * 10 minutes itself. Android requires a notification for this; it's a quiet one, and can be
 * hidden in Android's notification settings. Turned off in Settings → Sync.
 */
public class SyncService extends Service {
    static final String CHANNEL_ID = "restock-sync";
    static final int NOTIFICATION_ID = 4761;
    private ScheduledExecutorService timer;

    /** Starts the service if this phone is paired and "Stay ready to sync" is on. Safe to call any time. */
    static void startIfWanted(Context context) {
        try {
            SyncHub hub = SyncHub.get(context);
            if (!hub.paired() || !hub.keepReady()) return;
            Intent i = new Intent(context, SyncService.class);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
            else context.startService(i);
        } catch (Exception e) {
            // Android may refuse from the background without "don't restrict battery"; the
            // 15-minute job and opening the app still sync.
            Log.w("RestockSync", "service not started: " + e.getMessage());
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Sync with your household", NotificationManager.IMPORTANCE_MIN));
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_restock)
            .setColor(0xFF00843D)
            .setContentTitle("Ready to sync")
            .setContentText("Syncs with your household's phones on this Wi-Fi")
            .setOngoing(true);
        if (tap != null) b.setContentIntent(tap);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(NOTIFICATION_ID, b.build());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final SyncHub hub = SyncHub.get(this);
        try {
            if (!hub.paired() || !hub.keepReady()) {
                stopSelf();
                return START_NOT_STICKY;
            }
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        hub.start();
        if (timer == null) {
            timer = Executors.newSingleThreadScheduledExecutor();
            timer.scheduleWithFixedDelay(() -> {
                try {
                    hub.syncAll();
                } catch (Throwable t) {
                    Log.w("RestockSync", "timed sync", t);
                }
            }, 5, 600, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (timer != null) timer.shutdownNow();
        timer = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
