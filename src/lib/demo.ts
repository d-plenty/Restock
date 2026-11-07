import type { Chain, Group, PriceReading } from '../types';
import { allCategories, insertEntryOp, insertGroupOp, insertProductOp, insertReadingOp, nowIso, runOps, updateSettings } from './db';
import type { SqlOp } from './sql/driver';

// Sample items so testers can see verdicts working before real price history exists.
// Everything here is clearly marked "(sample)" and can be removed in Settings.

const DAY = 86_400_000;

interface DemoProduct {
  key: string;
  chain: Chain;
  name: string;
  size: string;
  normal: number;
  /** weeks-ago → sale price */
  sales?: Record<number, number>;
  current: { price: number; special?: boolean; was?: number; member?: boolean; promo?: string };
}

interface DemoGroup {
  key: string;
  name: string;
  category: string;
  usual: DemoProduct;
  same?: DemoProduct[];
  alts?: DemoProduct[];
}

const GROUPS: DemoGroup[] = [
  {
    key: 'paper',
    name: 'A4 copy paper',
    category: 'Pantry',
    usual: {
      key: 'paper-ww',
      chain: 'woolworths',
      name: 'A4 copy paper 500 sheets (sample)',
      size: '500 sheets',
      normal: 9,
      sales: { 20: 6.75, 12: 6.75, 6: 7.2 },
      current: { price: 4.5, special: true, was: 9, promo: '1/2 price' },
    },
    same: [
      {
        key: 'paper-coles',
        chain: 'coles',
        name: 'A4 copy paper 500 sheets (sample)',
        size: '500 sheets',
        normal: 8.5,
        current: { price: 8.5 },
      },
    ],
  },
  {
    key: 'tp',
    name: 'Toilet paper',
    category: 'Bathroom',
    usual: {
      key: 'tp-aldi',
      chain: 'aldi',
      name: 'Toilet paper 24 pack (sample)',
      size: '24 pack',
      normal: 5,
      current: { price: 5 },
    },
    alts: [
      {
        key: 'tp-coles',
        chain: 'coles',
        name: 'Coles toilet paper 24 pack (sample)',
        size: '24 pack',
        normal: 6,
        sales: { 15: 4.5 },
        current: { price: 3.5, special: true, was: 6, promo: 'Save $2.50' },
      },
      {
        key: 'tp-ww',
        chain: 'woolworths',
        name: 'Woolworths toilet paper 24 pack (sample)',
        size: '24 pack',
        normal: 6.2,
        current: { price: 6.2 },
      },
    ],
  },
  {
    key: 'coffee',
    name: 'Ground coffee 1kg',
    category: 'Pantry',
    usual: {
      key: 'coffee-coles',
      chain: 'coles',
      name: 'Ground coffee 1kg (sample)',
      size: '1kg',
      normal: 20,
      sales: { 24: 12, 18: 12, 12: 12, 6: 12 },
      current: { price: 15, special: true, was: 20, promo: 'Save $5' },
    },
  },
  {
    key: 'dish',
    name: 'Dishwasher tablets',
    category: 'Cleaning',
    usual: {
      key: 'dish-ww',
      chain: 'woolworths',
      name: 'Dishwasher tablets 60 pack (sample)',
      size: '60 pack',
      normal: 25,
      current: { price: 25, special: true, was: 27, promo: 'Special' },
    },
  },
  {
    key: 'laundry',
    name: 'Laundry liquid 2L',
    category: 'Cleaning',
    usual: {
      key: 'laundry-ww',
      chain: 'woolworths',
      name: 'Laundry liquid 2L (sample)',
      size: '2L',
      normal: 16,
      current: { price: 10, special: true, was: 16, member: true, promo: 'Member price' },
    },
  },
  {
    key: 'milk',
    name: 'Milk 2L',
    category: 'Fridge & freezer',
    usual: {
      key: 'milk-aldi',
      chain: 'aldi',
      name: 'Full cream milk 2L (sample)',
      size: '2L',
      normal: 3.1,
      current: { price: 3.1 },
    },
  },
  {
    key: 'pasta',
    name: 'Spaghetti 500g',
    category: 'Pantry',
    usual: {
      key: 'pasta-coles',
      chain: 'coles',
      name: 'Spaghetti 500g (sample)',
      size: '500g',
      normal: 2,
      current: { price: 1.8, special: true, was: 2, promo: 'Save 20c' },
    },
  },
];

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

export async function loadDemo(): Promise<void> {
  const now = Date.now();
  const categories = await allCategories();
  const catId = (name: string) => categories.find((c) => c.name === name)?.id;
  await removeDemo();
  const ops: SqlOp[] = [];
  for (const g of GROUPS) {
    const all = [g.usual, ...(g.same ?? []), ...(g.alts ?? [])];
    for (const p of all) {
      ops.push(insertProductOp({ id: `demo-${p.key}`, chain: p.chain, name: p.name, size: p.size, createdAt: nowIso() }, true));
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
  ops.push(
    insertEntryOp(
      { id: 'demo-list-1', text: 'Bananas', chain: 'woolworths', checked: false, createdAt: nowIso(), categoryId: catId('Fridge & freezer') },
      true,
    ),
    insertEntryOp({ id: 'demo-list-2', text: 'Bin bags', checked: false, createdAt: nowIso(), categoryId: catId('Cleaning') }, true),
  );
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
