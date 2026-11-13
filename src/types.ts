// Core data types. Everything here is stored on the device in SQLite.

import type { Chain, CustomShop, ListSection, Section, StoreChain } from './shops';
export type { Chain, CustomShop, ListSection, Section, StoreChain } from './shops';
export { chainName } from './shops';

/** Base unit used for unit-price comparison. */
export type BaseUnit = 'g' | 'ml' | 'ea';

/** One specific product at one specific chain (e.g. "Coles brand toilet paper 24pk"). */
export interface Product {
  id: string;
  chain: Chain;
  name: string;
  brand?: string;
  size?: string; // as the store writes it, e.g. "500 sheets", "1kg"
  barcode?: string;
  storeProductId?: string; // Woolworths stockcode / Coles id / Aldi sku
  imageUrl?: string;
  /** Amount in base units used for unit pricing (e.g. 1000 for 1kg). User can override. */
  qty?: number;
  qtyUnit?: BaseUnit;
  /** Online stock last time it was checked; undefined = the store doesn't say. */
  inStock?: boolean;
  stockAt?: string;
  /** Coles, with your store's prices on: in stock at your second Coles (checked with each price check). */
  inStock2?: boolean;
  createdAt: string;
  /** Shared price history for this product (from a downloaded summary), when there is one. Not stored on the product. */
  market?: MarketSummary;
  /** 0.9.6: the size worked out for it (from its words, a barcode match or a look-alike). Not stored on the product; see lib/unitPrice.ts. */
  sizing?: Sizing;
}

/** How a size was found: the person typed it, the shop's words say it, the same barcode elsewhere, or worked out from a look-alike. */
export type SizeBasis = 'confirmed' | 'shop' | 'barcode' | 'estimated';

/** 0.9.6: what Restock knows about how much is in a product (lib/unitPrice.ts). */
export interface Sizing {
  /** The size used for comparing. Missing when it isn't known (a guess below is only a suggestion). */
  size?: { qty: number; unit: BaseUnit; count?: number; basis: SizeBasis; from?: string };
  /** A common-size guess (375 mL cans). Never used for comparing: it is only offered to the person to confirm. */
  guess?: { qty: number; unit: BaseUnit; count?: number; why: string };
  /** How many are in the pack, when the name or size says. */
  packCount?: number;
  /** No size to compare by. */
  unknown: boolean;
}

/**
 * A summary of a product's recent price history from a shared source (restock-prices, or hotprices.org),
 * so new items can be judged from day one. Worked out on the phone from the downloaded file.
 */
export interface MarketSummary {
  /** The usual shelf price: the price it sat at most, among the higher prices. */
  normal: number;
  /** The usual sale price, when it went on sale. */
  sale?: number;
  /** Share of days it was on sale (0 to 1). */
  saleShare: number;
  low: number;
  cycleWeeks?: number;
  /** Its latest price in the shared history, used to match the summary to local prices. */
  latest?: number;
  /** Days of history the summary covers. */
  days: number;
  source: string;
  updatedAt: string;
}

export type AlertLevel = 'any' | 'good' | 'great' | 'custom' | 'never';

/** Sale thresholds, as a fraction off the normal price. Mirrored in Deals.java. */
export const GOOD_SALE = 0.15;
export const GREAT_SALE = 0.3;

/**
 * A pantry entry: the thing you buy (the "main product", which may be stocked by several
 * chains) plus alternatives you'd happily buy instead.
 *
 * Storage note: the main product at each store is `usualProductId` + `sameProductIds`
 * (old column names, kept so the Android worker and backups don't change shape).
 */
