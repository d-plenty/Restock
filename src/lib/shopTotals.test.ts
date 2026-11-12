import { describe, expect, it } from 'vitest';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import { toPicks } from './picks';
import { recommendedStores, shopTotals } from './shopTotals';
import { recommend } from './verdict';

const NOW = Date.parse('2026-11-05T00:00:00Z');
const prod = (id: string, chain: Product['chain']): Product => ({ id, chain, name: id, size: '400g', createdAt: '' });
const reading = (productId: string, price: number): PriceReading => ({
  productId,
  date: new Date(NOW).toISOString(),
  price,
  isSpecial: false,
  memberOnly: false,
  source: 'auto',
});

describe('one-shop totals', () => {
  it('prices the list at each store using your picks there', () => {
    const products = [prod('tom-ww', 'woolworths'), prod('tom-aldi-alt', 'aldi'), prod('tp-coles', 'coles'), prod('tp-ww', 'woolworths')];
    const groups: Group[] = [
      {
        id: 'tom',
        name: 'Diced tomatoes',
        usualProductId: 'tom-ww',
        sameProductIds: [],
        altProductIds: ['tom-aldi-alt'],
        alertLevel: 'any',
        createdAt: '',
      },
      { id: 'tp', name: 'Toilet paper', usualProductId: 'tp-coles', sameProductIds: ['tp-ww'], altProductIds: [], alertLevel: 'any', createdAt: '' },
    ];
    const readings = new Map([
      ['tom-ww', [reading('tom-ww', 1.2)]],
      ['tom-aldi-alt', [reading('tom-aldi-alt', 0.85)]],
      ['tp-coles', [reading('tp-coles', 9)]],
      ['tp-ww', [reading('tp-ww', 10)]],
    ]);
    const pm = new Map(products.map((p) => [p.id, p]));
    // As the 0.8.9 update moves them: the Aldi alternative is the only product at Aldi, so it's a pick there.
    const recs = groups.map((g) => recommend(toPicks(g, (id) => pm.get(id)?.chain), pm, readings, new Set(), NOW));
    const entries: ListEntry[] = [
      { id: '1', text: 'Diced tomatoes', groupId: 'tom', checked: false, createdAt: '' },
      { id: '2', text: 'Toilet paper', groupId: 'tp', checked: false, createdAt: '' },
      { id: '3', text: 'Bananas', checked: false, createdAt: '' },
      { id: '4', text: 'Old', groupId: 'tp', checked: true, createdAt: '' },
    ];
    const t = shopTotals(entries, recs, ['woolworths', 'coles', 'aldi']);
    const by = Object.fromEntries(t.stores.map((s) => [s.chain, s]));
    expect(by.woolworths.total).toBeCloseTo(11.2);
    expect(by.woolworths.missing).toEqual([]);
    expect(by.coles.total).toBeCloseTo(9);
    expect(by.coles.missing.map((m) => m.item)).toEqual(['Diced tomatoes']);
    // The next best place for the tomatoes is the Aldi one.
    expect(by.coles.missing[0].elsewhere?.product.id).toBe('tom-aldi-alt');
    expect(by.coles.totalWithElsewhere).toBeCloseTo(9.85);
    expect(by.woolworths.lines.map((l) => l.pick.product.id)).toEqual(['tom-ww', 'tp-ww']);
    expect(by.aldi.total).toBeCloseTo(0.85);
    expect(by.aldi.lines[0].pick.role).toBe('main');
    expect(t.stores[0].chain).toBe('woolworths'); // the only store with everything
    expect(t.around.total).toBeCloseTo(9.85);
    expect(t.around.chains.sort()).toEqual(['aldi', 'coles']);
    expect(t.unpriced).toBe(1);
  });

  it('multiplies by how many are on the list', () => {
    const products = [prod('a', 'coles')];
    const g: Group = { id: 'g', name: 'Tins', usualProductId: 'a', sameProductIds: [], altProductIds: [], alertLevel: 'any', createdAt: '' };
    const recs = [recommend(g, new Map(products.map((p) => [p.id, p])), new Map([['a', [reading('a', 1.5)]]]), new Set(), NOW)];
    const t = shopTotals([{ id: '1', text: 'Tins', groupId: 'g', qty: 3, checked: false, createdAt: '' }], recs, ['coles']);
    expect(t.stores[0].total).toBeCloseTo(4.5);
    expect(t.around.total).toBeCloseTo(4.5);
  });
});

