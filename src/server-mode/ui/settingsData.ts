// 0.9.3: everything the desktop Settings page reads and changes, in one place.
//
// Settings → Household shows what the web can change for the whole household (from
// src/lib/householdSettings.ts: Shop around, alerts for new items, the list's cheapest, the order of
// an item's products, recall alerts, and each shared tab's shops), with what only the owner phone
// or each phone can change shown greyed. Settings → Phones shows each phone's own settings, read-only,
// from the summaries the phones send (householdSettings.ts phoneSummaries, phoneSummary.ts).

import { useEffect, useState } from 'react';
import { addCategory, allCards, allCategories, deleteCategory, getSettings, renameCategory, swapCategories, updateSettings } from '../../lib/db';
import {
  getHouseholdSettings,
  phoneSummaries,
  setHouseholdSettings,
  type HouseholdSettingsPatch,
  type PhoneInfo,
  type PhoneSummary as SentSummary,
} from '../../lib/householdSettings';
import { haPhone } from '../../lib/listPicks';
import { PRODUCT_ORDERS } from '../../lib/productOrder';
import { builtInsOn } from '../../lib/sharedSettings';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, SECTION_NAMES, searchChainsIn, type Section, type StoreChain } from '../../shops';
import { historyLabel, type Category, type ProductOrder, type Settings } from '../../types';
import { PROGRAMS } from '../../ui/screens/Cards';
import { api, api3, isV3, serverInfo, type Device } from '../api';
import { downloadBackup, householdInfo, memberNames } from '../live';
import { canChangeVault, session, signOut, signOutEverywhere } from '../session';
import { leave } from './ServerScreens';
import { askThenConfirm } from './houseData';
import { confirmAction } from '../../lib/confirm';

/** Who can change a setting: here on the web, only on the owner phone, or on each phone. */
export type ChangedOn = 'web' | 'owner' | 'phone';

export interface ShopChoice {
  id: StoreChain;
  name: string;
  picked: boolean;
}

export interface ShopsForTab {
  section: Section;
  title: string;
  /** Keg and Pharmacy can be switched off for the household (Pantry is always on). */
  on: boolean;
  /** The shops picked. */
  shops: { id: StoreChain; name: string }[];
  /** Every shop that can be picked on this tab (built in, and ones people added). */
  choices: ShopChoice[];
}

export interface HouseholdSettings {
  /** In a household yet? Not until this browser's first sync with the phones; until then nothing here changes. */
  inHousehold: boolean;
  name: string;
  nameOn: ChangedOn;
  /** "Groceries, Keg and Health · receipts shared". Owner phone only. */
  shares: string;
  /** "Declan's phone is the owner". Owner phone only. */
  owner: string;
  shops: ShopsForTab[];
  /** The shops picked are the household's; the branch (and store numbers) each phone's own. */
  shopsOn: ChangedOn;
  shopAroundMin: number;
  /** Price alerts for new items: how far under the usual price (defaultThresholdPct). */
  newItemPct: number;
  /** The list's cheapest: by unit price ('unit', best value) or shelf price. */
  listCompare: 'unit' | 'price';
  /** The order of an item's products on its page. */
  productOrder: ProductOrder;
  recalls: boolean;
  /** Shop around, new items' alerts, the list's cheapest, product order and recalls. */
  settingsOn: ChangedOn;
  /** Categories are synced records, so they change here for everyone (the web's own sync file carries them). */
  categories: { section: Section; title: string; count: number }[];
  /** Each phone keeps its own amount of price history; anything older is on the server. */
  historyText: string;
  /** This browser's look (Auto, Light, Dark): only ever this browser. */
  theme: Settings['theme'];
}

/** The amounts "Shop around" can be set to (the same as the phone's Settings → Shopping list). */
export const SHOP_AROUND_MINS = [0, 0.5, 1, 2, 5, 10];
/** How far under the usual price a new item's alert starts (sharedSettings.ts allows 1–90). */
export const NEW_ITEM_PCTS = [10, 15, 20, 30, 40, 50];
export { PRODUCT_ORDERS };

