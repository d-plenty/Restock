// 0.9.5 (web search): the web's side of "Let the web page search the shops": the setting, the
// calls and their errors in words, ticking and the bar's arrow (the phone's own rules), Enter in the
// add box, the add body (General a list only), Picked for you from what the shops sent, specials,
// and a scanned barcode searching the shops only when the setting is on.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreProduct } from '../../stores/types';
import { keyOf, sheetOpenAfter, togglePick } from '../../ui/screens/addPicks';

const calls: { method: string; path: string; body: unknown }[] = [];
let settingsAnswer: { webSearch?: boolean } = { webSearch: false };
let sendAnswer: (path: string, body: unknown) => unknown = () => ({});

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api3: {
      settings: async () => settingsAnswer,
      putSettings: async (s: { webSearch?: boolean }) => {
        calls.push({ method: 'PUT', path: '/api/v3/settings', body: s });
        settingsAnswer = { ...settingsAnswer, ...s };
        return settingsAnswer;
      },
    },
    v3Send: async (method: string, path: string, body: unknown) => {
      calls.push({ method, path, body });
      return sendAnswer(path, body);
    },
  };
});
vi.mock('./houseData', () => ({ house: () => true, canAdmin: () => true }));

const ws = await import('./webSearch');
const { ApiError } = await import('../api');

const sp = (chain: StoreProduct['chain'], id: string, name: string, price: number, more: Partial<StoreProduct> = {}): StoreProduct => ({
  chain,
  storeProductId: id,
  name,
  price,
  isSpecial: false,
  memberOnly: false,
  ...more,
});

const MILK_W = sp('woolworths', '12', 'Woolworths Full Cream Milk 2L', 3.1, { brand: 'Woolworths', size: '2L', wasPrice: 6.2, isSpecial: true });
const MILK_C = sp('coles', '55', 'Coles Full Cream Milk 2L', 3.1, { brand: 'Coles', size: '2L' });
const CHOC_C = sp('coles', '56', 'Cadbury Dairy Milk Chocolate 180g', 6, { brand: 'Cadbury', size: '180g' });
const ANSWER: import('./webSearch').SearchAnswer = {
  search: 'abc',
  at: '2026-11-10T00:00:00Z',
  expires: '2026-11-10T00:15:00Z',
  text: 'milk',
  section: 'pantry',
  shops: [
    { chain: 'woolworths', name: 'Woolworths', status: 'ok', items: [MILK_W], top: ['12'] },
    { chain: 'coles', name: 'Coles', status: 'ok', items: [CHOC_C, MILK_C], top: [] },
    { chain: 'aldi', name: 'Aldi', status: 'blocked', blocked: true, message: 'Aldi blocked the search from your server. Search it on a phone instead.' },
  ],
};

beforeEach(() => {
  calls.length = 0;
  settingsAnswer = { webSearch: false };
  sendAnswer = () => ({});
  ws.resetWebSearch(undefined);
  ws.askShops(undefined);
});

describe('the setting', () => {
  it('is read from the server, saved through the settings write, and goes off when the server says so', async () => {
    await ws.loadWebSearch();
    expect(calls).toEqual([]);
    expect(await ws.saveWebSearch(true)).toBe(true);
    expect(calls).toEqual([{ method: 'PUT', path: '/api/v3/settings', body: { webSearch: true } }]);
    // Someone turned it off meanwhile: a search answers 403 web-search-off and the page shows it off.
    sendAnswer = () => {
      throw new ApiError(403, 'web-search-off', 'Turn on Let the web page search the shops in Settings.');
    };
    await expect(ws.searchShops({ q: 'milk', section: 'pantry' })).rejects.toThrow();
    // A scan then doesn't search (off).
    expect(await ws.barcodeSearch('9300000000001', 'pantry')).toBeUndefined();
  });

  it('uses the words Declan asked for', () => {
    expect(ws.WEB_SEARCH_TITLE).toBe('Let the web page search the shops');
    expect(ws.WEB_SEARCH_TEXT).toContain('The server only contacts a shop when someone presses Search here; nothing runs in the background.');
    expect(ws.TURN_ON_LINK).toBe('Search the shops from here? Turn it on in Settings.');
    expect(ws.PICK_OFF_TEXT).toBe('Search the shops on a phone, or turn on Let the web page search the shops in Settings.');
    for (const t of [ws.WEB_SEARCH_TEXT, ws.TURN_ON_LINK, ws.PICK_OFF_TEXT]) expect(t).not.toMatch(/—|store\b|device/);
  });
});

