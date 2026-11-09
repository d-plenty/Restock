import type { Snapshot } from './db';
import { isCustom } from '../shops';
import { localDay } from './verdict';

// Shared prices (0.9.0). Restock's plan is an open price list anyone can search for free, shared
// between the phones and computers that run Restock rather than collected by one central server,
// and never sold. For now nothing is sent anywhere: with "Share prices" on (the default), backups get
// a "sharedPrices" section, ready for when sharing starts.
//
// It holds facts about products and prices only. Never: who you are, your cards, your branch or
// location, your list or what you ticked off, receipts, notes, or anything you typed about yourself.
//
// Only what Restock itself checked at a shop goes in: products a shop Restock knows has by its own
// product number, and the prices Restock read from the shop. Products and prices you typed in by hand
// stay out (their names and prices are yours, not the shop's), and so do the sample items. The
// day is the day on the phone's own calendar, as the shop's shelf price goes by local days
// (new specials start on a Wednesday in Australia, which is still Tuesday in UTC until 10am).

export interface SharedPrices {
  format: 'restock-shared-prices';
  version: 1;
  products: {
    /** A number for this file only, to tie prices to products. */
    n: number;
    chain: string;
    name: string;
    brand?: string;
    size?: string;
    barcode?: string;
    /** The shop's own product number (Woolworths stockcode, Coles id, Aldi sku). */
    shopId?: string;
    prices: { day: string; price: number; was?: number; special: boolean; member: boolean; promo?: string }[];
  }[];
}

export function sharedPrices(s: Pick<Snapshot, 'products' | 'prices'>): SharedPrices {
  const byProduct = new Map<string, SharedPrices['products'][number]['prices']>();
  for (const r of s.prices) {
    // Only prices Restock read from the shop: not ones typed in by hand ('manual'), and not the
    // sample items' made-up ones ('demo').
    if (r.source !== 'auto' || r.productId.startsWith('demo-')) continue;
    const list = byProduct.get(r.productId) ?? [];
    list.push({
      day: localDay(r.date),
      price: r.price,
      ...(r.wasPrice !== undefined ? { was: r.wasPrice } : {}),
      special: r.isSpecial,
      member: r.memberOnly,
      ...(r.promo ? { promo: r.promo } : {}),
    });
    byProduct.set(r.productId, list);
  }
  const products: SharedPrices['products'] = [];
  for (const p of s.products) {
    const prices = byProduct.get(p.id);
    // A product without the shop's own product number was typed in by hand. Shops people add
    // themselves are left out too: their "product number" is the product's web address on a site
    // Restock doesn't know, which could carry anything.
    if (!prices?.length || p.chain === 'other' || isCustom(p.chain) || p.id.startsWith('demo-') || !p.storeProductId) continue;
    products.push({
      n: products.length + 1,
      chain: p.chain,
      name: p.name,
      ...(p.brand ? { brand: p.brand } : {}),
      ...(p.size ? { size: p.size } : {}),
      ...(p.barcode ? { barcode: p.barcode } : {}),
      ...(p.storeProductId ? { shopId: p.storeProductId } : {}),
      prices,
    });
  }
  return { format: 'restock-shared-prices', version: 1, products };
}
