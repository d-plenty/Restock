import { CHECK_INTERVALS, DEFAULT_SETTINGS, HISTORY_WEEKS, keepDays, keepWeeks, type HomeArea, type Settings, type ShopAccount, type StoreChoice } from '../types';
import { SECTIONS, isLocalOnlyShop, shopDef, type CustomShop, type Section, type StoreChain } from '../shops';
import { isCheckTime } from './checkSchedule';
import { ICON_COLOURS } from './looks';
import { asHttps, searchOnSite } from './site';

// 0.9.0: checking settings before Restock uses them. Settings can come from this phone's own
// database, a backup file, or another phone in the household, and any of those can hold something
// odd (an older version's shape, a damaged file, or a file someone made up). Every setting is
// checked against what it can be: the wrong kind of value gets the default, a choice has to be one
// of the real choices, numbers are kept within sensible limits, and lists have to be lists.
// Anything Restock doesn't know about is left out. Nothing here touches the database.

/** Keep receipts for 1, 2, 3, 6 or 12 months, or until deleted (0). The choices in Receipts. */
export const KEEP_MONTHS = [1, 2, 3, 6, 12, 0];

/** Text size choices run from normal (1) to largest (1.5), in Accessibility. */
const TEXT_MIN = 1;
const TEXT_MAX = 1.5;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const maybeBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
/** Some text, or undefined when it's empty, not text, or longer than `max` (cut text would be wrong text). */
const text = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v : undefined);
/** A name: trimmed and cut to length. */
const name = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const oneOf = <T>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const maybeOneOf = <T>(v: unknown, list: readonly T[]): T | undefined => (list.includes(v as T) ? (v as T) : undefined);
/** A number kept between `min` and `max` (rounded when it must be whole); anything else is `d`. */
const number = (v: unknown, d: number, min: number, max: number, whole = false): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return d;
  return Math.min(max, Math.max(min, whole ? Math.round(v) : v));
};
/** A day of the week, 0 (Sunday) to 6 (Saturday). */
const weekday = (v: unknown, d: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6 ? v : d);
/** A date and time Restock wrote (an ISO date). */
const when = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined);
/** A list of short texts, without repeats. */
const words = (v: unknown, d: string[], max = 300): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length <= 100))].slice(0, max) : d;
/** A list of tabs, or undefined when there are none. */
const tabs = (v: unknown): Section[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const t = SECTIONS.filter((s) => v.includes(s));
  return t.length ? t : undefined;
};
const HEX = /^#[0-9a-f]{6}$/i;
const colour = (v: unknown): string | undefined => (typeof v === 'string' && HEX.test(v) ? v : undefined);
/** "07:30" (Android's time picker can add seconds). */
const TIME = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const CUSTOM_ID = /^custom-[A-Za-z0-9_-]{1,40}$/;
const ICONS = [...ICON_COLOURS.map((c) => c.id), 'match'];

/** Drops keys whose value is undefined, so the saved settings stay tidy. */
function compact<T extends object>(o: T): T {
  const r = o as Obj;
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return o;
}