describe('one-shop totals: value, price and stock', () => {
  const p = (id: string, chain: Product['chain'], size: string, inStock?: boolean): Product => ({
    id,
    chain,
    name: id,
    size,
    inStock,
    createdAt: '',
  });
  const products = [p('single-coles', 'coles', '420g'), p('fourpack-coles', 'coles', '4 x 420g'), p('aldi-alt', 'aldi', '420g', false)];
  const group: Group = {
    id: 'spag',
    name: 'Spaghetti',
    usualProductId: 'single-coles',
    sameProductIds: ['fourpack-coles'],
    altProductIds: ['aldi-alt'],
    alertLevel: 'any',
    createdAt: '',
  };
  const readings = new Map([
    ['single-coles', [reading('single-coles', 1.7)]],
    ['fourpack-coles', [reading('fourpack-coles', 6)]],
    ['aldi-alt', [reading('aldi-alt', 0.9)]],
  ]);
  const pm = new Map(products.map((x) => [x.id, x]));
  const recs = [recommend(toPicks(group, (id) => pm.get(id)?.chain), pm, readings, new Set(), NOW)];
  const entries: ListEntry[] = [{ id: '1', text: 'Spaghetti', groupId: 'spag', checked: false, createdAt: '' }];

  it('best value picks the multipack when it works out cheaper per 100 g; lowest price picks the single tin', () => {
    const value = shopTotals(entries, recs, ['coles'], 'unit');
    expect(value.stores[0].lines[0].pick.product.id).toBe('fourpack-coles');
    const price = shopTotals(entries, recs, ['coles'], 'price');
    expect(price.stores[0].lines[0].pick.product.id).toBe('single-coles');
  });

  it('still counts a store whose only version is out of stock, and says so', () => {
    const t = shopTotals(entries, recs, ['aldi'], 'unit');
    expect(t.stores[0].missing).toEqual([]);
    expect(t.stores[0].lines[0]).toMatchObject({ outOfStock: true });
    expect(t.stores[0].lines[0].pick.product.id).toBe('aldi-alt');
    // Shopping around prefers something in stock, at the shops being compared (0.10.1: only those).
    const both = shopTotals(entries, recs, ['aldi', 'coles'], 'unit');
    expect(both.pickFor.get('spag')?.pick.product.id).toBe('fourpack-coles');
    expect(t.pickFor.get('spag')?.pick.product.id).toBe('aldi-alt');
  });
});

describe('bulk packs', () => {
  it('never counts a Would also take for a store, even a cheaper bigger pack (0.8.9)', async () => {
    const { shopTotals } = await import('./shopTotals');
    const { recommend } = await import('./verdict');
    const NOW2 = Date.parse('2026-11-05T09:00:00+10:00');
    const mk = (id: string, chain: 'coles' | 'woolworths', size: string) => ({ id, chain, name: `Tomatoes ${size}`, size, createdAt: '' });
    const one = mk('one', 'coles', '400g');
    const six = mk('six', 'coles', '6 x 400g');
    const products = new Map([
      ['one', one],
      ['six', six],
    ]);
    const reading = (productId: string, price: number) => ({
      productId,
      date: new Date(NOW2).toISOString(),
      price,
      isSpecial: false,
      memberOnly: false,
      source: 'auto' as const,
    });
    const readings = new Map([
      ['one', [reading('one', 1)]],
      ['six', [reading('six', 4)]],
    ]);
    const base = {
      id: 'g',
      name: 'Tomatoes',
      usualProductId: 'one',
      sameProductIds: [],
      altProductIds: ['six'],
      alertLevel: 'good' as const,
      createdAt: '',
    };
    const entries = [{ id: 'e', text: 'Tomatoes', groupId: 'g', qty: 1, checked: false, createdAt: '' }];
    const yes = shopTotals(entries, [recommend({ ...base, allowBulk: true }, products, readings, new Set(), NOW2)], ['coles'], 'unit');
    expect(yes.pickFor.get('g')?.pick.product.id).toBe('one');
    const no = shopTotals(entries, [recommend({ ...base, allowBulk: false }, products, readings, new Set(), NOW2)], ['coles'], 'unit');
    expect(no.pickFor.get('g')?.pick.product.id).toBe('one');
  });
});

