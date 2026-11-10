import { sharedPrices, type SharedPrices } from './sharedPrices';
import { RestockNative } from './sql/native';
import { SECTIONS, shopDef, type Section } from '../shops';
import type { Group, Product, Settings } from '../types';
import {
  getSettings,
  mergeSettings,
  photosOnServer,
  pickSnapshot,
  restoreParts,
  restoreSnapshot,
  snapshot,
  updateSettings,
  type RestoreParts,
  type Snapshot,
} from './db';
import { genericName } from './naming';
import { isPhotoPath, readPhoto, writePhoto } from './receiptFiles';
import { lockBackup } from './backupLock';
import { localDay } from './verdict';
import { base64ToText, textToBase64 } from './base64';
import { shareTextFile } from './shareFile';
import { LIST_ALIASES, LOCAL_ONLY_KV } from './haKeys';
import { aliasesForBackup } from './listPicks';

export { shareTextFile };

interface BackupFile {
  app: 'restock';
  version: 2;
  exportedAt: string;
  /** What was picked when exporting (missing in older, everything-included backups). */
  parts?: ExportParts;
  tables: Snapshot;
  /** Receipt photos (base64 JPEG) by their path in Restock's storage. Restock's own copies, not the phone's photos. */
  photos?: Record<string, string>;
  /** Shared prices (0.9.0): products and their prices only, nothing about you (sharedPrices.ts). Ignored when restoring. */
  sharedPrices?: SharedPrices;
}

export interface ExportParts extends RestoreParts {
  /** Include saved prices (price history). Without them the file is much smaller. */
  prices: boolean;
  /** Include the receipt photos Restock keeps (not the phone's own photos). */
  receiptPhotos?: boolean;
  /**
   * 0.9.2: with receiptPhotos, also the ones this phone moved to its Restock server (fetched from
   * there). Off for the automatic backups, which would fetch them all every time.
   */
  serverPhotos?: boolean;
  /** 0.9.0: lock the file with this password (backupLock.ts). */
  password?: string;
}

export const EVERYTHING: ExportParts = {
  pantry: true,
  sections: SECTIONS,
  list: true,
  cards: true,
  settings: true,
  prices: true,
  receipts: true,
  receiptPhotos: true,
};

/** What's on the phone, for the export sheet: items per tab, list lines, cards, prices. */
export async function exportCounts() {
  const s = await snapshot();
  const bySection = Object.fromEntries(SECTIONS.map((sec) => [sec, s.groups.filter((g) => (g.section ?? 'pantry') === sec).length])) as Record<
    Section,
    number
  >;
  const receipts = s.receipts ?? [];
  return {
    bySection,
    list: s.list.length,
    cards: s.cards.length,
    prices: s.prices.length,
    receipts: receipts.length,
    photos: receipts.filter((r) => r.photo).length,
  };
}

/** The backup file's text, for the parts picked (everything by default). */
export async function backupJson(parts: ExportParts = EVERYTHING): Promise<string> {
  const all = await snapshot();
  // 0.9.3: "Always use this for …" are the household's rows now (listPicks.ts); a backup still has
  // them where it always did (a restore moves them back into rows).
  const aliases = await aliasesForBackup().catch(() => undefined);
  if (aliases) all.kv = [...all.kv.filter((k) => k.key !== LIST_ALIASES), { key: LIST_ALIASES, value: aliases }];
  const picked: ExportParts = { ...parts, sections: parts.pantry ? (parts.sections ?? SECTIONS) : [] };
  const file: BackupFile = {
    app: 'restock',
    version: 2,
    exportedAt: new Date().toISOString(),
    parts: { ...picked, password: undefined, serverPhotos: undefined },
    tables: withoutSecrets(pickSnapshot(all, picked, { prices: parts.prices })),
  };
  // With "Share prices" on (the default) and price history in the file. 0.9.0: made from what's in
  // this file only (the tabs picked), not from everything on the phone.
  if (parts.prices && (await getSettings()).sharePrices !== 'no') file.sharedPrices = sharedPrices(file.tables);
  if (parts.receipts && parts.receiptPhotos) {
    const photos: Record<string, string> = {};
    const missing: string[] = [];
    for (const r of file.tables.receipts ?? []) {
      for (const path of [r.photo, ...(r.pages ?? [])]) {
        const data = path ? await readPhoto(path) : undefined;
        if (path && data) photos[path] = data;
        else if (path) missing.push(path);
      }
    }
    // 0.9.2: photos this phone moved to the Restock server come from there, so the backup still has
    // them (if the server can't be reached, the backup goes without them rather than waiting).
    for (const path of parts.serverPhotos === false ? [] : await photosOnServer(missing)) {
      try {
        photos[path] = (await RestockNative.syncServerPhoto({ path })).data;
      } catch {
        break;
      }
    }
    if (Object.keys(photos).length) file.photos = photos;
  }
  const json = JSON.stringify(file);
  return parts.password ? lockBackup(json, parts.password) : json;
}

/**
 * The automatic backups' password never goes into a backup (it would be in the file it locks).
 * 0.9.3: nor this phone's Home Assistant settings (haKeys.ts; its token isn't in the database at all).
 */
