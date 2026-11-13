import {
  GOOD_SALE,
  GREAT_SALE,
  LEARNING_DAYS,
  mainProductIds,
  type Chain,
  type Group,
  type MarketSummary,
  type PriceReading,
  type Product,
} from '../types';
import { nameHasSize } from './naming';
import { formatUnitPrice, inSheets, money, unitPrice } from './units';
import { compareStyleOfProducts, priceLine, sizingOf, withSizes } from './unitPrice';
import type { CompareStyle } from './units';
import { chainName, costcoDecides } from '../shops';

export type VerdictKind = 'great' | 'good' | 'small' | 'wait' | 'fake' | 'normal' | 'nodata';

export interface Verdict {
  kind: VerdictKind;
  headline: string;
  detail: string;
  /** Dollars saved vs the reference (typical or was) price. */
  saving?: number;
  /** Fraction off the normal price (0.2 = 20% off), when there's something to compare with. */
  discount?: number;
  /** Where the reference came from. */
  basis: 'history' | 'was-price' | 'none';
  /**
   * 0.9.0: the newest price may not be today's, so it isn't called a deal. 'ended': a sale price from
   * before this week's specials started. 'old': a price drop last seen over STALE_DAYS ago.
   */
  stale?: 'ended' | 'old';
  /** 0.10.3: on special nearly all the time, never at its "was" price (alwaysOnSpecial): shown as Always on special. */
  always?: true;
}

export const VERDICT_LABEL: Record<VerdictKind, string> = {
  great: 'GREAT DEAL',
  good: 'ON SPECIAL',
  small: 'SMALL SAVING',
  wait: 'WAIT',
  fake: 'FAKE SALE',
  normal: 'USUAL PRICE',
  nodata: 'NO PRICE YET',
};
/** 0.10.3: a verdict's tag ("ALWAYS ON SPECIAL" for a special that never ends). */
export const verdictLabel = (v: Pick<Verdict, 'kind' | 'always'>): string => (v.always ? 'ALWAYS ON SPECIAL' : VERDICT_LABEL[v.kind]);

/**
 * 0.10.3: "Always on special" (as CartSavvy's perpetual specials): on special on at least
 * ALWAYS_DAYS of the last ALWAYS_WINDOW days Restock has a price for, and in that time never seen
 * at its "was" price, so the "special" is really its usual price. Any size of claimed discount.
 * Mirrored in Deals.java.
 */
export const ALWAYS_WINDOW = 21;
export const ALWAYS_DAYS = 14;
export function alwaysOnSpecial(readings: PriceReading[], now: number): { days: number; was: number } | undefined {
  const recent = readings.filter((r) => now - Date.parse(r.date) <= ALWAYS_WINDOW * DAY);
  const special = recent.filter((r) => r.isSpecial);
  if (special.length < ALWAYS_DAYS) return undefined;
  let was: number | undefined;
  for (const r of special) if (typeof r.wasPrice === 'number' && r.wasPrice > 0 && (was === undefined || r.wasPrice > was)) was = r.wasPrice;
  if (was === undefined) return undefined;
  const w = was;
  if (recent.some((r) => r.price >= w - 0.005)) return undefined;
  return { days: special.length, was };
}

export interface PriceStats {
  current?: PriceReading;
  typical?: number;
  /** True when "typical" comes from seen non-sale prices, not the store's was-price. */
  typicalFromHistory?: boolean;
  usualSale?: number;
  low?: number;
  lowDate?: string;
  readings: number;
  spanDays: number;
  cycleWeeks?: number;
  /** 0.10.3: on special nearly all the time (alwaysOnSpecial). */
  always?: { days: number; was: number };
  /** True when the normal price comes from shared price history rather than this phone's own. */
  fromMarket?: boolean;
  /** How much the shared history was scaled to match local prices (1.04 = 4% dearer here). */
  marketScale?: number;
  /** 0.9.0: when these were worked out (the `now` given to computeStats), to tell how old the newest price is. */
  asOf?: number;
}

const DAY = 86_400_000;

/** 0.9.0: a price seen longer ago than this isn't taken as today's price when judging a deal. Same as Deals.STALE_DAYS. */
export const STALE_DAYS = 14;