describe('which shop Restock recommends', () => {
  // Milo: Aldi only has a small tin. It's the cheapest checkout, but not the best value per 100 g.
  const products: Product[] = [
    { id: 'milo-ww', chain: 'woolworths', name: 'Milo', size: '1kg', createdAt: '' },
    { id: 'milo-coles', chain: 'coles', name: 'Milo', size: '1.2kg', createdAt: '' },
    { id: 'milo-aldi', chain: 'aldi', name: 'Milo', size: '680g', createdAt: '' },
  ];
  const groups: Group[] = [
    {
      id: 'milo',
      name: 'Milo',
      usualProductId: 'milo-ww',
      sameProductIds: ['milo-coles', 'milo-aldi'],
      altProductIds: [],
      alertLevel: 'any',
      createdAt: '',
    },
  ];
  const readings = new Map([
    ['milo-ww', [reading('milo-ww', 14)]],
    ['milo-coles', [reading('milo-coles', 18)]],
    ['milo-aldi', [reading('milo-aldi', 10.79)]],
  ]);
  const pm = new Map(products.map((p) => [p.id, p]));
  const recs = groups.map((g) => recommend(g, pm, readings, new Set(), NOW));
  const entries: ListEntry[] = [{ id: '1', text: 'Milo', groupId: 'milo', checked: false, createdAt: '' }];

  it('recommends the store where the same shopping costs least', () => {
    const t = shopTotals(entries, recs, ['woolworths', 'coles', 'aldi'], 'unit');
    const r = recommendedStores(t);
    expect(r.recommended?.chain).toBe('woolworths'); // 1 kg for $14
    expect(r.lowest?.chain).toBe('aldi'); // $10.79 at the till, but only 680 g
    expect(t.stores[0].chain).toBe('woolworths');
    const aldi = t.stores.find((s) => s.chain === 'aldi')!;
    expect(aldi.fair).toBeCloseTo(15.87, 1); // 1 kg of the Aldi tin
    expect(r.runnerUp?.chain).toBe('coles');
  });

  it('recommends the lowest checkout on "Lowest price"', () => {
    const t = shopTotals(entries, recs, ['woolworths', 'coles', 'aldi'], 'price');
    const r = recommendedStores(t);
    expect(r.recommended?.chain).toBe('aldi'); // $10.79 vs $14: clearly less at the till
    expect(r.reason).toBe('cheapest');
    expect(t.stores[0].chain).toBe('aldi');
  });
});

