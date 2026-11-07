package family.plenty.restock;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Automatic backups, written into a folder the person picked (Settings → Backups). The app makes
 * the backup file itself; this only saves it there and removes the oldest automatic ones so at
 * most "keep" are left. Files it didn't make (anything not named restock-auto-…) are never touched.
 */
final class Backups {
    private Backups() {}

    static final String PREFIX = "restock-auto-";

    private static Uri folder(Uri tree) {
        return DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    }

    static String folderName(Context context, Uri tree) {
        try (Cursor c = context.getContentResolver().query(folder(tree), new String[] {DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
            // Fall through to the path.
        }
        String id = DocumentsContract.getTreeDocumentId(tree);
        int colon = id.lastIndexOf(':');
        return colon >= 0 && colon < id.length() - 1 ? id.substring(colon + 1) : id;
    }

    /** Saves one backup and returns how many old automatic backups were removed. */
    static int write(Context context, Uri tree, String name, String json, int keep) throws Exception {
        ContentResolver cr = context.getContentResolver();
        Uri dir = folder(tree);
        Uri file = DocumentsContract.createDocument(cr, dir, "application/json", name);
        if (file == null) throw new Exception("The folder didn't let Restock save there. Pick the folder again in Settings → Backups.");
        try (OutputStream out = cr.openOutputStream(file, "wt")) {
            if (out == null) throw new Exception("Couldn't open the backup file");
            out.write(json.getBytes(StandardCharsets.UTF_8));
        }

        // Tidy up: newest first by name (the names start with the date), keep the newest "keep".
        List<String[]> mine = new ArrayList<>();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        try (Cursor c = cr.query(children, new String[] {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String n = c.getString(1);
                if (n != null && n.startsWith(PREFIX) && n.endsWith(".json")) mine.add(new String[] {c.getString(0), n});
            }
        }
        Collections.sort(mine, (a, b) -> b[1].compareTo(a[1]));
        int removed = 0;
        for (int i = Math.max(1, keep); i < mine.size(); i++) {
            try {
                if (DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, mine.get(i)[0]))) removed++;
            } catch (Exception ignored) {
                // Leave it; next time.
            }
        }
        return removed;
    }
}