function withoutSecrets(t: Snapshot): Snapshot {
  return {
    ...t,
    kv: t.kv.filter((k) => !LOCAL_ONLY_KV.includes(k.key)).map((k) => {
      if (k.key !== 'settings' || !k.value || typeof k.value !== 'object') return k;
      const v = k.value as { autoBackup?: { password?: string } };
      if (!v.autoBackup?.password) return k;
      return { key: k.key, value: { ...v, autoBackup: { ...v.autoBackup, password: undefined } } };
    }),
  };
}

/**
 * A full backup (without receipt photos) kept inside Restock (0.8.0): before the 0.8.0 upgrade,
 * and before joining a household with "use the household's things". Returns the JSON too.
 */
export async function saveCopyInApp(path: string): Promise<string> {
  const json = await backupJson({ ...EVERYTHING, receiptPhotos: false });
  await RestockNative.writeAppFile({ path, data: textToBase64(json) });
  return json;
}

/** A copy saved by saveCopyInApp, or undefined if there isn't one. */
export async function readCopyInApp(path: string): Promise<string | undefined> {
  try {
    const { data } = await RestockNative.readAppFile({ path });
    return base64ToText(data);
  } catch {
    return undefined;
  }
}

/** A backup file of the parts picked (everything by default), shared through Android's share menu. */
export async function exportBackup(parts: ExportParts = EVERYTHING): Promise<string> {
  const json = await backupJson(parts);
  const whole =
    parts.pantry &&
    (parts.sections ?? SECTIONS).length === SECTIONS.length &&
    parts.list &&
    parts.cards &&
    parts.settings &&
    parts.prices &&
    parts.receipts !== false;
  // 0.9.0: named for the day on the phone's own calendar, not UTC's (an evening backup in
  // Australia isn't yesterday's).
  const name = `restock-backup-${localDay(new Date().toISOString())}${whole ? '' : '-part'}${parts.password ? '-locked' : ''}.json`;

  await shareTextFile(name, json, 'application/json', 'Restock backup');
  await updateSettings({ lastBackupAt: new Date().toISOString() });
  return name;
}

/**
 * Time for a backup nudge? Everything lives on this phone, so once there's something worth
 * keeping, remind about once a month (or a month after "Not now").
 */
export function needsBackupNudge(
  s: { lastBackupAt?: string; backupNudgeAt?: string },
  items: number,
  oldestItemAt: string | undefined,
  now = Date.now(),
  /** 0.9.3: phone-to-phone sync or a Restock server keeps a copy (Settings suggests a local backup as well). */
  keptElsewhere = false,
): boolean {
  const DAY = 86_400_000;
  if (keptElsewhere) return false;
  if (items < 3 || !oldestItemAt || now - Date.parse(oldestItemAt) < 7 * DAY) return false;
  if (s.lastBackupAt && now - Date.parse(s.lastBackupAt) < 30 * DAY) return false;
  if (s.backupNudgeAt && now - Date.parse(s.backupNudgeAt) < 30 * DAY) return false;
  return true;
}

export interface BackupSummary {
  exportedAt?: string;
  snapshot: Snapshot;
  /** Receipt photos in the file, by path. */
  photos: Record<string, string>;
  counts: {
    items: number;
    prices: number;
    list: number;
    cards: number;
    categories: number;
    hasSettings: boolean;
    bySection: Record<Section, number>;
    receipts: number;
    photos: number;
    /** Tabs whose shops the backup has. */
    shopTabs: Section[];
  };
  /** The tabs whose items are in this backup (a part backup may have only some). */
  sections: Section[];
  /** Suggested tidier names for pantry items, e.g. "Coles Simply Pure Honey Squeeze 400g" → "Honey". */
  renames: { groupId: string; from: string; to: string }[];
}

/** Reads a backup file without changing anything, so the person can pick what to restore. */
export function readBackup(text: string): BackupSummary {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('That file isn’t a Restock backup.');
  }
  if (file.app !== 'restock' || !file.tables || file.version !== 2) throw new Error('That file isn’t a Restock backup.');
  const t = file.tables;
  const snap: Snapshot = {
    products: t.products ?? [],
    groups: t.groups ?? [],
    prices: t.prices ?? [],
    list: t.list ?? [],
    cards: t.cards ?? [],
    categories: t.categories ?? [],
    kv: t.kv ?? [],
    receipts: t.receipts ?? [],
  };
  const photos = file.photos ?? {};
  return {
    exportedAt: file.exportedAt,
    snapshot: snap,
    photos,
    counts: {
      items: snap.groups.length,
      prices: snap.prices.length,
      list: snap.list.length,
      cards: snap.cards.length,
      categories: snap.categories.length,
      hasSettings: snap.kv.some((k) => k.key === 'settings'),
      receipts: snap.receipts?.length ?? 0,
      photos: Object.keys(photos).length,
      shopTabs: shopTabsIn(snap),
      bySection: Object.fromEntries(SECTIONS.map((sec) => [sec, snap.groups.filter((g) => (g.section ?? 'pantry') === sec).length])) as Record<
        Section,
        number
      >,
    },
    // Older backups had everything; part backups say which tabs they hold.
    sections: file.parts ? (file.parts.sections ?? []) : SECTIONS,
    renames: suggestRenames(snap.groups, snap.products),
  };
}