/** An address that parses as a web address (http is allowed here: a home server may not have https). */
function webAddress(v: unknown): string | undefined {
  const t = text(v, 500);
  if (!t) return undefined;
  try {
    return /^https?:$/.test(new URL(t).protocol) ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A shop the person added, or undefined if it can't be used. Its website has to be a proper web
 * address (an http one is moved to https), and its search page, if it has one, has to be on the
 * same site with {q} where the words go. `strict` (backups and households): a shop whose search
 * page is anywhere else is left out altogether. Otherwise (this phone's own shops) only that
 * search page is dropped, and Restock finds the search page on the shop's own site again.
 */
export function checkCustomShop(v: unknown, strict = false): CustomShop | undefined {
  if (!isObj(v)) return undefined;
  const id = typeof v.id === 'string' && CUSTOM_ID.test(v.id) ? (v.id as CustomShop['id']) : undefined;
  const shopName = name(v.name, 80);
  const site = asHttps(typeof v.website === 'string' ? v.website : undefined);
  const section = maybeOneOf(v.section, SECTIONS);
  if (!id || !shopName || !site || !section) return undefined;
  const raw = String(v.website).trim();
  const website = /^https:\/\//i.test(raw) ? raw : /^http:\/\//i.test(raw) ? raw.replace(/^http:/i, 'https:') : site.origin;
  const typed = typeof v.search === 'string' && v.search.trim() ? v.search : undefined;
  const search = typed ? searchOnSite(typed, website) : undefined;
  if (typed && !search && strict) return undefined;
  return compact({ id, name: shopName, website, section, search, createdAt: text(v.createdAt, 40) ?? '' });
}

const STORE_FIELDS = ['primary', 'secondary', 'storeId', 'primaryMap', 'branchStoreNo', 'branchStoreNo2', 'secondaryMap', 'householdBranch', 'householdStoreNo'] as const;

function storeChoiceOf(v: unknown): StoreChoice {
  const o = obj(v);
  const out: StoreChoice = {};
  for (const k of STORE_FIELDS) {
    const t = text(o[k], 160);
    if (t) out[k] = t;
  }
  return out;
}

function accountOf(v: unknown): ShopAccount | undefined {
  if (!isObj(v) || typeof v.signedIn !== 'boolean') return undefined;
  return compact({ signedIn: v.signedIn, storeId: text(v.storeId, 40), storeName: text(v.storeName, 160), checkedAt: when(v.checkedAt) });
}

function areaOf(v: unknown): HomeArea | undefined {
  if (!isObj(v)) return undefined;
  const { lat, lon } = v;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { label: name(v.label, 120) ?? 'Your area', lat, lon };
}

/**
 * Settings Restock can use, from whatever was saved or sent. See the top of this file. `strict`
 * is for settings from a backup or another phone (see checkCustomShop).
 */
export function checkSettings(raw: unknown, opts: { strict?: boolean } = {}): Settings {
  const s = obj(raw);
  const D = DEFAULT_SETTINGS;

  const customShops: CustomShop[] = [];
  if (Array.isArray(s.customShops))
    for (const x of s.customShops) {
      const c = checkCustomShop(x, opts.strict);
      if (c && !customShops.some((m) => m.id === c.id)) customShops.push(c);
    }
  const customIds = new Set<string>(customShops.map((c) => c.id));
  const isShop = (c: unknown): c is StoreChain => typeof c === 'string' && ((!!shopDef(c) && !isLocalOnlyShop(c)) || customIds.has(c));

  const stores: Settings['stores'] = {};
  for (const c of Object.keys(D.stores) as StoreChain[]) stores[c] = {};
  if (isObj(s.stores)) for (const [k, v] of Object.entries(s.stores)) if (isShop(k) && isObj(v)) stores[k] = storeChoiceOf(v);

  const sec = obj(s.sections);
  const a = obj(s.alerts);
  const sy = obj(s.sync);
  const lk = obj(s.look);
  const ax = obj(s.a11y);
  const su = obj(s.setup);
  const tr = obj(s.tour);
  const rc = obj(s.receipts);
  const rl = obj(s.recalls);
  const ab = obj(s.autoBackup);
  const w = obj(s.widgets);
  const md = obj(s.marketData);
  const weeks = keepWeeks(typeof s.historyWeeks === 'number' && HISTORY_WEEKS.includes(s.historyWeeks) ? s.historyWeeks : D.historyWeeks);
  const acc = obj(s.accounts);
  const accounts = isObj(s.accounts) ? compact({ woolworths: accountOf(acc.woolworths), coles: accountOf(acc.coles), costco: accountOf(acc.costco) }) : undefined;

  return compact<Settings>({
    onboarded: bool(s.onboarded, D.onboarded),
    stores,
    // 0.9.7: Costco switched on in 0.9.6's own setting becomes one of the picked shops.
    enabledChains: (() => {
      const picked = Array.isArray(s.enabledChains) ? [...new Set(s.enabledChains.filter(isShop))] : [...D.enabledChains];
      const was = obj(s.costco);
      if (bool(was.on, false) && !!when(was.acceptedAt) && !picked.includes('costco')) picked.push('costco');
      return picked;
    })(),
    sections: {
      keg: bool(sec.keg, D.sections.keg),
      pharmacy: bool(sec.pharmacy, D.sections.pharmacy),
      // 0.10.3 (beta): only written once switched on.
      ...(sec.baby === true ? { baby: true } : {}),
      ...(sec.pets === true ? { pets: true } : {}),
    },
    hiddenTabs: tabs(s.hiddenTabs),
    // 0.10.3: the tabs a shop is in, when it isn't just its own (shops known here, at least one tab).
    shopTabs: (() => {
      if (!isObj(s.shopTabs)) return undefined;
      const out: Partial<Record<string, Section[]>> = {};
      for (const [k, v] of Object.entries(s.shopTabs)) {
        const t = tabs(v);
        if (isShop(k) && t) out[k] = t;
      }
      return Object.keys(out).length ? out : undefined;
    })(),
    customShops,
    adultConfirmed: maybeBool(s.adultConfirmed),
    alerts: {
      catalogueDay: bool(a.catalogueDay, D.alerts.catalogueDay),
      catalogueWeekday: weekday(a.catalogueWeekday, D.alerts.catalogueWeekday),
      daily: bool(a.daily, D.alerts.daily),
      dailyTime: typeof a.dailyTime === 'string' && TIME.test(a.dailyTime) ? a.dailyTime : D.alerts.dailyTime,
      greatDeals: bool(a.greatDeals, D.alerts.greatDeals),
      monthly: bool(a.monthly, D.alerts.monthly),
      stockUp: bool(a.stockUp, D.alerts.stockUp),
      stockUpTips: bool(a.stockUpTips, D.alerts.stockUpTips),
    },
    sync: compact({
      mode: oneOf(sy.mode, ['device', 'server'] as const, D.sync.mode),
      serverUrl: webAddress(sy.serverUrl),
      schedule: oneOf(sy.schedule, ['background', 'daily', 'weekly'] as const, D.sync.schedule),
      weekday: weekday(sy.weekday, D.sync.weekday),
      backgroundActivity: bool(sy.backgroundActivity, D.sync.backgroundActivity),
    }),
    household: { name: name(obj(s.household).name, 80) ?? D.household.name },
    sharePrices: oneOf(s.sharePrices, ['unasked', 'yes', 'no'] as const, D.sharePrices),
    ...(isObj(s.beta) ? { beta: { enabled: bool(s.beta.enabled, false) } } : {}),
    ...(isObj(s.yourData) ? { yourData: { server: bool(s.yourData.server, true) } } : {}),
    ...(isObj(s.shopSort) && ['aisle', 'category', 'az'].includes(s.shopSort.by as string)
      ? { shopSort: { by: s.shopSort.by as 'aisle' | 'category' | 'az', ...(s.shopSort.down === true ? { down: true } : {}) } }
      : {}),
    defaultThresholdPct: number(s.defaultThresholdPct, D.defaultThresholdPct, 1, 90),
    checkIntervalHours: oneOf(s.checkIntervalHours, CHECK_INTERVALS, D.checkIntervalHours),
    // 0.9.14: 8 weeks, 6 months or 12 months (1 and 3 months become the next one up).
    historyWeeks: weeks,
    checkWeekday: weekday(s.checkWeekday, D.checkWeekday),
    // 0.9.6: HH:MM; anything else is 5:00 am. A 0.9.5 phone's file has none, which is the same.
    checkTime: isCheckTime(s.checkTime) ? s.checkTime : D.checkTime,
    connection: oneOf(s.connection, ['auto', 'browser'] as const, D.connection),
    localPrices: maybeBool(s.localPrices),
    accounts: accounts && Object.keys(accounts).length ? accounts : undefined,
    // 0.9.6: Costco is on only when the person read the notice and turned it on (acceptedAt is the proof): a
    // file or phone that says "on" without it leaves it off.
    costco: isObj(s.costco)
      ? compact({
          on: bool(obj(s.costco).on, false) && !!when(obj(s.costco).acceptedAt),
          buyOnline: maybeBool(obj(s.costco).buyOnline),
          acceptedAt: when(obj(s.costco).acceptedAt),
          // 0.9.6 (review L1): item ids, at most 2,000 short ones.
          notAt: Array.isArray(obj(s.costco).notAt)
            ? [...new Set((obj(s.costco).notAt as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100))].slice(0, 2000)
            : undefined,
        })
      : undefined,
    theme: oneOf(s.theme, ['system', 'light', 'dark'] as const, D.theme),
    listCompare: oneOf(s.listCompare, ['unit', 'price'] as const, D.listCompare),
    shopAroundMin: number(s.shopAroundMin, D.shopAroundMin, 0, 1000),
    productOrder: maybeOneOf(s.productOrder, ['size', 'cheapest', 'name'] as const),
    otherContainerSizes: bool(s.otherContainerSizes, D.otherContainerSizes),
    updates: isObj(s.updates)
      ? compact({
          notify: bool(s.updates.notify, false),
          lastCheck: when(s.updates.lastCheck),
          told: text(s.updates.told, 40),
          everyDays: s.updates.everyDays === 7 ? 7 : undefined,
        })
      : D.updates,
    privacyAccepted: text(s.privacyAccepted, 60),
    seenHints: words(s.seenHints, [...D.seenHints]),
    seenTabOffers: tabs(s.seenTabOffers),
    lastBackupAt: when(s.lastBackupAt),
    backupNudgeAt: when(s.backupNudgeAt),
    marketData: {
      // 0.10.0: one switch, Shared prices: on exactly when sending prices back is.
      enabled: (s.sharePrices ?? D.sharePrices) !== 'no',
      wifiOnly: bool(md.wifiOnly, D.marketData.wifiOnly),
      // 0.9.14: follows how far back Restock looks (historyWeeks).
      days: keepDays(weeks),
      every: md.every === 'daily' ? 'daily' : 'weekly',
    },
    // 0.9.11: price helper phone mode.
    ...(isObj(s.priceHelper)
      ? {
          priceHelper: {
            enabled: bool(s.priceHelper.enabled, false),
            url: text(s.priceHelper.url, 200),
            key: text(s.priceHelper.key, 200),
            searches: Array.isArray(s.priceHelper.searches)
              ? (s.priceHelper.searches as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim() && x.length <= 60).slice(0, 1000)
              : undefined,
          },
        }
      : {}),
    area: areaOf(s.area),
    lastCheck: when(s.lastCheck),
    demoLoaded: maybeBool(s.demoLoaded),
    look: compact({
      style: oneOf(lk.style, ['australia', 'plain'] as const, D.look.style),
      // The accent is a colour ("#ffcd00"): one of the swatches, or any colour from the colour wheel.
      accent: colour(lk.accent),
      icon: oneOf(lk.icon, ICONS, D.look.icon),
      black: maybeBool(lk.black),
    }),
    a11y: {
      text: number(ax.text, D.a11y.text, TEXT_MIN, TEXT_MAX),
      contrast: bool(ax.contrast, D.a11y.contrast),
      motion: bool(ax.motion, D.a11y.motion),
      big: bool(ax.big, D.a11y.big),
    },
    setup: compact({ done: words(su.done, []), skipped: words(su.skipped, []), dismissed: maybeBool(su.dismissed) }),
    tour: compact({
      seen: maybeBool(tr.seen),
      active: maybeBool(tr.active),
      step: typeof tr.step === 'number' && Number.isInteger(tr.step) && tr.step >= 0 ? Math.min(tr.step, 100) : undefined,
      addedSamples: maybeBool(tr.addedSamples),
    }),
    receipts: {
      enabled: bool(rc.enabled, D.receipts.enabled),
      installed: bool(rc.installed, D.receipts.installed),
      keepMonths: oneOf(rc.keepMonths, KEEP_MONTHS, D.receipts.keepMonths),
    },
    recalls: compact({ enabled: bool(rl.enabled, D.recalls.enabled), lastCheck: when(rl.lastCheck) }),
    autoBackup: compact({
      enabled: bool(ab.enabled, D.autoBackup.enabled),
      folder: text(ab.folder, 2000),
      folderName: text(ab.folderName, 200),
      everyDays: number(ab.everyDays, D.autoBackup.everyDays, 1, 30, true),
      keep: number(ab.keep, D.autoBackup.keep, 1, 20, true),
      receiptPhotos: maybeBool(ab.receiptPhotos),
      // Never changed, only kept or not: a cut or tidied password wouldn't open the backups.
      password: typeof ab.password === 'string' && ab.password.length > 0 && ab.password.length <= 1000 ? ab.password : undefined,
      lastAt: when(ab.lastAt),
      lastError: name(ab.lastError, 500),
    }),
    cartPush: { experimental: bool(obj(s.cartPush).experimental, D.cartPush.experimental) },
    widgets: {
      background: oneOf(w.background, ['solid', 'colour', 'none'] as const, D.widgets.background),
      colour: colour(w.colour) ?? D.widgets.colour,
      transparency: number(w.transparency, D.widgets.transparency, 0, 90, true),
      text: w.text === 'auto' ? 'auto' : (colour(w.text) ?? D.widgets.text),
    },
  });
}