export interface Group {
  id: string;
  name: string;
  categoryId?: string;
  /** First main product. */
  usualProductId?: string;
  /** The main product at other stores. */
  sameProductIds: string[];
  /** Different products you'd accept instead. */
  altProductIds: string[];
  /** For alertLevel 'custom': alert at this % off or more. Stored in the threshold_pct column. */
  alertPct?: number;
  alertLevel: AlertLevel;
  /**
   * May Restock suggest a bigger pack (a 6-pack instead of one can) because it's cheaper per
   * 100 g? Off means bigger packs are never picked as swaps. Undefined (older items) means yes.
   */
  allowBulk?: boolean;
  /**
   * Do multi-buy deals ("2 for $12") count for this item? Off means its price is always the price
   * for one, and a multi-buy alone isn't a sale. Undefined (older items) means yes.
   */
  allowMulti?: boolean;
  /** Which tab it's on (Pantry, Keg or Pharmacy). Undefined (older items) means Pantry. */
  section?: Section;
  /** "Alert me under $X": tell me when any of my shops has it at or below this price. */
  targetPrice?: number;
  /**
   * Any size (0.8.9): any pack and any number of them will do, so at each shop Restock works out
   * the cheapest way to get the amount you usually buy (three 500 g bags instead of a 1.5 kg one).
   * Off ("This size") means one of your picks, as many as are on the list.
   */
  anySize?: boolean;
  /** Shops you don't buy this at ("Not at this shop", 0.8.9): Restock stops asking you to find it there. */
  notAt?: string[];
  createdAt: string;
}

export function mainProductIds(g: Group): string[] {
  return [g.usualProductId, ...g.sameProductIds].filter((x): x is string => !!x);
}

export interface PriceReading {
  id?: number;
  productId: string;
  date: string; // ISO datetime
  price: number; // shelf price paid (dollars)
  wasPrice?: number;
  isSpecial: boolean;
  memberOnly: boolean; // needs Flybuys / Everyday Rewards
  promo?: string;
  source: 'auto' | 'manual' | 'demo' | 'imported';
}

/** A shop receipt kept in Restock (the Receipts add-on). The photo lives in Restock's private storage, not the phone's photos. */
export interface Receipt {
  id: string;
  /** When it was scanned; how long it's kept counts from here. */
  scannedAt: string;
  /** The shop as written on the receipt ("Woolworths Newtown"). */
  shop?: string;
  chain?: Chain;
  /** The date printed on the receipt (YYYY-MM-DD). */
  receiptDate?: string;
  total?: number;
  /** Which tab it's for. */
  section: Section;
  note?: string;
  /** The words read off the receipt. */
  text?: string;
  /** The photo, as a path in Restock's private storage (receipts/<id>.jpg). */
  photo?: string;
  /** A long receipt taken in several photos: the ones after the first (receipts/<id>-2.jpg …). */
  pages?: string[];
  /** Kept however long the keep setting is. */
  pinned: boolean;
}

export interface ListEntry {
  id: string;
  text: string;
  groupId?: string;
  chain?: Chain;
  categoryId?: string;
  /** How many to buy (1 if not set). */
  qty?: number;
  /** The shelf price when it was added, for lines not linked to a pantry item (a one-off buy). */
  price?: number;
  /**
   * Which list it's on, for lines that aren't linked to a pantry item. Linked lines follow their item.
   * 0.9.5: 'general' is the General list (no pantry): lines Home Assistant added that matched nothing,
   * or put there by hand.
   */
  section?: ListSection;
  /** For a one-off buy found at a shop (0.7.3): what it is, so the list can show its photo and details. */
  product?: ListProduct;
  checked: boolean;
  createdAt: string;
}

/** A snapshot of the shop's product behind a one-off list line. */
export interface ListProduct {
  chain: Chain;
  name: string;
  brand?: string;
  size?: string;
  imageUrl?: string;
  storeProductId?: string;
  unitText?: string;
}

export type CardProgram = 'flybuys' | 'everyday' | 'other';

export interface LoyaltyCard {
  id: string;
  program: CardProgram;
  label: string;
  number: string;
  createdAt: string;
}

// ---------- 0.9.6 (cards): gift cards, beside loyalty cards on the Cards screen ----------
// Kept on this phone only (table gift_cards, never synced, never on a Restock server), or on the
// web in this browser only (src/server-mode/cardStore.ts). In a backup for the person themself.

/** How a gift card's barcode is drawn for the till. */
export type GiftBarcodeType = 'CODE128' | 'QR' | 'EAN';

/** One "update balance": what the balance was after it. */
export interface GiftBalanceEntry {
  /** When (ISO). */
  at: string;
  balance: number;
}

