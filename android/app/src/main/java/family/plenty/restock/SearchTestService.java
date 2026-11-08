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
import android.os.PowerManager;
import android.util.Log;

/**
 * The search test, running with the screen off (0.8.6). The searches themselves run in the app as
 * usual; this keeps Restock working while the phone is locked or you're in another app: Android
 * needs a notification for that, which shows how far it's got and has a Stop button. It stops
 * itself when the test ends, and after two hours at most.
 */
public class SearchTestService extends Service {
    static final String CHANNEL_ID = "restock-search-test";
    static final String DONE_CHANNEL_ID = "restock-search-test-done";
    static final int NOTIFICATION_ID = 4762;
    static final int DONE_NOTIFICATION_ID = 4763;
    static final String ACTION_STOP = "family.plenty.restock.SEARCH_TEST_STOP";
    private static final long MAX_MS = 2 * 60 * 60 * 1000L;

    /** Set by the notification's Stop button; the test checks it after each search. */
    static volatile boolean stopAsked = false;
    private static volatile int done = 0;
    private static volatile int total = 0;
    private static volatile String now = "";
    private PowerManager.WakeLock lock;

    static void begin(Context context, int of) {
        stopAsked = false;
        done = 0;
        total = of;
        now = "Starting";
        Intent i = new Intent(context, SearchTestService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }

    static void progress(Context context, int d, int of, String text) {
        done = d;
        total = of;
        now = text == null ? "" : text;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, build(context));
    }

    /** Ends the test; when it finished in the background, says so with a notification. */
    static void end(Context context, String title, String text) {
        context.stopService(new Intent(context, SearchTestService.class));
        if (title == null) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(DONE_CHANNEL_ID, "Search test finished", NotificationManager.IMPORTANCE_DEFAULT));
        Notification.Builder b = new Notification.Builder(context, DONE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_restock)
            .setColor(0xFF00843D)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true);
        PendingIntent tap = openApp(context);
        if (tap != null) b.setContentIntent(tap);
        nm.notify(DONE_NOTIFICATION_ID, b.build());
    }

    private static PendingIntent openApp(Context context) {
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        return open == null ? null : PendingIntent.getActivity(context, 3, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static Notification build(Context context) {
        Intent stop = new Intent(context, SearchTestService.class).setAction(ACTION_STOP);
        PendingIntent stopTap = PendingIntent.getService(context, 4, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_restock)
            .setColor(0xFF00843D)
            .setContentTitle(stopAsked ? "Search test: stopping" : "Search test: " + done + " of " + total)
            .setContentText(now)
            .setProgress(Math.max(total, 1), Math.min(done, Math.max(total, 1)), total == 0)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop and save", stopTap).build());
        PendingIntent tap = openApp(context);
        if (tap != null) b.setContentIntent(tap);
        return b.build();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Search test", NotificationManager.IMPORTANCE_LOW));
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, build(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTIFICATION_ID, build(this));
        try {
            PowerManager pm = getSystemService(PowerManager.class);
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Restock:searchTest");
            lock.acquire(MAX_MS);
        } catch (Exception e) {
            Log.w("RestockSearchTest", "no wake lock: " + e.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopAsked = true;
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIFICATION_ID, build(this));
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        try {
            if (lock != null && lock.isHeld()) lock.release();
        } catch (Exception ignored) {
            // already let go
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
