package family.plenty.restock;

import android.content.Context;
import android.content.SharedPreferences;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 0.9.3: Home Assistant's side of the shopping list (src/lib/homeAssistant.ts does the rest).
 *
 * - The long-lived access token is kept here, sealed with a key of its own in Android's key store
 *   ("restock-ha"), in Restock's private preferences (left out of Android's cloud backup and phone
 *   transfer, data_extraction_rules.xml). It's never in Restock's database, so it's never in a
 *   backup, in household sync or in the settings a joining phone takes. Once saved it's never handed
 *   back to the screens: this class adds it to each request itself. It's never logged, and no message
 *   from here has it in.
 * - Requests go through SyncDav's HTTP: plain http only to an address at home (192.168.x.x,
 *   10.x.x.x, homeassistant.local and the like) or on Tailscale (100.64.0.0/10), https with the
 *   certificate checked everywhere else, a timeout and a size limit on each. That's the same rule
 *   as sync; nothing in the app allows plain http otherwise.
 * - Only Home Assistant's API (/api/...), GET and POST.
 */
final class HomeAssistant {
    private HomeAssistant() {}

    static final String PREFS = "restock-ha";
    private static final String TOKEN = "token";
    /** The address the token was saved for: the saved token only ever goes there. */
    private static final String FOR = "for";
    private static final SyncKeystore KEYS = new SyncKeystore("restock-ha");
    /** Home Assistant's API only. */
    private static final Pattern PATH = Pattern.compile("/api/[A-Za-z0-9_./-]{0,200}(\\?return_response)?");
    private static final Pattern TOKEN_CHARS = Pattern.compile("[A-Za-z0-9._~+/=-]{20,2000}");

    static final class Answer {
        final int status;
        final String body;

        Answer(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** A token as typed, or an IllegalArgumentException in words (that never has the token in it). */
    static String checkToken(String typed) {
        String t = typed == null ? "" : typed.trim();
        if (t.regionMatches(true, 0, "Bearer ", 0, 7)) t = t.substring(7).trim();
        if (!TOKEN_CHARS.matcher(t).matches())
            throw new IllegalArgumentException("That doesn't look like a long-lived access token. Copy the whole token from Home Assistant and paste it in again.");
        return t;
    }

    /** Saves the token for one Home Assistant address; it's never sent anywhere else. */
    static void saveToken(Context c, String typed, String address) throws Exception {
        String t = checkToken(typed);
        String at = base(address);
        if (!prefs(c).edit().putString(TOKEN, KEYS.seal(t)).putString(FOR, at).commit()) throw new Exception("Couldn't save the token on this phone. Try again.");
    }

    static boolean hasToken(Context c) {
        return prefs(c).getString(TOKEN, null) != null;
    }

    /** Remove, and Erase everything: the token and its key go. */
    static void forget(Context c) {
        prefs(c).edit().clear().commit();
        KEYS.forgetKey();
    }

    private static String token(Context c) throws Exception {
        String sealed = prefs(c).getString(TOKEN, null);
        if (sealed == null) throw new Exception("No token is saved on this phone. Paste one in on Settings → Home Assistant.");
        try {
            return KEYS.open(sealed);
        } catch (SyncEngine.SecretLost e) {
            throw new Exception("Restock can't open the saved token any more. Paste the token in again with Change.");
        }
    }

    /** The address Home Assistant is at, tidied (scheme, host, port), or a SyncDav.Problem in words. */
    static String base(String typed) throws SyncDav.Problem {
        String t = typed == null ? "" : typed.trim();
        if (!t.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) t = "http://" + t;
        URI u = SyncDav.address(t);
        String a = u.getScheme() + "://" + u.getRawAuthority();
        if (u.getRawUserInfo() != null) throw new SyncDav.Problem("Leave any user name out of the address.");
        return a;
    }

    /**
     * One request to Home Assistant's API. `typedToken`: one typed in but not saved yet (Test
     * connection); otherwise the saved one. Throws in words when Home Assistant can't be reached.
     */
    static Answer request(Context c, String address, String method, String path, String body, String typedToken) throws Exception {
        if (!"GET".equals(method) && !"POST".equals(method)) throw new IllegalArgumentException("Only GET and POST");
        if (path == null || !PATH.matcher(path).matches() || path.contains("..")) throw new IllegalArgumentException("Not a Home Assistant API path");
        String at = base(address);
        String token;
        if (typedToken != null && !typedToken.trim().isEmpty()) token = checkToken(typedToken);
        else {
            // The saved token only goes to the address it was saved for, whatever the screens ask.
            if (!at.equals(prefs(c).getString(FOR, null)))
                throw new Exception("Home Assistant's address has changed. Tap Change and paste the token in again, so it's only sent to the new address.");
            token = token(c);
        }
        URI u = URI.create(at + path);
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Authorization", "Bearer " + token);
        h.put("Accept", "application/json");
        byte[] b = null;
        if (body != null) {
            h.put("Content-Type", "application/json");
            b = body.getBytes(StandardCharsets.UTF_8);
        }
        // A home's whole /api/states can be a few megabytes.
        SyncDav.Response r = SyncDav.request(method, u, h, b, SyncDav.MAX_LIST);
        return new Answer(r.status, r.text());
    }
}
