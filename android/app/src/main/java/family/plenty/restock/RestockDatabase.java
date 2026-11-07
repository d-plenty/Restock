package family.plenty.restock;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;

/**
 * The one SQLite database the app uses, shared by the app's screens (through
 * RestockNativePlugin) and the background PriceCheckWorker. One connection object for the
 * whole process, so the two never fight over it.
 *
 * The tables themselves are created by the app's migrations in src/lib/sql/schema.ts.
 */
final class RestockDatabase {
    static final String FILE_NAME = "restock.db";
    private static SQLiteDatabase db;

    private RestockDatabase() {}

    static synchronized SQLiteDatabase get(Context context) {
        if (db == null || !db.isOpen()) {
            File file = context.getApplicationContext().getDatabasePath(FILE_NAME);
            File dir = file.getParentFile();
            if (dir != null && !dir.exists()) dir.mkdirs();
            db = SQLiteDatabase.openOrCreateDatabase(file, null);
            db.enableWriteAheadLogging();
        }
        return db;
    }

    /** True once the app has created its tables (i.e. it has been opened at least once). */
    static boolean ready(SQLiteDatabase db) {
        try (android.database.Cursor c = db.rawQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'products'", null)) {
            return c.moveToFirst();
        }
    }
}
