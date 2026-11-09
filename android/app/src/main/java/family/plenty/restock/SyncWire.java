package family.plenty.restock;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/**
 * How two phones talk on the same Wi-Fi (0.8.0): a plain TCP connection carrying messages
 * sealed with the household's key (AES-256-GCM). A phone that doesn't have the key can't read
 * the messages or send any that will be accepted, so only paired phones can sync.
 *
 * Each message: 4 bytes of length, then 12 bytes of random nonce and the sealed JSON.
 *
 * 0.9.0: the listener only takes a small first message (until one of the household's keys opens
 * it, nothing big is read), gives each message a deadline, keeps a few connections at a time (two
 * per address), only answers addresses on the local network, and never lets one bad connection
 * stop it. The household's public tag changes every day (dayTag), so a phone can't be followed
 * from place to place by it.
 *
 * 0.9.1: the listener can be tied to one address (the phone's address on the Wi-Fi), so it can't
 * be reached through mobile data or a VPN; SyncHub only listens while on Wi-Fi or Ethernet. A
 * "photo" message's answer can be a receipt photo (up to 8 MB, about 11 MB once encoded), well
 * inside MAX.
 *
 * No Android classes here, so it's tested on a computer too.
 */
final class SyncWire {
    static final int PORT = 47461;
    private static final int MAX = 32 * 1024 * 1024;
    /** Before a key has opened anything on a connection, messages can't be bigger than this. */
    private static final int FIRST_MAX = 256 * 1024;
    /** How long one message may take to arrive. */
    private static final int MESSAGE_MS = 20_000;
    private static final SecureRandom RANDOM = new SecureRandom();

    private SyncWire() {}

    // ---------- the household key ----------

    static byte[] newKey() {
        byte[] k = new byte[32];
        RANDOM.nextBytes(k);
        return k;
    }

