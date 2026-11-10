// 0.9.3: household-wide settings, for the screens (on a phone and on the Restock server's web app).
// The rules are in sharedSettings.ts; the phones' own settings summary is in phoneSummary.ts.
//
// For the web app's Settings (works the same in the phone app and in server mode, where the data is
// the browser's own copy and the web writes its own device file on its next round, a few seconds
// after a change):
//
//   getHouseholdSettings(): Promise<HouseholdSettings | null>
//       The household's settings as they stand on this device; null when it isn't in a household
//       (yet: the web before its first round with the phones).
//   setHouseholdSettings(patch): Promise<HouseholdSettings | null>
//       Changes some of them. Only what's in the patch changes; each setting (and each shop) is its
//       own change, and the later change wins, so two people changing different ones both keep theirs.
//       Throws when not in a household.
//   phoneSummaries(): Promise<PhoneInfo[]>
//       Each phone's own settings, read-only (server mode; [] on a phone): show them greyed with
//       "Change this on <name>".
//   HOUSEHOLD_WIDE, PER_PHONE, settingScope(path)
//       Which settings are the household's and which each phone's own.
//
// The phone's own Settings screens need nothing from here: updateSettings (db.ts) writes household
// settings to the household as they change, and the phone follows changes from the others.

import { applyRows, builtInsOn, checkShop, checkValue, decode, SCALAR_KEYS } from './sharedSettings';
import { getSettings, householdContext, queryRows, reapplyHouseholdSettings, runOps } from './db';
import { cleanSummary, PER_PHONE, type PhoneSummary } from './phoneSummary';
import type { CustomShop, ProductOrder, Section, Settings, StoreChain } from '../types';

export { PER_PHONE, reapplyHouseholdSettings, type PhoneSummary };

/** One tab's shops, for the household. */
export interface TabShops {
  /** The tab switched on (Pantry is always on). */
  on: boolean;
  /** The shops picked on this tab (built-in ids like "coles", and "custom-…" for shops people added). */
  chains: StoreChain[];
  /** Shops people added on this tab (picked or not), with their name and website. */
  customShops: CustomShop[];
}

export interface HouseholdSettings {
  /** "Shop around" is only suggested when it saves at least this many dollars. */
  shopAroundMin: number;
  /** The alert level new items start with, in % off. */
  defaultThresholdPct: number;
  /** The list's cheapest: by unit price or by shelf price. */
  listCompare: 'unit' | 'price';
  /** The order of an item's products. */
  productOrder: ProductOrder;
  /** Recall alerts on. */
  recallsEnabled: boolean;
  /** The shops of each tab the household shares (and this device takes). A tab that isn't here isn't shared. */
  tabs: Partial<Record<Section, TabShops>>;
}

/** What setHouseholdSettings changes: any of the above; for a tab, any of on, chains (the whole list) and customShops (the whole list). */
export type HouseholdSettingsPatch = Partial<Omit<HouseholdSettings, 'tabs'>> & { tabs?: Partial<Record<Section, Partial<TabShops>>> };

/**
 * The household's settings, by their Settings path. Shops: which shops each shared tab uses
 * (enabledChains), the tab switched on (sections), and shops people added (customShops).
 */
export const HOUSEHOLD_WIDE = ['enabledChains', 'sections', 'customShops', 'shopAroundMin', 'defaultThresholdPct', 'listCompare', 'productOrder', 'recalls.enabled'] as const;

/**
 * Whose a setting is: 'household' (changed once for everyone) or 'phone' (each phone's own). By its
 * Settings path ("shopAroundMin", "recalls.enabled", "stores", "autoBackup.everyDays"). Branches and
 * store numbers (stores, area) are each phone's own; so is everything not in HOUSEHOLD_WIDE.
 */
export function settingScope(path: string): 'household' | 'phone' {
  const top = path.split('.')[0];
  if (path === 'recalls.enabled') return 'household';
  if (top === 'recalls') return 'phone';
  return (HOUSEHOLD_WIDE as readonly string[]).includes(top) ? 'household' : 'phone';
}

const TABS: Section[] = ['pantry', 'keg', 'pharmacy'];

function view(s: Settings, tabs: Set<Section>): HouseholdSettings {
  const out: HouseholdSettings = {
    shopAroundMin: s.shopAroundMin,
    defaultThresholdPct: s.defaultThresholdPct,
    listCompare: s.listCompare,
    productOrder: s.productOrder ?? 'size',
    recallsEnabled: s.recalls.enabled,
    tabs: {},
  };
  for (const t of TABS) {
    if (!tabs.has(t)) continue;
    const customShops = s.customShops.filter((c) => c.section === t);
    const ids = new Set<string>([...builtInsOn(t), ...customShops.map((c) => c.id)]);
    out.tabs[t] = {
      on: t === 'pantry' ? true : s.sections[t],
      chains: s.enabledChains.filter((c) => ids.has(c)),
      customShops,
    };
  }
  return out;
}