export interface GiftCard {
  id: string;
  /** The card or shop name ("Myer", "Bunnings"). */
  name: string;
  /** What the barcode holds (often the card number). Empty: no barcode drawn. */
  barcode?: string;
  barcodeType: GiftBarcodeType;
  /** The card number, separate from the barcode. */
  number?: string;
  /** 4 to 8 digits, hidden until tapped. */
  pin?: string;
  /** Balance now, in dollars. */
  balance?: number;
  /** The last few balance updates, oldest first (at most GIFT_HISTORY_MAX). */
  history?: GiftBalanceEntry[];
  /** Expiry date, YYYY-MM-DD. */
  expiry?: string;
  /** Remind this many days before it expires (0 or missing: no reminder). Phone only. */
  remindDays?: number;
  notes?: string;
  /** Photos of the front and back: paths in Restock's own storage (cardPhotos.ts), never the gallery. */
  photoFront?: string;
  photoBack?: string;
  /** One of CARD_COLOURS (giftCards.ts). */
  colour: string;
  /** Used up: kept, out of the way, under "Used up". */
  usedUp?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  order: number;
  section: Section;
}

export interface ShopAccount {
  /** Signed in, as last checked with the shop. */
  signedIn: boolean;
  /** The store the account shops at, when the shop says (Woolworths: its pick-up or delivery store). */
  storeId?: string;
  storeName?: string;
  checkedAt?: string;
}

export interface StoreChoice {
  primary?: string; // store name for the user's reference
  secondary?: string;
  storeId?: string; // advanced: chain's own store id (Coles), Aldi service point
  /** The map ids of the picked branches, so same-named branches are never mixed up. */
  primaryMap?: string;
  /**
   * Coles only: the store number of your branch (from the map, or the store's page link), used for
   * its own prices and stock when "Prices and stock at my store" is on.
   */
  branchStoreNo?: string;
  /** Coles only: your second branch's store number, for its stock. */
  branchStoreNo2?: string;
  secondaryMap?: string;
  /**
   * 0.9.4: the household's default branch (a household_settings branch:<chain> row) this phone took
   * because it hadn't picked its own; while `primary` is still this, a new default replaces it.
   */
  householdBranch?: string;
  householdStoreNo?: string;
}

/** Where to look for nearby stores. Only ever kept on this phone. */
export interface HomeArea {
  label: string; // e.g. "Bohle Plains QLD 4817"
  lat: number;
  lon: number;
}

export type ProductOrder = 'size' | 'cheapest' | 'name';