const TAB_TITLE: Record<Section, string> = { pantry: 'Groceries', keg: 'Keg (bottle shops)', pharmacy: 'Health' };
/** 0.10.0: the shop rows, named as on the phone's Settings → Your shops (Keg and Health are beta). */
const SHOPS_TITLE: Record<Section, string> = { pantry: 'Supermarkets (Pantry tab)', keg: 'Bottle shops (Keg tab) · Beta', pharmacy: 'Chemists (Health tab) · Beta' };

function sharesText(tabs: string[], receipts: boolean): string {
  const names = tabs.map((t) => (t === 'pantry' ? 'Groceries' : (SECTION_NAMES[t as Section] ?? t)));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? 'Nothing yet');
  return `${list}${receipts ? ' · receipts shared' : ''}`;
}

async function readHousehold(): Promise<HouseholdSettings> {
  const [s, hs, cats] = await Promise.all([getSettings(), getHouseholdSettings(), allCategories()]);
  const h = householdInfo();
  const names = memberNames();
  const custom = new Map(s.customShops.map((c) => [c.id, c.name]));
  const nameOf = (id: string) => (custom as Map<string, string>).get(id) ?? chainName(id as StoreChain);
  // The household's shared tabs (with their shops), or, before the first sync, what this browser shows.
  const shops: ShopsForTab[] = hs
    ? (['pantry', 'keg', 'pharmacy'] as Section[])
        .filter((t) => hs.tabs[t])
        .map((t) => {
          const tab = hs.tabs[t]!;
          const ids = [...builtInsOn(t), ...tab.customShops.map((c) => c.id)] as StoreChain[];
          return {
            section: t,
            title: SHOPS_TITLE[t],
            on: tab.on,
            shops: tab.chains.map((id) => ({ id, name: nameOf(id) })),
            choices: ids.map((id) => ({ id, name: nameOf(id), picked: tab.chains.includes(id) })),
          };
        })
    : activeSections(s).map((t) => ({
        section: t,
        title: SHOPS_TITLE[t],
        on: true,
        shops: searchChainsIn(s.enabledChains, t).map((id) => ({ id, name: nameOf(id) })),
        choices: [],
      }));
  return {
    inHousehold: !!hs,
    // The household's name is owner-signed (household record "name", engine.ts ownerOnly).
    name: h.name ?? s.household.name,
    nameOn: 'owner',
    shares: sharesText(h.tabs.length ? h.tabs : activeSections(s), h.receipts),
    owner: h.owner ? `${names.get(h.owner) ?? 'A phone'} is the owner` : 'No owner phone yet',
    shops,
    shopsOn: hs ? 'web' : 'phone',
    shopAroundMin: hs?.shopAroundMin ?? s.shopAroundMin ?? 1,
    newItemPct: hs?.defaultThresholdPct ?? s.defaultThresholdPct,
    listCompare: hs?.listCompare ?? s.listCompare,
    productOrder: hs?.productOrder ?? s.productOrder ?? 'size',
    recalls: hs?.recallsEnabled ?? s.recalls.enabled,
    settingsOn: hs ? 'web' : 'phone',
    categories: activeSections(s).map((section) => ({ section, title: TAB_TITLE[section], count: cats.filter((c) => c.section === section).length })),
    historyText: `This browser shows everything the server keeps. Each phone keeps its own amount (${historyLabel(s.historyWeeks)} unless changed); older prices move here.`,
    theme: s.theme,
  };
}

/** The household's settings, kept up to date as they change (undefined while loading). */
export function useHouseholdSettings(): HouseholdSettings | undefined {
  return useLive(readHousehold, []);
}

