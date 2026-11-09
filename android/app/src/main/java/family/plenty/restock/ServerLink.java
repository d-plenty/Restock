package family.plenty.restock;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/**
 * 0.9.2: the phone's side of handing keys to a browser (docs/server-protocol.md):
 *
 * - The web page's codes: restock-link:2?u=ORIGIN&s=ID&k=KEY ("Let this browser see your household?")
 *   and restock-login:2?… ("Sign in to Restock on …?"). k is the browser's ECDH P-256 public key, so
 *   the server in the middle can't swap in its own.
 * - Sealing for a browser: a fresh ECDH P-256 key on the phone, HKDF-SHA256 of the shared secret (no
 *   salt, info "restock-link-v2") gives an AES-256-GCM key. Posted as { pub, sealed }, or written as
 *   webkeys/<webId>.bin: "RSE2" + pub (SPKI) + nonce + sealed.
 * - The phone's own signing key for the server (ECDSA P-256), kept in sync_meta sealed by SyncKeystore.
 *
 * Public keys are SPKI (Java's getEncoded(), 91 bytes); a raw 65-byte point is taken too. Bytes are
 * base64url without padding; reading takes plain base64 as well.
 *
 * No Android classes here, so it's tested on a computer too (tools/sync-test).
 */
final class ServerLink {
    static final String INFO = "restock-link-v2";
    static final byte[] RSE2 = "RSE2".getBytes(StandardCharsets.US_ASCII);
    private static final SecureRandom RANDOM = new SecureRandom();
    /** The DER start of a P-256 SubjectPublicKeyInfo, before the 65-byte point. */
    private static final byte[] SPKI_P256 = {
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, (byte) 0x86, 0x48, (byte) 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, (byte) 0x86, 0x48, (byte) 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00 };
    static final int SPKI_LENGTH = SPKI_P256.length + 65;

    private ServerLink() {}

    // ---------- bytes ----------

    static String b64u(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** base64url or plain base64, with or without padding. */
    static byte[] unb64(String s) {
        String t = s.trim().replace('+', '-').replace('/', '_');
        while (t.endsWith("=")) t = t.substring(0, t.length() - 1);
        return Base64.getUrlDecoder().decode(t);
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    static byte[] sha256(byte[] b) throws Exception {
        return java.security.MessageDigest.getInstance("SHA-256").digest(b);
    }

    // ---------- keys ----------

    static KeyPair newKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
        return g.generateKeyPair();
    }

    static PrivateKey privateKey(String pkcs8) throws Exception {
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(unb64(pkcs8)));
    }

    /** A P-256 public key from SPKI (91 bytes) or a raw uncompressed point (65 bytes). */
    static PublicKey publicKey(byte[] b) throws Exception {
        byte[] spki = b;
        if (b.length == 65 && b[0] == 0x04) {
            spki = new byte[SPKI_LENGTH];
            System.arraycopy(SPKI_P256, 0, spki, 0, SPKI_P256.length);
            System.arraycopy(b, 0, spki, SPKI_P256.length, 65);
        } else if (b.length != SPKI_LENGTH || !startsWith(b, SPKI_P256)) {
            throw new IllegalArgumentException("not a P-256 public key");
        }
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
    }

    private static boolean startsWith(byte[] b, byte[] magic) {
        if (b.length < magic.length) return false;
        for (int i = 0; i < magic.length; i++) if (b[i] != magic[i]) return false;
        return true;
    }

    /** HKDF-SHA256 (RFC 5869) with no salt. */
    static byte[] hkdf(byte[] ikm, String info, int length) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(new byte[32], "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] t = new byte[0];
        for (int i = 1; out.size() < length; i++) {
            mac.update(t);
            mac.update(info.getBytes(StandardCharsets.UTF_8));
            mac.update((byte) i);
            t = mac.doFinal();
            out.write(t);
        }
        byte[] okm = new byte[length];
        System.arraycopy(out.toByteArray(), 0, okm, 0, length);
        return okm;
    }

    /** The AES key between a private key and the other side's public key. */
    static byte[] linkKey(PrivateKey mine, PublicKey theirs) throws Exception {
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(mine);
        ka.doPhase(theirs, true);
        return hkdf(ka.generateSecret(), INFO, 32);
    }

