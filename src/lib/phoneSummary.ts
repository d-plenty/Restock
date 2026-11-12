// 0.9.3: what a phone tells the web app about its own settings (read-only, for the web's Settings →
// Phones: "Change this on <phone>"). Built on the phone by PhoneSummary.java from an allow-list, and
// only in the phone's file on a Restock server (not a folder's or WebDAV's). Checked again here, field
// by field, before the web keeps it: anything not in this list is dropped, and every text is one of a
// few known kinds (a version, a time, a choice), so no address, password, email, card number, branch,
// folder or token can come through even if a phone sent one.
//
// No database here (the web's engine uses it as files come in; householdSettings.ts reads them back).

export interface PhoneSummary {
  /** Summary format (1). */
  v: 1;
  /** Restock version on that phone ("0.9.3"). */
  version?: string;
  /** Price checks: every N hours (168 = weekly, on `weekday` 0–6), in the background or not, and the last one. */
  checks?: { everyHours?: number; weekday?: number; background?: boolean; lastAt?: string; lastItems?: number };
  /** Notifications on or off (and the daily one's time, the catalogue day). Restock has no quiet hours. */
  notifications?: {
    catalogueDay?: boolean;
    catalogueWeekday?: number;
    daily?: boolean;
    dailyTime?: string;
    greatDeals?: boolean;
    monthly?: boolean;
    stockUp?: boolean;
    stockUpTips?: boolean;
  };
  /** Signed in to the shop inside Restock, per shop (never who as). */
  accounts?: { woolworths?: boolean; coles?: boolean };
  /** How many loyalty cards (never their numbers). */
  cards?: number;
  /** Automatic backups (never the folder or the password). */
  backups?: { on?: boolean; everyDays?: number; keep?: number; lastAt?: string; photos?: boolean };
  /** Keep price history for N weeks. */
  historyWeeks?: number;
  /** The tabs this phone takes. */
  tabs?: ('pantry' | 'keg' | 'pharmacy')[];
  /** Away from home: through a folder, WebDAV, Nextcloud, only the Restock server, or none (never where). */
  away?: 'none' | 'folder' | 'webdav' | 'nextcloud' | 'server';
  /** Home Assistant: on or off, and which list (never the address or token). */
  homeAssistant?: { on?: boolean; entity?: string };
  /** The look: theme and text size. */
  look?: { theme?: 'system' | 'light' | 'dark'; text?: 'Normal' | 'Large' | 'Larger' | 'Largest' };
  /** The Receipts add-on switched on. */
  receipts?: boolean;
  /** Shared price history (the download) on. */
  sharedPrices?: boolean;
  /** Update checks: on, every 1 or 7 days. */
  updates?: { on?: boolean; everyDays?: 1 | 7 };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]) => (list.includes(v as T) ? (v as T) : undefined);
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(-[a-z0-9]{1,12})?$/;
const TIME_OF_DAY = /^([01]?\d|2[0-3]):[0-5]\d$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ENTITY = /^todo\.[a-z0-9_]{1,80}$/;

/** Drops undefined fields; undefined when nothing's left. */
function compact<T extends Obj>(o: T): T | undefined {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return Object.keys(o).length ? o : undefined;
}

/** A phone's summary, kept to the allow-list above; null when it isn't one. */
export function cleanSummary(raw: unknown): PhoneSummary | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const o = (k: string): Obj => (isObj(raw[k]) ? (raw[k] as Obj) : {});
  const c = o('checks'),
    n = o('notifications'),
    a = o('accounts'),
    b = o('backups'),
    h = o('homeAssistant'),
    l = o('look'),
    u = o('updates');
  const str = (v: unknown, re: RegExp) => (typeof v === 'string' && v.length <= 40 && re.test(v) ? v : undefined);
  const out = {
    v: 1 as const,
    version: str(raw.version, VERSION),
    checks: compact({
      everyHours: int(c.everyHours, 1, 24 * 31),
      weekday: int(c.weekday, 0, 6),
      background: bool(c.background),
      lastAt: str(c.lastAt, ISO),
      lastItems: int(c.lastItems, 0, 1_000_000),
    }),
    notifications: compact({
      catalogueDay: bool(n.catalogueDay),
      catalogueWeekday: int(n.catalogueWeekday, 0, 6),
      daily: bool(n.daily),
      dailyTime: str(n.dailyTime, TIME_OF_DAY),
      greatDeals: bool(n.greatDeals),
      monthly: bool(n.monthly),
      stockUp: bool(n.stockUp),
      stockUpTips: bool(n.stockUpTips),
    }),
    accounts: compact({ woolworths: bool(a.woolworths), coles: bool(a.coles) }),
    cards: int(raw.cards, 0, 10_000),
    backups: compact({ on: bool(b.on), everyDays: int(b.everyDays, 1, 366), keep: int(b.keep, 1, 1000), lastAt: str(b.lastAt, ISO), photos: bool(b.photos) }),
    historyWeeks: int(raw.historyWeeks, 1, 520),
    tabs: Array.isArray(raw.tabs) ? (['pantry', 'keg', 'pharmacy'] as const).filter((t) => (raw.tabs as unknown[]).includes(t)) : undefined,
    away: oneOf(raw.away, ['none', 'folder', 'webdav', 'nextcloud', 'server'] as const),
    homeAssistant: compact({ on: bool(h.on), entity: str(h.entity, ENTITY) }),
    look: compact({ theme: oneOf(l.theme, ['system', 'light', 'dark'] as const), text: oneOf(l.text, ['Normal', 'Large', 'Larger', 'Largest'] as const) }),
    receipts: bool(raw.receipts),
    sharedPrices: bool(raw.sharedPrices),
    updates: compact({ on: bool(u.on), everyDays: u.everyDays === 1 || u.everyDays === 7 ? (u.everyDays as 1 | 7) : undefined }),
  };
  return compact(out as Obj) as unknown as PhoneSummary;
}

/**
 * Which settings are each phone's own (shown greyed on the web: "Change this on <phone>"), by the
 * summary's field, with the Settings field(s) they come from. Everything else the web shows under
 * household settings (householdSettings.ts HOUSEHOLD_WIDE).
 */
export const PER_PHONE: readonly { field: keyof PhoneSummary; title: string; settings: string[] }[] = [
  { field: 'version', title: 'Restock version', settings: [] },
  { field: 'checks', title: 'Price checks', settings: ['checkIntervalHours', 'checkTime', 'checkWeekday', 'sync.backgroundActivity', 'lastCheck'] },
  { field: 'notifications', title: 'Notifications', settings: ['alerts'] },
  { field: 'accounts', title: 'Shop accounts', settings: ['accounts'] },
  { field: 'cards', title: 'Loyalty cards', settings: [] },
  { field: 'backups', title: 'Automatic backups', settings: ['autoBackup'] },
  { field: 'historyWeeks', title: 'Keep price history for', settings: ['historyWeeks'] },
  { field: 'tabs', title: 'Tabs this phone takes', settings: [] },
  { field: 'away', title: 'Sync away from home', settings: [] },
  { field: 'homeAssistant', title: 'Home Assistant', settings: [] },
  { field: 'look', title: 'Look and text size', settings: ['theme', 'look', 'a11y'] },
  { field: 'receipts', title: 'Receipts', settings: ['receipts'] },
  { field: 'sharedPrices', title: 'Shared prices', settings: ['marketData', 'sharePrices'] },
  { field: 'updates', title: 'Update checks', settings: ['updates'] },
];