/** Which tabs a backup has shops for: Groceries if it has settings, Keg and Pharmacy if they were on with a shop picked. */
function shopTabsIn(snap: Snapshot): Section[] {
  const raw = snap.kv.find((k) => k.key === 'settings')?.value as Partial<Settings> | undefined;
  if (!raw) return [];
  // 0.9.0: checked first, so an odd backup can't stop the restore sheet opening.
  const st = mergeSettings(raw, { strict: true });
  const chains = st.enabledChains;
  const custom = st.customShops ?? [];
  const has = (sec: Section) =>
    chains.some((c) => (shopDef(c)?.section ?? custom.find((x) => x.id === c)?.section) === sec) || custom.some((x) => x.section === sec);
  return SECTIONS.filter((sec) => sec === 'pantry' || (st.sections?.[sec as 'keg' | 'pharmacy'] && has(sec)));
}

const SIZEISH = /\d|\b(pack|pk|each|ea)\b/i;

/**
 * Pantry items whose name looks like a full product title (a size in it, a brand, the product's
 * whole name, or more than three words) get a short everyday name instead. Names the person
 * clearly chose themselves ("Choc Wafers") are left alone.
 */
export function suggestRenames(groups: Group[], products: Product[]): BackupSummary['renames'] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: BackupSummary['renames'] = [];
  for (const g of groups) {
    const ids = [g.usualProductId, ...(g.sameProductIds ?? [])].filter((x): x is string => !!x);
    const mine = ids.map((id) => byId.get(id)).filter((p): p is Product => !!p);
    const p = mine[0];
    if (!p) continue;
    const to = genericName(p.name, p.brand).trim();
    const from = g.name.trim();
    if (!to || to.toLowerCase() === from.toLowerCase() || to.length >= from.length) continue;
    const lower = from.toLowerCase();
    const looksLikeTitle =
      SIZEISH.test(from) ||
      mine.some((x) => x.name.toLowerCase() === lower || (x.brand && lower.includes(x.brand.toLowerCase()))) ||
      from.split(/\s+/).length > 3;
    if (looksLikeTitle) out.push({ groupId: g.id, from, to });
  }
  return out;
}

/**
 * Restores the parts picked from a backup (all of them by default). From setup, `stayInSetup`
 * keeps the phone in setup (with the privacy policy accepted) so it can still be given its
 * permissions. `renames` gives pantry items tidier names as they come in.
 */
export async function restoreBackup(
  summary: BackupSummary,
  parts: RestoreParts,
  opts: { stayInSetup?: string; renames?: Map<string, string>; household?: boolean } = {},
): Promise<void> {
  // 0.9.0: `household` ("Restore for the household") adds the backup's cards rather than replacing them all (db.ts restoreParts).
  await restoreParts(summary.snapshot, parts, opts.renames, { household: opts.household });
  if (parts.receipts) await restorePhotos(summary.photos);
  if (opts.stayInSetup) await updateSettings({ privacyAccepted: opts.stayInSetup });
}

/** Puts receipt photos from a backup back into Restock's storage (only at receipt photo paths, receiptPaths.ts). */
async function restorePhotos(photos: Record<string, string> | undefined): Promise<void> {
  for (const [path, data] of Object.entries(photos ?? {})) {
    if (isPhotoPath(path) && typeof data === 'string') await writePhoto(path, data).catch(() => undefined);
  }
}

/**
 * Replaces everything with a backup. From setup, `stayInSetup` keeps the phone in setup
 * (with the privacy policy accepted) so it can still be given its permissions.
 */
export async function importBackup(text: string, opts: { stayInSetup?: string } = {}): Promise<void> {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('That file isn’t a Restock backup.');
  }
  if (file.app !== 'restock' || !file.tables || file.version !== 2) throw new Error('That file isn’t a Restock backup.');
  const t = file.tables;
  let kv = t.kv ?? [];
  if (opts.stayInSetup) {
    const has = kv.some((r) => r.key === 'settings');
    kv = kv.map((r) => (r.key === 'settings' ? { ...r, value: { ...(r.value as object), onboarded: false, privacyAccepted: opts.stayInSetup } } : r));
    if (!has) kv.push({ key: 'settings', value: { onboarded: false, privacyAccepted: opts.stayInSetup } });
  }
  await restoreSnapshot({
    products: t.products ?? [],
    groups: t.groups ?? [],
    prices: t.prices ?? [],
    list: t.list ?? [],
    cards: t.cards ?? [],
    categories: t.categories ?? [],
    kv,
    receipts: t.receipts ?? [],
  });
  await restorePhotos(file.photos);
  // A restored phone is set up, even if the backup was made part-way through setup.
  if (!opts.stayInSetup && !(await getSettings()).onboarded) await updateSettings({ onboarded: true });
}