/** Changes household settings for every phone (they go out with the next sync). Throws when not in a household yet. */
export async function changeHousehold(patch: HouseholdSettingsPatch): Promise<void> {
  await setHouseholdSettings(patch);
}

export const setShopAroundMin = (v: number) => changeHousehold({ shopAroundMin: v });
export const setNewItemPct = (pct: number) => changeHousehold({ defaultThresholdPct: pct });
export const setListCompare = (v: 'unit' | 'price') => changeHousehold({ listCompare: v });
export const setProductOrder = (v: ProductOrder) => changeHousehold({ productOrder: v });
export const setRecalls = (on: boolean) => changeHousehold({ recallsEnabled: on });
/** A tab's shops: the whole list of the ones picked (and, for Keg and Pharmacy, the tab on or off). */
export const setTabShops = (section: Section, chains: StoreChain[], on?: boolean) =>
  changeHousehold({ tabs: { [section]: { chains, ...(on === undefined || section === 'pantry' ? {} : { on }) } } });

// ---------- categories (synced records: a change here reaches every phone) ----------

export const categoriesData = {
  all: allCategories,
  add: (name: string, section: Section) => addCategory(name, section),
  rename: (id: string, name: string) => renameCategory(id, name),
  swap: (a: Category, b: Category) => swapCategories(a, b),
  remove: (id: string) => deleteCategory(id),
};

// ---------- this browser and the server ----------

export function setTheme(theme: Settings['theme']): Promise<Settings> {
  return updateSettings({ theme });
}

export interface ServerAccount {
  user: string;
  viaPhone: boolean;
  /** Signed in with the passphrase in this tab (needed to change it). */
  canChangePassphrase: boolean;
}

export function serverAccount(): ServerAccount {
  const s = session();
  return { user: s?.user ?? 'admin', viaPhone: !!s?.viaPhone, canChangePassphrase: canChangeVault() };
}

/** "Download a backup": this browser's copy as a Restock backup file (never card numbers: the web doesn't have them). */
export const downloadBrowserBackup = () => downloadBackup();

/** Sign out of this browser (its copy of the household goes too), or every browser. */
export const signOutHere = () => leave(() => signOut());
export const signOutAll = () => leave(() => signOutEverywhere());

/** The server's own version ("0.9.3"), for About. */
export function useServerVersion(): string | undefined {
  const [v, setV] = useState<string>();
  useEffect(() => {
    const known = serverInfo()?.version;
    if (known) return setV(known);
    api
      .health()
      .then((h) => setV(h.version))
      .catch(() => undefined);
  }, []);
  return v;
}

// ---------- the phones ----------

export interface PhoneSettingGroup {
  title: string;
  rows: { label: string; value: string }[];
  /** "Change this on Declan's phone", "Kept on Declan's phone for privacy". */
  note: string;
}

export interface PhoneSettings {
  device: string;
  name: string;
  isOwner: boolean;
  lastSeen?: string;
  /** Restock on that phone ("0.9.3"), once it says. */
  version?: string;
  /** False until the phone sends a summary of its settings (every value reads "Not sent yet"). */
  sent: boolean;
  /** 0.9.3: the household's one phone that syncs the shopping list with Home Assistant. */
  homeAssistant: boolean;
  groups: PhoneSettingGroup[];
}

export const NOT_SENT = 'Not sent yet';

const onOff = (v: boolean | undefined) => (v === undefined ? NOT_SENT : v ? 'On' : 'Off');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : NOT_SENT;
function every(h?: number, weekday?: number): string {
  if (h === undefined) return NOT_SENT;
  if (h >= 168) return weekday !== undefined ? `Once a week, ${DAYS[weekday]}` : 'Once a week';
  if (h === 24) return 'Once a day';
  if (h === 48) return 'Every 2 days';
  return `Every ${h} hours`;
}
const AWAY: Record<string, string> = { none: 'Not away from home', folder: 'A shared folder', webdav: 'WebDAV', nextcloud: 'Nextcloud', server: 'This server' };
const THEME: Record<string, string> = { system: 'Follows the phone', light: 'Light', dark: 'Dark' };

