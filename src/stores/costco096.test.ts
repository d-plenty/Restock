import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import emptyHtml from './fixtures-costco/empty.html?raw';
import ldHtml from './fixtures-costco/search-jsonld.html?raw';
import tilesHtml from './fixtures-costco/search-tiles.html?raw';
import productHtml from './fixtures-costco/product-page.html?raw';
import {
  CostcoBlockedError,
  Gate,
  checkReply,
  countFromName,
  estimateSize,
  isFoodPath,
  makeCostco,
  parseCostcoPage,
  parseUnitPrice,
  readFacts,
  sizeFromName,
  stateFromArea,
  textOf } from './costco';
import { type HttpResult } from './http';
import { costcoIsOn, searchChainsIn, setCostcoState } from '../shops';
import { checkSettings } from '../lib/settingsCheck';
import { DEFAULT_SETTINGS } from '../types';
import { withoutCostco } from '../lib/costcoLocal';
import { sharedPrices } from '../lib/sharedPrices';
import { shopsOn } from '../lib/recs';
import { recommend } from '../lib/verdict';
import { priceLine } from '../lib/unitPrice';
import { unitTextOf } from '../lib/searchHelp';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import type { Snapshot } from '../lib/db';

// 0.9.6: Costco. The pages below are AUTHORED BY HAND from the wording on costco.com.au (see the notes
// in each file under fixtures-costco/), so these prove the reader and the safeguards, not that Costco's
// real pages parse. That needs a test on a real phone.

const byId = (items: ReturnType<typeof parseCostcoPage>, id: string) => items.find((p) => p.storeProductId === id);

describe('Costco: reading a results page (hand-made fixture)', () => {
  const items = parseCostcoPage(tilesHtml);


  it('a special: price, usual price, save, dates, delivery, Costco unit price, size, per item', () => {
    const p = byId(items, '51210')!;
    expect(p.chain).toBe('costco');
    expect(p.name).toBe("Kellogg's Nutri-Grain Bars 36 x 40g");
    expect(p.price).toBe(23.99);
    expect(p.wasPrice).toBe(29.99);
    expect(p.isSpecial).toBe(true);
    expect(p.size).toBe('36 x 40g');
    expect(p.unitPriceText).toBe('$1.67 / 100g');
    expect(p.costco).toMatchObject({
      itemNumber: '51210',
      delivery: 'included',
      save: 6,
      validFrom: '2026-10-26',
      validTo: '2026-11-22',
      count: 36,
      perItem: 0.67,
      sizeFrom: 'name',
      category: 'Online Grocery / Snacks / Bars',
    });
    expect(p.costco!.ownUnit!.unit).toBe('g');
    expect(p.costco!.ownUnit!.perBase).toBeCloseTo(0.0167, 4);
    expect(p.promo).toBe('Online price, includes delivery · On special, save $6.00, until 22/11/2026');
    expect(p.imageUrl).toBe('https://www.costco.com.au/medias/51210.jpg');
  });

  it('Minimum purchase of 2 and We cannot ship this product to WA', () => {
    const p = byId(items, '277790')!;
    expect(p.price).toBe(23.99);
    expect(p.isSpecial).toBe(false);
    expect(p.costco).toMatchObject({
      minQty: 2,
      cantShipTo: ['WA'],
      delivery: 'included',
    });
    // No state known: the states Costco lists.
    expect(p.promo).toBe("Online price, includes delivery · Minimum 2 when buying online · Can't ship to WA");
    // The person's state: shown only when Costco can't ship there.
    const qld = byId(parseCostcoPage(tilesHtml, 'QLD'), '277790')!;
    expect(qld.promo).toBe('Online price, includes delivery · Minimum 2 when buying online');
    const wa = byId(parseCostcoPage(tilesHtml, 'WA'), '277790')!;
    expect(wa.promo).toContain("Can't ship to WA");
  });

  it('Business Delivery: shipping is added at checkout, and a per kg price is a comparison price', () => {
    const p = byId(items, '310022')!;
    expect(p.costco!.delivery).toBe('checkout');
    expect(p.promo).toBe('Online price, shipping added at checkout');
    expect(p.size).toBe('10kg');
    expect(p.unitPriceText).toBe('$0.32 / 100g');
    expect(p.costco!.ownUnit).toMatchObject({ unit: 'g' });
  });

  it('a per each price: the unit price is per item, the pack count comes from the name', () => {
    const p = byId(items, '412345')!;
    expect(p.costco!.ownUnit).toMatchObject({ unit: 'ea', perBase: 0.43 });
    expect(p.costco!.perItem).toBe(0.43);
    expect(p.costco!.count).toBe(100);
    expect(p.size).toBe('100 Pack');
    expect(p.unitPriceText).toBe('$0.43 each');
  });

  it('a pack with no size in the name stays "size unknown" when Costco only says per each', () => {
    const p = byId(items, '800300')!;
    expect(p.size).toBeUndefined();
    expect(p.costco!.sizeFrom).toBeUndefined();
    expect(p.costco!.perItem).toBe(0.25);
  });

  it('works a missing size out from the unit price, and says it is an estimate', () => {
    const p = byId(items, '420420')!;
    expect(p.size).toBe('1.5kg (estimated)');
    expect(p.costco!.sizeFrom).toBe('estimated');
  });

  it('per litre', () => {
    const p = byId(items, '555001')!;
    expect(p.size).toBe('24 x 330ml');
    expect(p.unitPriceText).toBe('$4.04 / L');
  });

  it('out of stock is said, and kept (the price still shows)', () => {
    const p = byId(items, '555001')!;
    expect(p.inStock).toBe(false);
    expect(p.price).toBe(31.99);
    expect(p.promo).toContain('Out of stock');
  });

  it('a member-only item has no price and says Member only', () => {
    const p = byId(items, '600100')!;
    expect(p.price).toBeUndefined();
    expect(p.memberOnly).toBe(true);
    expect(p.promo).toBe('Member only');
    expect(p.costco!.memberOnlyItem).toBe(true);
  });

  it('is not fooled by "Business Delivery" in the page menu', () => {
    for (const p of items) if (p.storeProductId !== '310022') expect(p.costco!.delivery).not.toBe('checkout');
  });
});

