// 0.9.6 (cards): gift cards, the plain rules. No database, no DOM: shared by the phone's Cards
// screen, the web's Cards tab (kept in this browser only) and the cards file that moves them
// between the two.
//
// Privacy: a gift card's number and PIN stay on the phone (or in this browser). They're never
// synced, never sent to a Restock server, never in the spreadsheet or export files and never
// logged. A backup the person makes for themself has them (as it has loyalty card numbers), and so
// does the cards file, which says plainly that it's private.
import type { CardProgram, GiftBalanceEntry, GiftBarcodeType, GiftCard, LoyaltyCard } from '../types';

/** How many balance updates a card keeps (the short spend history). */
export const GIFT_HISTORY_MAX = 12;

/** Colours a gift card can have: fixed (like shop colours), each with text at 4.5:1 or better. */
export const CARD_COLOURS: { id: string; name: string; bg: string; ink: string }[] = [
  { id: 'navy', name: 'Navy', bg: '#1f3a68', ink: '#ffffff' },
  { id: 'green', name: 'Green', bg: '#1b6b3a', ink: '#ffffff' },
  { id: 'red', name: 'Red', bg: '#a3261f', ink: '#ffffff' },
  { id: 'purple', name: 'Purple', bg: '#5b2a86', ink: '#ffffff' },
  { id: 'orange', name: 'Orange', bg: '#9a4500', ink: '#ffffff' },
  { id: 'teal', name: 'Teal', bg: '#0f6368', ink: '#ffffff' },
  { id: 'charcoal', name: 'Charcoal', bg: '#3a3f45', ink: '#ffffff' },
  { id: 'gold', name: 'Gold', bg: '#e8b931', ink: '#1a1a1a' },
];
export const colourOf = (id: string | undefined) => CARD_COLOURS.find((c) => c.id === id) ?? CARD_COLOURS[0];

export const BARCODE_TYPES: { id: GiftBarcodeType; name: string }[] = [
  { id: 'CODE128', name: 'Code 128' },
  { id: 'QR', name: 'QR code' },
  { id: 'EAN', name: 'EAN' },
];

/** Reminder choices (days before the expiry date). */
export const REMIND_CHOICES: { days: number; name: string }[] = [
  { days: 0, name: 'Off' },
  { days: 7, name: '1 week before' },
  { days: 14, name: '2 weeks before' },
  { days: 30, name: '1 month before' },
];

const MAX_TEXT = 200;
const MAX_NOTES = 1000;
const MAX_CODE = 300;
const MAX_MONEY = 100_000;

/** A PIN is 4 to 8 digits. Undefined: fine (or none). */
export function pinProblem(pin: string | undefined): string | undefined {
  const p = (pin ?? '').trim();
  if (!p) return undefined;
  return /^\d{4,8}$/.test(p) ? undefined : 'A PIN is 4 to 8 digits.';
}

/** EAN-13, EAN-8 or UPC-A, with a right check digit. */
export function eanOk(code: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13})$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  // From the right, the digits next to the check digit count three times.
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Can this be drawn as that kind of barcode? Undefined: yes. */
export function barcodeProblem(value: string | undefined, type: GiftBarcodeType): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined;
  if (v.length > MAX_CODE) return 'That barcode is too long.';
  if (type === 'EAN') return eanOk(v) ? undefined : 'An EAN barcode is 8, 12 or 13 digits, and the last one is a check digit. Try Code 128.';
  // eslint-disable-next-line no-control-regex
  if (type === 'CODE128' && !/^[\x20-\x7e]+$/.test(v)) return 'Code 128 takes letters, numbers and common symbols only. Try QR code.';
  return undefined;
}

/** A good first guess at the barcode type for a scanned or typed code. */
export function guessBarcodeType(code: string): GiftBarcodeType {
  const v = code.trim();
  if (eanOk(v)) return 'EAN';
  // eslint-disable-next-line no-control-regex
  if (v.length > 48 || !/^[\x20-\x7e]+$/.test(v) || /^https?:/i.test(v)) return 'QR';
  return 'CODE128';
}