/**
 * Midnight at the start of the specials week (Wednesday to Tuesday) that `now` is in, where the
 * phone is (0.9.0). A sale price from before then was last week's special and may have ended.
 * Same as Deals.weekStart in Java.
 */
export function specialsWeekStart(now: number): number {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  from.setDate(from.getDate() - ((from.getDay() + 7 - 3) % 7));
  return from.getTime();
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** How far back "normal price" and "lowest price" look. */
export const HISTORY_DAYS = 183;

/**
 * The calendar day (yyyy-mm-dd) a time falls on where the phone is. Not the UTC day: in
 * Australia that runs 10am to 10am, so an evening price and the next morning's sale would
 * count as one day. Same as Deals.localDay in Java.
 */
export function localDay(iso: string): string {
  // 0.9.0: a plain date is already a day (JavaScript would read it as UTC midnight, the day before west of UTC).
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Keep the last reading per calendar day (a hand-typed one wins over a check that day), oldest first, within the history window. `days`: a longer
 * window, only for an item page's chart showing 12 months (0.9.1); verdicts and alerts always use HISTORY_DAYS.
 */
export function normaliseReadings(readings: PriceReading[], now = Date.now(), days = HISTORY_DAYS): PriceReading[] {
  const byDay = new Map<string, PriceReading>();
  const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of sorted) {
    if (now - Date.parse(r.date) > days * DAY) continue;
    const day = localDay(r.date);
    // 0.9.6: a price typed in by hand isn't overwritten by a price check the same day.
    if (byDay.get(day)?.source === 'manual' && r.source !== 'manual') continue;
    byDay.set(day, r);
  }
  return [...byDay.values()];
}

/**
 * A product's normal price, usual sale, lowest price and sale cycle. `hasCard`: whether you have
 * the shop's loyalty card. Without it (0.9.0), member prices aren't prices you can pay, so they don't
 * set the normal price, the usual sale, the lowest price ("wait for a better sale") or the sale
 * cycle; only their "was" price still counts, as the store's. Mirrored in Deals.java.
 */
export function computeStats(raw: PriceReading[], now = Date.now(), hasCard = true, days = HISTORY_DAYS): PriceStats {
  const readings = normaliseReadings(raw, now, days);
  if (!readings.length) return { readings: 0, spanDays: 0, asOf: now };
  const current = readings[readings.length - 1];
  const mine = hasCard ? readings : readings.filter((r) => !r.memberOnly);
  const history = mine.filter((r) => r !== current);

  const nonSpecial = mine.filter((r) => !r.isSpecial).map((r) => r.price);
  const wasPrices = readings.map((r) => r.wasPrice).filter((v): v is number => typeof v === 'number' && v > 0);
  const typicalFromHistory = median(nonSpecial);
  const typical = typicalFromHistory ?? median(wasPrices);

  const usualSale = median(history.filter((r) => r.isSpecial).map((r) => r.price));

  let low: number | undefined;
  let lowDate: string | undefined;
  for (const r of history) {
    if (low === undefined || r.price < low) {
      low = r.price;
      lowDate = r.date;
    }
  }

  // Sale cycle: average gap between the starts of consecutive special runs.
  const starts: number[] = [];
  mine.forEach((r, i) => {
    if (r.isSpecial && (i === 0 || !mine[i - 1].isSpecial)) starts.push(Date.parse(r.date));
  });
  let cycleWeeks: number | undefined;
  if (starts.length >= 2) {
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    cycleWeeks = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / (7 * DAY));
  }

  const spanDays = Math.round((Date.parse(current.date) - Date.parse(readings[0].date)) / DAY);
  const always = alwaysOnSpecial(readings, now);
  return {
    current,
    typical,
    typicalFromHistory: typicalFromHistory !== undefined,
    usualSale,
    low,
    lowDate,
    readings: readings.length,
    spanDays,
    cycleWeeks,
    asOf: now,
    ...(always ? { always } : {}),
  };
}

/**
 * While a product is still learning (under LEARNING_DAYS of its own history), shared price history
 * fills in its normal price, usual sale price, lowest price and sale cycle. Once the phone has its
 * own few weeks of prices, those win. Mirrored in Deals.java.
 */
