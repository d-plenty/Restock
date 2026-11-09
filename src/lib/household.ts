import { mergeSettings, mergeShopsFor } from './db';
import type { Settings, StoreChoice } from '../types';
import { shopDef, type Section, type StoreChain } from '../shops';

// 0.8.5: what a phone joining a household takes from the owner phone's settings.
//
// Shared by the household: which shops (for the tabs this phone shares) and their branches, how
// long price history is kept, price checks, recall alerts and the household's name.
// Each person's own: permissions, accessibility, look and colours, auto backups, loyalty cards
// and shop sign-ins, notifications, receipts, widgets and updates.
//
// 0.9.0: the joining phone is strict about what it takes, whatever the owner phone sends. The
// owner's settings are checked first (settingsCheck.ts, strictly, so a shop of theirs whose search
// page is on another site is left out), and this phone never takes: shared price history (each
// person turns that download on themselves), the owner's home area or position, shop store
// numbers (Coles branch numbers, Aldi service points), the backup folder or any password.

/** Settings a joining phone takes from the household as they are. */
export const CARRIED_SETTINGS = [
  'checkIntervalHours',
  'checkWeekday',
  'historyWeeks',
  'defaultThresholdPct',
  'listCompare',
  'shopAroundMin',
  'productOrder',
  'household',
] as const;

const STORE_NUMBERS = ['storeId', 'branchStoreNo', 'branchStoreNo2'] as const;

/**
 * The household's branches without their store numbers. Where this phone already has the same
 * branch picked, it keeps its own numbers for it.
 */
function branchesOnly(from: Settings, current: Settings): Settings['stores'] {
  const out: Settings['stores'] = {};
  for (const [c, theirs] of Object.entries(from.stores) as [StoreChain, StoreChoice][]) {
    const mine = current.stores[c] ?? {};
    const same = (map: 'primaryMap' | 'secondaryMap', label: 'primary' | 'secondary') =>
      !!theirs[label] && (mine[map] && theirs[map] ? mine[map] === theirs[map] : mine[label] === theirs[label]);
    const next: StoreChoice = { ...theirs };
    for (const k of STORE_NUMBERS) delete next[k];
    if (same('primaryMap', 'primary')) {
      if (mine.storeId) next.storeId = mine.storeId;
      if (mine.branchStoreNo) next.branchStoreNo = mine.branchStoreNo;
    }
    if (same('secondaryMap', 'secondary') && mine.branchStoreNo2) next.branchStoreNo2 = mine.branchStoreNo2;
    out[c] = next;
  }
  return out;
}

/** Setup tiles the household's settings cover, so a joined phone isn't asked again. */
export const CARRIED_TILES = ['history', 'checks', 'recalls', 'household', 'sync'] as const;

/**
 * This phone's settings after joining a household that has the owner's settings `theirs`.
 * `tabs`: the tabs this phone shares (Keg only if the person said they're 18 or over).
 * `replace`: "Use the household's things": the household's shops for those tabs. Otherwise
 * ("Combine") this phone keeps its own shops and branches, and gets the household's as well.
 */
export function householdSettingsFor(current: Settings, theirs: Partial<Settings>, opts: { tabs: Section[]; replace: boolean }): Settings {
  const sent = theirs && typeof theirs === 'object' && !Array.isArray(theirs) ? theirs : {};
  const checked = mergeSettings(sent, { strict: true });
  // 0.9.0: never the owner's store numbers or home area (see the top of this file).
  const from: Settings = { ...checked, stores: branchesOnly(checked, current), area: undefined };
  const out: Settings = { ...current };
  const o = out as unknown as Record<string, unknown>;
  const f = from as unknown as Record<string, unknown>;
  for (const k of CARRIED_SETTINGS) if (k in sent) o[k] = f[k];
  if ('recalls' in sent) out.recalls = { ...current.recalls, enabled: from.recalls.enabled };
  if (sent.sync && typeof sent.sync.backgroundActivity === 'boolean') out.sync = { ...current.sync, backgroundActivity: sent.sync.backgroundActivity };
  const tabs = opts.tabs;
  if (opts.replace) {
    Object.assign(out, mergeShopsFor(current, from, sent, tabs));
  } else {
    // Combine: this phone's shops stay; the household's are added.
    const shopTab = (c: string) => [...from.customShops, ...current.customShops].find((x) => x.id === c)?.section;
    const theirChains = from.enabledChains.filter((c) => {
      const t = shopTab(c);
      return tabs.includes(t ?? tabOfBuiltIn(c));
    });
    out.enabledChains = [...new Set([...current.enabledChains, ...theirChains])];
    const stores = { ...current.stores };
    for (const c of theirChains) {
      const k = c as keyof Settings['stores'];
      const mine = current.stores[k];
      if (!mine || !(mine.primary || mine.storeId || mine.secondary)) stores[k] = from.stores[k] ?? mine ?? {};
    }
    out.stores = stores;
    out.customShops = [
      ...current.customShops,
      ...from.customShops.filter((x) => tabs.includes(x.section) && !current.customShops.some((m) => m.id === x.id)),
    ];
    out.sections = {
      keg: current.sections.keg || (tabs.includes('keg') && from.sections.keg),
      pharmacy: current.sections.pharmacy || (tabs.includes('pharmacy') && from.sections.pharmacy),
    };
    const shown = tabs.filter((t) => !(from.hiddenTabs ?? []).includes(t));
    const hidden = (current.hiddenTabs ?? []).filter((t) => !shown.includes(t));
    out.hiddenTabs = hidden.length ? hidden : undefined;
  }
  // Keg is only for a phone whose person said they're 18 or over (asked when joining).
  if (tabs.includes('keg')) out.adultConfirmed = true;
  else out.sections = { ...out.sections, keg: current.sections.keg };
  // The tiles the household covered count as set up.
  const done = new Set(current.setup.done);
  for (const t of [...CARRIED_TILES, ...tabs]) done.add(t);
  out.setup = { ...current.setup, done: [...done], skipped: current.setup.skipped.filter((t) => !done.has(t)) };
  // 0.9.0: these are always this phone's own, whatever was sent.
  out.area = current.area;
  out.marketData = current.marketData;
  out.autoBackup = current.autoBackup;
  out.accounts = current.accounts;
  out.localPrices = current.localPrices;
  return out;
}

/** A built-in shop's tab. */
function tabOfBuiltIn(chain: string): Section {
  return shopDef(chain)?.section ?? 'pantry';
}
