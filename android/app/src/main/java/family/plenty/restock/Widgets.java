package family.plenty.restock;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The three home screen widgets: Deals, Shopping list and Quick actions. The app hands over what
 * to show (RestockNativePlugin.updateWidgets) each time it opens or the list changes; this keeps
 * it and draws it. The look (background, colour, see-through, text colour) is set in Settings →
 * Widgets and applies to all three.
 */
final class Widgets {
    private Widgets() {}

    private static final String PREFS = "restock_widgets";

    static void saveFromApp(Context context, String json) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("data", json).apply();
        refreshAll(context);
    }

    static JSONObject data(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            return new JSONObject(p.getString("data", "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static void refreshAll(Context context) {
        AppWidgetManager m = AppWidgetManager.getInstance(context);
        if (m == null) return;
        draw(context, m, m.getAppWidgetIds(new ComponentName(context, DealsWidget.class)), "deals");
        draw(context, m, m.getAppWidgetIds(new ComponentName(context, ListWidget.class)), "list");
        draw(context, m, m.getAppWidgetIds(new ComponentName(context, QuickWidget.class)), "quick");
    }

    static void draw(Context context, AppWidgetManager m, int[] ids, String kind) {
        if (ids == null || ids.length == 0) return;
        JSONObject d = data(context);
        RemoteViews v = "quick".equals(kind) ? quick(context, d) : text(context, d, kind);
        for (int id : ids) m.updateAppWidget(id, v);
    }

    // ---------- look ----------

    static final class Look {
        int bg;
        int alpha;
        boolean none;
        int ink;
        int muted;
    }

    static Look look(JSONObject d) {
        JSONObject s = d.optJSONObject("look");
        if (s == null) s = new JSONObject();
        boolean dark = d.optBoolean("dark", false);
        String kind = s.optString("background", "solid");
        Look l = new Look();
        l.none = "none".equals(kind);
        l.bg = "colour".equals(kind) ? parse(s.optString("colour"), 0xFF00843D) : (dark ? 0xFF15213F : 0xFFFFFFFF);
        l.alpha = Math.round(255 * Math.max(0, Math.min(100, 100 - s.optInt("transparency", 0))) / 100f);
        String text = s.optString("text", "auto");
        if ("auto".equals(text)) {
            // White or near-black, whichever reads better on the background.
            l.ink = l.none ? Color.WHITE : (contrast(l.bg, Color.WHITE) >= contrast(l.bg, 0xFF0F1D3D) ? Color.WHITE : 0xFF0F1D3D);
        } else {
            l.ink = parse(text, Color.WHITE);
        }
        l.muted = (l.ink & 0x00FFFFFF) | 0xB3000000;
        return l;
    }

    private static int parse(String hex, int fallback) {
        try {
            return Color.parseColor(hex);
        } catch (Exception e) {
            return fallback;
        }
    }

    private static double contrast(int a, int b) {
        double x = luminance(a);
        double y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }

    private static double luminance(int c) {
        double[] ch = {Color.red(c) / 255.0, Color.green(c) / 255.0, Color.blue(c) / 255.0};
        for (int i = 0; i < 3; i++) ch[i] = ch[i] <= 0.03928 ? ch[i] / 12.92 : Math.pow((ch[i] + 0.055) / 1.055, 2.4);
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }

    private static void background(RemoteViews v, Look l) {
        if (l.none) {
            v.setViewVisibility(R.id.widget_bg, View.GONE);
            return;
        }
        v.setViewVisibility(R.id.widget_bg, View.VISIBLE);
        v.setInt(R.id.widget_bg, "setColorFilter", l.bg | 0xFF000000);
        v.setInt(R.id.widget_bg, "setImageAlpha", l.alpha);
    }

    // ---------- opening the app ----------

    static PendingIntent open(Context context, String action, int code) {
        Intent i = new Intent(context, MainActivity.class);
        i.setAction(Intent.ACTION_VIEW);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (action != null) i.putExtra("restockAction", action);
        return PendingIntent.getActivity(context, 5100 + code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // ---------- Deals and Shopping list ----------

    private static RemoteViews text(Context context, JSONObject d, String kind) {
        Look l = look(d);
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_text);
        background(v, l);
        boolean deals = "deals".equals(kind);
        JSONArray lines = d.optJSONArray(deals ? "deals" : "list");
        int count = lines == null ? 0 : lines.length();
        String title = deals ? "Deals" : "Shopping list";
        if (!deals && count > 0) title += " · " + d.optInt("listCount", count);
        v.setTextViewText(R.id.widget_title, title);
        v.setTextColor(R.id.widget_title, l.ink);

        StringBuilder body = new StringBuilder();
        for (int i = 0; i < Math.min(count, 8); i++) {
            JSONObject o = lines.optJSONObject(i);
            if (o == null) continue;
            if (body.length() > 0) body.append('\n');
            body.append(deals ? "• " : "☐ ").append(o.optString("text"));
            String extra = o.optString("extra", "");
            if (!extra.isEmpty()) body.append("  ").append(extra);
        }
        if (body.length() == 0) {
            body.append(deals ? "No deals right now. Restock checks your shops and shows the good ones here." : "Your shopping list is empty.");
        }
        v.setTextViewText(R.id.widget_body, body.toString());
        v.setTextColor(R.id.widget_body, count == 0 ? l.muted : l.ink);
        String when = d.optString("updated", "");
        v.setTextViewText(R.id.widget_foot, when.isEmpty() ? "Open Restock to fill this in" : "Updated " + when);
        v.setTextColor(R.id.widget_foot, l.muted);
        v.setOnClickPendingIntent(R.id.widget_root, open(context, deals ? "deals" : "list", deals ? 1 : 2));
        return v;
    }

    // ---------- Quick actions ----------

    private static RemoteViews quick(Context context, JSONObject d) {
        Look l = look(d);
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_quick);
        background(v, l);
        int[][] parts = {
            {R.id.quick_scan, R.id.quick_scan_icon, R.id.quick_scan_label},
            {R.id.quick_list, R.id.quick_list_icon, R.id.quick_list_label},
            {R.id.quick_receipt, R.id.quick_receipt_icon, R.id.quick_receipt_label},
        };
        String[] actions = {"scan", "list", "receipt"};
        boolean receipts = d.optBoolean("receipts", false);
        for (int i = 0; i < parts.length; i++) {
            v.setInt(parts[i][1], "setColorFilter", l.ink);
            v.setTextColor(parts[i][2], l.ink);
            v.setOnClickPendingIntent(parts[i][0], open(context, actions[i], 10 + i));
        }
        v.setViewVisibility(R.id.quick_receipt, receipts ? View.VISIBLE : View.GONE);
        return v;
    }
}