describe('a bulk deal at one store', () => {
  // Ten things a little cheaper at Aldi, and Woolworths with a big rice bag that's cheap per kg.
  const products: Product[] = [];
  const groups: Group[] = [];
  const readings = new Map<string, PriceReading[]>();
  for (let i = 0; i < 10; i++) {
    for (const [chain, price] of [
      ['aldi', 2],
      ['woolworths', 2.1],
    ] as const) {
      products.push({ id: `${i}-${chain}`, chain, name: `Thing ${i}`, size: '500g', createdAt: '' });
      readings.set(`${i}-${chain}`, [reading(`${i}-${chain}`, price)]);
    }
    groups.push({
      id: `g${i}`,
      name: `Thing ${i}`,
      usualProductId: `${i}-aldi`,
      sameProductIds: [`${i}-woolworths`],
      altProductIds: [],
      alertLevel: 'any',
      createdAt: '',
    });
  }
  products.push(
    { id: 'rice-aldi', chain: 'aldi', name: 'Rice', size: '1kg', createdAt: '' },
    { id: 'rice-ww', chain: 'woolworths', name: 'Rice', size: '1kg', createdAt: '' },
    { id: 'rice-ww-bulk', chain: 'woolworths', name: 'Rice', size: '10kg', createdAt: '' },
  );
  readings.set('rice-aldi', [reading('rice-aldi', 3)]);
  readings.set('rice-ww', [reading('rice-ww', 3.2)]);
  readings.set('rice-ww-bulk', [reading('rice-ww-bulk', 15)]);
  groups.push({
    id: 'rice',
    name: 'Rice',
    usualProductId: 'rice-aldi',
    sameProductIds: ['rice-ww', 'rice-ww-bulk'],
    altProductIds: [],
    alertLevel: 'any',
    allowBulk: true,
    createdAt: '',
  });
  const pm = new Map(products.map((p) => [p.id, p]));
  const recs = groups.map((g) => recommend(g, pm, readings, new Set(), NOW));
  const entries: ListEntry[] = groups.map((g) => ({ id: g.id, text: g.name, groupId: g.id, checked: false, createdAt: '' }));

  it("doesn't tip the recommendation", () => {
    const t = shopTotals(entries, recs, ['woolworths', 'aldi'], 'unit');
    const r = recommendedStores(t);
    // Per kg the 10 kg bag makes Woolworths look like better value...
    expect(r.bestValue?.chain).toBe('woolworths');
    // ...but for the same shopping Aldi is cheaper on every item.
    expect(r.recommended?.chain).toBe('aldi');
    expect(t.stores.find((s) => s.chain === 'aldi')?.cheapestFor).toBe(11);
    expect(r.saving).toBeCloseTo(1.2, 2);
    expect(r.mostlyFrom).toBeUndefined();
  });

  it('says when one item makes most of the difference', () => {
    const r2 = new Map(readings);
    r2.set('rice-aldi', [reading('rice-aldi', 0.5)]); // a big rice special at Aldi
    for (let i = 0; i < 10; i++) r2.set(`${i}-woolworths`, [reading(`${i}-woolworths`, 1.95)]);
    const recs2 = groups.map((g) => recommend(g, pm, r2, new Set(), NOW));
    const r = recommendedStores(shopTotals(entries, recs2, ['woolworths', 'aldi'], 'unit'));
    // Aldi is cheaper in total, but only because of one big special: Woolworths is cheaper for
    // the other ten things, so it's recommended.
    expect(r.cheapest?.chain).toBe('aldi');
    expect(r.mostlyFrom?.item).toBe('Rice');
    expect(r.recommended?.chain).toBe('woolworths');
    expect(r.reason).toBe('more-items');
  });

  it('calls a couple of dollars too close, and goes with the store cheaper for more items', () => {
    // Twelve things: Aldi cheaper for nine by 5c each, Woolworths cheaper for three by 60c each.
    const products: Product[] = [];
    const groups: Group[] = [];
    const rd = new Map<string, PriceReading[]>();
    for (let i = 0; i < 12; i++) {
      const [a, w] = i < 9 ? [2, 2.05] : [4, 3.4];
      for (const [chain, price] of [
        ['aldi', a],
        ['woolworths', w],
      ] as const) {
        products.push({ id: `c${i}-${chain}`, chain, name: `Item ${i}`, size: '500g', createdAt: '' });
        rd.set(`c${i}-${chain}`, [reading(`c${i}-${chain}`, price)]);
      }
      groups.push({
        id: `c${i}`,
        name: `Item ${i}`,
        usualProductId: `c${i}-aldi`,
        sameProductIds: [`c${i}-woolworths`],
        altProductIds: [],
        alertLevel: 'any',
        createdAt: '',
      });
    }
    const pm2 = new Map(products.map((p) => [p.id, p]));
    const recs3 = groups.map((g) => recommend(g, pm2, rd, new Set(), NOW));
    const es: ListEntry[] = groups.map((g) => ({ id: g.id, text: g.name, groupId: g.id, checked: false, createdAt: '' }));
    for (const by of ['unit', 'price'] as const) {
      const r = recommendedStores(shopTotals(es, recs3, ['woolworths', 'aldi'], by));
      expect(r.cheapest?.chain).toBe('woolworths'); // $1.35 less in total
      expect(r.close).toBe(true);
      expect(r.recommended?.chain).toBe('aldi'); // cheapest for 9 of 12
    }
  });

  it('keeps a clear winner', () => {
    const r2 = new Map(readings);
    for (let i = 0; i < 10; i++) r2.set(`${i}-woolworths`, [reading(`${i}-woolworths`, 3)]);
    const recs2 = groups.map((g) => recommend(g, pm, r2, new Set(), NOW));
    const r = recommendedStores(shopTotals(entries, recs2, ['woolworths', 'aldi'], 'price'));
    expect(r.recommended?.chain).toBe('aldi');
    expect(r.reason).toBe('cheapest');
    expect(r.close).toBe(false);
  });
});

