import { isNative } from '../stores/http';
import type { StoreProduct } from '../stores/types';
import { RestockNative } from './sql/native';
import { cachedSettings, getKV, putKV, queryRows } from './db';
import type { Settings } from '../types';

// 0.9.14: "Send prices back" (Settings → Privacy and sharing, on unless turned off). What a search
// shows from Coles, Woolworths, Aldi and Costco waits in the "priceShareOutbox" store entry, and
// PriceShare.java sends it, with the prices price checks read, to Restock's shared price service
// (restock-prices.plenty.family/share/prices). Only what the shop's website said: a price typed in
// by hand is never in a search result or a price check, so it never goes. Android app only.

export const SHARE_SHOPS = ['coles', 'woolworths', 'aldi', 'costco'] as const;
export const SHARE_URL = 'https://restock-prices.plenty.family/share/prices';
const OUTBOX = 'priceShareOutbox';
const MAX_WAITING = 4000;
const SEND_AFTER_MS = 2 * 60_000;

export interface PriceShareStatus {
  at?: string;
  lastSentAt?: string;
  sent?: number;
  total?: number;
  error?: string;
}

/**
 * 0.10.0: Shared prices, one switch: getting the shared history (marketData.enabled) and sending
 * prices back (sharePrices) go together, on unless turned off (settingsCheck keeps them the same).
 */
export const sharedOn = (s: Pick<Settings, 'sharePrices'>) => s.sharePrices !== 'no';
export const sharing = (s = cachedSettings()) => !!s && sharedOn(s);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A search result in the shared price service's shape (lib/helper.mjs cleanProduct there), or undefined. */
export function shareShape(p: StoreProduct, day = today()) {
  if (!(SHARE_SHOPS as readonly string[]).includes(p.chain) || !p.storeProductId || !/^[\w.-]{1,40}$/.test(p.storeProductId)) return undefined;
  if (!(typeof p.price === 'number' && p.price > 0) || !p.name?.trim() || p.storeProductId.startsWith('demo-') || p.storeProductId.startsWith('fake')) return undefined;
  return {
    id: `${p.chain}:${p.storeProductId}`,
    chain: p.chain,
    store_product_id: p.storeProductId,
    name: p.name.trim().slice(0, 200),
    ...(p.brand ? { brand: p.brand.slice(0, 80) } : {}),
    ...(p.size ? { size: p.size.slice(0, 60) } : {}),
    ...(p.barcode && /^\d{8,14}$/.test(p.barcode) ? { barcode: p.barcode } : {}),
    ...(p.imageUrl && /^https:\/\//.test(p.imageUrl) ? { image_url: p.imageUrl.slice(0, 300) } : {}),
    day,
    price: {
      price: p.price,
      ...(p.wasPrice && p.wasPrice > p.price ? { was_price: p.wasPrice } : {}),
      is_special: !!p.isSpecial,
      member_only: !!p.memberOnly,
      ...(p.promo ? { promo: p.promo.slice(0, 120) } : {}),
    },
  };
}

let timer: ReturnType<typeof setTimeout> | undefined;
let adding: Promise<void> = Promise.resolve();

/** What a search showed, kept to send (and sent a couple of minutes later, all together). */
export function noteSearch(products: StoreProduct[]): void {
  if (!isNative() || import.meta.env.VITE_FAKE_STORES === '1' || !sharing() || !products.length) return;
  const shaped = products.map((p) => shareShape(p)).filter((x): x is NonNullable<typeof x> => !!x);
  if (!shaped.length) return;
  adding = adding
    .then(async () => {
      const box = (await getKV<unknown[]>(OUTBOX)) ?? [];
      await putKV(OUTBOX, [...box, ...shaped].slice(-MAX_WAITING));
    })
    .catch(() => undefined);
  timer ??= setTimeout(() => {
    timer = undefined;
    void sendPricesNow();
  }, SEND_AFTER_MS);
}

/** Sends what's waiting (searches and price checks). Quietly does nothing when off or offline. */
export async function sendPricesNow(): Promise<number> {
  if (!isNative() || !sharing()) return 0;
  await adding;
  try {
    return (await RestockNative.sharePrices()).sent;
  } catch {
    return 0;
  }
}

export const priceShareStatus = () => getKV<PriceShareStatus>('priceShare');

/**
 * 0.10.0: Shared prices turned on after being off starts from now: prices read while it was off,
 * and searches kept from then, never go (PriceShare.java sends from priceShareCursor on).
 */
export async function shareFromNow(): Promise<void> {
  const [row] = await queryRows<{ m: number | null }>('SELECT MAX(id) AS m FROM prices');
  await putKV('priceShareCursor', row?.m ?? 0);
  await putKV(OUTBOX, []);
}