export interface Settings {
  onboarded: boolean;
  /** Your store at each shop, by shop id. Look up with storeChoice(). */
  stores: Partial<Record<StoreChain, StoreChoice>>;
  /** The shops you use, in every section. */
  enabledChains: StoreChain[];
  /** Keg and Pharmacy tabs: switched on? (They also need at least one shop picked.) */
  sections: { keg: boolean; pharmacy: boolean };
  /**
   * Tabs left out of the bottom bar. Their shops still come up on Add and the shopping list, for
   * the odd bottle of wine you don't want to track.
   */
  hiddenTabs?: Section[];
  /** Shops you added yourself (a website and a name). */
  customShops: CustomShop[];
  /** Confirmed 18 or over, for the Keg tab. */
  adultConfirmed?: boolean;
  alerts: {
    catalogueDay: boolean;
    catalogueWeekday: number; // 0=Sun … 6=Sat, default 3 (Wed)
    daily: boolean;
    dailyTime: string; // "07:30"
    greatDeals: boolean;
    monthly: boolean;
    stockUp: boolean;
    /** Stock-up tips with deal alerts ("usually on sale every 6 weeks, a good time to stock up"). */
    stockUpTips: boolean;
  };
  sync: {
    mode: 'device' | 'server';
    serverUrl?: string;
    schedule: 'background' | 'daily' | 'weekly';
    weekday: number; // default 3 (Wed)
    backgroundActivity: boolean;
  };
  household: { name: string };
  /**
   * Shared prices (0.10.0, one switch with marketData.enabled): on unless 'no'. Sends the shop prices
   * this phone reads to restock-prices (priceShare.ts) and gets the shared history (market.ts).
   */
  sharePrices: 'unasked' | 'yes' | 'no';
  /** 0.9.13: Beta and development features shown (this phone only). */
  beta?: { enabled: boolean };
  /**
   * 0.10.0: Your data with a Restock server: share this phone's spending with it and show the
   * household's figures (on unless turned off), or keep this phone's own.
   */
  yourData?: { server: boolean };
  /**
   * 0.10.2: how shopping mode sorts each shop's lines: by aisle (the default; 1 to 50, or 50 to 1
   * with `down`), by category (your aisle groups), or A–Z. Picking one in shopping mode saves it.
   */
  shopSort?: { by: 'aisle' | 'category' | 'az'; down?: boolean };
  defaultThresholdPct: number;
  /** How often background price checks run. 168 = weekly, on checkWeekday. */
  checkIntervalHours: number;
  /**
   * 0.9.6: the time of day price checks run, "HH:MM" on the phone's own clock (5:00 am when not set).
   * With every 12 hours, this and 12 hours later. This phone's own: never shared with the household.
   */
  checkTime?: string;
  /** How long price history is kept on the phone, in weeks. */
  historyWeeks: number;
  checkWeekday: number; // 0=Sun … 6=Sat, default 3 (Wed)
  /** How the phone talks to the stores: direct with a hidden-browser backup, or always the browser. */
  connection: 'auto' | 'browser';
  /** Testing: ask Coles for your branch's prices and stock instead of its online store's. */
  localPrices?: boolean;
  /**
   * Shop accounts you've signed in to inside Restock (0.6.12). Woolworths only shows your store's
   * prices and stock, and lets Restock fill your trolley, when you're signed in.
   */
  accounts?: { woolworths?: ShopAccount; coles?: ShopAccount; costco?: ShopAccount };
  /**
   * 0.9.6: Costco on this phone (src/stores/costco.ts). Off unless `on`, which needs `acceptedAt`: the day
   * the person read the notice (lib/costcoNotice.ts) and turned it on. `buyOnline` ("I buy from Costco online"):
   * only then do Costco's online prices count when working out the cheapest shop; otherwise they are shown for
   * information. This phone's own: never shared with the household or the server, never in a backup file.
   * 0.9.6 (review L1): `notAt`, the items this phone said "Not at Costco" for (item ids), kept here rather
   * than in the shared item, so the household and the server are never told this phone uses Costco.
   */
  costco?: { on: boolean; buyOnline?: boolean; acceptedAt?: string; notAt?: string[] };
  theme: 'system' | 'light' | 'dark';
  /** Shopping list: cheapest by best value (per 100 g / litre / item) or by lowest shelf price. */
  listCompare: 'unit' | 'price';
  /** Shopping around is only recommended over one store with everything when it saves at least this much (0.9.0). */
  shopAroundMin: number;
  /** The order of an item's products (0.7.6): by shop then size, cheapest first, or A to Z. */
  productOrder?: ProductOrder;
  /**
   * 0.9.1: "Other sizes of this" when adding an item also shows other can, bottle or jar sizes of the
   * same product (1.25L bottles as well as 375mL cans), not just other packs of the same size. Off by default.
   */
  otherContainerSizes: boolean;
  /** New versions on GitHub (0.7.3): tell me once a week, when I last looked, and the last one I was told about. */
  /** everyDays (0.9.3): how often to check, 1 or 7 (every 24 hours if not set). */
  updates?: { notify: boolean; lastCheck?: string; told?: string; everyDays?: number };
  /** Date of the privacy policy the person accepted. */
  privacyAccepted?: string;
  /** One-time hints already dismissed. */
  seenHints: string[];
  /** 0.8.5: tabs the household started sharing that this phone was already asked about (yes or no). */
  seenTabOffers?: Section[];
  /** When a backup was last exported, and when the reminder was last put off. */
  lastBackupAt?: string;
  backupNudgeAt?: string;
  /** Shared price history download (testing): off until turned on. */
  /** 0.9.13: `days`, how much shared history: 56 (8 weeks, the default), 182 (6 months) or 365 (12 months). */
  /**
   * Judge new items from day one. 0.9.14: `days` follows historyWeeks (one setting, keepDays);
   * `every`: get new shared prices weekly (after Thursday's collection, the default) or daily.
   */
  marketData: { enabled: boolean; wifiOnly: boolean; days?: 56 | 182 | 365; every?: 'weekly' | 'daily' };
  /** 0.9.11: price helper phone mode (priceHelper.ts). This phone only, never shared. */
  priceHelper?: import('./lib/priceHelper').PriceHelperSettings;
  area?: HomeArea;
  lastCheck?: string;
  demoLoaded?: boolean;
  /** Colours: the Australian style (navy bars, green and gold) or plain; an accent colour; the app icon colour. */
  /** `black`: true black in dark mode, for OLED screens (0.8.9). On unless set to false (0.9.0). */
  look: { style: 'australia' | 'plain'; accent?: string; icon: string; black?: boolean };
  /** Accessibility: text size (1 = normal), high contrast, less motion, bigger buttons. */
  a11y: { text: number; contrast: boolean; motion: boolean; big: boolean };
  /** Setup tiles finished or skipped, and whether the "Finish setting up" card was dismissed. */
  setup: { done: string[]; skipped: string[]; dismissed?: boolean };
  /** The guided tour: finished (or dismissed), or running with sample items. */
  tour: { seen?: boolean; active?: boolean; step?: number; addedSamples?: boolean };
  /** Receipts add-on: switched on, its scanner and text reader downloaded, how long receipts are kept (0 = forever). */
  receipts: { enabled: boolean; installed: boolean; keepMonths: number };
  /** Recall alerts: checked once a day while on. */
  recalls: { enabled: boolean; lastCheck?: string };
  /** Automatic backups to a folder the person picked. */
  autoBackup: {
    enabled: boolean;
    folder?: string;
    folderName?: string;
    everyDays: number;
    keep: number;
    /** Put receipt photos in automatic backups (on unless turned off). */
    receiptPhotos?: boolean;
    /** 0.9.0: lock automatic backups with this password. Kept on this phone only, never in a backup. */
    password?: string;
    lastAt?: string;
    lastError?: string;
  };
  /** Sending lists to Coles or Woolworths: allow the experimental automatic way. */
  cartPush: { experimental: boolean };
  /** Home screen widgets: background (the app's own, a colour, or none), how see-through, and text colour ('auto' or a colour). */
  widgets: { background: 'solid' | 'colour' | 'none'; colour: string; transparency: number; text: string };
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  stores: { woolworths: {}, coles: {}, aldi: {} },
  enabledChains: ['woolworths', 'coles', 'aldi'],
  sections: { keg: false, pharmacy: false },
  customShops: [],
  alerts: {
    catalogueDay: true,
    catalogueWeekday: 3,
    daily: false,
    dailyTime: '07:30',
    greatDeals: true,
    monthly: false,
    stockUp: false,
    stockUpTips: true,
  },
  sync: { mode: 'device', schedule: 'background', weekday: 3, backgroundActivity: true },
  household: { name: 'Our house' },
  sharePrices: 'yes',
  defaultThresholdPct: 10,
  checkIntervalHours: 24,
  checkTime: '05:00',
  historyWeeks: 8,
  checkWeekday: 3,
  connection: 'auto',
  theme: 'system',
  listCompare: 'unit',
  shopAroundMin: 1,
  otherContainerSizes: false,
  seenHints: [],
  marketData: { enabled: true, wifiOnly: true, days: 56, every: 'weekly' },
  look: { style: 'australia', icon: 'green' },
  a11y: { text: 1, contrast: false, motion: false, big: false },
  setup: { done: [], skipped: [] },
  tour: {},
  receipts: { enabled: false, installed: false, keepMonths: 3 },
  recalls: { enabled: true },
  autoBackup: { enabled: false, everyDays: 7, keep: 5 },
  cartPush: { experimental: false },
  widgets: { background: 'solid', colour: '#012169', transparency: 0, text: 'auto' },
  // 0.9.11: on by default, every 24 hours (no longer asked in setup).
  updates: { notify: true },
};

