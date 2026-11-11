import { getSettings, updateSettings } from './db';
import { backupJson, EVERYTHING, type ExportParts } from './backup';
import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';
import type { Settings } from '../types';

// Automatic backups: a whole backup file saved into a folder the person picked, when Restock is
// opened (or comes back) and the last one is older than they asked for. Android's background
// scheduler can't run the app's code, and opening Restock is frequent enough for a backup that's
// "every few days", so this keeps it simple and always makes exactly the same file as Export.

/** 0.9.6 (review M3): said in the Back up automatically setting. */
export const AUTO_GIFT_NOTE = 'Gift cards are only included when the backup has a password.';

/**
 * 0.9.6 (review M3): what an automatic backup holds. Gift cards (numbers, PINs and photos) only
 * when the backups are locked with a password: the folder is often a cloud drive.
 */
export function autoParts(b: Settings['autoBackup']): ExportParts {
  const password = b.password || undefined;
  return { ...EVERYTHING, receiptPhotos: b.receiptPhotos !== false, serverPhotos: false, password, giftCards: !!password };
}

/**
 * 0.9.11: the folder for automatic backups without asking: Documents/Restock backups, which Restock
 * makes itself (Android 10 and later). Undefined on older Android, where a folder is picked instead.
 */
export async function defaultBackupFolder(): Promise<{ uri: string; name: string } | undefined> {
  if (!isNative()) return undefined;
  try {
    const d = await RestockNative.backupDocuments();
    return d.available ? { uri: d.uri, name: d.name } : undefined;
  } catch {
    return undefined; // an older app build
  }
}

export const BACKUP_EVERY = [1, 3, 7, 14, 30];
export const BACKUP_KEEP = [3, 4, 5, 10, 20]; // 0.9.3: 4, for "weekly, kept for 4 weeks"
export const everyLabel = (d: number) =>
  d === 1 ? 'Every day' : d === 7 ? 'Every week' : d === 14 ? 'Every fortnight' : d === 30 ? 'Every month' : `Every ${d} days`;

export function backupDue(s: Settings, now = Date.now()): boolean {
  const b = s.autoBackup;
  if (!b.enabled || !b.folder) return false;
  if (!b.lastAt) return true;
  // A little early is fine: "every day" shouldn't skip a day because it ran at 9 am yesterday and it's 8 am now.
  return now - Date.parse(b.lastAt) >= b.everyDays * 86_400_000 - 3 * 3_600_000;
}

/** "restock-auto-2026-11-07-0915.json": sorts by date, so the oldest are easy to find and remove. */
export function autoName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `restock-auto-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

let running = false;

/** Saves a backup if one is due (or now, with force). Returns the file name, or undefined if nothing was saved. */
export async function maybeAutoBackup(force = false): Promise<string | undefined> {
  if (running || !isNative()) return undefined;
  const s = await getSettings();
  if (!s.autoBackup.folder || (!force && !backupDue(s))) return undefined;
  running = true;
  try {
    // 0.9.0: locked with the automatic backups' password, if one is set.
    // 0.9.6 (review M3): gift cards only in a locked backup (autoParts).
    const json = await backupJson(autoParts(s.autoBackup));
    const name = autoName();
    await RestockNative.writeBackup({ uri: s.autoBackup.folder, name, json, keep: s.autoBackup.keep });
    const now = new Date().toISOString();
    const latest = await getSettings();
    await updateSettings({ autoBackup: { ...latest.autoBackup, lastAt: now, lastError: undefined }, lastBackupAt: now });
    return name;
  } catch (e) {
    const latest = await getSettings();
    await updateSettings({ autoBackup: { ...latest.autoBackup, lastError: e instanceof Error ? e.message : String(e) } });
    if (force) throw e;
    return undefined;
  } finally {
    running = false;
  }
}
