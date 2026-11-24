package family.plenty.restock;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 0.14.0: plain connections on the Wi-Fi for the app's own screens (Export data → Send to another
 * phone, Import data → From another phone: src/lib/handover.ts). It only carries whole messages, 4
 * bytes of length and then the message, as SyncWire does; what's in a message is sealed by the app
 * before it gets here. The same calls the iPhone app's native side has (RestockLan.swift), so one
 * piece of the app's code talks on both.
 *
 * Only addresses on the local network, never the internet or mobile data. No Android classes here,
 * so it's tested on a computer too.
 */
final class LanBridge {
    /** A message can't be bigger than this (SyncWire's limit). */
    static final int MAX = 32 * 1024 * 1024;
    /** How long the app has to answer a message before the connection is dropped. */
    private static final int ANSWER_MS = 60_000;

    interface Events {
        void message(String key, String conn, String from, byte[] data);

        void ended(String key, String conn);
    }

    private static final byte[] HANG_UP = new byte[0];
    private final Events events;
    private final AtomicInteger counter = new AtomicInteger();
    private final Map<String, Socket> outgoing = new ConcurrentHashMap<>();
    private final Map<String, ServerSocket> listeners = new ConcurrentHashMap<>();
    private final Map<String, LinkedBlockingQueue<byte[]>> answers = new ConcurrentHashMap<>();
    private final Map<String, Socket> incoming = new ConcurrentHashMap<>();
    private final Map<String, String> cameInOn = new ConcurrentHashMap<>();

    LanBridge(Events events) {
        this.events = events;
    }

    private static void write(Socket s, byte[] b) throws IOException {
        DataOutputStream out = new DataOutputStream(s.getOutputStream());
        out.writeInt(b.length);
        out.write(b);
        out.flush();
    }

    private static byte[] read(Socket s) throws IOException {
        DataInputStream in = new DataInputStream(s.getInputStream());
        int n = in.readInt();
        if (n < 0 || n > MAX) throw new IOException("message too big");
        byte[] b = new byte[n];
        in.readFully(b);
        return b;
    }

    private static void closeQuietly(java.io.Closeable c) {
        try {
            if (c != null) c.close();
        } catch (IOException ignored) {
            // closed
        }
    }

    // ---------- asking another phone ----------

    /** Connects to a phone on the local network; answers the connection's name. */
    String dial(String host, int port, int timeoutMs) throws IOException {
        InetAddress a = InetAddress.getByName(host);
        if (!SyncWire.local(a)) throw new IOException("That address isn't on this Wi-Fi.");
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(a, port), Math.max(500, timeoutMs));
            s.setTcpNoDelay(true);
        } catch (IOException e) {
            closeQuietly(s);
            throw e;
        }
        String id = "out" + counter.incrementAndGet();
        outgoing.put(id, s);
        return id;
    }

    /** One message out, its answer back. */
    byte[] ask(String id, byte[] data, int timeoutMs) throws IOException {
        Socket s = outgoing.get(id);
        if (s == null) throw new IOException("That connection has closed.");
        try {
            s.setSoTimeout(Math.max(1000, timeoutMs));
            synchronized (s) {
                write(s, data);
                return read(s);
            }
        } catch (IOException e) {
            close(id);
            throw new IOException("The other phone stopped answering.");
        }
    }

    void close(String id) {
        closeQuietly(outgoing.remove(id));
    }

    // ---------- answering other phones ----------

    /** Starts listening under `key` (once), on `bind` (null: every address); answers the port. */
    synchronized int listen(final String key, InetAddress bind) throws IOException {
        ServerSocket had = listeners.get(key);
        if (had != null && !had.isClosed()) return had.getLocalPort();
        final ServerSocket server = new ServerSocket(0, 10, bind);
        listeners.put(key, server);
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                final Socket c;
                try {
                    c = server.accept();
                } catch (IOException closed) {
                    return;
                }
                // Only phones on the local network, and a few at a time.
                if (!SyncWire.local(c.getInetAddress()) || incoming.size() >= 6) {
                    closeQuietly(c);
                    continue;
                }
                final String conn = "in" + counter.incrementAndGet();
                incoming.put(conn, c);
                cameInOn.put(conn, key);
                answers.put(conn, new LinkedBlockingQueue<>());
                Thread serve = new Thread(() -> serve(key, conn, c), "restock-lan-conn");
                serve.setDaemon(true);
                serve.start();
            }
        }, "restock-lan-listen");
        t.setDaemon(true);
        t.start();
        return server.getLocalPort();
    }

    private void serve(String key, String conn, Socket c) {
        String from = c.getInetAddress() == null ? "" : c.getInetAddress().getHostAddress();
        try {
            c.setSoTimeout(5 * 60_000);
            c.setTcpNoDelay(true);
            LinkedBlockingQueue<byte[]> mine = answers.get(conn);
            while (!c.isClosed() && mine != null) {
                byte[] m = read(c);
                events.message(key, conn, from, m);
                byte[] answer = mine.poll(ANSWER_MS, TimeUnit.MILLISECONDS);
                if (answer == null || answer == HANG_UP) break;
                write(c, answer);
            }
        } catch (Exception gone) {
            // the other phone went away
        } finally {
            closeQuietly(c);
            incoming.remove(conn);
            answers.remove(conn);
            cameInOn.remove(conn);
            events.ended(key, conn);
        }
    }

    /** The app's answer to a message (null: hang up). */
    void reply(String conn, byte[] data) {
        LinkedBlockingQueue<byte[]> q = answers.get(conn);
        if (q != null) q.offer(data == null ? HANG_UP : data);
    }

    synchronized void stop(String key) {
        closeQuietly(listeners.remove(key));
        for (Map.Entry<String, String> e : cameInOn.entrySet()) {
            if (key.equals(e.getValue())) {
                reply(e.getKey(), null);
                closeQuietly(incoming.get(e.getKey()));
            }
        }
    }
}
