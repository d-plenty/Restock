package family.plenty.restock;

import java.nio.charset.StandardCharsets;

/**
 * 0.14.0: LanBridge (the Wi-Fi for Export data → Send to another phone) against itself: a listener
 * that answers each message, a connection that asks, a message at the size limit's edge, hanging up,
 * and stopping. With "serve" as the first argument it listens, prints "PORT n" and answers until its
 * input closes (tools/sync-test/wire-parity.test.ts talks to it from the iPhone's side of the code).
 */
public class LanBridgeTest {
    static int fails = 0;

    static void report(String name, boolean problem, String detail) {
        System.out.println((problem ? "  FAIL " : "  ok   ") + name + "  :: " + detail);
        if (problem) fails++;
    }

    public static void main(String[] args) throws Exception {
        final LanBridge[] box = new LanBridge[1];
        final java.util.List<String> ended = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        box[0] = new LanBridge(new LanBridge.Events() {
            public void message(String key, String conn, String from, byte[] data) {
                String text = new String(data, StandardCharsets.UTF_8);
                if (text.equals("bye")) box[0].reply(conn, null);
                else box[0].reply(conn, ("echo:" + key + ":" + text).getBytes(StandardCharsets.UTF_8));
            }

            public void ended(String key, String conn) {
                ended.add(key + ":" + conn);
            }
        });
        LanBridge b = box[0];
        int port = b.listen("send", java.net.InetAddress.getByName("127.0.0.1"));
        if (args.length > 0 && "serve".equals(args[0])) {
            System.out.println("PORT " + port);
            while (System.in.read() >= 0) {
                // until the input closes
            }
            return;
        }
        report("A1 listening twice under one name is the same listener", b.listen("send", null) != port, "port " + port);
        String id = b.dial("127.0.0.1", port, 2000);
        String a = new String(b.ask(id, "hello".getBytes(StandardCharsets.UTF_8), 5000), StandardCharsets.UTF_8);
        report("A2 a message gets its answer", !"echo:send:hello".equals(a), a);
        byte[] big = new byte[3 * 1024 * 1024];
        java.util.Arrays.fill(big, (byte) 'x');
        byte[] back = b.ask(id, big, 10000);
        report("A3 a large message goes whole", back.length != big.length + "echo:send:".length(), "bytes " + back.length);
        boolean hungUp = false;
        try {
            b.ask(id, "bye".getBytes(StandardCharsets.UTF_8), 3000);
        } catch (java.io.IOException e) {
            hungUp = true;
        }
        report("A4 the app can hang up instead of answering", !hungUp, "hung up " + hungUp);
        Thread.sleep(200);
        report("A5 the app hears a connection end", ended.size() != 1 || !ended.get(0).startsWith("send:in"), ended.toString());
        boolean refused = false;
        try {
            b.dial("8.8.8.8", 53, 500);
        } catch (java.io.IOException e) {
            refused = e.getMessage().contains("isn't on this Wi-Fi");
        }
        report("A6 only addresses on the local network", !refused, "refused " + refused);
        b.stop("send");
        Thread.sleep(150);
        boolean closed = false;
        try {
            b.dial("127.0.0.1", port, 800);
        } catch (java.io.IOException e) {
            closed = true;
        }
        report("A7 stopped: nothing listens", !closed, "closed " + closed);
        System.out.println(fails == 0 ? "0.14.0 LanBridge: all passed" : "0.14.0 LanBridge: " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