/** JsBarcode's name for an EAN-type code (by its length). */
export const eanFormat = (code: string): 'EAN13' | 'EAN8' | 'UPC' => (code.length === 8 ? 'EAN8' : code.length === 12 ? 'UPC' : 'EAN13');

/** "$37.50" (no cents when whole: "$50"). */
export function money(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  return Number.isInteger(n) ? `$${n.toLocaleString('en-AU')}` : `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A typed amount ("$37.50", "37.5") as dollars, or undefined if it isn't one. */
export function parseMoney(text: string): number | undefined {
  const t = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const n = Math.round(parseFloat(t) * 100) / 100;
  return n >= 0 && n <= MAX_MONEY ? n : undefined;
}

/** A new balance (or what was spent), noted in the short history. */
export function withBalance(card: GiftCard, balance: number, at: string): GiftCard {
  const b = Math.max(0, Math.round(balance * 100) / 100);
  const history = [...(card.history ?? [])];
  // The first update on a card that had a balance keeps where it started.
  if (!history.length && card.balance !== undefined) history.push({ at: card.updatedAt || card.createdAt, balance: card.balance });
  history.push({ at, balance: b });
  return { ...card, balance: b, history: history.slice(-GIFT_HISTORY_MAX), updatedAt: at };
}

/** The history, newest first, with what changed each time: "Spent $12.50" or "Added $20". */
export function spendLines(card: GiftCard): { at: string; balance: number; change?: number }[] {
  const h = card.history ?? [];
  return h
    .map((e, i) => ({ at: e.at, balance: e.balance, change: i > 0 ? Math.round((e.balance - h[i - 1].balance) * 100) / 100 : undefined }))
    .reverse();
}

const DAY = 86_400_000;
/** Midnight at the start of a YYYY-MM-DD day, on this phone's own calendar. */
export function dayStart(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // A day that doesn't exist (31 February) isn't rolled over into the next month.
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : NaN;
}

export type ExpiryState = { kind: 'none' } | { kind: 'expired'; text: string } | { kind: 'soon'; days: number; text: string } | { kind: 'ok'; text: string };

const longDay = (ymd: string) =>
  new Date(dayStart(ymd)).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

/** "Expires 3 December 2027", "Expires in 12 days", "Expires today", "Expired 3 November 2026". */
export function expiryState(card: Pick<GiftCard, 'expiry'>, now = Date.now()): ExpiryState {
  if (!card.expiry) return { kind: 'none' };
  const start = dayStart(card.expiry);
  if (!Number.isFinite(start)) return { kind: 'none' };
  const today = new Date(now);
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.round((start - t0) / DAY);
  if (days < 0) return { kind: 'expired', text: `Expired ${longDay(card.expiry)}` };
  if (days === 0) return { kind: 'soon', days, text: 'Expires today' };
  if (days <= 30) return { kind: 'soon', days, text: days === 1 ? 'Expires tomorrow' : `Expires in ${days} days` };
  return { kind: 'ok', text: `Expires ${longDay(card.expiry)}` };
}

/** When the reminder goes (9 am, `remindDays` before the expiry), or undefined (none, or already past). */
export function reminderAt(card: GiftCard, now = Date.now()): Date | undefined {
  if (!card.expiry || !card.remindDays || card.usedUp) return undefined;
  const start = dayStart(card.expiry);
  if (!Number.isFinite(start)) return undefined;
  const d = new Date(start);
  d.setDate(d.getDate() - card.remindDays);
  d.setHours(9, 0, 0, 0);
  return d.getTime() > now ? d : undefined;
}

/** The reminder's words: the card's name and the day only, never its number, PIN or balance. */
export function reminderText(card: GiftCard): { title: string; body: string } {
  return {
    title: `${card.name || 'Gift card'} expires soon`,
    body: `Your ${card.name || 'gift'} card expires on ${card.expiry ? longDay(card.expiry) : 'its expiry date'}. Use it before then.`,
  };
}

/** A stable notification id for a card (200000 to 299999, clear of notify.ts's ids). */
export function reminderId(cardId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cardId.length; i++) {
    h ^= cardId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 200_000 + (h % 100_000);
}
export const isReminderId = (id: number) => id >= 200_000 && id < 300_000;

/** "•••• 5678": the last four only. */
export const masked = (s: string | undefined) => (s ? `•••• ${s.replace(/\s+/g, '').slice(-4)}` : '');

// ---------- checking cards that come from outside (a file, a backup, this browser's storage) ----------

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY ? Math.round(v * 100) / 100 : undefined);
const iso = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined);
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A gift card as it may be kept, or undefined if it isn't one. Photo paths are checked by the caller. */
export function cleanGiftCard(raw: unknown, now = new Date().toISOString()): GiftCard | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && SAFE_ID.test(r.id) ? r.id : undefined;
  const name = str(r.name, MAX_TEXT);
  if (!id || !name) return undefined;
  const type = BARCODE_TYPES.some((b) => b.id === r.barcodeType) ? (r.barcodeType as GiftBarcodeType) : 'CODE128';
  const pin = str(r.pin, 8);
  const expiry = typeof r.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.expiry) && Number.isFinite(dayStart(r.expiry)) ? r.expiry : undefined;
  const history: GiftBalanceEntry[] = Array.isArray(r.history)
    ? r.history
        .map((e) => (e && typeof e === 'object' ? { at: iso((e as GiftBalanceEntry).at), balance: num((e as GiftBalanceEntry).balance) } : undefined))
        .filter((e): e is GiftBalanceEntry => !!e && !!e.at && e.balance !== undefined)
        .slice(-GIFT_HISTORY_MAX)
    : [];
  const remind = typeof r.remindDays === 'number' && REMIND_CHOICES.some((c) => c.days === r.remindDays) ? r.remindDays : 0;
  return {
    id,
    name,
    barcode: str(r.barcode, MAX_CODE),
    barcodeType: type,
    number: str(r.number, 64),
    pin: pin && !pinProblem(pin) ? pin : undefined,
    balance: num(r.balance),
    history: history.length ? history : undefined,
    expiry,
    remindDays: remind || undefined,
    notes: str(r.notes, MAX_NOTES),
    photoFront: typeof r.photoFront === 'string' ? r.photoFront : undefined,
    photoBack: typeof r.photoBack === 'string' ? r.photoBack : undefined,
    colour: CARD_COLOURS.some((c) => c.id === r.colour) ? (r.colour as string) : CARD_COLOURS[0].id,
    usedUp: r.usedUp === true || undefined,
    createdAt: iso(r.createdAt) ?? now,
    updatedAt: iso(r.updatedAt) ?? iso(r.createdAt) ?? now,
  };
}

const PROGRAMS: CardProgram[] = ['flybuys', 'everyday', 'other'];

/** A loyalty card as it may be kept, or undefined. */
export function cleanLoyaltyCard(raw: unknown, now = new Date().toISOString()): LoyaltyCard | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && SAFE_ID.test(r.id) ? r.id : undefined;
  const number = typeof r.number === 'string' ? r.number.replace(/\s+/g, '').slice(0, 64) : '';
  if (!id || !number || !PROGRAMS.includes(r.program as CardProgram)) return undefined;
  return { id, program: r.program as CardProgram, label: str(r.label, MAX_TEXT) ?? 'Card', number, createdAt: iso(r.createdAt) ?? now };
}

// ---------- the cards file (moving cards between a phone and a browser) ----------

export const CARDS_FILE_FORMAT = 'restock-cards';
export const CARDS_FILE_PRIVATE =
  'PRIVATE. This file has your card numbers, barcodes and gift card PINs, not encrypted. Keep it to yourself, open it only in Restock, and delete it once your cards are moved.';
/** At most this much in a cards file (photos take most of it). */
export const CARDS_FILE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_CARDS = 500;
/** Base64 of one photo (about 3 MB of JPEG). */
export const MAX_PHOTO_B64 = 4 * 1024 * 1024;

export interface CardsFile {
  format: typeof CARDS_FILE_FORMAT;
  v: 1;
  private: true;
  warning: string;
  exportedAt: string;
  loyalty: LoyaltyCard[];
  gift: GiftCard[];
  /** Card photos, base64 JPEG, by card id and side ("<id>:front"). */
  photos?: Record<string, string>;
}

export const cardsFileName = (day: string) => `restock-cards-PRIVATE-${day}.json`;

export function makeCardsFile(loyalty: LoyaltyCard[], gift: GiftCard[], photos: Record<string, string>, at = new Date().toISOString()): string {
  const file: CardsFile = {
    format: CARDS_FILE_FORMAT,
    v: 1,
    private: true,
    warning: CARDS_FILE_PRIVATE,
    exportedAt: at,
    loyalty,
    // Photo paths belong to the phone or browser they were taken on; the photos themselves travel in `photos`.
    gift: gift.map((g) => ({ ...g, photoFront: undefined, photoBack: undefined })),
    photos: Object.keys(photos).length ? photos : undefined,
  };
  return JSON.stringify(file, null, 1);
}

export interface ReadCards {
  loyalty: LoyaltyCard[];
  gift: GiftCard[];
  /** By "<id>:front" / "<id>:back". */
  photos: Record<string, string>;
  skipped: number;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Reads a cards file (or throws a plain message). Nothing is changed. */
export function readCardsFile(text: string): ReadCards {
  if (text.length > CARDS_FILE_MAX_BYTES) throw new Error('That file is too big to be a Restock cards file.');
  let raw: Partial<CardsFile>;
  try {
    raw = JSON.parse(text) as Partial<CardsFile>;
  } catch {
    throw new Error("That file isn't a Restock cards file.");
  }
  if (!raw || raw.format !== CARDS_FILE_FORMAT) throw new Error("That file isn't a Restock cards file.");
  if (typeof raw.v !== 'number' || raw.v > 1) throw new Error('That cards file is from a newer Restock. Update Restock first.');
  const ls = Array.isArray(raw.loyalty) ? raw.loyalty.slice(0, MAX_CARDS) : [];
  const gs = Array.isArray(raw.gift) ? raw.gift.slice(0, MAX_CARDS) : [];
  const loyalty = ls.map((c) => cleanLoyaltyCard(c)).filter((c): c is LoyaltyCard => !!c);
  const gift = gs.map((c) => cleanGiftCard(c)).filter((c): c is GiftCard => !!c).map((g) => ({ ...g, photoFront: undefined, photoBack: undefined }));
  const ids = new Set(gift.map((g) => g.id));
  const photos: Record<string, string> = {};
  if (raw.photos && typeof raw.photos === 'object')
    for (const [k, v] of Object.entries(raw.photos)) {
      const m = /^([A-Za-z0-9_-]{1,80}):(front|back)$/.exec(k);
      if (m && ids.has(m[1]) && typeof v === 'string' && v.length <= MAX_PHOTO_B64 && B64.test(v)) photos[k] = v;
    }
  const skipped = ls.length - loyalty.length + gs.length - gift.length;
  return { loyalty, gift, photos, skipped };
}

/** "2 loyalty cards and 1 gift card". */
export function cardsCount(loyalty: number, gift: number): string {
  const p = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (loyalty && gift) return `${p(loyalty, 'loyalty card')} and ${p(gift, 'gift card')}`;
  if (gift) return p(gift, 'gift card');
  return p(loyalty, 'loyalty card');
}
