package family.plenty.restock;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Makes price histories (the same ones every run), summarises each with Deals.summarise, and prints
 * the histories and the summaries, for comparing with the iPhone's TypeScript port (market-parity.test.ts).
 */
public final class MarketDump {
    public static void main(String[] args) throws Exception {
        long now = java.time.Instant.parse("2026-11-25T04:00:00Z").toEpochMilli();
        java.util.Random rnd = new java.util.Random(20261125L);
        int[] windows = {56, 182, 365};
        JSONArray out = new JSONArray();
        for (int n = 0; n < 600; n++) {
            int window = windows[n % 3];
            List<String> dates = new ArrayList<>();
            List<Double> prices = new ArrayList<>();
            java.time.LocalDate day = java.time.LocalDate.of(2026, 11, 25).minusDays(10 + rnd.nextInt(420));
            long base = 100 + rnd.nextInt(2000);
            int points = 1 + rnd.nextInt(14);
            for (int i = 0; i < points; i++) {
                long cents = rnd.nextInt(3) == 0 ? Math.round(base * (0.5 + rnd.nextInt(45) / 100.0)) : base + (rnd.nextInt(5) == 0 ? rnd.nextInt(60) - 30 : 0);
                dates.add(day.toString());
                prices.add(Math.max(1, cents) / 100.0);
                day = day.plusDays(1 + rnd.nextInt(n % 7 == 0 ? 70 : 21));
            }
            if (n % 11 == 0 && dates.size() > 2) {
                // out of order, as a broken file might have them
                java.util.Collections.swap(dates, 0, dates.size() - 1);
                java.util.Collections.swap(prices, 0, prices.size() - 1);
            }
            Deals.Market m = Deals.summarise(dates, prices, now, window);
            JSONObject o = new JSONObject().put("window", window).put("dates", new JSONArray(dates)).put("prices", new JSONArray(prices));
            if (m == null) o.put("m", JSONObject.NULL);
            else o.put("m", new JSONObject().put("normal", m.normal).put("sale", m.sale == null ? JSONObject.NULL : m.sale).put("saleShare", m.saleShare).put("low", m.low)
                .put("cycleWeeks", m.cycleWeeks == null ? JSONObject.NULL : m.cycleWeeks).put("days", m.days).put("latest", m.latest == null ? JSONObject.NULL : m.latest));
            out.put(o);
        }
        System.out.println(new JSONObject().put("now", now).put("cases", out).toString());
    }
}
