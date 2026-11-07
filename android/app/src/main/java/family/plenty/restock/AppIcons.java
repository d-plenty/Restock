package family.plenty.restock;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;

/**
 * The app icon's colour (Settings → Look and colours → App icon). Android can't recolour an
 * installed icon, so each colour is its own launcher entry (an activity-alias in the manifest,
 * all opening MainActivity) and exactly one is switched on at a time.
 */
final class AppIcons {
    private AppIcons() {}

    static final String[] IDS = {
        "green", "gold", "navy", "red", "forest", "teal", "sky", "indigo", "purple", "pink", "orange", "amber", "brown", "slate", "black", "white",
    };

    static String alias(String id) {
        return "family.plenty.restock.Icon" + Character.toUpperCase(id.charAt(0)) + id.substring(1);
    }

    /** Switches the launcher icon to this colour. False if it isn't one of ours. */
    static boolean set(Context context, String id) {
        boolean known = false;
        for (String i : IDS) if (i.equals(id)) known = true;
        if (!known) return false;
        PackageManager pm = context.getPackageManager();
        // Turn the new one on first, so there's never a moment with no icon at all.
        pm.setComponentEnabledSetting(new ComponentName(context, alias(id)), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
        for (String i : IDS) {
            if (i.equals(id)) continue;
            pm.setComponentEnabledSetting(new ComponentName(context, alias(i)), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
        }
        return true;
    }
}