describe('the same price everywhere', () => {
  it("doesn't call one shop cheapest when all three charge the same", async () => {
    const { tiedWithBest } = await import('./verdict');
    const products: Product[] = [
      { id: 'm-ww', chain: 'woolworths', name: 'Woolworths Full Cream Milk 3L', size: '3L', createdAt: '' },
      { id: 'm-coles', chain: 'coles', name: 'Coles Full Cream Milk', size: '3000ml', createdAt: '' },
      { id: 'm-aldi', chain: 'aldi', name: 'Full Cream Milk 3L', size: '3 l', createdAt: '' },
    ];
    const g: Group = {
      id: 'milk',
      name: 'Milk',
      usualProductId: 'm-ww',
      sameProductIds: ['m-coles', 'm-aldi'],
      altProductIds: [],
      alertLevel: 'any',
      createdAt: '',
    };
    const readings = new Map(products.map((p) => [p.id, [reading(p.id, 4.95)]]));
    const rec = recommend(g, new Map(products.map((p) => [p.id, p])), readings, new Set(), NOW);
    expect(tiedWithBest(rec)).toHaveLength(2);
  });
});

describe('a cheaper store missing a couple of items (0.7.2)', () => {
  // Coles is much cheaper for 4 things but doesn't have 2; Woolworths has all 6.
  const products: Product[] = [];
  const groups: Group[] = [];
  const readings = new Map<string, PriceReading[]>();
  const add = (id: string, prices: Partial<Record<'coles' | 'woolworths', number>>) => {
    const ids: string[] = [];
    for (const [chain, price] of Object.entries(prices) as ['coles' | 'woolworths', number][]) {
      products.push(prod(`${id}-${chain}`, chain));
      readings.set(`${id}-${chain}`, [reading(`${id}-${chain}`, price)]);
      ids.push(`${id}-${chain}`);
    }
    groups.push({ id, name: id, usualProductId: ids[0], sameProductIds: ids.slice(1), altProductIds: [], alertLevel: 'any', createdAt: '' });
  };
  for (let i = 0; i < 4; i++) add(`thing${i}`, { coles: 5, woolworths: 15 });
  add('only-ww-a', { woolworths: 3 });
  add('only-ww-b', { woolworths: 4 });
  const pm = new Map(products.map((p) => [p.id, p]));
  const recs = groups.map((g) => recommend(g, pm, readings, new Set(), NOW));
  const entries: ListEntry[] = groups.map((g) => ({ id: g.id, text: g.name, groupId: g.id, checked: false, createdAt: '' }));

  it('recommends it when it still wins after buying the rest elsewhere', () => {
    for (const by of ['unit', 'price'] as const) {
      const t = shopTotals(entries, recs, ['woolworths', 'coles'], by);
      const r = recommendedStores(t);
      expect(r.recommended?.chain).toBe('coles'); // $20 + $7 elsewhere, against $67
      expect(r.reason).toBe('with-elsewhere');
      expect(r.fewestMissing?.chain).toBe('woolworths');
      expect(r.saving).toBeCloseTo(40, 1);
    }
  });

  it('sticks with the store that has everything when the saving is small', () => {
    const near = recs.map((x) => x);
    const t = shopTotals(
      entries.filter((e) => e.groupId !== 'thing0' && e.groupId !== 'thing1' && e.groupId !== 'thing2'),
      near,
      ['woolworths', 'coles'],
      'price',
    );
    // Left: thing3 ($5 vs $15) and two only at Woolworths ($7): Coles route $12, Woolworths $22: still a clear win.
    expect(recommendedStores(t).recommended?.chain).toBe('coles');
    readings.set('thing3-coles', [reading('thing3-coles', 14)]);
    const recs2 = groups.map((g) => recommend(g, pm, readings, new Set(), NOW));
    const t2 = shopTotals(
      entries.filter((e) => e.groupId !== 'thing0' && e.groupId !== 'thing1' && e.groupId !== 'thing2'),
      recs2,
      ['woolworths', 'coles'],
      'price',
    );
    expect(recommendedStores(t2).recommended?.chain).toBe('woolworths'); // only $1 less: not worth a second stop
  });
});
