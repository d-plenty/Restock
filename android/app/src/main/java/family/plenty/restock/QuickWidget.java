package family.plenty.restock;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;

/** The "Quick" home screen widget; Widgets draws it. */
public class QuickWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        Widgets.draw(context, manager, ids, "quick");
    }
}