export function withMarket(stats: PriceStats, m?: MarketSummary): PriceStats {
  if (!m || !stats.current || stats.spanDays >= LEARNING_DAYS || !(m.normal > 0) || m.days < LEARNING_DAYS) return stats;
  const k = marketScale(stats.current, m);
  const mLow = m.low * k;
  const low = stats.low === undefined ? mLow : Math.min(stats.low, mLow);
  return {
    ...stats,
    typical: m.normal * k,
    typicalFromHistory: true,
    marketScale: k,
    usualSale: stats.usualSale ?? (m.sale !== undefined ? m.sale * k : undefined),
    low,
    lowDate: stats.low !== undefined && low === stats.low ? stats.lowDate : undefined,
    cycleWeeks: stats.cycleWeeks ?? m.cycleWeeks,
    readings: Math.max(stats.readings, 4),
    spanDays: Math.max(stats.spanDays, m.days),
    fromMarket: true,
  };
}

/**
 * Shared history comes from one store's prices, which can differ from yours (regional pricing).
 * Compare this phone's shelf price with the shared one and scale the summary to match, within
 * 20% down / 25% up (a bigger gap probably means it isn't the same thing, so it's left alone).
 * Mirrored in Deals.java.
 */
export function marketScale(cur: PriceReading, m: MarketSummary): number {
  let ratio: number | undefined;
  if (cur.isSpecial) {
    // On special here: compare the store's "was" price with the usual price.
    if (cur.wasPrice !== undefined && cur.wasPrice > 0) ratio = cur.wasPrice / m.normal;
  } else if (m.latest !== undefined && m.latest > 0 && m.latest >= m.normal * 0.97) {
    // Neither on sale: compare today's shelf prices.
    ratio = cur.price / m.latest;
  } else {
    ratio = cur.price / m.normal;
  }
  if (ratio === undefined || ratio < 0.8 || ratio > 1.25) return 1;
  return Math.abs(ratio - 1) < 0.01 ? 1 : ratio;
}

/** The price this shopper would actually pay, given which loyalty cards they have. */
export interface MultiBuy {
  n: number;
  total: number;
}

/**
 * Multi-buy deals like "2 for $5", "Any 3 for $10" or "Buy 2 for $7". Mirrored in Deals.java.
 * (Not "2 x 150g": the price has to have a dollar sign. And not "112 for $5" as "12 for $5":
 * the count can't be the end of a longer number, 0.9.0.)
 */