/** A phone's own settings, from the summary it sent (none yet: "Not sent yet" everywhere). Never card numbers. */
export function phoneGroups(name: string, s: SentSummary | undefined, haPhone = false): PhoneSettingGroup[] {
  const on = `Change this on ${name}`;
  const tabNames = s?.tabs?.map((t) => (t === 'pantry' ? 'Groceries' : SECTION_NAMES[t]));
  return [
    {
      title: 'Price checks',
      rows: [
        { label: 'How often', value: every(s?.checks?.everyHours, s?.checks?.weekday) },
        { label: 'In the background', value: onOff(s?.checks?.background) },
        { label: 'Last check', value: s?.checks?.lastAt ? `${when(s.checks.lastAt)}${s.checks.lastItems !== undefined ? ` · ${s.checks.lastItems} items` : ''}` : NOT_SENT },
      ],
      note: on,
    },
    {
      title: 'Shop accounts',
      rows: [
        { label: 'Coles', value: s?.accounts ? (s.accounts.coles ? 'Signed in' : 'Not signed in') : NOT_SENT },
        { label: 'Woolworths', value: s?.accounts ? (s.accounts.woolworths ? 'Signed in' : 'Not signed in') : NOT_SENT },
        { label: 'Loyalty cards', value: s?.cards === undefined ? NOT_SENT : s.cards === 1 ? '1 on this phone' : `${s.cards} on this phone` },
      ],
      note: `Kept on ${name} for privacy`,
    },
    {
      title: 'Notifications',
      rows: [
        { label: 'Great deals', value: onOff(s?.notifications?.greatDeals) },
        { label: 'Daily summary', value: s?.notifications?.daily === undefined ? NOT_SENT : s.notifications.daily ? `On${s.notifications.dailyTime ? `, ${s.notifications.dailyTime}` : ''}` : 'Off' },
        { label: 'Catalogue day', value: s?.notifications?.catalogueDay === undefined ? NOT_SENT : s.notifications.catalogueDay ? `On${s.notifications.catalogueWeekday !== undefined ? `, ${DAYS[s.notifications.catalogueWeekday]}` : ''}` : 'Off' },
      ],
      note: on,
    },
    {
      title: 'Sync and backups',
      rows: [
        { label: 'Takes from the household', value: tabNames ? (tabNames.length ? tabNames.join(', ') : 'Nothing') : NOT_SENT },
        { label: 'Away from home', value: s?.away ? (AWAY[s.away] ?? s.away) : NOT_SENT },
        { label: 'Automatic backups', value: s?.backups ? (s.backups.on ? `Every ${s.backups.everyDays ?? 7} days, keep ${s.backups.keep ?? 5}` : 'Off') : NOT_SENT },
        { label: 'Keeps prices for', value: s?.historyWeeks ? historyLabel(s.historyWeeks) : NOT_SENT },
      ],
      note: on,
    },
    {
      title: 'Home Assistant',
      rows: [
        // From the household's own row (synced), so it's right even before the phone sends its summary.
        { label: 'Syncs the shopping list', value: haPhone ? 'Yes, for the household' : 'No' },
        { label: 'Shopping list', value: s?.homeAssistant ? (s.homeAssistant.on ? `On${s.homeAssistant.entity ? ` · ${s.homeAssistant.entity}` : ''}` : 'Off') : NOT_SENT },
      ],
      note: haPhone ? on : 'One phone per household. Turn it on on a phone to move it there',
    },
    {
      title: 'Look and text size',
      rows: [
        { label: 'Theme', value: s?.look?.theme ? THEME[s.look.theme] : NOT_SENT },
        { label: 'Text size', value: s?.look?.text ?? NOT_SENT },
      ],
      note: on,
    },
    {
      title: 'Receipts and shared prices',
      rows: [
        { label: 'Receipts', value: onOff(s?.receipts) },
        { label: 'Shared prices', value: onOff(s?.sharedPrices) },
      ],
      note: on,
    },
    {
      title: 'About and updates',
      rows: [
        { label: 'Restock on this phone', value: s?.version ?? NOT_SENT },
        { label: 'Update checks', value: s?.updates ? (s.updates.on ? (s.updates.everyDays === 7 ? 'Every 7 days' : 'Every 24 hours') : 'Off') : NOT_SENT },
      ],
      note: 'Phone updates happen on the phone',
    },
  ];
}