    static String encodeKey(byte[] k) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(k);
    }

    static byte[] decodeKey(String s) {
        byte[] k = Base64.getUrlDecoder().decode(s);
        if (k.length != 32) throw new IllegalArgumentException("bad key");
        return k;
    }

    private static final String B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /** The key as capitals and digits (RFC 4648 base32, no padding), for a compact QR code. */
    static String base32(byte[] b) {
        StringBuilder sb = new StringBuilder();
        int buffer = 0;
        int bits = 0;
        for (byte x : b) {
            buffer = (buffer << 8) | (x & 0xff);
            bits += 8;
            while (bits >= 5) {
                sb.append(B32.charAt((buffer >> (bits - 5)) & 31));
                bits -= 5;
            }
        }
        if (bits > 0) sb.append(B32.charAt((buffer << (5 - bits)) & 31));
        return sb.toString();
    }

    static byte[] unbase32(String s) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int buffer = 0;
        int bits = 0;
        for (char ch : s.trim().toUpperCase(java.util.Locale.ROOT).toCharArray()) {
            int v = B32.indexOf(ch);
            if (v < 0) throw new IllegalArgumentException("That code is damaged. Scan it again.");
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8) {
                out.write((buffer >> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return out.toByteArray();
    }

    /**
     * 0.9.0: the household's public tag for one day (UTC), from the key, so phones on the same
     * Wi-Fi find each other but someone watching can't follow a phone from day to day.
     * `dayOffset`: 0 today, -1 yesterday, 1 tomorrow (phones either side of midnight).
     */
    static String dayTag(byte[] key, int dayOffset) {
        try {
            long day = Math.floorDiv(System.currentTimeMillis(), 86_400_000L) + dayOffset;
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] h = mac.doFinal(("restock-tag|" + day).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", h[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** A short, public name for the household, so phones can find each other without showing the key. */
    static String householdId(byte[] key) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(concat("restock-household".getBytes(StandardCharsets.UTF_8), key));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", h[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    static byte[] seal(byte[] key, JSONObject message) throws Exception {
        byte[] nonce = new byte[12];
        RANDOM.nextBytes(nonce);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        byte[] body = c.doFinal(message.toString().getBytes(StandardCharsets.UTF_8));
        return concat(nonce, body);
    }

    /** Opens a sealed message; throws if it wasn't sealed with this key. */
    static JSONObject open(byte[] key, byte[] sealed) throws Exception {
        if (sealed.length < 28) throw new SecurityException("too short");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, sealed, 0, 12));
        byte[] body = c.doFinal(sealed, 12, sealed.length - 12);
        return new JSONObject(new String(body, StandardCharsets.UTF_8));
    }

    private static void write(DataOutputStream out, byte[] b) throws IOException {
        out.writeInt(b.length);
        out.write(b);
        out.flush();
    }

    private static byte[] read(DataInputStream in) throws IOException {
        return read(in, MAX, 0);
    }

    /** One message, at most `max` bytes, arriving by `deadline` (System.nanoTime; 0: no deadline). */
    private static byte[] read(DataInputStream in, int max, long deadline) throws IOException {
        int n = in.readInt();
        if (n < 0 || n > max) throw new IOException("message too big");
        byte[] b = new byte[n];
        int off = 0;
        while (off < n) {
            if (deadline != 0 && System.nanoTime() > deadline) throw new IOException("too slow");
            int r = in.read(b, off, Math.min(n - off, 65536));
            if (r < 0) throw new IOException("ended early");
            off += r;
        }
        return b;
    }

    /** Is this address on a local network (home Wi-Fi), not the internet or a mobile network? */
    static boolean local(java.net.InetAddress a) {
        if (a == null) return false;
        if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress()) return true;
        byte[] b = a.getAddress();
        // IPv6 unique local addresses (fc00::/7), which home routers hand out too.
        return b.length == 16 && (b[0] & 0xfe) == 0xfc;
    }

    // ---------- asking another phone ----------

    /** 0.9.0: the other phone answered, but said no (a used code, a full household): its words. */
    static final class Refused extends IOException {
        Refused(String why) {
            super(why);
        }
    }

    /** A connection to another phone, one message at a time. Close it when done. */
    static final class Client implements SyncEngine.Transport, AutoCloseable {
        private final byte[] key;
        private final Socket socket;
        private final DataInputStream in;
        private final DataOutputStream out;

        Client(byte[] key, String host, int port, int timeoutMs) throws IOException {
            this.key = key;
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(60_000);
            in = new DataInputStream(socket.getInputStream());
            out = new DataOutputStream(socket.getOutputStream());
        }

        @Override
        public JSONObject send(JSONObject message) throws Exception {
            write(out, seal(key, message));
            JSONObject res = open(key, read(in));
            if (res.has("error")) throw new Refused(res.optString("error"));
            return res;
        }

        @Override
        public void close() {
            try {
                socket.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }

    // ---------- answering other phones ----------

    /**
     * The keys the server accepts, in order (0.8.2): the household's key, the one before it (on
     * the owner, so phones that missed a change can be given the new one) and a one-time pairing
     * key while an invite is open. Missing ones are null.
     */
    interface Keys {
        List<byte[]> keys();
    }

    /** What the server does with each message it can open; `which` says which key opened it. */
    interface Handler {
        JSONObject handle(JSONObject message, String fromHost, int which) throws Exception;

        /** Called after a connection ends, when something was taken in. */
        default void done(String fromHost) {}
    }

    /** Listens for other phones in the household. */
    static final class Server {
        private final Keys keys;
        private final Handler handler;
        private final ServerSocket socket;
        /** A few connections at a time; more wait briefly in line, and past that they're closed. */
        private final java.util.concurrent.ThreadPoolExecutor pool = new java.util.concurrent.ThreadPoolExecutor(
            3, 3, 30, java.util.concurrent.TimeUnit.SECONDS, new java.util.concurrent.ArrayBlockingQueue<>(6));
        private final java.util.Map<String, Integer> perAddress = new java.util.HashMap<>();
        private volatile boolean running = true;

        Server(Keys keys, Handler handler) throws IOException {
            this(keys, handler, null);
        }

        /** 0.9.1: `bind`: listen only on this address (null: every address). */
        Server(Keys keys, Handler handler, java.net.InetAddress bind) throws IOException {
            this.keys = keys;
            this.handler = handler;
            ServerSocket s;
            try {
                s = new ServerSocket(PORT, 50, bind);
            } catch (IOException taken) {
                s = new ServerSocket(0, 50, bind); // any free port; other phones find it by discovery
            }
            socket = s;
            Thread t = new Thread(this::loop, "restock-sync-server");
            t.setDaemon(true);
            t.start();
        }

        int port() {
            return socket.getLocalPort();
        }

        private void loop() {
            while (running) {
                try {
                    final Socket c = socket.accept();
                    String host = c.getInetAddress() == null ? "" : c.getInetAddress().getHostAddress();
                    // Only phones on the local network, and at most two connections from each.
                    boolean ok = local(c.getInetAddress()) && local(c.getLocalAddress());
                    synchronized (perAddress) {
                        int n = perAddress.getOrDefault(host, 0);
                        if (ok && n < 2) perAddress.put(host, n + 1);
                        else ok = false;
                    }
                    if (!ok) {
                        closeQuietly(c);
                        continue;
                    }
                    try {
                        pool.execute(() -> {
                            try {
                                serve(c);
                            } finally {
                                synchronized (perAddress) {
                                    int n = perAddress.getOrDefault(host, 1) - 1;
                                    if (n <= 0) perAddress.remove(host);
                                    else perAddress.put(host, n);
                                }
                            }
                        });
                    } catch (java.util.concurrent.RejectedExecutionException busy) {
                        synchronized (perAddress) {
                            int n = perAddress.getOrDefault(host, 1) - 1;
                            if (n <= 0) perAddress.remove(host);
                            else perAddress.put(host, n);
                        }
                        closeQuietly(c);
                    }
                } catch (SocketException closed) {
                    return;
                } catch (Throwable e) {
                    if (!running) return;
                }
            }
        }

        private static void closeQuietly(Socket c) {
            try {
                c.close();
            } catch (IOException ignored) {
                // closed
            }
        }

        private void serve(Socket c) {
            String host = c.getInetAddress().getHostAddress();
            try (Socket s = c) {
                s.setSoTimeout(MESSAGE_MS);
                DataInputStream in = new DataInputStream(s.getInputStream());
                DataOutputStream out = new DataOutputStream(s.getOutputStream());
                byte[] key = null;
                int which = -1;
                while (running) {
                    byte[] sealed;
                    try {
                        // Small until a key has opened something; each message has a deadline.
                        sealed = read(in, key == null ? FIRST_MAX : MAX, System.nanoTime() + MESSAGE_MS * 1_000_000L);
                    } catch (IOException end) {
                        break;
                    }
                    JSONObject msg = null;
                    if (key == null) {
                        // The first message decides which key this connection uses.
                        List<byte[]> list = keys.keys();
                        for (int i = 0; i < list.size() && msg == null; i++) {
                            byte[] k = list.get(i);
                            if (k == null) continue;
                            try {
                                msg = open(k, sealed);
                                key = k;
                                which = i;
                            } catch (Exception notThisOne) {
                                // try the next
                            }
                        }
                    } else {
                        try {
                            msg = open(key, sealed);
                        } catch (Exception e) {
                            msg = null;
                        }
                    }
                    if (msg == null) break; // not one of ours: say nothing and hang up
                    JSONObject res;
                    try {
                        res = handler.handle(msg, host, which);
                    } catch (Exception e) {
                        res = new JSONObject();
                        res.put("error", String.valueOf(e.getMessage()));
                    }
                    write(out, seal(key, res));
                }
            } catch (Throwable ignored) {
                // the other phone went away (or sent something odd); it carries on next time
            } finally {
                try {
                    handler.done(host);
                } catch (Throwable ignored) {
                    // never stop listening over one connection
                }
            }
        }

        void stop() {
            running = false;
            try {
                socket.close();
            } catch (IOException ignored) {
                // closed
            }
            pool.shutdownNow();
        }
    }
}