describe('errors in words', () => {
  it('429, 410, 403 and the rest', () => {
    expect(ws.searchErrorText(new ApiError(429, 'rate', "That's a lot of searches"))).toBe('Too many searches. Try again in a minute.');
    expect(ws.searchErrorText(new ApiError(429, 'rate-server', 'x'))).toBe('Your server has done a lot of searches this hour. Try again later, or search on a phone.');
    expect(ws.searchErrorText(new ApiError(410, 'search-gone', 'Search again first'))).toBe('That search expired. Search again.');
    expect(ws.searchErrorText(new ApiError(403, 'web-search-off', 'x'))).toBe('Turn on Let the web page search the shops in Settings.');
    expect(ws.searchErrorText(new ApiError(400, 'chain', "That isn't one of your shops."))).toBe("That isn't one of your shops.");
    expect(ws.isGone(new ApiError(410, 'search-gone', ''))).toBe(true);
    expect(ws.isGone(new ApiError(429, 'rate', ''))).toBe(false);
  });
});

describe('ticks and the bar (as the phone)', () => {
  it('a tap only ticks; only the arrow opens the sheet; nothing ticked shuts it', () => {
    let picks = new Map<string, StoreProduct>();
    let open = false;
    picks = togglePick(picks, MILK_W);
    open = sheetOpenAfter(open, { kind: 'picks', size: picks.size });
    expect([picks.size, open]).toEqual([1, false]);
    open = sheetOpenAfter(open, { kind: 'arrow', size: picks.size });
    expect(open).toBe(true);
    picks = togglePick(picks, MILK_C);
    open = sheetOpenAfter(open, { kind: 'picks', size: picks.size });
    expect([picks.size, open]).toEqual([2, true]);
    picks = togglePick(togglePick(picks, MILK_C), MILK_W);
    open = sheetOpenAfter(open, { kind: 'picks', size: picks.size });
    expect([picks.size, open]).toEqual([0, false]);
    expect(ws.tickedShops([MILK_W, MILK_C, CHOC_C])).toBe('Woolworths, Coles (2)');
  });

  it('shows ticked ones first and the rest under Show more; On special only', () => {
    const coles = ANSWER.shops[1];
    const picks = new Map([[keyOf(MILK_C), MILK_C]]);
    expect(ws.shownItems(coles, picks, false, 1)).toEqual({ list: [MILK_C], left: 1, total: 2 });
    expect(ws.shownItems(ANSWER.shops[0], new Map(), true, 5).list).toEqual([MILK_W]);
    expect(ws.shownItems(coles, new Map(), true, 5).total).toBe(0);
    expect(ws.shopNote(ANSWER.shops[2])).toMatch(/^Aldi blocked the search from your server/);
    expect(ws.shopNote({ chain: 'coles', name: 'Coles', status: 'ok', items: [], top: [] })).toBe('No matches at Coles.');
  });

  it('Picked for you at your other shops comes from what the others sent back (no second search)', () => {
    const r = ws.picksForYou(MILK_W, ANSWER.shops, 'milk');
    expect(r.map((x) => x.chain)).toEqual(['coles']);
    expect(r[0].same?.storeProductId ?? r[0].like[0]?.storeProductId).toBe('55');
    expect(calls).toEqual([]);
  });
});

describe('Enter in the add box', () => {
  it('your item first, then the shops (when on and nothing in the pantry is like it), else the words', () => {
    expect(ws.enterDoes({ text: ' ', exactPantry: false, pantryMatches: 0, searchOn: true })).toBe('nothing');
    expect(ws.enterDoes({ text: 'milk', exactPantry: true, pantryMatches: 1, searchOn: true })).toBe('pantry');
    expect(ws.enterDoes({ text: 'honey', exactPantry: false, pantryMatches: 0, searchOn: true })).toBe('search');
    expect(ws.enterDoes({ text: 'hon', exactPantry: false, pantryMatches: 2, searchOn: true })).toBe('add');
    expect(ws.enterDoes({ text: 'honey', exactPantry: false, pantryMatches: 0, searchOn: false })).toBe('add');
    expect(ws.enterDoes({ text: 'honey', exactPantry: false, pantryMatches: 0, searchOn: undefined })).toBe('add');
  });
});