describe('Costco: the page’s own product data first', () => {
  const items = parseCostcoPage(ldHtml);
  it('uses JSON-LD (barcode, brand, decoded name) and adds what only the words say', () => {
    const p = byId(items, '51210')!;
    expect(p.name).toBe("Kellogg's Nutri-Grain Bars 36 x 40g");
    expect(p.barcode).toBe('9300675024235');
    expect(p.brand).toBe("Kellogg's");
    expect(p.price).toBe(23.99);
    expect(p.wasPrice).toBe(29.99);
    expect(p.costco!.validTo).toBe('2026-11-22');
  });
});

describe('Costco: a product page (an item number search can land on one)', () => {
  it('reads one product', () => {
    const items = parseCostcoPage(productHtml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      storeProductId: '277790',
      price: 23.99,
      size: '10 x 500g',
    });
    expect(items[0].costco).toMatchObject({
      minQty: 2,
      cantShipTo: ['WA', 'NT', 'TAS'],
    });
  });
});

describe('Costco: reading is defensive', () => {
  it('gives nothing, and does not throw, for pages it cannot read', () => {
    expect(parseCostcoPage('')).toEqual([]);
    expect(parseCostcoPage('<html><body>hello</body></html>')).toEqual([]);
    expect(parseCostcoPage(emptyHtml)).toEqual([]);
    expect(parseCostcoPage('<script type="application/ld+json">{not json</script><a href="/x/p/123456">')).toEqual([]);
  });
  it('unit prices in Costco’s mixed units', () => {
    expect(parseUnitPrice('$1.67 per 100 g')).toMatchObject({ unit: 'g' });
    expect(parseUnitPrice('$62.88 per kg')!.perBase).toBeCloseTo(0.06288, 5);
    expect(parseUnitPrice('$2.60 per 100 g')!.perBase).toBeCloseTo(0.026, 5);
    expect(parseUnitPrice('$0.42 per each')).toMatchObject({
      unit: 'ea',
      perBase: 0.42,
    });
    expect(parseUnitPrice('$0.25 per each')).toMatchObject({
      unit: 'ea',
      perBase: 0.25,
    });
    expect(parseUnitPrice('$2.10 per litre')!.perBase).toBeCloseTo(0.0021, 6);
    expect(parseUnitPrice('$1.20 per 100 ml')).toMatchObject({ unit: 'ml' });
    expect(parseUnitPrice('no unit price here')).toBeUndefined();
  });
  it('sizes, counts and estimates', () => {
    expect(sizeFromName('Chips 10 x 100g')).toBe('10 x 100g');
    expect(sizeFromName('Beans 1.58kg')).toBe('1.58kg');
    expect(sizeFromName('Coffee 100 capsules')).toBe('100 capsules');
    expect(sizeFromName('Mystery box')).toBeUndefined();
    expect(countFromName('Bars 36 x 40g')).toBe(36);
    expect(countFromName('Cans 1 x 400g')).toBeUndefined();
    expect(estimateSize(23.99, { text: '', perBase: 0.016, unit: 'g' })).toBe('1.5kg');
    expect(estimateSize(5, { text: '', perBase: 0.42, unit: 'ea' })).toBeUndefined();
  });
  it('states', () => {
    expect(readFacts('We cannot ship this product to WA, NT and TAS').cantShipTo).toEqual(['WA', 'NT', 'TAS']);
    expect(readFacts('We cannot ship this product to Western Australia').cantShipTo).toEqual(['WA']);
    expect(stateFromArea('Bohle Plains QLD 4817')).toBe('QLD');
    expect(stateFromArea('Werribee VIC 3030')).toBe('VIC');
    expect(stateFromArea(undefined)).toBeUndefined();
  });
  it('food only, by category path', () => {
    for (const ok of ['Online Grocery / Snacks', 'Grocery-Household/Pantry', 'Food-Pantry/Rice', 'Online Grocery / Beverages', undefined])
      expect(isFoodPath(ok)).toBe(true);
    for (const no of ['Home / Furniture', 'Electronics / TVs', 'Outdoor / Garden', 'Health & Beauty / Vitamins', 'Clothing', 'Something Odd'])
      expect(isFoodPath(no)).toBe(false);
  });
  it('words on a page', () => {
    expect(textOf('<p>a&nbsp;&amp;&nbsp;b</p><script>x</script><style>y</style>')).toBe('a & b');
  });
});

