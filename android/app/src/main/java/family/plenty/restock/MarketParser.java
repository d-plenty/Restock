package family.plenty.restock;

import android.util.JsonReader;
import android.util.JsonToken;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * 0.9.13: reads a restock-prices day-one file (window/&lt;shop&gt;-&lt;days&gt;d.json.gz) one product at a time
 * and hands back a summary for each, so the whole file never sits in memory:
 *
 * <pre>{"format": "restock-window", "v": 1, "chain": "coles", "days": 56, "from": "2026-09-17", "to": "2026-11-12",
 *  "products": {"8150288": [[0, 495], [33, 350, 1], [47, 495]], …}}</pre>
 *
 * Each product's change points are [day counted from "from", price in cents, flags (1 on special,
 * 2 member price)]. Restock 0.9.12 and earlier read hotprices.org and the latest/ files instead.
 */
final class MarketParser {
    interface Sink {
        void accept(String storeProductId, Deals.Market summary) throws IOException;
    }

    interface Progress {
        void onProgress(int seen, int kept) throws IOException;
    }

    private MarketParser() {}

    /**
     * The most change points kept per product (12 months at one change a day is 366), so one
     * broken entry with endless points can't fill the phone's memory.
     */
    static final int MAX_POINTS = 400;

    /** Returns how many products had enough history to summarise. */
    static int parseWindow(InputStream in, long now, int windowDays, Sink sink, Progress progress) throws IOException {
        int seen = 0, kept = 0;
        LocalDate from = null;
        JsonReader r = new JsonReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        try {
            r.beginObject();
            while (r.hasNext()) {
                String key = r.nextName();
                if ("format".equals(key) && r.peek() == JsonToken.STRING) {
                    if (!"restock-window".equals(r.nextString())) throw new IOException("not a restock-prices day-one file");
                } else if ("from".equals(key) && r.peek() == JsonToken.STRING) {
                    from = LocalDate.parse(r.nextString());
                } else if ("products".equals(key) && r.peek() == JsonToken.BEGIN_OBJECT) {
                    // "from" comes before "products" in the files the collector writes.
                    if (from == null) throw new IOException("the file has no start date");
                    r.beginObject();
                    while (r.hasNext()) {
                        String id = r.nextName();
                        List<String> dates = new ArrayList<>();
                        List<Double> prices = new ArrayList<>();
                        readPoints(r, from, dates, prices);
                        seen++;
                        if (!dates.isEmpty()) {
                            Deals.Market m = Deals.summarise(dates, prices, now, windowDays);
                            if (m != null) {
                                sink.accept(id, m);
                                kept++;
                            }
                        }
                        if (progress != null && seen % 2000 == 0) progress.onProgress(seen, kept);
                    }
                    r.endObject();
                } else {
                    r.skipValue();
                }
            }
            r.endObject();
        } finally {
            r.close();
        }
        if (progress != null) progress.onProgress(seen, kept);
        return kept;
    }

    /** [[day, cents, flags?], …] into dates ("2026-11-10") and prices (dollars), oldest first. */
    static void readPoints(JsonReader r, LocalDate from, List<String> dates, List<Double> prices) throws IOException {
        if (r.peek() != JsonToken.BEGIN_ARRAY) {
            r.skipValue();
            return;
        }
        r.beginArray();
        while (r.hasNext()) {
            if (r.peek() != JsonToken.BEGIN_ARRAY) {
                r.skipValue();
                continue;
            }
            r.beginArray();
            int day = -1;
            long cents = -1;
            if (r.hasNext() && r.peek() == JsonToken.NUMBER) day = r.nextInt();
            if (r.hasNext() && r.peek() == JsonToken.NUMBER) cents = r.nextLong();
            while (r.hasNext()) r.skipValue(); // flags: not needed for the summary
            r.endArray();
            if (day < 0 || day > 4000 || cents <= 0 || cents > 10_000_000 || dates.size() >= MAX_POINTS) continue;
            dates.add(from.plusDays(day).toString());
            prices.add(cents / 100.0);
        }
        r.endArray();
    }
}