export const CHECK_INTERVALS = [6, 12, 24, 48, 168];
/** Price history to keep: 1 month, 8 weeks (default), 3 months, 6 months, 12 months (0.9.1). */
export const HISTORY_WEEKS = [4, 8, 13, 26, 52];
/**
 * 0.9.14: how far back Restock looks, one setting (Settings → Prices and deals → Price history):
 * the prices this phone keeps, and the shared price history it gets for day one.
 */
export const KEEP_WEEKS = [8, 26, 52] as const;
/** An older choice (1 or 3 months) becomes the next one up, so no prices are lost. */
export const keepWeeks = (w: unknown): (typeof KEEP_WEEKS)[number] => KEEP_WEEKS.find((k) => typeof w === 'number' && w <= k) ?? (typeof w === 'number' && w > 52 ? 52 : 8);
export const keepDays = (w: number): 56 | 182 | 365 => (w >= 52 ? 365 : w >= 26 ? 182 : 56);
export const historyLabel = (w: number) =>
  w === 4 ? '1 month' : w === 13 ? '3 months' : w === 26 ? '6 months' : w === 52 ? '12 months' : `${w} weeks`;
/**
 * Under this much history, an item is still "learning" what its normal price is. A little under
 * four weeks, so items don't flicker back to "learning" when only 1 month of history is kept.
 */