function settingsOf(d: Device, names: Map<string, string>, owner: string | undefined, sent: PhoneInfo | undefined, ha: string | undefined): PhoneSettings {
  const name = sent?.name ?? d.name ?? names.get(d.device) ?? 'Phone';
  return {
    device: d.device,
    name,
    isOwner: sent?.owner ?? (!!owner && owner === d.device),
    lastSeen: d.lastSeen ?? d.seen ?? sent?.syncedAt,
    version: sent?.version,
    sent: !!sent,
    homeAssistant: !!ha && ha === d.device,
    groups: phoneGroups(name, sent?.summary, !!ha && ha === d.device),
  };
}

/**
 * 0.9.3: which phone syncs the shopping list with Home Assistant, from the household's row (read
 * only here: it's moved by turning Home Assistant on on a phone). Null: none does.
 */
export async function homeAssistantPhone(): Promise<{ device: string; name: string } | null> {
  const who = await haPhone();
  return who.device && !who.left ? { device: who.device, name: who.name ?? 'another phone' } : null;
}

/**
 * The phones on this server (the server's own list), each with the summary of its own settings it
 * sent (phones on Restock 0.9.3 or newer; older ones read "Not sent yet").
 */
export function usePhones(): { phones?: PhoneSettings[]; error?: string; reload: () => void } {
  const [devices, setDevices] = useState<Device[]>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const sent = useLive(phoneSummaries, []);
  const ha = useLive(homeAssistantPhone, []);
  useEffect(() => {
    let live = true;
    // 0.9.4, a house: the server's phones (the active ones; removed and left ones are on Server and phones).
    const load: Promise<Device[]> = isV3()
      ? api3.phones().then((list) =>
          list
            .filter((p) => !p.status || p.status === 'active')
            .map((p) => ({ device: p.device, name: p.label || p.name, added: p.added, lastSeen: p.lastSeen })),
        )
      : api.devices();
    load
      .then((d) => {
        if (!live) return;
        setDevices(d);
        setError(undefined);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [tick]);
  const owner = householdInfo().owner;
  const names = memberNames();
  const phones = devices
    ?.map((d) => settingsOf(d, names, owner, sent?.find((x) => x.device === d.device), ha?.device))
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.name.localeCompare(b.name));
  return { phones, error, reload: () => setTick((t) => t + 1) };
}

/**
 * Takes a phone off this server (it stops syncing here), after asking: in a house (v3) with the
 * passphrase again (0.9.4), otherwise a plain confirm. False if it wasn't. Taking it out of the
 * household is the owner phone's on a 0.9.3-style server.
 */
export async function removePhone(device: string, ask: { title: string; detail: string; action: string }): Promise<boolean> {
  if (isV3()) return (await askThenConfirm(ask.title, ask.detail, ask.action, (c) => api3.removePhone(device, c).then(() => true))) === true;
  if (!(await confirmAction(ask.title, { detail: ask.detail, action: ask.action, danger: true }))) return false;
  await api.removeDevice(device);
  return true;
}

/** The loyalty cards the phones share, as the web knows them: the shop's name, never the number. */
export async function cardNames(): Promise<string[]> {
  return (await allCards()).map((c) => (c.program === 'other' ? c.label : (PROGRAMS[c.program]?.name ?? c.label)));
}
