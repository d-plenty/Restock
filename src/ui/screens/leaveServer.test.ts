import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SyncInfo } from '../../lib/sql/native';

// 0.9.4: leaving a server's house, and turning a share off: what stays is said every time (the shops'
// prices and products, and personal things unless taken back), and the Leave sheet's take-back ticks
// go to the phone (the Java side: SyncServerV3Test W17b).

const native = vi.hoisted(() => ({ stops: [] as unknown[] }));
vi.mock('../../lib/sql/native', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/sql/native')>();
  return { ...real, RestockNative: { syncStopServer: async (o: unknown) => (native.stops.push(o), {}) } };
});
vi.mock('../../lib/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/db')>();
  return { ...real, getSettings: async () => undefined as never };
});

// The sheet as plain markup (the real one opens in a layer on the page).
vi.mock('../components', async (importOriginal) => {
  const real = await importOriginal<typeof import('../components')>();
  const { createElement: h } = await import('react');
  return { ...real, Sheet: ({ title, children }: { title: string; children: unknown }) => h('section', null, h('h2', null, title), children as never) };
});

const { leaveServer, LeaveServerSheet, personalShared, shopsText } = await import('./Sync');
const { NavContext } = await import('../nav');
const nav = { toast: () => undefined, pop: () => undefined, push: () => undefined } as never;
const render = (info: SyncInfo) =>
  renderToStaticMarkup(createElement(NavContext.Provider, { value: nav }, createElement(LeaveServerSheet, { info, onClose: () => undefined, onDone: () => undefined }))).replace(
    /&#x27;/g,
    "'",
  );

const house = (more: Partial<SyncInfo> = {}): SyncInfo => ({ paired: true, house: true, serverApi: 3, serverLabel: 'Home', tabs: ['pantry'], myTabs: ['pantry'], ...more }) as SyncInfo;

describe('leaving the server (0.9.4)', () => {
  it('takes back only the ticked personal kinds this phone shares; never groceries', async () => {
    native.stops = [];
    const info = house({ tabs: ['pantry', 'keg'], myTabs: ['pantry', 'keg'], shareReceipts: true, shareCards: false });
    expect(personalShared(info)).toEqual(['keg', 'receipts']);
    await leaveServer(info, ['keg', 'cards', 'pharmacy', 'pantry' as never]);
    await leaveServer(info, []);
    await leaveServer(info, ['keg', 'receipts'], false);
    expect(native.stops).toEqual([
      { bringBack: true, takeBack: ['keg'] },
      { bringBack: true, takeBack: [] },
      { bringBack: false, takeBack: ['keg', 'receipts'] },
    ]);
    // Review fix: a try that couldn't reach the server already turned Keg off and is taking it back:
    // trying again still asks for it (so the phone reaches the server first), never for what's not ticked.
    native.stops = [];
    const after = house({ tabs: ['pantry'], myTabs: ['pantry'], takeBack: ['keg'] });
    await leaveServer(after, ['keg']);
    await leaveServer(after, []);
    expect(native.stops).toEqual([
      { bringBack: true, takeBack: ['keg'] },
      { bringBack: true, takeBack: [] },
    ]);
    // Not a house (a 0.9.3-style server): nothing to take back.
    native.stops = [];
    await leaveServer({ ...info, house: false, serverApi: 2 }, ['keg']);
    expect(native.stops).toEqual([{ bringBack: true, takeBack: [] }]);
  });

  it('the sheet says what stays: the shops’ prices always; each personal kind shared gets an unticked box, with Select all', () => {
    const html = render(house({ tabs: ['pantry', 'keg', 'pharmacy'], shareReceipts: true, shareCards: true }));
    expect(html).toContain('your phone found at your shops (Coles, Woolworths, Aldi and the others) stay on the server');
    expect(html).toContain("They're about the shops, not about you.");
    for (const t of ['Keg', 'Pharmacy', 'Receipts', 'Loyalty cards']) expect(html).toContain(`>${t}</span>`);
    expect(html).toContain('Select all');
    expect(html).not.toMatch(/type="checkbox" checked/);
    expect(html).toContain('Only what this phone added comes off the server');
    expect(html).not.toContain('>Groceries<');
    const none = render(house());
    expect(none).toContain("This phone didn't share anything personal (Keg, Pharmacy, receipts or loyalty cards).");
    expect(none).not.toContain('Select all');
    expect(none).toContain('stay on the server');
  });

  it('names the grocery shops this phone follows', () => {
    expect(shopsText({ enabledChains: ['coles', 'woolworths', 'aldi', 'danmurphys'] } as never)).toBe('Coles, Woolworths and Aldi');
    expect(shopsText(undefined)).toBe('Coles, Woolworths, Aldi and the others');
  });
});