export function multiBuy(promo?: string): MultiBuy | undefined {
  if (!promo) return undefined;
  const m = promo.match(/(?<!\d)(\d{1,2})\s*for\s*\$\s*(\d+(?:\.\d{1,2})?)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const total = Number(m[2]);
  if (n < 2 || n > 12 || !(total > 0)) return undefined;
  return { n, total };
}

/**
 * The price this shopper would pay per item. Member prices only count with the card. A
 * multi-buy counts at its per-item price ("2 for $5" is $2.50 each) when that's cheaper.
 */
export function effectivePrice(
  r: PriceReading,
  hasCard: boolean,
  /** Count multi-buy deals (the item's "multi-buy to save money" setting). */
  allowMulti = true,
  /** Its normal price for this shopper (PriceStats.typical), for a member price without a "was" price. */
  normal?: number,
): { price: number; locked: boolean; multi?: MultiBuy; shelf: number } {
  if (r.memberOnly && !hasCard) {
    // Without the card you pay the shelf price: the store's "was" price or, without one, its normal
    // price (0.9.0). The member price is only used when there's nothing else to go by.
    const p = r.wasPrice ?? normal ?? r.price;
    return { price: p, locked: true, shelf: p };
  }
  const mb = allowMulti ? multiBuy(r.promo) : undefined;
  if (mb && mb.total / mb.n < r.price - 0.004) return { price: mb.total / mb.n, locked: false, multi: mb, shelf: r.price };
  return { price: r.price, locked: false, shelf: r.price };
}

/** "2 for $5" */
export const multiText = (m: MultiBuy) => `${m.n} for ${money(m.total)}`;

/** What `qty` of something costs, counting a multi-buy only for the full sets you buy. */
export function lineCost(o: { price?: number; shelfPrice?: number; multi?: MultiBuy }, qty: number): number {
  const one = o.shelfPrice ?? o.price ?? 0;
  if (!o.multi || qty < o.multi.n) return one * qty;
  return Math.floor(qty / o.multi.n) * o.multi.total + (qty % o.multi.n) * one;
}

const pct = (d: number) => `${Math.round(d * 100)}%`;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
/** At this discount or more, a sale is never "wait for a better one". */
export const HALF_PRICE = 0.45;

/**
 * Judge one product's current price.
 *  - Normal price = the middle of its non-sale prices over the last 6 months
 *    (or the store's "was" price until there's history).
 *  - Great deal: 30%+ off normal. On sale (good sale): 15%+. Small saving: any price drop below that, even 5c.
 *  - Wait: it's been at least 5% cheaper than this in the last 6 months.
 *  - Fake sale: marked as a special, but not even a cent below normal.
 *  - Not a deal at all (0.9.0): a sale price from before this week's specials started (Wednesday),
 *    or a lower price last seen over STALE_DAYS ago. They may not be today's prices.
 * Mirrored in Deals.java.
 */
export function judge(stats: PriceStats, hasCard = true, allowMulti = true): Verdict {
  const cur = stats.current;
  if (!cur) return { kind: 'nodata', headline: 'No price yet', detail: 'Check prices or add one by hand.', basis: 'none' };

  const { price: p, locked, multi } = effectivePrice(cur, hasCard, allowMulti, stats.typical);
  // With multi-buys off, a multi-buy on its own (the shelf price unchanged) isn't a sale.
  const multiOnly = !allowMulti && !!multiBuy(cur.promo) && !(cur.wasPrice !== undefined && cur.wasPrice > cur.price + 0.004);
  const isSpecial = ((cur.isSpecial && !multiOnly) || !!multi) && !locked;
  const deal = multi ? `${multiText(multi)} (${money(p)} each). ` : '';
  const ref = stats.typical ?? cur.wasPrice;
  const basis: Verdict['basis'] = stats.typicalFromHistory ? 'history' : ref !== undefined ? 'was-price' : 'none';

  if (locked) {
    return { kind: 'normal', headline: 'Member price only', detail: 'Add your loyalty card to count this sale.', basis };
  }
  const seen = Date.parse(cur.date);
  // 0.9.0: last week's special (or multi-buy) may be over by now, so it isn't "on sale now".
  if (isSpecial && stats.asOf !== undefined && seen < specialsWeekStart(stats.asOf)) {
    return {
      kind: 'normal',
      headline: 'Sale may have ended',
      detail: `It was ${multi ? multiText(multi) : `on special for ${money(p)}`} on ${shortDate(cur.date)}, before this week's specials started. Check prices to see this week's price.`,
      basis,
      stale: 'ended',
    };
  }
  // 0.10.3: a "special" that never ends is its usual price.
  if (isSpecial && stats.always) {
    const a = stats.always;
    return {
      kind: 'fake',
      headline: 'Always on special',
      detail: `On special ${a.days} of the last ${ALWAYS_WINDOW} days, and never at ${money(a.was)} in that time, so ${money(p)} is really its usual price.`,
      basis,
      always: true,
    };
  }
  if (ref === undefined) {
    return {
      kind: isSpecial ? 'small' : 'normal',
      headline: isSpecial ? 'On special' : 'Price recorded',
      detail: 'Not enough history yet to judge it.',
      basis,
    };
  }

  const discount = 1 - p / ref;
  const saving = ref - p > 0.004 ? ref - p : undefined;

  if (ref - p < 0.005) {
    if (isSpecial) {
      return { kind: 'fake', headline: 'Fake sale', detail: 'Marked as a special, but this is its usual price.', discount, basis };
    }
    if (p > ref * 1.03) return { kind: 'normal', headline: 'Pricier than usual', detail: `Usually ${money(ref)}.`, discount, basis };
    return { kind: 'normal', headline: 'Usual price', detail: `Usually ${money(ref)}.`, discount, basis };
  }
  // 0.9.0: a lower price from over two weeks ago may not be today's, so it isn't called a deal.
  if (stats.asOf !== undefined && stats.asOf - seen > STALE_DAYS * DAY) {
    return {
      kind: 'normal',
      headline: 'Price may be out of date',
      detail: `${money(p)} when last checked, on ${shortDate(cur.date)}. Usually ${money(ref)}.`,
      discount,
      basis,
      stale: 'old',
    };
  }

  const enoughHistory = stats.readings >= 4 && stats.spanDays >= 21;
  // Half price is about as good as supermarket specials get, so it's never "wait".
  if (enoughHistory && stats.low !== undefined && stats.low < p * 0.95 && discount < HALF_PRICE) {
    const cycle = stats.cycleWeeks ? ` It goes on special about every ${stats.cycleWeeks} weeks.` : '';
    const when = stats.lowDate ? ` on ${shortDate(stats.lowDate)}` : stats.fromMarket ? ' in shared prices' : '';
    return {
      kind: 'wait',
      headline: 'Wait for a better sale',
      detail: `${deal}It's been as low as ${money(stats.low)}${when}.${cycle}`,
      saving,
      discount,
      basis,
    };
  }

  // "the store's was-price" only when it is the store's was-price (0.9.0). From the prices Restock
  // has seen, it's "its usual" until there's enough history to call it normal.
  const vs = stats.fromMarket
    ? `its usual ${money(ref)} (from shared prices)`
    : basis === 'was-price'
      ? `the shop's "was" price of ${money(ref)}`
      : enoughHistory
        ? `its usual ${money(ref)}`
        : `its usual ${money(ref)}`;
  const kind: VerdictKind = discount >= GREAT_SALE ? 'great' : discount >= GOOD_SALE ? 'good' : 'small';
  const headline = { great: 'Great deal', good: 'On special', small: 'Small saving' }[kind as 'great' | 'good' | 'small'];
  return { kind, headline, detail: `${deal}${pct(discount)} off ${vs}.`, saving, discount, basis };
}

// ---------- Pantry item recommendation ----------

export type Role = 'main' | 'alt';

export interface Option {
  product: Product;
  role: Role;
  stats: PriceStats;
  verdict: Verdict;
  price?: number; // effective current price, per item
  /** Price for one, without a multi-buy. */
  shelfPrice?: number;
  /** A multi-buy deal ("2 for $5") that the price assumes. */
  multi?: MultiBuy;
  locked: boolean;
  unitPrice?: number; // effective, per base unit
  normalUnitPrice?: number; // typical, per base unit
}

/**
 * buy   — your product is on a good or great sale
 * alt   — your product isn't on sale, but an alternative is, and it's cheaper
 * small — your product has a small saving
 * wait / skip / none — hold off, fake sale, normal price
 */
export type ActionKind = 'buy' | 'alt' | 'small' | 'wait' | 'skip' | 'none';

export interface Recommendation {
  group: Group;
  options: Option[];
  /** Your product at its cheapest store. */
  best?: Option;
  /** An alternative on sale that's cheaper than your product right now. */
  alt?: Option;
  /** Your product is out of stock everywhere it's linked (online stock, as the stores report it). */
  outOfStock?: boolean;
  /** When it is: the cheapest alternative that's in stock, sale or not. */
  stockAlt?: Option;
  action: ActionKind;
  headline: string;
  detail: string;
  saving?: number;
  /** Prices are compared per 100 g / per litre / per item. */
  byUnit: boolean;
  /** 0.9.6: priced lines left out of the comparison because their size is unknown. */
  sizeUnknown?: Option[];
}

/**
 * How much is in a product, from what you typed in, or its size and name. A "30 Pack" of
 * "375ml" cans is 11,250 ml, so it compares by the litre with a Woolworths "375mL x 30 pack".
 * count is how many are in the pack, when the size says.
 */
export function productQty(p: Product): { qty?: number; unit?: Product['qtyUnit']; count?: number } {
  // 0.9.6: a size the person typed, then the shop's words, then one worked out (barcode, look-alike). A pack of
  // drinks with no size at all has none: it isn't compared by the litre until the person says (or Restock can tell).
  const s = sizingOf(p).size;
  return { qty: s?.qty, unit: s?.unit, count: s?.count };
}

const ON_SALE: VerdictKind[] = ['great', 'good', 'small'];
export const isOnSale = (o?: Option) => !!o && ON_SALE.includes(o.verdict.kind);

export function recommend(
  group: Group,
  products: Map<string, Product>,
  readingsByProduct: Map<string, PriceReading[]>,
  cards: Set<Chain>,
  now = Date.now(),
  /**
   * 0.9.0: the shops switched on (recs.ts shopsOn). Products at any other shop are left out: no deal,
   * verdict, "cheapest at" or total. Hand-typed prices ('other') always count. Left out: every shop.
   */
  shopsOn?: ReadonlySet<string>,
  /** 0.9.6: other products to match barcodes against when a size is missing (the rest of the catalogue). */
  catalogue?: Product[],
): Recommendation {
  const ids: [string, Role][] = [
    ...mainProductIds(group).map((id): [string, Role] => [id, 'main']),
    ...group.altProductIds.map((id): [string, Role] => [id, 'alt']),
  ];

  // 0.9.6: sizes worked out for products that have none (a barcode match, a look-alike at another shop).
  const present = [...new Set(ids.map(([id]) => id))]
    .map((id) => products.get(id))
    .filter((p): p is Product => !!p && !(shopsOn && p.chain !== 'other' && !shopsOn.has(p.chain)));
  const latest = (id: string) => readingsByProduct.get(id)?.at(-1)?.price;
  const sized = new Map(withSizes(present, latest, catalogue).map((p) => [p.id, p]));

  const options: Option[] = [];
  const seen = new Set<string>();
  for (const [id, role] of ids) {
    const product = sized.get(id);
    if (!product || seen.has(id)) continue;
    seen.add(id);
    const hasCard = cards.has(product.chain);
    const stats = withMarket(computeStats(readingsByProduct.get(id) ?? [], now, hasCard), product.market);
    const allowMulti = group.allowMulti !== false;
    const verdict = judge(stats, hasCard, allowMulti);
    const { qty, unit } = productQty(product);
    let price: number | undefined;
    let shelfPrice: number | undefined;
    let multi: MultiBuy | undefined;
    let locked = false;
    if (stats.current) {
      // A multi-buy from a sale that may have ended (0.9.0) doesn't count: the price is for one.
      const eff = effectivePrice(stats.current, hasCard, allowMulti && verdict.stale !== 'ended', stats.typical);
      price = eff.price;
      shelfPrice = eff.shelf;
      multi = eff.multi;
      locked = eff.locked;
    }
    options.push({
      product,
      role,
      stats,
      verdict,
      price,
      shelfPrice,
      multi,
      locked,
      unitPrice: price !== undefined ? unitPrice(price, qty, unit) : undefined,
      normalUnitPrice: stats.typical !== undefined ? unitPrice(stats.typical, qty, unit) : undefined,
    });
  }

  // 0.9.6: Costco's online prices are information only (shown, with their comparison price) unless "I buy from
  // Costco online" is ticked: they never decide the cheapest, a deal or a swap otherwise.
  const decides = (o: Option) => o.product.chain !== 'costco' || costcoDecides();
  const priced = options.filter((o) => o.price !== undefined && decides(o));
  // Compare by the comparison price (per litre, per 100 g, per item) when the priced options share a unit.
  // Sheets ("4,320 sheets") and packs ("48 pack") both count, but not the same thing (0.8.9).
  // 0.9.6: a line whose size is unknown is left out of the cheapest comparison (it still shows, as "size unknown"),
  // as long as one of your picks has a size to compare by. With none, shelf prices decide, as before.
  const unitOf = (o: Option) => (!o.product.qty && inSheets(o.product.size) ? 'sheet' : productQty(o.product).unit);
  const sizedMains = priced.filter((o) => o.role === 'main' && o.unitPrice !== undefined);
  const units = new Set(priced.filter((o) => o.unitPrice !== undefined).map(unitOf));
  const byUnit = sizedMains.length > 0 && units.size === 1 && !units.has(undefined);
  const comparable = (o: Option) => !byUnit || o.unitPrice !== undefined;
  const cost = (o: Option) => (byUnit ? o.unitPrice! : o.price!);
  const cheapest = (list: Option[]) => list.filter(comparable).reduce<Option | undefined>((b, o) => (!b || cost(o) < cost(b) ? o : b), undefined);

  const unsized = byUnit ? priced.filter((o) => !comparable(o)) : [];
  const base: Recommendation = { group, options, action: 'none', headline: 'Usual prices', detail: '', byUnit, sizeUnknown: unsized.length ? unsized : undefined };
  if (!priced.length)
    return options.some((o) => o.price !== undefined)
      ? { ...base, headline: 'Costco prices only', detail: "Costco's online prices, which include delivery." }
      : { ...base, headline: 'No prices yet', detail: 'Check prices or add one by hand.' };

  // Out-of-stock products only count when nothing else is available.
  const gone = (o: Option) => o.product.inStock === false;
  const mains = priced.filter((o) => o.role === 'main');
  const best = cheapest(mains.filter((o) => !gone(o))) ?? cheapest(mains);
  const outOfStock = !!best && gone(best);
  // Bigger packs only count as swaps if this item allows them.
  const swappable = (o: Option) => o.role === 'alt' && !gone(o) && (group.allowBulk !== false || !isBulk(o, options, group));
  const alt = cheapest(priced.filter((o) => swappable(o) && isOnSale(o) && (!best || outOfStock || cost(o) < cost(best))));
  const stockAlt = outOfStock ? cheapest(priced.filter(swappable)) : undefined;
  base.outOfStock = outOfStock || undefined;
  base.stockAlt = stockAlt;

  if (best && !outOfStock && (best.verdict.kind === 'great' || best.verdict.kind === 'good')) {
    const where = chainLabel(best.product.chain);
    return {
      ...base,
      best,
      alt,
      action: 'buy',
      headline: `${best.verdict.headline} at ${where}`,
      detail: best.verdict.detail,
      saving: best.verdict.saving,
    };
  }

  if (alt) {
    const qty = productQty(alt.product).qty;
    const saving = best && byUnit && qty ? (best.unitPrice! - alt.unitPrice!) * qty : best ? best.price! - alt.price! : undefined;
    return {
      ...base,
      best,
      alt,
      action: 'alt',
      headline: `Swap & save at ${chainLabel(alt.product.chain)}`,
      detail: outOfStock
        ? `Yours (${describe(best!)}) is out of stock at ${chainLabel(best!.product.chain)}. Get ${describe(alt)} at ${chainLabel(alt.product.chain)} instead: it's in stock and on special for ${money(alt.price!)}.`
        : best
          ? `Instead of yours, ${describe(best)} at ${chainLabel(best.product.chain)} for ${money(best.price!)}, get ${describe(alt)} at ${chainLabel(alt.product.chain)}, on special for ${money(alt.price!)}.` +
            (byUnit ? ` That's ${unitText(alt)} instead of ${unitText(best)}.` : '')
          : `${describe(alt)} is on special at ${chainLabel(alt.product.chain)} for ${money(alt.price!)}.`,
      saving: saving && saving > 0.004 ? saving : undefined,
    };
  }

  if (!best) return { ...base, headline: 'No price for your product yet', detail: 'Check prices or add one by hand.' };

  if (outOfStock) {
    return {
      ...base,
      best,
      action: 'none',
      headline: 'Out of stock online',
      detail: stockAlt
        ? `${stockAlt.product.name} is in stock at ${chainLabel(stockAlt.product.chain)}.`
        : 'Your product is out of stock at every shop it is linked to. Add an alternative to have a backup.',
    };
  }

  const v = best.verdict;
  const where = chainLabel(best.product.chain);
  if (v.kind === 'small') return { ...base, best, action: 'small', headline: `Small saving at ${where}`, detail: v.detail, saving: v.saving };
  if (v.kind === 'wait') return { ...base, best, action: 'wait', headline: 'Wait for a better sale', detail: v.detail };
  if (v.kind === 'fake') return { ...base, best, action: 'skip', headline: 'Fake sale', detail: v.detail };
  if (v.kind === 'nodata') return { ...base, best, headline: 'No price yet', detail: v.detail };
  return { ...base, best, action: 'none', headline: `Cheapest at ${where}`, detail: v.detail };
}

/** A product's name with its size, if the name doesn't already say it ("Nutella Hazelnut Spread 1kg"). */
export function describe(o: Option): string {
  const { name, size } = o.product;
  if (nameHasSize(name, size)) return name;
  return `${name} ${size}`;
}

/** "$0.87 each" for a pack priced by the litre or kilo, so you can still see the price a can. Per item: for understanding, never for deciding. */
export function eachText(o?: Option): string {
  if (!o || o.price === undefined) return '';
  return priceLine(o.product, o.price).each ?? '';
}

/** The comparison price, "$2.61 / L" (only this decides the cheapest). */
function unitText(o: Option): string {
  return o.unitPrice !== undefined ? formatUnitPrice(o.unitPrice, productQty(o.product).unit) : '';
}

/** Both prices on one line: "$0.98 each · $2.61 / L (estimated)", or "$0.98 each · size unknown". */
export function bothPrices(o?: Option, style?: CompareStyle): string {
  return o ? priceLine(o.product, o.price, style).text : '';
}

/** 0.9.6: the one comparison unit for the lines of one item (its shops and packs), so they read the same way. */
export const optionStyle = (options: Option[]): CompareStyle => compareStyleOfProducts(options);

/**
 * Is this a bigger pack than your own product (more than 1.5 times the grams, millilitres or
 * items)? Used to keep bulk packs out of the suggestions for items that don't want them.
 * Mirrored in Deals.java.
 */
export function isBulk(o: Option, options: Option[], group: Group): boolean {
  const ref =
    options.find((x) => x.product.id === group.usualProductId && productQty(x.product).qty) ??
    options.find((x) => x.role === 'main' && productQty(x.product).qty);
  if (!ref || ref === o) return false;
  const a = productQty(o.product);
  const b = productQty(ref.product);
  return !!a.qty && !!b.qty && a.unit === b.unit && a.qty > b.qty * 1.5;
}

/** The option an alert or deal card is about. */
export function dealOption(rec: Recommendation): Option | undefined {
  if (rec.action === 'alt') return rec.alt;
  if (rec.action === 'buy' || rec.action === 'small') return rec.best;
  return undefined;
}

/** Should this item's deal be announced, given its alert setting? Mirrored in Deals.java. */
export function worthAlerting(rec: Recommendation): boolean {
  const o = dealOption(rec);
  const level = rec.group.alertLevel;
  if (!o || level === 'never' || o.product.id.startsWith('demo-')) return false;
  const k = o.verdict.kind;
  switch (level) {
    case 'any':
      return k === 'great' || k === 'good' || k === 'small';
    case 'good':
      return k === 'great' || k === 'good';
    case 'great':
      return k === 'great';
    case 'custom':
      return (o.verdict.discount ?? 0) >= (rec.group.alertPct ?? 30) / 100 - 1e-9;
    default:
      return false;
  }
}

export const ALERT_LEVELS: { id: Group['alertLevel']; label: string; explain: string }[] = [
  { id: 'any', label: 'Any price drop', explain: 'Any price drop at all, even 5c below its usual price.' },
  { id: 'good', label: 'Good sale (15%+)', explain: `At least ${GOOD_SALE * 100}% below its usual price.` },
  { id: 'great', label: 'Great deal (30%+)', explain: `At least ${GREAT_SALE * 100}% below its usual price.` },
  { id: 'custom', label: 'Custom', explain: 'Pick how much off it needs to be.' },
  { id: 'never', label: 'Never', explain: 'Keep tracking the price, but no alerts.' },
];

function chainLabel(c: Chain): string {
  return c === 'other' ? 'another shop' : chainName(c);
}

/**
 * The other stores selling your product at exactly the same price (and the same price per 100 g
 * or litre) as the cheapest one. When there are any, no store is "the cheapest".
 */
export function tiedWithBest(rec: Pick<Recommendation, 'best' | 'options'>): Option[] {
  const b = rec.best;
  if (!b || b.price === undefined) return [];
  // Compare unit prices as they're shown ("$1.65 / L"): one shop may write 3L and another 3000 ml,
  // which is the same price per litre. A missing unit price doesn't stop a tie on the same price.
  const shown = (o: Option) => unitText(o) || undefined;
  const same = (o: Option) => !shown(o) || !shown(b) || shown(o) === shown(b);
  return rec.options.filter(
    (o) => o !== b && o.role === b.role && o.product.inStock !== false && Math.abs((o.price ?? Infinity) - b.price!) < 0.005 && same(o),
  );
}