describe('Track, Add to list, or both', () => {
  it('builds the body from the ticks; General is a list only and has no category', () => {
    const picks = [MILK_W, MILK_C];
    expect(ws.addBody('abc', picks, { target: 'both', tab: 'pantry', list: 'pantry', name: ' Milk ', categoryId: 'c1', qty: 2 })).toEqual({
      search: 'abc',
      picks: [
        { chain: 'woolworths', storeProductId: '12' },
        { chain: 'coles', storeProductId: '55' },
      ],
      target: 'both',
      name: 'Milk',
      categoryId: 'c1',
      qty: 2,
    });
    expect(ws.addBody('abc', [MILK_W], { target: 'list', tab: 'pantry', list: 'general', categoryId: 'c1' })).toEqual({
      search: 'abc',
      picks: [{ chain: 'woolworths', storeProductId: '12' }],
      target: 'list',
      list: 'general',
    });
    expect(() => ws.addBody('abc', [MILK_W], { target: 'both', tab: 'pantry', list: 'general' })).toThrow(/General is a list only/);
    expect(() => ws.addBody('abc', [MILK_W], { target: 'pantry', tab: 'pantry', list: 'general' })).toThrow(/General is a list only/);
    expect(() => ws.addBody('abc', [MILK_W], { target: 'list', tab: 'pantry', list: 'keg' })).toThrow();
    expect(() => ws.addBody('abc', [], { target: 'list', tab: 'pantry', list: 'pantry' })).toThrow(/Tick at least one/);
    expect(() => ws.addBody('abc', Array(7).fill(MILK_W), { target: 'list', tab: 'pantry', list: 'pantry' })).toThrow(/6 or fewer/);
    expect(ws.listChoices('keg')).toEqual(['keg', 'general']);
    expect(ws.searchTabFor('general')).toBe('pantry');
    expect(ws.searchTabFor('pharmacy')).toBe('pharmacy');
  });

  it('sends it to search/add and says where it went', async () => {
    sendAnswer = (path) => (path === '/api/v3/search/add' ? { item: null, products: [], line: { id: 'l1', list: 'general' } } : {});
    const a = await ws.addFromSearch(ws.addBody('abc', [MILK_W], { target: 'list', tab: 'pantry', list: 'general' }));
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/v3/search/add', body: { list: 'general', target: 'list' } });
    // No price is ever sent: the server saves the shop's.
    expect(JSON.stringify(calls.at(-1)?.body)).not.toMatch(/price/i);
    expect(ws.addedText(a, 'Milk', 'pantry')).toBe('Milk added to General');
    expect(ws.addedText({ item: { id: 'i', name: 'Milk', section: 'pantry' }, products: ['p'], line: { id: 'l' } }, 'Milk', 'pantry')).toBe(
      'Milk added to your pantry and your Shopping list',
    );
    expect(ws.addedText({ item: { id: 'i', name: 'Ale', section: 'keg' }, products: ['p'], line: null }, 'Ale', 'keg')).toBe('Ale added to your keg');
    expect(ws.addedText({ item: null, products: [], line: { id: 'l', list: 'pantry' } }, 'Milk', 'pantry')).toBe('Milk added to your Shopping list');
  });

  it('a search sends only what to search for, which tab, and the shop or barcode when there is one', async () => {
    sendAnswer = () => ANSWER;
    await ws.searchShops({ q: 'milk', section: 'pantry' });
    await ws.searchShops({ q: 'Milk', section: 'pantry', chain: 'woolworths' });
    expect(calls.map((c) => c.body)).toEqual([
      { q: 'milk', section: 'pantry' },
      { q: 'Milk', section: 'pantry', chain: 'woolworths' },
    ]);
  });
});

describe('specials and scans', () => {
  it("finds the special's own product in its shop's answer", () => {
    expect(ws.findProduct(ANSWER, 'coles', '55')).toBe(MILK_C);
    expect(ws.findProduct(ANSWER, 'coles', '999')).toBeUndefined();
    expect(ws.findProduct(ANSWER, 'aldi', '1')).toBeUndefined();
    expect(ws.findProduct(ANSWER, 'coles', undefined)).toBeUndefined();
    expect(ws.tabOfChain('woolworths')).toBe('pantry');
  });

  it('a scanned barcode searches the shops only when the setting is on', async () => {
    settingsAnswer = { webSearch: false };
    expect(await ws.barcodeSearch('9300000000001', 'pantry')).toBeUndefined();
    expect(ws.currentAsk()).toBeUndefined();
    ws.resetWebSearch(undefined);
    settingsAnswer = { webSearch: true };
    expect(await ws.barcodeSearch('9300000000001', 'general')).toBe('Searching your shops for barcode 9300000000001…');
    expect(ws.currentAsk()).toMatchObject({ q: '9300000000001', barcode: '9300000000001', list: 'general' });
    const n = ws.currentAsk()!.n;
    ws.askShops({ q: '  honey ', list: 'pantry' });
    expect(ws.currentAsk()).toMatchObject({ q: 'honey', list: 'pantry' });
    expect(ws.currentAsk()!.n).toBeGreaterThan(n);
    ws.askShops({ q: '   ', list: 'pantry' });
    expect(ws.currentAsk()).toBeUndefined();
    expect(ws.searchingText(['woolworths', 'coles', 'aldi'])).toBe('Searching Woolworths, Coles and Aldi from your server…');
  });
});