    /** nonce (12) + AES-256-GCM(key, JSON), no associated data. */
    static byte[] sealWith(byte[] key, JSONObject message) throws Exception {
        byte[] nonce = new byte[12];
        RANDOM.nextBytes(nonce);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        byte[] body = c.doFinal(message.toString().getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[12 + body.length];
        System.arraycopy(nonce, 0, out, 0, 12);
        System.arraycopy(body, 0, out, 12, body.length);
        return out;
    }

    static JSONObject openWith(byte[] key, byte[] sealed) throws Exception {
        if (sealed.length < 12 + 16) throw new SecurityException("too short");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, sealed, 0, 12));
        return new JSONObject(new String(c.doFinal(sealed, 12, sealed.length - 12), StandardCharsets.UTF_8));
    }

    /** What the phone posts for a link or a QR sign-in: { pub, sealed }, for the browser's key. */
    static JSONObject sealFor(PublicKey browser, JSONObject gift) throws Exception {
        KeyPair eph = newKey();
        JSONObject out = new JSONObject();
        out.put("pub", b64u(eph.getPublic().getEncoded()));
        out.put("sealed", b64u(sealWith(linkKey(eph.getPrivate(), browser), gift)));
        return out;
    }

    /** webkeys/<webId>.bin: "RSE2" + a fresh public key (SPKI) + nonce + sealed JSON. */
    static byte[] sealWebKeys(PublicKey web, JSONObject gift) throws Exception {
        KeyPair eph = newKey();
        byte[] pub = eph.getPublic().getEncoded();
        byte[] sealed = sealWith(linkKey(eph.getPrivate(), web), gift);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(RSE2);
        out.write(pub);
        out.write(sealed);
        return out.toByteArray();
    }

    /** Tests: what a browser does with a webkeys file. */
    static JSONObject openWebKeys(PrivateKey web, byte[] file) throws Exception {
        if (file.length < 4 + SPKI_LENGTH + 28 || !startsWith(file, RSE2)) throw new SecurityException("not a webkeys file");
        byte[] pub = java.util.Arrays.copyOfRange(file, 4, 4 + SPKI_LENGTH);
        return openWith(linkKey(web, publicKey(pub)), java.util.Arrays.copyOfRange(file, 4 + SPKI_LENGTH, file.length));
    }

    // ---------- the web page's codes ----------

    /** A scanned web page code. */
    static final class Code {
        /** "link" (let this browser see the household) or "login" (sign in to Restock there). */
        String kind;
        String origin;
        String host;
        String id;
        PublicKey browser;
    }

    static final String LINK_PREFIX = "restock-link:2?";
    static final String LOGIN_PREFIX = "restock-login:2?";

    @SuppressWarnings("CharsetObjectCanBeUsed") // URLDecoder.decode(String, Charset) is Android 13+
    static String decode(String v) {
        try {
            return URLDecoder.decode(v, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    /** A web page's link or sign-in code, or an IllegalArgumentException saying what's wrong with it. */
    static Code parse(String text) {
        String t = text == null ? "" : text.trim();
        Code c = new Code();
        String rest;
        if (t.regionMatches(true, 0, LINK_PREFIX, 0, LINK_PREFIX.length())) {
            c.kind = "link";
            rest = t.substring(LINK_PREFIX.length());
        } else if (t.regionMatches(true, 0, LOGIN_PREFIX, 0, LOGIN_PREFIX.length())) {
            c.kind = "login";
            rest = t.substring(LOGIN_PREFIX.length());
        } else {
            throw new IllegalArgumentException("That isn't a code from your Restock server's web page.");
        }
        String k = null;
        for (String part : rest.split("&")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String name = part.substring(0, eq);
            String v = decode(part.substring(eq + 1));
            if (name.equals("u")) c.origin = v;
            else if (name.equals("s")) c.id = v;
            else if (name.equals("k")) k = v;
        }
        if (c.id == null || !c.id.matches("[A-Za-z0-9_-]{8,128}") || k == null || c.origin == null)
            throw new IllegalArgumentException("That code is damaged. Refresh the web page and scan it again.");
        try {
            URI u = Net.strictUri(c.origin);
            if (u == null || u.getHost() == null) throw new IllegalArgumentException();
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) throw new IllegalArgumentException();
            c.host = u.getHost().toLowerCase(Locale.ROOT).replace("[", "").replace("]", "");
            c.browser = publicKey(unb64(k));
        } catch (Exception e) {
            throw new IllegalArgumentException("That code is damaged. Refresh the web page and scan it again.");
        }
        return c;
    }

    /** The host of a server address ("http://192.168.1.10:8787" → "192.168.1.10"), lower case, or null. */
    static String hostOf(String address) {
        try {
            URI u = Net.strictUri(address);
            return u == null || u.getHost() == null ? null : u.getHost().toLowerCase(Locale.ROOT).replace("[", "").replace("]", "");
        } catch (Exception e) {
            return null;
        }
    }
}
