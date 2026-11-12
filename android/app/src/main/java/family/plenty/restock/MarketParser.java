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

    /**
     * 0.9.0: the most price changes kept per product, the newest ones. The summary only looks at
     * the last 26 weeks (at most one change a day, so about 183), so keeping the newest 400 never
     * changes a summary; it stops one broken entry with endless history filling the phone's memory.
     */
    static final int MAX_HISTORY = 400;

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

    /**
     * 0.9.11: a restock-prices file, Restock's own export format: {"format": "restock-export",
     * "tables": {"products": [{"store_product_id": "…", "prices": [{"date": "…", "price": 3.1}, …]}, …]}}.
     * Read a product at a time, as above. Returns how many products had enough history to summarise.
     */
    static int parseExport(InputStream in, long now, int windowDays, Sink sink, Progress progress) throws IOException {
        int[] counts = {0, 0};
        JsonReader r = new JsonReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        try {
            r.beginObject();
            while (r.hasNext()) {
                if (!"tables".equals(r.nextName()) || r.peek() != JsonToken.BEGIN_OBJECT) {
                    r.skipValue();
                    continue;
                }
                r.beginObject();
                while (r.hasNext()) {
                    if (!"products".equals(r.nextName()) || r.peek() != JsonToken.BEGIN_ARRAY) {
                        r.skipValue();
                        continue;
                    }
                    r.beginArray();
                    while (r.hasNext()) {
                        Item item = readExportItem(r);
                        counts[0]++;
                        if (item.id != null && !item.dates.isEmpty()) {
                            Deals.Market m = Deals.summarise(item.dates, item.prices, now, windowDays);
                            if (m != null) {
                                sink.accept(item.id, m);
                                counts[1]++;
                            }
                        }
                        if (progress != null && counts[0] % 2000 == 0) progress.onProgress(counts[0], counts[1]);
                    }
                    r.endArray();
                }
                r.endObject();
            }
            r.endObject();
        } finally {
            r.close();
        }
        if (progress != null) progress.onProgress(counts[0], counts[1]);
        return counts[1];
    }

    /** One product of a restock-prices file: its id and its prices (oldest first, as the file has them). */
    static Item readExportItem(JsonReader r) throws IOException {
        Item item = new Item();
        r.beginObject();
        while (r.hasNext()) {
            String key = r.nextName();
            if (r.peek() == JsonToken.NULL) {
                r.nextNull();
            } else if ("store_product_id".equals(key)) {
                item.id = r.nextString();
            } else if ("prices".equals(key) && r.peek() == JsonToken.BEGIN_ARRAY) {
                readPrices(r, item);
            } else {
                r.skipValue();
            }
        }
        r.endObject();
        return item;
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
                    readPrices(r, item);
                    break;
                default:
                    r.skipValue();
            }
        }
        r.endObject();
        return item;
    }

    /** [{"date": "2026-11-10", "price": 3.1}, …], keeping the newest MAX_HISTORY. */
    static void readPrices(JsonReader r, Item item) throws IOException {
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
                // 0.9.0: trim now and then while reading (not every time), and at the end.
                if (item.dates.size() >= 2 * MAX_HISTORY) keepNewest(item, MAX_HISTORY);
            }
        }
        r.endArray();
        keepNewest(item, MAX_HISTORY);
    }

    /** 0.9.0: keeps a product's newest `keep` price changes (the dates are ISO, so they sort as text). */
    static void keepNewest(Item item, int keep) {
        int n = Math.min(item.dates.size(), item.prices.size());
        if (n <= keep) return;
        Integer[] order = new Integer[n];
        for (int i = 0; i < n; i++) order[i] = i;
        java.util.Arrays.sort(order, (a, b) -> item.dates.get(b).compareTo(item.dates.get(a)));
        List<String> dates = new ArrayList<>(keep);
        List<Double> prices = new ArrayList<>(keep);
        for (int k = 0; k < keep; k++) {
            dates.add(item.dates.get(order[k]));
            prices.add(item.prices.get(order[k]));
        }
        item.dates.clear();
        item.dates.addAll(dates);
        item.prices.clear();
        item.prices.addAll(prices);
    }
}
