import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import blockedHtml from './fixtures-costco/blocked.html?raw';
import emptyHtml from './fixtures-costco/empty.html?raw';
import ldHtml from './fixtures-costco/search-jsonld.html?raw';
import tilesHtml from './fixtures-costco/search-tiles.html?raw';
import addSource from '../ui/screens/Add.tsx?raw';
import productHtml from './fixtures-costco/product-page.html?raw';
import {
  CostcoBlockedError,
  CostcoBusyError,
  Gate,
  checkReply,
  costcoSearchUrl,
  countFromName,
  estimateSize,
  isFoodPath,
  makeCostco,
  parseCostcoPage,
  parseUnitPrice,
  readFacts,
  sizeFromName,
  stateFromArea,
  textOf,
} from './costco';
import { NativeOnlyError, type HttpResult } from './http';
import { COSTCO_NOTICE, COSTCO_NOTICE_TEXT, COSTCO_OFF_MESSAGE } from '../lib/costcoNotice';
import { SHOPS, costcoDecides, costcoIsOn, enabledIn, isLocalOnlyShop, kindOf, searchChainsIn, setCostcoState } from '../shops';
import { checkSettings } from '../lib/settingsCheck';
import { DEFAULT_SETTINGS } from '../types';
import { withoutCostco } from '../lib/costcoLocal';
import { sharedPrices } from '../lib/sharedPrices';
import { csvFiles } from '../lib/csvExport';
import { builtInsOn } from '../lib/sharedSettings';
import { shopsOn } from '../lib/recs';
import { recommend } from '../lib/verdict';
import { priceLine } from '../lib/unitPrice';
import { unitTextOf } from '../lib/searchHelp';
import { shopTotals } from '../lib/shopTotals';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { migrate } from '../lib/sql/schema';
import { WebSyncEngine } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { signedText, verifySig } from '../server-mode/crypto';
import { SHOP_HOSTS } from './node';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import type { Snapshot } from '../lib/db';

// 0.9.6: Costco. The pages below are AUTHORED BY HAND from the wording on costco.com.au (see the notes
// in each file under fixtures-costco/), so these prove the reader and the safeguards, not that Costco's
// real pages parse. That needs a test on a real phone.

const byId = (items: ReturnType<typeof parseCostcoPage>, id: string) => items.find((p) => p.storeProductId === id);