describe('Costco: gentle, and stops when turned away', () => {
  const ok = (text = tilesHtml): HttpResult => ({
    status: 200,
    text,
    headers: {},
  });
  const setup = (reply: () => HttpResult | Promise<HttpResult>, opts: { native?: boolean; on?: boolean } = {}) => {
    let t = 1_000_000;
    const waits: number[] = [];
    const gate = new Gate(
      1100,
      6,
      30 * 60_000,
      () => t,
      async (ms) => void ((t += ms), waits.push(ms)),
    );
    const request = vi.fn(async (_o: { url: string; anonymous?: string }) => reply());
    const costco = makeCostco({
      isNative: () => opts.native !== false,
      settings: () => ({
        costco: { on: opts.on !== false },
        area: { label: 'Bohle Plains QLD 4817' },
      }),
      request: request as never,
      gate,
    });
    return {
      costco,
      request,
      waits,
      gate,
      tick: (ms: number) => void (t += ms),
    };
  };




  it('waits at least a second between requests', async () => {
    const { costco, waits } = setup(() => ok());
    await costco.search('a');
    await costco.search('b');
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1100);
  });


  it.each([[403], [429]])('HTTP %i: stops with a plain message, no retry, and no more tries for a while', async (status) => {
    const { costco, request, tick } = setup(() => ({
      status,
      text: '',
      headers: {},
    }));
    await expect(costco.search('milk')).rejects.toThrow(/Costco blocked the search/);
    expect(request).toHaveBeenCalledTimes(1);
    await expect(costco.search('milk')).rejects.toBeInstanceOf(CostcoBlockedError);
    expect(request).toHaveBeenCalledTimes(1);
    tick(31 * 60_000);
    await expect(costco.search('milk')).rejects.toThrow(/blocked the search/);
    expect(request).toHaveBeenCalledTimes(2);
  });


  it('a page with nothing found is an empty answer; a page it does not recognise says so', async () => {
    expect(await setup(() => ok(emptyHtml)).costco.search('zzzz')).toEqual([]);
    await expect(
      setup(() => ok(`<html><body>${'<p>Welcome to something else entirely.</p>'.repeat(100)}</body></html>`)).costco.search('milk'),
    ).rejects.toThrow(/looked different/);
  });

  it('a network failure is a plain message', async () => {
    const { costco } = setup(() => {
      throw new Error('socket hang up');
    });
    await expect(costco.search('milk')).rejects.toThrow(/Couldn't reach Costco/);
  });

  it('checkReply', () => {
    expect(() => checkReply({ status: 200, text: tilesHtml, headers: {} })).not.toThrow();
    expect(() => checkReply({ status: 500, text: '', headers: {} })).toThrow('Costco returned HTTP 500');
    expect(() => checkReply({ status: 403, text: '', headers: {} })).toThrow(CostcoBlockedError);
  });
});