export const LEARNING_DAYS = 25;

/** Your store at a shop (never undefined, so it's safe to read .primary). */
export const storeChoice = (s: Pick<Settings, 'stores'>, c: StoreChain): StoreChoice => s.stores[c] ?? {};

/**
 * The store to search at a shop: your Coles branch when "Prices and stock at my store" is on and
 * its number is known, else any store number typed by hand (Coles, or Aldi's service point).
 */
export const searchStoreId = (s: Pick<Settings, 'stores' | 'localPrices'>, c: StoreChain): string | undefined => {
  const ch = storeChoice(s, c);
  if (c === 'coles' && s.localPrices && ch.branchStoreNo) return ch.branchStoreNo;
  return ch.storeId || undefined;
};

/** Signed in to Woolworths inside Restock? */
export const wooliesAccount = (s: Pick<Settings, 'accounts'> | undefined) => !!s?.accounts?.woolworths?.signedIn;

/**
 * Is a shop's stock about your own store, and so worth showing? Woolworths when you're signed in;
 * Coles with your store number. Otherwise it's the shop's online stock, which isn't reliable for
 * your store, so Restock doesn't show it at all.
 */
export const stockKnown = (s: Pick<Settings, 'stores' | 'localPrices' | 'accounts'> | undefined, c: string): boolean => {
  if (!s) return false;
  if (c === 'woolworths') return wooliesAccount(s);
  if (c === 'coles') return !!(s.localPrices && storeChoice(s, 'coles').branchStoreNo);
  return false;
};

/** Is this shop's stock checked at your own branch? (Coles, with the testing setting on.) */
export const stockAtBranch = (s: Pick<Settings, 'stores' | 'localPrices' | 'accounts'> | undefined, c: string): string | undefined => {
  if (c === 'woolworths' && wooliesAccount(s)) {
    const w = s?.accounts?.woolworths;
    return w?.storeName ? `Woolworths ${w.storeName.replace(/^woolworths\s+/i, '')}` : 'your Woolworths';
  }
  if (!s || c !== 'coles' || !s.localPrices) return undefined;
  const ch = storeChoice(s, 'coles');
  return ch.branchStoreNo ? ch.primary || 'your Coles' : undefined;
};

/** Your second Coles, when its stock is checked too. */
export const secondBranch = (s: Pick<Settings, 'stores' | 'localPrices'> | undefined): string | undefined => {
  if (!s?.localPrices) return undefined;
  const ch = storeChoice(s, 'coles');
  return ch.branchStoreNo && ch.branchStoreNo2 ? ch.secondary || 'your other Coles' : undefined;
};

/** A Coles store number from a store page link ("…/find-stores/coles/qld/kirwan-0844") or the number itself. */
export function colesStoreNo(text: string): string | undefined {
  const t = text.trim();
  if (/^\d{3,5}$/.test(t)) return t;
  const m = /find-stores\/[^?#]*?-(\d{3,5})\/?(?:[?#].*)?$/i.exec(t) ?? /[-/](\d{3,5})\/?(?:[?#].*)?$/.exec(t);
  return m?.[1];
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
