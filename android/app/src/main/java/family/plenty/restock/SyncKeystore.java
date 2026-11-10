package family.plenty.restock;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 0.9.1: the household's keys, the phones' secrets, the signing keys, the recovery key and the
 * WebDAV or Nextcloud password are kept in sync_meta sealed with an AES-256-GCM key that lives in
 * Android's key store ("restock-sync"). That key never leaves the phone (on most phones it's held
 * in the phone's secure hardware), so a copy of Restock's database alone opens nothing.
 *
 * Stored as "ks1:" + base64(iv | sealed). A value without "ks1:" is an old plain one (0.9.0);
 * SyncEngine seals it the first time it's read. If the key store's key is gone (Restock's data
 * was copied onto another phone, or Android's key store was reset), open() throws and the phone
 * counts as not in a household: SyncHub forgets it and says to join again. Any other key store
 * problem (busy, say) is only passing: it's thrown as it is, and nothing is forgotten.
 */
final class SyncKeystore implements SyncEngine.Secrets {
    static final String ALIAS = "restock-sync";
    static final String PREFIX = "ks1:";
    private static final int IV = 12;
    private SecretKey key;
    /** The key store's name for the key (0.9.3: Home Assistant's token has a key of its own, "restock-ha"). */
    private final String alias;

    SyncKeystore() {
        this(ALIAS);
    }

    SyncKeystore(String alias) {
        this.alias = alias;
    }

    private static KeyStore store() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    /** The key store's key, made if it isn't there and `make`. Null if it isn't there. */
    private synchronized SecretKey key(boolean make) throws Exception {
        if (key != null) return key;
        KeyStore ks = store();
        if (ks.containsAlias(alias)) {
            KeyStore.Entry e = ks.getEntry(alias, null);
            if (e instanceof KeyStore.SecretKeyEntry) return key = ((KeyStore.SecretKeyEntry) e).getSecretKey();
        }
        if (!make) return null;
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return key = g.generateKey();
    }

    @Override
    public String seal(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key(true));
        byte[] iv = c.getIV();
        byte[] body = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + body.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(body, 0, out, iv.length, body.length);
        return PREFIX + Base64.encodeToString(out, Base64.NO_WRAP);
    }

    @Override
    public String open(String stored) throws Exception {
        if (!stored.startsWith(PREFIX)) return stored;
        SecretKey k = key(false);
        if (k == null) throw new SyncEngine.SecretLost("This phone's sync keys can't be opened.", null);
        byte[] b;
        try {
            b = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
        } catch (IllegalArgumentException bad) {
            throw new SyncEngine.SecretLost("A sync key is damaged.", bad);
        }
        if (b.length < IV + 16) throw new SyncEngine.SecretLost("A sync key is damaged.", null);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, b, 0, IV));
        try {
            return new String(c.doFinal(b, IV, b.length - IV), StandardCharsets.UTF_8);
        } catch (javax.crypto.AEADBadTagException wrongKey) {
            // Sealed with a key store key this phone doesn't have (a new key since).
            throw new SyncEngine.SecretLost("This phone's sync keys can't be opened.", wrongKey);
        }
    }

    @Override
    public boolean sealed(String stored) {
        return stored.startsWith(PREFIX);
    }

    /** Erase everything: the key store's key goes too (a new one is made when it's next needed). */
    synchronized void forgetKey() {
        key = null;
        try {
            KeyStore ks = store();
            if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        } catch (Exception e) {
            android.util.Log.w("RestockSync", "forget key", e);
        }
    }
}
