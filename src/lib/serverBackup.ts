// 0.18.4: this phone's backup on the household's Restock server, so a lost or broken phone can be put
// back on a new one: its settings, look, shops, every tab, cards and receipts (not the photos).
//
// Once a day, while Restock is open, the phone makes the same file Export data makes and seals it to
// the household's backup key (server-mode/crypto.ts sealPhoneBackup): a key whose private half only
// opens with the server's passphrase, so the server can't read the backups. Phone backups are turned
// on once, with the passphrase (Server admin, or the server's web page); until then nothing goes up.
//
// Putting one back: an admin makes an Add a phone code that replaces the lost phone; the new phone
// joins with it, says the server's passphrase, and gets everything back (restoreFromServer). The lost
// phone is then taken off the server. The web page can also download any phone's backup.
import { backupJson, EVERYTHING, readBackup, restoreBackup, type ExportParts } from './backup';
import { getKV, putKV } from './db';
import { RestockNative } from './sql/native';
import { syncInfo } from './sync';
import { base64ToBytes, bytesToBase64 } from './base64';
import { derivePassphrase, newBackupKey, openBackupKey, openPhoneBackup, sealPhoneBackup, unb64 } from '../server-mode/crypto';
import { SECTIONS } from '../shops';

const KV = 'serverBackup';
/** A day between backups (a little early is fine: once a day, whenever Restock is opened). */
const EVERY_MS = 20 * 3_600_000;

export interface ServerBackupState {
  /** Off when this phone was told not to keep one. On unless turned off. */
  on: boolean;
  /** When the last one went up, and how big it was. */
  at?: string;
  size?: number;
  /** Why the last try didn't (in words), or 'no-key' while phone backups aren't turned on for the server. */
  problem?: string;
}

export async function serverBackupState(): Promise<ServerBackupState> {
  const s = await getKV<Partial<ServerBackupState>>(KV).catch(() => undefined);
  return { on: s?.on !== false, ...(s?.at ? { at: s.at } : {}), ...(s?.size ? { size: s.size } : {}), ...(s?.problem ? { problem: s.problem } : {}) };
}
const save = async (s: ServerBackupState) => putKV(KV, s).catch(() => undefined);

export async function setServerBackupOn(on: boolean): Promise<void> {
  await save({ ...(await serverBackupState()), on });
}

/** What goes in: everything Export data has, less the receipt photos (they'd make it huge). */
export const SERVER_BACKUP_PARTS: ExportParts = { ...EVERYTHING, receiptPhotos: false, serverPhotos: false, giftCards: true };

async function onServer(): Promise<{ device: string; label?: string } | undefined> {
  const info = await syncInfo().catch(() => undefined);
  if (!info?.server || info.serverApi !== 3 || !info.device) return undefined;
  return { device: info.device, label: info.serverMemberLabel ?? undefined };
}

let running = false;

/** Sends this phone's backup up if one is due (or now, with force). Answers the state afterwards. */
export async function maybeServerBackup(force = false): Promise<ServerBackupState> {
  const st = await serverBackupState();
  if (running || (!st.on && !force)) return st;
  if (!force && st.at && Date.now() - Date.parse(st.at) < EVERY_MS && !st.problem) return st;
  const here = await onServer();
  if (!here) return st;
  running = true;
  try {
    const key = (await RestockNative.serverPhone({ method: 'GET', path: '/backupkey' })) as { pub?: string };
    if (typeof key.pub !== 'string') {
      const next = { ...st, problem: 'no-key' };
      await save(next);
      return next;
    }
    const json = await backupJson(SERVER_BACKUP_PARTS);
    const sealed = sealPhoneBackup(key.pub, { format: 'restock-phone-backup', v: 1, device: here.device, ...(here.label ? { label: here.label } : {}), at: new Date().toISOString(), json });
    const r = await RestockNative.serverBackupPut({ data: bytesToBase64(sealed) });
    const next: ServerBackupState = { on: st.on, at: new Date().toISOString(), size: r.size ?? sealed.length };
    await save(next);
    return next;
  } catch (e) {
    const next = { ...st, problem: e instanceof Error ? e.message : String(e) };
    await save(next);
    return next;
  } finally {
    running = false;
  }
}

/** Turning phone backups on for the whole server, from an admin phone (with the passphrase): makes the key. */
export async function turnOnBackups(passphrase: string): Promise<void> {
  const ch = (await RestockNative.serverAdmin({ method: 'GET', path: '/confirm/challenge' })) as { salt: string };
  const keys = await derivePassphrase(passphrase, unb64(ch.salt));
  const k = newBackupKey(keys.vault);
  keys.auth.fill(0);
  keys.vault.fill(0);
  // The passphrase proved over this phone's id, as for any risky change (serverAdmin.proveFor).
  const { proveFor } = await import('./serverAdmin');
  await RestockNative.serverAdmin({ method: 'PUT', path: '/backupkey', body: { ...k, confirm: await proveFor(passphrase) } });
  await maybeServerBackup(true);
}

// ---------- putting a lost phone's backup on this one ----------

export interface RestoreOffer {
  /** The lost phone's id and name, and its backup (when and how big), if it kept one. */
  from: string;
  label: string | null;
  backup: { at: string | null; size: number } | null;
  key?: { pub: string; sealed: string; salt: string | null };
}

/** After joining with a code that replaces a lost phone: what there is to put back (or undefined). */
export async function restoreOffer(): Promise<RestoreOffer | undefined> {
  const r = (await RestockNative.serverPhone({ method: 'GET', path: '/restore' }).catch(() => ({}))) as Partial<RestoreOffer>;
  return typeof r.from === 'string' ? (r as RestoreOffer) : undefined;
}

/**
 * Puts it back: the server's passphrase opens the backup key, the backup comes down and opens, and its
 * settings, look, shops, cards and receipts replace this phone's; the items, categories and prices are
 * added alongside what the household's sync already brought (the same names aren't added twice). The
 * shopping list comes from the household as it is now, not from the backup. Then the lost phone is
 * taken off the server.
 */
export async function restoreFromServer(offer: RestoreOffer, passphrase: string): Promise<void> {
  if (!offer.backup) throw new Error(`${offer.label ?? 'That phone'} didn't keep a backup on the server.`);
  if (!offer.key?.sealed || !offer.key.salt) throw new Error("Phone backups aren't on for this server.");
  const keys = await derivePassphrase(passphrase, unb64(offer.key.salt));
  let priv: Uint8Array;
  try {
    priv = openBackupKey(keys.vault, offer.key.sealed);
  } finally {
    keys.auth.fill(0);
    keys.vault.fill(0);
  }
  const got = await RestockNative.serverBackupGet({ device: offer.from });
  if (!got.data) throw new Error(`${offer.label ?? 'That phone'}'s backup isn't on the server any more.`);
  const b = openPhoneBackup(priv, base64ToBytes(got.data));
  priv.fill(0);
  const summary = readBackup(b.json);
  await restoreBackup(summary, { pantry: false, list: false, cards: true, settings: true, shops: true, receipts: true });
  await restoreBackup(summary, { pantry: true, sections: SECTIONS, list: false, cards: false, settings: false }, { add: true });
  await RestockNative.serverPhone({ method: 'POST', path: '/restore', body: {} });
  // Taking the lost phone off gave the household a new key: a sync now takes it (and sends what came back).
  await RestockNative.syncNow().catch(() => undefined);
}

/** Not putting it back: this phone carries on as itself (the lost one stays on the server until removed). */
export async function skipRestore(): Promise<void> {
  await RestockNative.serverPhone({ method: 'POST', path: '/restore', body: { skip: true } });
}