/** The settings with the household's rows applied (what this device shows), and the tabs. */
async function current(): Promise<{ s: Settings; tabs: Set<Section>; rows: Map<string, string> } | null> {
  const ctx = await householdContext();
  if (!ctx) return null;
  const s = structuredClone(await getSettings());
  // The household's own values (its Keg tab too, whatever this device has confirmed).
  applyRows(s as unknown as Record<string, unknown>, [...ctx.rows].map(([k, v]) => ({ k, v })), ctx.tabs, { adult: true });
  return { s, tabs: ctx.tabs, rows: ctx.rows };
}

export async function getHouseholdSettings(): Promise<HouseholdSettings | null> {
  const c = await current();
  return c ? view(c.s, c.tabs) : null;
}

export async function setHouseholdSettings(patch: HouseholdSettingsPatch): Promise<HouseholdSettings | null> {
  const c = await current();
  if (!c) throw new Error('Not in a household yet.');
  const rows: [string, unknown][] = [];
  const scalar: Record<(typeof SCALAR_KEYS)[number], unknown> = {
    shopAroundMin: patch.shopAroundMin,
    defaultThresholdPct: patch.defaultThresholdPct,
    listCompare: patch.listCompare,
    productOrder: patch.productOrder,
    'recalls.enabled': patch.recallsEnabled,
  };
  for (const k of SCALAR_KEYS) {
    if (scalar[k] === undefined) continue;
    if (checkValue(k, scalar[k]) === undefined) throw new Error(`That isn't a value ${k} can have.`);
    rows.push([k, scalar[k]]);
  }
  for (const t of TABS) {
    const p = patch.tabs?.[t];
    if (!p) continue;
    if (!c.tabs.has(t)) throw new Error(`The household doesn't share the ${t} tab.`);
    if (p.on !== undefined && t !== 'pantry') rows.push(['tab:' + t, p.on]);
    const had = c.s.customShops.filter((x) => x.section === t);
    const shops = p.customShops ?? had;
    for (const x of shops) if (x.section !== t || !checkShop(x, x.id)) throw new Error(`${x.name || 'That shop'} can't be used.`);
    const picked = new Set<string>(p.chains ?? c.s.enabledChains);
    for (const id of builtInsOn(t)) if (p.chains) rows.push(['shop:' + id, { on: picked.has(id) }]);
    for (const x of shops) if (p.chains || p.customShops) rows.push(['shop:' + x.id, { on: picked.has(x.id), shop: checkShop(x, x.id) }]);
    if (p.customShops) for (const x of had) if (!shops.some((y) => y.id === x.id)) rows.push(['shop:' + x.id, { on: false, removed: true, shop: checkShop(x, x.id) }]);
  }
  // Only the rows that change (each a change of this device's, noted for sync by the table's triggers).
  const ops = rows
    .map(([k, v]) => [k, JSON.stringify(v)] as const)
    .filter(([k, v]) => {
      const had = c.rows.get(k);
      // No row yet: written, so the household has it from now on, whatever each phone had.
      return had === undefined || JSON.stringify(checkValue(k, decode(had))) !== JSON.stringify(checkValue(k, JSON.parse(v)));
    })
    .map(([k, v]) => ({ sql: 'INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)', params: [k, v] }));
  if (ops.length) await runOps(ops);
  await reapplyHouseholdSettings();
  return getHouseholdSettings();
}

/** One phone's own settings, for the web's Settings → Phones. */
export interface PhoneInfo {
  device: string;
  /** The phone's name in the household. */
  name: string;
  /** The household's owner phone. */
  owner: boolean;
  /** Restock version on it (also in summary.version). */
  version?: string;
  /** When the phone last wrote its file to the server. */
  syncedAt?: string;
  summary: PhoneSummary;
}

/**
 * The phones' own settings, from their files on the Restock server (server mode; on a phone, []):
 * every phone in the household whose file had a summary (0.9.3 or newer), owner first, then by name.
 */
export async function phoneSummaries(): Promise<PhoneInfo[]> {
  const metas = await queryRows<{ key: string; value: string }>("SELECT key, value FROM sync_meta WHERE key LIKE 'phone_summary:%'").catch(() => []);
  const members = await queryRows<{ k: string; v: string }>("SELECT k, v FROM household WHERE k LIKE 'member:%' OR k = 'owner'").catch(() => []);
  const owner = members.find((m) => m.k === 'owner')?.v;
  const names = new Map<string, string>();
  for (const m of members) {
    if (!m.k.startsWith('member:')) continue;
    try {
      names.set(m.k.slice(7), String((JSON.parse(m.v) as { name?: unknown }).name ?? 'Phone'));
    } catch {
      names.set(m.k.slice(7), 'Phone');
    }
  }
  const out: PhoneInfo[] = [];
  for (const r of metas) {
    const device = r.key.slice('phone_summary:'.length);
    if (device.startsWith('web-') || !names.has(device)) continue;
    let kept: { name?: unknown; at?: unknown; summary?: unknown };
    try {
      kept = JSON.parse(r.value) as typeof kept;
    } catch {
      continue;
    }
    const summary = cleanSummary(kept.summary);
    if (!summary) continue;
    out.push({
      device,
      name: names.get(device) ?? (typeof kept.name === 'string' ? kept.name : 'Phone'),
      owner: device === owner,
      version: summary.version,
      syncedAt: typeof kept.at === 'string' ? kept.at : undefined,
      summary,
    });
  }
  return out.sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name));
}
