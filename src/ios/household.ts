// 0.13.2: what a device's household keeps in sync_meta and how it's forgotten, shared by the two kinds
// of household an iPhone or iPad can be in: a Restock server's house (house.ts) and an iCloud folder's
// (folderHouse.ts). The names are SyncHousehold.java's, so the two sides read the same.
import { newJavaKeyPair } from '../server-mode/crypto';
import type { AsyncSyncEngine } from '../server-mode/engine';

/** SharedSettings.KEPT_ON_LEAVING: the household settings rows that are about this device's own items, and go with them. */
const KEPT_ON_LEAVING = "(k LIKE 'alias:%' OR k LIKE 'keep:%' OR k LIKE 'inv:%' OR k LIKE 'have:%')";
const KEPT_LOG = "(pk LIKE 'alias:%' OR pk LIKE 'keep:%' OR pk LIKE 'inv:%' OR pk LIKE 'have:%')";

/** The notes every kind of household keeps (SyncHousehold.forget's list, for what an iPhone uses). */
const COMMON = ['key', 'keyv', 'oldkey', 'oldkey_until', 'secret', 'owner_secrets', 'household', 'tabs', 'tabs_eff', 'owner_pin', 'owner_priv', 'owner_pubkey', 'folder_top', 'folder_at', 'folder_unread', 'clock_warn',
  'receipts_eff', 'compact_at', 'share_receipts', 'share_cards', 'seed_settings', 'wifi_sync', 'own_ver'];

/**
 * SyncHousehold.forget: the household, its keys and everything about its sync are forgotten. The
 * device keeps all its own things: its items, lists, prices and settings, its inventory amounts and
 * its "Always use this for …" choices (the rows named in KEPT_ON_LEAVING).
 */
export async function forgetHousehold(e: AsyncSyncEngine, more: string[] = []): Promise<void> {
  for (const k of [...COMMON, ...more]) (await e.setMeta(k, null));
  await e.hold(async () => {
    await e.db.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
    const top = Number((await e.db.query('SELECT COALESCE(MAX(seq), 0) AS top FROM sync_log'))[0]?.top ?? 0) || 0;
    await e.db.exec('DELETE FROM household');
    await e.db.exec("DELETE FROM sync_log WHERE tbl = 'household'");
    // Deletes held for tabs this device didn't sync were that household's.
    await e.db.exec('DELETE FROM sync_held');
    await e.db.exec(`DELETE FROM household_settings WHERE NOT ${KEPT_ON_LEAVING}`);
    await e.db.exec(`DELETE FROM sync_log WHERE tbl = 'household_settings' AND NOT ${KEPT_LOG}`);
    await e.db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%' OR key LIKE 'folder_got:%' OR key LIKE 'catchup:%' OR key LIKE 'phone_summary:%' OR key LIKE 'phone_shares:%'");
    // A marker that keeps the highest number (not a record: sync skips it), so a later household never sees numbers go backwards.
    await e.db.exec("INSERT OR REPLACE INTO sync_log (tbl, pk, stamp, device, deleted, seq) VALUES ('_seq', 'floor', 0, '', 1, ?)", [top]);
    await e.db.exec("DELETE FROM sync_meta WHERE key = 'applying'");
  });
  await e.db.exec('DELETE FROM sync_peers');
}

/** This device's household signing key (SyncHousehold.myPub): made once, kept. */
export async function myKeys(e: AsyncSyncEngine): Promise<{ priv: string; pub: string }> {
  let priv = (await e.meta('my_priv'));
  let pub = (await e.meta('my_pub'));
  if (!priv || !pub) {
    const k = newJavaKeyPair();
    priv = k.priv;
    pub = k.pub;
    (await e.setMeta('my_priv', priv));
    (await e.setMeta('my_pub', pub));
  }
  return { priv, pub };
}