describe('Costco: one shop that lives on one phone', () => {
  beforeEach(() => setCostcoState(undefined));


  it('is off by default: never searched, never in the shops', () => {
    expect(costcoIsOn()).toBe(false);
    expect(searchChainsIn(['woolworths', 'coles', 'aldi'], 'pantry')).toEqual(['woolworths', 'coles', 'aldi']);
    expect(shopsOn({ ...DEFAULT_SETTINGS }).has('costco')).toBe(false);
  });



  it('the setting is on only with the proof the notice was read', () => {
    const s = (costco: unknown) => checkSettings({ costco } as never).costco;
    expect(s({ on: true })).toEqual({ on: false });
    expect(s({ on: true, acceptedAt: '2026-11-11T01:00:00.000Z', buyOnline: true })).toEqual({
      on: true,
      buyOnline: true,
      acceptedAt: '2026-11-11T01:00:00.000Z',
    });
    expect(s('yes')).toBeUndefined();
    expect(checkSettings({} as never).costco).toBeUndefined();
  });


});


// ---------- Costco prices stay on the phone ----------

const product = (id: string, chain: string, over: Partial<Product> = {}): Product => ({
  id,
  chain: chain as never,
  name: `${chain} ${id}`,
  storeProductId: id,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const reading = (productId: string, price: number, source: PriceReading['source'] = 'auto'): PriceReading => ({
  productId,
  date: '2026-11-10T02:00:00.000Z',
  price,
  isSpecial: false,
  memberOnly: false,
  source,
});
const group = (over: Partial<Group> = {}): Group => ({
  id: 'g1',
  name: 'Pasta',
  sameProductIds: [],
  altProductIds: [],
  alertLevel: 'normal' as never,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const snap = (): Snapshot => ({
  products: [product('w1', 'woolworths'), product('c1', 'costco', { name: 'Costco Pasta 10 x 500g' }), product('c2', 'costco')],
  groups: [
    group({
      usualProductId: 'w1',
      sameProductIds: ['c1'],
      altProductIds: ['c2'],
    }),
  ],
  prices: [reading('w1', 5), reading('c1', 23.99), reading('c2', 9.99, 'manual')],
  list: [
    {
      id: 'l1',
      text: 'Pasta',
      groupId: 'g1',
      checked: false,
      createdAt: '2026-11-10T00:00:00.000Z',
    },
    {
      id: 'l2',
      text: 'Nuts',
      chain: 'costco',
      price: 20,
      checked: false,
      createdAt: '2026-11-10T00:00:00.000Z',
    } as ListEntry,
  ],
  cards: [],
  categories: [],
  kv: [
    {
      key: 'settings',
      value: {
        ...DEFAULT_SETTINGS,
        costco: {
          on: true,
          buyOnline: true,
          acceptedAt: '2026-11-11T01:00:00.000Z',
        },
      },
    },
  ],
});

describe('Costco prices never leave the phone: copies of the data', () => {
  it('and changes nothing when there is no Costco', () => {
    const s = {
      ...snap(),
      products: [product('w1', 'woolworths')],
      prices: [reading('w1', 5)],
      list: [],
      kv: [],
    };
    expect(withoutCostco(s)).toBe(s);
  });


  it('the shared price pack has none of it, even if a Costco product slips in', () => {
    const pack = sharedPrices({
      products: snap().products,
      prices: snap().prices,
    });
    expect(pack.products.map((p) => p.chain)).toEqual(['woolworths']);
    expect(JSON.stringify(pack)).not.toMatch(/costco/i);
  });
});

describe('Costco prices never leave the phone: backup files', () => {
  beforeEach(async () => {
    const [{ initDb, ensureDefaults }] = await Promise.all([import('../lib/db')]);
    await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
    await ensureDefaults();
  });
  const fill = async () => {
    const db = await import('../lib/db');
    await db.addProduct(product('w1', 'woolworths'));
    await db.addProduct(product('c1', 'costco', { name: 'Costco Pasta 10 x 500g' }));
    await db.addReading({
      productId: 'w1',
      date: '2026-11-10T02:00:00.000Z',
      price: 5,
      isSpecial: false,
      memberOnly: false,
      source: 'auto',
    });
    await db.addReading({
      productId: 'c1',
      date: '2026-11-10T02:00:00.000Z',
      price: 23.99,
      isSpecial: false,
      memberOnly: false,
      source: 'auto',
    });
    await db.addGroup(group({ usualProductId: 'w1', sameProductIds: ['c1'] }));
    await db.updateSettings({
      costco: {
        on: true,
        buyOnline: true,
        acceptedAt: '2026-11-11T01:00:00.000Z',
      },
    });
  };
  it('the shared prices inside a backup have none of it either', async () => {
    await fill();
    const { backupJson, EVERYTHING } = await import('../lib/backup');
    const file = JSON.parse(await backupJson(EVERYTHING)) as {
      sharedPrices?: { products: { chain: string }[] };
    };
    expect(file.sharedPrices?.products.map((p) => p.chain) ?? []).not.toContain('costco');
  });
});


describe('Costco prices only decide the cheapest shop when "I buy from Costco online" is ticked', () => {
  afterEach(() => setCostcoState(undefined));
  const day = '2026-11-10T02:00:00.000Z';
  const now = Date.parse('2026-11-11T02:00:00.000Z');
  const build = () => {
    const products = new Map<string, Product>([
      ['w1', product('w1', 'woolworths', { name: 'Spaghetti 500g', size: '500g' })],
      [
        'c1',
        product('c1', 'costco', {
          name: 'Spaghetti 10 x 500g',
          size: '10 x 500g',
        }),
      ],
    ]);
    const readings = new Map<string, PriceReading[]>([
      ['w1', [{ ...reading('w1', 3), date: day }]],
      ['c1', [{ ...reading('c1', 23.99), date: day }]],
    ]);
    const g = group({ usualProductId: 'w1', sameProductIds: ['c1'] });
    return { products, readings, g };
  };


  it('counted when ticked: Costco’s per 100 g is lower, so it is the cheapest', () => {
    setCostcoState({ on: true, buyOnline: true });
    const { products, readings, g } = build();
    const rec = recommend(g, products, readings, new Set(), now, new Set(['woolworths', 'costco']));
    expect(rec.best?.product.chain).toBe('costco');
  });


});

describe('Costco: both prices, like every other shop (unitPrice.ts)', () => {
  const items = parseCostcoPage(tilesHtml);
  const line = (id: string) => {
    const p = byId(items, id)!;
    return priceLine({ ...p, chain: 'costco' }, p.price);
  };

  it('a size in the name: per item and the comparison price, as the shop gave them', () => {
    const l = line('51210');
    expect(l.each).toBe('$0.67 each');
    expect(l.compare).toBe('$1.67 / 100g');
    expect(l.tag).toBeUndefined();
    expect(l.unknown).toBe(false);
  });

  it('a size worked out from Costco’s unit price is said to be estimated', () => {
    const l = line('420420');
    expect(l.size).toContain('estimated');
    expect(l.compare).toBe('$1.33 / 100g');
    expect(l.tag).toBe('estimated');
  });

  it('a pack Costco only prices per each, with no size anywhere: size unknown, never a guess', () => {
    const l = line('800300');
    expect(l.unknown).toBe(true);
    expect(l.compare).toBeUndefined();
    expect(unitTextOf(byId(items, '800300')!)).toContain('size unknown');
  });

  it('shows on the search line the way the other shops do', () => {
    expect(unitTextOf(byId(items, '51210')!)).toBe('$0.67 each · $1.67 / 100g');
    expect(unitTextOf(byId(items, '420420')!)).toContain('(estimated)');
  });
});