describe('Costco: reading a results page (hand-made fixture)', () => {
  const items = parseCostcoPage(tilesHtml);

  it('finds the food and leaves the homewares', () => {
    expect(items.map((p) => p.storeProductId).sort()).toEqual(['277790', '310022', '412345', '420420', '51210', '555001', '600100', '800300']);
    expect(byId(items, '700200')).toBeUndefined();
  });

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
  it('skips non-food by the data’s category, and takes the words’ price when the data says 0', () => {
    expect(byId(items, '900900')).toBeUndefined();
    expect(byId(items, '610610')!.price).toBe(9.99);
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

  it('one request a search, from the phone’s own cookie-free jar, to the search page', async () => {
    const { costco, request } = setup(() => ok());
    const found = await costco.search('nutri grain');
    expect(found.length).toBeGreaterThan(5);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].url).toBe(costcoSearchUrl('nutri grain'));
    expect(request.mock.calls[0][0].url).toBe('https://www.costco.com.au/search?text=nutri%20grain');
    expect(request.mock.calls[0][0].anonymous).toBe('costco');
    // The person's state came from their area: a WA-only note does not show for QLD.
    expect(byId(found, '277790')!.promo).not.toContain('ship');
  });

  it('is off by default: nothing is sent', async () => {
    const { costco, request } = setup(() => ok(), { on: false });
    await expect(costco.search('milk')).rejects.toThrow(COSTCO_OFF_MESSAGE);
    expect(request).not.toHaveBeenCalled();
  });

  it('never runs where it is not a phone (the server, the web page)', async () => {
    const { costco, request } = setup(() => ok(), { native: false });
    await expect(costco.search('milk')).rejects.toBeInstanceOf(NativeOnlyError);
    expect(request).not.toHaveBeenCalled();
  });

  it('waits at least a second between requests', async () => {
    const { costco, waits } = setup(() => ok());
    await costco.search('a');
    await costco.search('b');
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1100);
  });

  it('a few a minute at most, nothing sent past that', async () => {
    const { costco, request, tick } = setup(() => ok());
    for (let i = 0; i < 6; i++) await costco.search(`q${i}`);
    await expect(costco.search('one more')).rejects.toBeInstanceOf(CostcoBusyError);
    expect(request).toHaveBeenCalledTimes(6);
    tick(61_000);
    await costco.search('later');
    expect(request).toHaveBeenCalledTimes(7);
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

  it('a robot check with a 200 is a block too', async () => {
    const { costco, request } = setup(() => ok(blockedHtml));
    await expect(costco.search('milk')).rejects.toThrow(/a robot check came up/);
    await expect(costco.search('milk')).rejects.toBeInstanceOf(CostcoBlockedError);
    expect(request).toHaveBeenCalledTimes(1);
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

  it('is a shop on the Pantry tab, read by its own adapter, never picked with the household’s shops', () => {
    expect(SHOPS.find((s) => s.id === 'costco')).toMatchObject({
      section: 'pantry',
      kind: 'costco',
      website: 'https://www.costco.com.au',
    });
    expect(kindOf('costco')).toBe('costco');
    expect(isLocalOnlyShop('costco')).toBe(true);
    expect(builtInsOn('pantry')).not.toContain('costco');
  });

  it('is off by default: never searched, never in the shops', () => {
    expect(costcoIsOn()).toBe(false);
    expect(searchChainsIn(['woolworths', 'coles', 'aldi'], 'pantry')).toEqual(['woolworths', 'coles', 'aldi']);
    expect(shopsOn({ ...DEFAULT_SETTINGS }).has('costco')).toBe(false);
  });

  it('switched on in this phone’s own setting: searched, shown, but not counted until "I buy from Costco online"', () => {
    setCostcoState({ on: true });
    expect(searchChainsIn(['woolworths', 'coles'], 'pantry')).toEqual(['woolworths', 'coles', 'costco']);
    expect(costcoDecides()).toBe(false);
    setCostcoState({ on: true, buyOnline: true });
    expect(costcoDecides()).toBe(true);
    setCostcoState({ on: false, buyOnline: true });
    expect(costcoDecides()).toBe(false);
    expect(enabledIn(['woolworths'], 'pantry')).toEqual(['woolworths']);
  });

  it('a picked "costco" in the household’s list is ignored (it is only ever this phone’s own switch)', () => {
    expect(
      checkSettings({
        enabledChains: ['coles', 'costco'],
        stores: { costco: { primary: 'x' } },
      } as never).enabledChains,
    ).toEqual(['coles']);
    expect(Object.keys(checkSettings({ stores: { costco: { primary: 'x' } } } as never).stores)).not.toContain('costco');
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

  it('the server may not ask costco.com.au', () => {
    expect([...SHOP_HOSTS.keys()].some((h) => h.includes('costco'))).toBe(false);
  });

  it('shows in shop lists on the web as phone only', async () => {
    const { COSTCO_WEB_NAME } = await import('../lib/costcoNotice');
    expect(COSTCO_WEB_NAME).toBe('Costco (phone only, turned on in Settings on a phone)');
  });
});

describe('Costco: the words', () => {
  it('say what the notice must say, plainly and without em dashes', () => {
    const text = COSTCO_NOTICE_TEXT;
    expect(text).toContain("Costco's website terms say automated collection of product listings isn't allowed.");
    expect(text).toMatch(/only looks when you press Search, one page at a time, from your phone/);
    expect(text).toMatch(/never runs in the background and never in bulk/);
    expect(text).toMatch(/Nothing from Costco is sent to your server, your other phones, exports or shared files/);
    expect(text).toMatch(/may block it or change its pages/);
    expect(text).toMatch(/your choice to turn this on, and your responsibility/);
    expect(text).toMatch(/online prices, which include delivery/);
    expect(text).toMatch(/differ from the warehouse shelf/);
    expect(COSTCO_NOTICE).toHaveLength(6);
    expect(text).not.toMatch(/—|–/);
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
  it('withoutCostco takes out its products, prices, picks, list lines and setting', () => {
    const out = withoutCostco(snap());
    expect(out.products.map((p) => p.id)).toEqual(['w1']);
    expect(out.prices.map((r) => r.productId)).toEqual(['w1']);
    expect(out.groups[0]).toMatchObject({
      usualProductId: 'w1',
      sameProductIds: [],
      altProductIds: [],
    });
    expect(out.list.map((e) => e.id)).toEqual(['l1']);
    expect(JSON.stringify(out)).not.toMatch(/costco|Costco/);
  });
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

  it('the spreadsheets (CSV) have none of it', () => {
    const text = csvFiles(snap())
      .map((f) => f.text)
      .join('\n');
    expect(text).not.toMatch(/costco/i);
    expect(text).not.toContain('23.99');
    expect(text).toContain('Woolworths');
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
  it('a backup file (shared, or automatic to a folder or a Restock server) has none of it; the copy kept inside Restock does', async () => {
    await fill();
    const { backupJson, EVERYTHING, readBackup } = await import('../lib/backup');
    const out = await backupJson(EVERYTHING);
    expect(out).not.toMatch(/costco/i);
    expect(out).not.toContain('23.99');
    expect(out).toContain('woolworths');
    expect(readBackup(out).snapshot.products.map((p) => p.id)).toEqual(['w1']);
    const kept = await backupJson({ ...EVERYTHING, keepCostco: true });
    expect(kept).toMatch(/costco/i);
    expect(
      readBackup(kept)
        .snapshot.prices.map((r) => r.price)
        .sort((a, b) => a - b),
    ).toEqual([5, 23.99]);
  });
  it('the shared prices inside a backup have none of it either', async () => {
    await fill();
    const { backupJson, EVERYTHING } = await import('../lib/backup');
    const file = JSON.parse(await backupJson(EVERYTHING)) as {
      sharedPrices?: { products: { chain: string }[] };
    };
    expect(file.sharedPrices?.products.map((p) => p.chain) ?? []).not.toContain('costco');
  });
});

describe('Costco prices never leave the phone: sync with other phones and the server', () => {
  let SQL: SqlJsStatic;
  beforeAll(async () => {
    SQL = await initSqlJs();
  });
  const engine = async () => {
    const d = await createSqlJsDriver({ load: async () => SQL });
    await migrate(d);
    const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
    e.setMeta('device', 'a1phone');
    return e;
  };

  it('Costco’s products and prices are on a tab no one shares; a list line is an ordinary line (review H1)', async () => {
    const e = await engine();
    expect(e.tabOf('products', { chain: 'costco' })).toBe('local');
    // 0.9.6 (review H1): a line an earlier build put at Costco is shared like any other (as Any shop).
    expect(e.tabOf('list_entries', { chain: 'costco', section: 'pantry' })).toBe('pantry');
    expect(e.tabOf('list_entries', { chain: 'costco' })).toBe('pantry');
    expect(e.tabOf('products', { chain: 'woolworths' })).toBe('pantry');
    e.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('w1', 'woolworths', 'Milk', 'x')");
    e.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('c1', 'costco', 'Pasta', 'x')");
    e.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('w1', '2026-11-10T00:00:00Z', 5, 0, 0, 'auto')");
    e.db.exec("INSERT INTO prices (product_id, date, price, is_special, member_only, source) VALUES ('c1', '2026-11-10T00:00:00Z', 23.99, 0, 0, 'auto')");
    // Every tab shared, with moves on (the most that could be sent): Costco's still isn't.
    const sent = e.collect(0, null, 1000, new Set(['pantry', 'keg', 'pharmacy', 'local']), '', true, 0).entries;
    const pks = sent.map((x) => `${x.tbl}:${x.pk}`);
    expect(pks).toContain('products:w1');
    expect(pks.some((k) => k.includes('c1'))).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('23.99');
  });

  it('what another device sends about Costco is not taken in', async () => {
    const e = await engine();
    const now = Date.now();
    const n = e.apply([
      {
        tbl: 'products',
        pk: 'c9',
        stamp: now,
        device: 'b2phone',
        created: now,
        deleted: false,
        row: { id: 'c9', chain: 'costco', name: 'Nope', created_at: 'x' },
      },
    ]);
    expect(n).toBe(0);
    expect(e.db.query("SELECT id FROM products WHERE id = 'c9'")).toEqual([]);
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

  it('information only by default: shown, with its price, but not "the cheapest"', () => {
    setCostcoState({ on: true });
    const { products, readings, g } = build();
    const rec = recommend(g, products, readings, new Set(), now, new Set(['woolworths', 'costco']));
    expect(rec.options.map((o) => o.product.chain).sort()).toEqual(['costco', 'woolworths']);
    expect(rec.options.find((o) => o.product.chain === 'costco')!.price).toBe(23.99);
    expect(rec.best?.product.chain).toBe('woolworths');
  });

  it('counted when ticked: Costco’s per 100 g is lower, so it is the cheapest', () => {
    setCostcoState({ on: true, buyOnline: true });
    const { products, readings, g } = build();
    const rec = recommend(g, products, readings, new Set(), now, new Set(['woolworths', 'costco']));
    expect(rec.best?.product.chain).toBe('costco');
  });

  it('a list never recommends Costco as a shop to buy at unless ticked', () => {
    const { products, readings, g } = build();
    for (const [buyOnline, expected] of [
      [false, ['woolworths']],
      [true, ['woolworths', 'costco']],
    ] as const) {
      setCostcoState({ on: true, buyOnline });
      const rec = recommend(g, products, readings, new Set(), now, new Set(['woolworths', 'costco']));
      const totals = shopTotals(
        [
          {
            id: 'l1',
            text: 'Pasta',
            groupId: 'g1',
            checked: false,
            createdAt: day,
          },
        ],
        [rec],
        ['woolworths', 'costco'],
        'unit',
      );
      expect(totals.stores.map((s) => s.chain).sort()).toEqual([...expected].sort());
    }
  });

  it('only Costco has a price: it says so, rather than "no prices yet"', () => {
    setCostcoState({ on: true });
    const { products, readings } = build();
    const rec = recommend(group({ usualProductId: 'c1' }), products, readings, new Set(), now, new Set(['costco']));
    expect(rec.headline).toBe('Costco prices only');
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

describe('Costco: follow-up searches never ask Costco', () => {
  it('Add.tsx asks the shops only in the Search itself; every follow-up goes through followAdapter, which refuses Costco', () => {
    const direct = [...addSource.matchAll(/adapterFor\(/g)].length;
    // searchChain (the Search) and followAdapter's own call: nothing else.
    expect(direct).toBe(2);
    expect(addSource).toMatch(/isLocalOnlyShop\(chain\) \? undefined : adapterFor/);
    expect(addSource).toContain('<CostcoLines sp={sp} />');
    expect(addSource).toContain('<CostcoLines sp={preview} />');
  });
});

describe('Costco: item picks at Costco stay on their phone', () => {
  let SQL: SqlJsStatic;
  beforeAll(async () => {
    SQL = await initSqlJs();
  });
  const engine = async () => {
    const d = await createSqlJsDriver({ load: async () => SQL });
    await migrate(d);
    const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
    e.setMeta('device', 'a1phone');
    e.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('w1', 'woolworths', 'Pasta', 'x')");
    e.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('c1', 'costco', 'Pasta 10 x 500g', 'x')");
    e.db.exec("INSERT INTO products (id, chain, name, created_at) VALUES ('c2', 'costco', 'Rice 10kg', 'x')");
    e.db.exec(
      "INSERT INTO items (id, name, usual_product_id, same_product_ids, alt_product_ids, alert_level, created_at) VALUES ('g1', 'Pasta', 'c1', '[\"w1\",\"c1\"]', '[\"c2\"]', 'good', 'x')",
    );
    return e;
  };

  it('goes without its Costco picks, so no other phone has a pick with a missing product', async () => {
    const e = await engine();
    const sent = e.collect(0, null, 1000, new Set(['pantry']), '', true, 0).entries.find((x) => x.tbl === 'items' && x.pk === 'g1')!;
    // 0.9.6 (review L2): a usual pick at Costco is left out, so the other phones keep their own.
    expect(sent.row && 'usual_product_id' in sent.row).toBe(false);
    expect(JSON.parse(String(sent.row?.same_product_ids))).toEqual(['w1']);
    expect(JSON.parse(String(sent.row?.alt_product_ids))).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/c1|c2/);
    // The phone's own item is as it was.
    expect(e.db.query("SELECT usual_product_id, same_product_ids FROM items WHERE id = 'g1'")[0]).toMatchObject({
      usual_product_id: 'c1',
      same_product_ids: '["w1","c1"]',
    });
  });

  it('another phone’s change to the item keeps this phone’s own Costco picks', async () => {
    const e = await engine();
    const now = Date.now() + 1000;
    const row = {
      id: 'g1',
      name: 'Pasta shapes',
      category_id: null,
      usual_product_id: null,
      same_product_ids: '["w1","w9"]',
      alt_product_ids: '[]',
      threshold_pct: null,
      alert_level: 'good',
      created_at: 'x',
    };
    expect(e.apply([{ tbl: 'items', pk: 'g1', stamp: now, device: 'b2phone', created: now, deleted: false, row }])).toBe(1);
    const mine = e.db.query("SELECT name, usual_product_id, same_product_ids, alt_product_ids FROM items WHERE id = 'g1'")[0];
    expect(mine.name).toBe('Pasta shapes');
    expect(mine.usual_product_id).toBe('c1');
    expect(JSON.parse(String(mine.same_product_ids)).sort()).toEqual(['c1', 'w1', 'w9']);
    expect(JSON.parse(String(mine.alt_product_ids))).toEqual(['c2']);
  });
});
