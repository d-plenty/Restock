import type { Chain, Group, PriceReading } from '../types';
import { allCategories, insertEntryOp, insertGroupOp, insertProductOp, insertReadingOp, nowIso, runOps, updateSettings } from './db';
import type { SqlOp } from './sql/driver';
import { DEMO_GROUPS, DEMO_LIST } from './demoData';

// Sample items so people can see Restock working before they've added anything of their own.
// 0.13.0: they're real items (demoData.ts), with example prices; all removed in Settings, or when the
// walkthrough ends. Their ids start "demo-", which keeps them out of sync, sharing and price checks.

const DAY = 86_400_000;

export interface DemoProduct {
  key: string;
  chain: Chain;
  name: string;
  size: string;
  /** 0.13.0: real items have their brand and photo. */
  brand?: string;
  imageUrl?: string;
  normal: number;
  /** weeks-ago → sale price */
  sales?: Record<number, number>;
  current: { price: number; special?: boolean; was?: number; member?: boolean; promo?: string };
}

export interface DemoGroup {
  key: string;
  name: string;
  category: string;
  usual: DemoProduct;
  same?: DemoProduct[];
  alts?: DemoProduct[];
}

function buildReadings(p: DemoProduct, now: number): Omit<PriceReading, 'id'>[] {
  const out: Omit<PriceReading, 'id'>[] = [];
  const id = `demo-${p.key}`;
  for (let w = 26; w >= 1; w--) {
    const sale = p.sales?.[w];
    out.push({
      productId: id,
      date: new Date(now - w * 7 * DAY).toISOString(),
      price: sale ?? p.normal,
      wasPrice: sale ? p.normal : undefined,
      isSpecial: !!sale,
      memberOnly: false,
      source: 'demo',
    });
  }
  out.push({
    productId: id,
    date: new Date(now - 60_000).toISOString(),
    price: p.current.price,
    wasPrice: p.current.was,
    isSpecial: !!p.current.special,
    memberOnly: !!p.current.member,
    promo: p.current.promo,
    source: 'demo',
  });
  return out;
}

/** What a sample set holds: the items, and what starts on the shopping list. */
export interface DemoSet {
  groups: DemoGroup[];
  /** Loose lines on the list (not one of the items). */
  entries?: { id: string; text: string; chain?: Chain; category?: string }[];
  /** Items (by key) that start on the shopping list. */
  listed?: string[];
}

/** 0.13.0: twenty real items from the makers' pantry, ten of them on the shopping list (demoData.ts). */
export const REAL_SET: DemoSet = { groups: DEMO_GROUPS, listed: DEMO_LIST };

export async function loadDemo(set: DemoSet = REAL_SET): Promise<void> {
  const now = Date.now();
  const categories = await allCategories();
  const catId = (name: string) => categories.find((c) => c.name === name)?.id;
  await removeDemo();
  const ops: SqlOp[] = [];
  for (const g of set.groups) {
    const all = [g.usual, ...(g.same ?? []), ...(g.alts ?? [])];
    for (const p of all) {
      ops.push(insertProductOp({ id: `demo-${p.key}`, chain: p.chain, name: p.name, brand: p.brand, size: p.size, imageUrl: p.imageUrl, createdAt: nowIso() }, true));
      buildReadings(p, now).forEach((r) => ops.push(insertReadingOp(r)));
    }
    const group: Group = {
      id: `demo-${g.key}`,
      name: g.name,
      categoryId: catId(g.category),
      usualProductId: `demo-${g.usual.key}`,
      sameProductIds: (g.same ?? []).map((p) => `demo-${p.key}`),
      altProductIds: (g.alts ?? []).map((p) => `demo-${p.key}`),
      alertLevel: 'good',
      createdAt: nowIso(),
    };
    ops.push(insertGroupOp(group, true));
  }
  for (const e of set.entries ?? [])
    ops.push(insertEntryOp({ id: e.id, text: e.text, chain: e.chain, checked: false, createdAt: nowIso(), categoryId: e.category ? catId(e.category) : undefined }, true));
  // the items that start on the list: each line is its item (so it shows the item's price and shop)
  (set.listed ?? []).forEach((key, i) => {
    const g = set.groups.find((x) => x.key === key);
    if (g) ops.push(insertEntryOp({ id: `demo-list-${i + 1}`, text: g.name, groupId: `demo-${g.key}`, checked: false, createdAt: nowIso(), categoryId: catId(g.category) }, true));
  });
  await runOps(ops);
  await updateSettings({ demoLoaded: true });
}

export async function removeDemo(): Promise<void> {
  await runOps([
    { sql: "DELETE FROM prices WHERE product_id LIKE 'demo-%'" },
    { sql: "DELETE FROM products WHERE id LIKE 'demo-%'" },
    { sql: "DELETE FROM list_entries WHERE id LIKE 'demo-%' OR item_id LIKE 'demo-%'" },
    { sql: "DELETE FROM items WHERE id LIKE 'demo-%'" },
  ]);
  await updateSettings({ demoLoaded: false });
}
