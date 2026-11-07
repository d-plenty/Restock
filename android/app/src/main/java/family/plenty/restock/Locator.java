package family.plenty.restock;

import android.annotation.SuppressLint;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import java.util.List;

/**
 * A one-off "roughly where am I", using Android's own location service. No Google Play
 * services. Only approximate location is asked for, which is plenty to find nearby stores.
 */
final class Locator {
    interface Callback {
        void done(Location location, String error);
    }

    private static final long FRESH_MS = 30 * 60_000L;
    private static final long TIMEOUT_MS = 20_000L;

    private Locator() {}

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation") // requestSingleUpdate is only used before Android 11
    static void locate(Context context, Callback cb) {
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            cb.done(null, "This phone has no location service. Search by suburb or postcode instead.");
            return;
        }

        List<String> providers = lm.getProviders(true);
        Location last = null;
        for (String p : providers) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (last == null || l.getTime() > last.getTime())) last = l;
            } catch (SecurityException | IllegalArgumentException ignored) {
                // Provider not allowed or gone; try the next one.
            }
        }
        if (last != null && System.currentTimeMillis() - last.getTime() < FRESH_MS) {
            cb.done(last, null);
            return;
        }

        String provider = null;
        if (Build.VERSION.SDK_INT >= 31 && providers.contains(LocationManager.FUSED_PROVIDER)) provider = LocationManager.FUSED_PROVIDER;
        else if (providers.contains(LocationManager.NETWORK_PROVIDER)) provider = LocationManager.NETWORK_PROVIDER;
        else if (providers.contains(LocationManager.GPS_PROVIDER)) provider = LocationManager.GPS_PROVIDER;
        if (provider == null) {
            if (last != null) cb.done(last, null);
            else cb.done(null, "Location is turned off on this phone. Turn it on, or search by suburb or postcode instead.");
            return;
        }

        final Location fallback = last;
        final Handler main = new Handler(Looper.getMainLooper());
        final boolean[] finished = {false};
        final Runnable[] timeout = new Runnable[1];

        final Callback once = (loc, err) -> main.post(() -> {
            if (finished[0]) return;
            finished[0] = true;
            main.removeCallbacks(timeout[0]);
            if (loc != null) cb.done(loc, null);
            else if (fallback != null) cb.done(fallback, null);
            else cb.done(null, err != null ? err : "Couldn't work out where you are. Try again, or search by suburb or postcode.");
        });
        timeout[0] = () -> once.done(null, "Couldn't get your location in time. Try again, or search by suburb or postcode.");
        main.postDelayed(timeout[0], TIMEOUT_MS);

        try {
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(provider, new CancellationSignal(), context.getMainExecutor(), loc -> once.done(loc, null));
            } else {
                lm.requestSingleUpdate(provider, new LocationListener() {
                    @Override
                    public void onLocationChanged(Location location) {
                        once.done(location, null);
                    }

                    @Override
                    public void onStatusChanged(String p, int status, Bundle extras) {}

                    @Override
                    public void onProviderEnabled(String p) {}

                    @Override
                    public void onProviderDisabled(String p) {}
                }, Looper.getMainLooper());
            }
        } catch (SecurityException e) {
            once.done(null, "Restock isn't allowed to use your location. You can allow it in Settings.");
        }
    }
}
