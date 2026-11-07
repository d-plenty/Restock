import { Capacitor } from '@capacitor/core';
import { SECTIONS, shopDef, type Section } from '../shops';
import type { Group, Product, Settings } from '../types';
import { getSettings, pickSnapshot, restoreParts, restoreSnapshot, snapshot, updateSettings, type RestoreParts, type Snapshot } from './db';
import { genericName } from './naming';
import { readPhoto, writePhoto } from './receiptFiles';

interface BackupFile {
  app: 'restock';
  version: 2;
  exportedAt: string;
  /** What was picked when exporting (missing in older, everything-included backups). */
  parts?: ExportParts;
  tables: Snapshot;
  /** Receipt photos (base64 JPEG) by their path in Restock's storage. Restock's own copies, not the phone's photos. */
  photos?: Record<string, string>;
}

export interface ExportParts extends RestoreParts {
  /** Include saved prices (price history). Without them the file is much smaller. */
  prices: boolean;
  /** Include the receipt photos Restock keeps (not the phone's own photos). */
  receiptPhotos?: boolean;
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
  const picked: ExportParts = { ...parts, sections: parts.pantry ? (parts.sections ?? SECTIONS) : [] };
  const file: BackupFile = {
    app: 'restock',
    version: 2,
    exportedAt: new Date().toISOString(),
    parts: picked,
    tables: pickSnapshot(all, picked, { prices: parts.prices }),
  };
  if (parts.receipts && parts.receiptPhotos) {
    const photos: Record<string, string> = {};
    for (const r of file.tables.receipts ?? []) {
      for (const path of [r.photo, ...(r.pages ?? [])]) {
        const data = path ? await readPhoto(path) : undefined;
        if (path && data) photos[path] = data;
      }
    }
    if (Object.keys(photos).length) file.photos = photos;
  }
  return JSON.stringify(file);
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
  const name = `restock-backup-${new Date().toISOString().slice(0, 10)}${whole ? '' : '-part'}.json`;

  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({ path: name, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: 'Restock backup', files: [written.uri] });
  } else {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  await updateSettings({ lastBackupAt: new Date().toISOString() });
  return name;
}

/** Hand a text file to the person: the share sheet on the phone, a download in a browser. */
export async function shareTextFile(name: string, text: string, mime = 'application/json', title = name): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title, files: [written.uri] });
  } else {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
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
): boolean {
  const DAY = 86_400_000;
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
  const st = snap.kv.find((k) => k.key === 'settings')?.value as Partial<Settings> | undefined;
  if (!st) return [];
  const chains = st.enabledChains ?? [];
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
  opts: { stayInSetup?: string; renames?: Map<string, string> } = {},
): Promise<void> {
  await restoreParts(summary.snapshot, parts, opts.renames);
  if (parts.receipts) await restorePhotos(summary.photos);
  if (opts.stayInSetup) await updateSettings({ privacyAccepted: opts.stayInSetup });
}

/** Puts receipt photos from a backup back into Restock's storage. */
async function restorePhotos(photos: Record<string, string> | undefined): Promise<void> {
  for (const [path, data] of Object.entries(photos ?? {})) {
    if (/^receipts\/[\w-]+\.jpg$/.test(path)) await writePhoto(path, data).catch(() => undefined);
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
