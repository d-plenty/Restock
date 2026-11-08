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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
 * No Android classes here, so it's tested on a computer too.
 */
final class SyncWire {
    static final int PORT = 47461;
    private static final int MAX = 32 * 1024 * 1024;
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
        int n = in.readInt();
        if (n < 0 || n > MAX) throw new IOException("message too big");
        byte[] b = new byte[n];
        in.readFully(b);
        return b;
    }

    // ---------- asking another phone ----------

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
            if (res.has("error")) throw new IOException("the other phone said: " + res.optString("error"));
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

    /** What the server does with each message it can open. */
    interface Handler {
        JSONObject handle(JSONObject message, String fromHost) throws Exception;

        /** Called after a connection ends, when something was taken in. */
        default void done(String fromHost) {}
    }

    /** Listens for other phones in the household. */
    static final class Server {
        private final byte[] key;
        private final Handler handler;
        private final ServerSocket socket;
        private final ExecutorService pool = Executors.newFixedThreadPool(2);
        private volatile boolean running = true;

        Server(byte[] key, Handler handler) throws IOException {
            this.key = key;
            this.handler = handler;
            ServerSocket s;
            try {
                s = new ServerSocket(PORT);
            } catch (IOException taken) {
                s = new ServerSocket(0); // any free port; other phones find it by discovery
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
                    pool.execute(() -> serve(c));
                } catch (SocketException closed) {
                    return;
                } catch (IOException e) {
                    if (!running) return;
                }
            }
        }

        private void serve(Socket c) {
            String host = c.getInetAddress().getHostAddress();
            try (Socket s = c) {
                s.setSoTimeout(60_000);
                DataInputStream in = new DataInputStream(s.getInputStream());
                DataOutputStream out = new DataOutputStream(s.getOutputStream());
                while (running) {
                    byte[] sealed;
                    try {
                        sealed = read(in);
                    } catch (IOException end) {
                        break;
                    }
                    JSONObject msg;
                    try {
                        msg = open(key, sealed);
                    } catch (Exception wrongKey) {
                        break; // not one of ours: say nothing and hang up
                    }
                    JSONObject res;
                    try {
                        res = handler.handle(msg, host);
                    } catch (Exception e) {
                        res = new JSONObject();
                        res.put("error", String.valueOf(e.getMessage()));
                    }
                    write(out, seal(key, res));
                }
            } catch (Exception ignored) {
                // the other phone went away; it carries on next time
            } finally {
                handler.done(host);
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
