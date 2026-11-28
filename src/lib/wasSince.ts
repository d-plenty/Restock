// 0.12.7: a shop's "Was $5.80 - 01/09/2026" (Woolworths' own wording on a special): the old price,
// and the day it stopped being the price. Said in plain words ("Was $5.80 until 1 Sep 2026"), and
// flagged when that day is more than 14 days back: a "special" that has run that long is close to
// being the usual price. It isn't called a fake special (that's Restock's own judgement, from price
// history); the date is just made hard to miss.

/** A special older than this is flagged. */
const WAS_OLD_DAYS = 14;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface WasSince {
  /** "Was $5.80 until 1 Sep 2026" */
  text: string;
  /** More than 14 days ago. */
  old: boolean;
  days: number;
}

/** The promo text as a was-price and date, or undefined when it isn't one. Dates are day/month/year. */
export function wasSince(promo: string | undefined, now: Date = new Date()): WasSince | undefined {
  const m = /^\s*was\s+\$?\s*(\d+(?:\.\d{1,2})?)\s*[-–—]\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/i.exec(promo ?? '');
  if (!m) return undefined;
  const [, price, d, mo, y] = m;
  const day = Number(d);
  const month = Number(mo);
  const year = Number(y);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const then = new Date(year, month - 1, day);
  if (then.getMonth() !== month - 1) return undefined;
  // Rounded: a day is 23 or 25 hours when the clocks change.
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - then.getTime()) / 86_400_000);
  return { text: `Was $${Number(price).toFixed(2)} until ${day} ${MONTHS[month - 1]} ${year}`, old: days > WAS_OLD_DAYS, days };
}
