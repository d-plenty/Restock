package family.plenty.restock;

import android.util.JsonReader;
import android.util.JsonToken;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads a hotprices.org file one product at a time (it's a JSON array of products, each with
 * its price history) and hands back a summary for each, so the whole file never sits in memory.
 */
final class MarketParser {
    interface Sink {
        void accept(String storeProductId, Deals.Market summary) throws IOException;
    }

    interface Progress {
        void onProgress(int seen, int kept) throws IOException;
    }

    private MarketParser() {}

    /** Returns how many products had enough history to summarise. */
    static int parse(InputStream in, long now, int windowDays, Sink sink, Progress progress) throws IOException {
        int seen = 0, kept = 0;
        JsonReader r = new JsonReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        try {
            r.beginArray();
            while (r.hasNext()) {
                Item item = readItem(r);
                seen++;
                if (item.id != null && !item.weighted && !item.dates.isEmpty()) {
                    Deals.Market m = Deals.summarise(item.dates, item.prices, now, windowDays);
                    if (m != null) {
                        sink.accept(item.id, m);
                        kept++;
                    }
                }
                if (progress != null && seen % 2000 == 0) progress.onProgress(seen, kept);
            }
            r.endArray();
        } finally {
            r.close();
        }
        if (progress != null) progress.onProgress(seen, kept);
        return kept;
    }

    static final class Item {
        String id;
        boolean weighted;
        final List<String> dates = new ArrayList<>();
        final List<Double> prices = new ArrayList<>();
    }

    /** Reads one product, keeping only what the summary needs. */
    static Item readItem(JsonReader r) throws IOException {
        Item item = new Item();
        r.beginObject();
        while (r.hasNext()) {
            String key = r.nextName();
            if (r.peek() == JsonToken.NULL) {
                r.nextNull();
                continue;
            }
            switch (key) {
                case "id":
                    // Numbers come through as text, without a ".0".
                    String v = r.nextString();
                    item.id = v.endsWith(".0") ? v.substring(0, v.length() - 2) : v;
                    break;
                case "isWeighted":
                    item.weighted = r.peek() == JsonToken.BOOLEAN ? r.nextBoolean() : "true".equals(r.nextString());
                    break;
                case "priceHistory":
                    r.beginArray();
                    while (r.hasNext()) {
                        String date = null;
                        Double price = null;
                        r.beginObject();
                        while (r.hasNext()) {
                            String k = r.nextName();
                            if (r.peek() == JsonToken.NULL) {
                                r.nextNull();
                            } else if ("date".equals(k)) {
                                date = r.nextString();
                            } else if ("price".equals(k)) {
                                price = r.nextDouble();
                            } else {
                                r.skipValue();
                            }
                        }
                        r.endObject();
                        if (date != null && price != null && date.length() >= 10) {
                            item.dates.add(date);
                            item.prices.add(price);
                        }
                    }
                    r.endArray();
                    break;
                default:
                    r.skipValue();
            }
        }
        r.endObject();
        return item;
    }
}
