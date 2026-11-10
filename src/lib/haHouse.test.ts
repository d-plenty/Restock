import initSqlJs from 'sql.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 0.9.4: Home Assistant on the phone in a server house (design section 9, D12), and every round
// through Java (RestockNative.haRound, HaSync.java). The Java side has its own checks (HaSyncTest.java).

const native = vi.hoisted(() => ({
  token: undefined as string | undefined,
  rounds: [] as { manual?: boolean }[],
  resets: 0,
  answer: undefined as unknown,
  unimplemented: false,
  requests: [] as string[],
}));
vi.mock('@capacitor/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@capacitor/core')>();
  return { ...real, Capacitor: { ...real.Capacitor, isNativePlatform: () => true, getPlatform: () => 'android' } };
});
vi.mock('./sql/native', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sql/native')>();
  return {
    ...real,
    RestockNative: {
      haSaveToken: async ({ token }: { token: string }) => void (native.token = token),
      haForgetToken: async () => void (native.token = undefined),
      haHasToken: async () => ({ saved: !!native.token }),
      haRound: async (opts: { manual?: boolean }) => {
        native.rounds.push(opts);
        if (native.unimplemented) throw Object.assign(new Error('"RestockNative.haRound()" is not implemented on android'), { code: 'UNIMPLEMENTED' });
        return native.answer;
      },
      haResetPairing: async () => void native.resets++,
      haRequest: async ({ path }: { path: string }) => {
        native.requests.push(path);
        return { status: 200, body: JSON.stringify({ service_response: { 'todo.shopping_list': { items: [] } } }) };
      },
    },
  };
});

const { allListEntries, ensureDefaults, getKV, initDb, putKV } = await import('./db');
const { onChange } = await import('./live');
const ha = await import('./homeAssistant');
const { haLineId } = await import('./haSync');
const { claimHaPhone, releaseHaPhone } = await import('./listPicks');
const { resetHaPairing } = await import('./haKeys');
const { createSqlJsDriver } = await import('./sql/sqljs');
const screen = await import('../ui/screens/HomeAssistant');
const { NavContext } = await import('../ui/nav');

let raw: { exec: (sql: string) => { values: unknown[][] }[] };

beforeEach(async () => {
  Object.assign(native, { token: undefined, rounds: [], resets: 0, answer: undefined, unimplemented: false, requests: [] });
  const d = await createSqlJsDriver({ load: () => initSqlJs() });
  raw = d.raw as never;
  await initDb(d);
  await ensureDefaults();
  raw.exec("UPDATE sync_meta SET value = 'me00000000000000' WHERE key = 'device'");
});

const ME = 'me00000000000000';
const SERVER = { v: 3, sid: 'k3x9q2', home: 'http://192.168.1.20:8787', away: 'https://restock.example.ts.net', kex: 'x', keepMonths: 12 };
/** This phone in a house: the server srv-k3x9q2 owns it. */
const house = () =>
  raw.exec(
    `INSERT OR REPLACE INTO household (k, v) VALUES ('owner', 'srv-k3x9q2'), ('name', 'Declan and Sarah'), ('member:srv-k3x9q2', '{"name":"Declan and Sarah"}'), ('member:${ME}', '{"name":"Kitchen"}'), ('server', '${JSON.stringify(SERVER)}')`,
  );
const phoneHousehold = () => raw.exec(`INSERT OR REPLACE INTO household (k, v) VALUES ('owner', '${ME}'), ('member:${ME}', '{"name":"Kitchen"}'), ('member:alex000000000000', '{"name":"Alex"}')`);
const haRow = () => raw.exec("SELECT v FROM household_settings WHERE k = 'ha:phone'")[0]?.values[0]?.[0];
const serverRunsIt = () => {
  raw.exec("INSERT INTO sync_meta (key, value) VALUES ('applying', '1')");
  raw.exec(`INSERT OR REPLACE INTO household_settings (k, v) VALUES ('ha:phone', '"srv-k3x9q2"')`);
  raw.exec("DELETE FROM sync_meta WHERE key = 'applying'");
};
const nav = { toast: () => undefined, pop: () => undefined, push: () => undefined } as never;
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(NavContext.Provider, { value: nav }, el));

describe('the page in three states', () => {
  it('a phone household: as in 0.9.3, and once linked it says it isn’t server-wide', async () => {
    phoneHousehold();
    const who = await ha.haPhone();
    expect(who.house).toBeUndefined();
    expect(screen.pageState(who)).toBe('phone');
    expect(render(createElement(screen.NotServerWide))).toContain("This isn&#x27;t server-wide.</strong><span style=\"font-size:13px\">It&#x27;s just this phone and the phones paired with it.");
    // Not in a household at all: the same.
    raw.exec('DELETE FROM household');
    expect(screen.pageState(await ha.haPhone())).toBe('phone');
  });

  it('a house whose server runs it: handled by your server, with a link to its page, no controls', async () => {
    house();
    serverRunsIt();
    const who = await ha.haPhone();
    expect(who.house).toEqual({ name: 'Declan and Sarah', serverRuns: true, home: SERVER.home, away: SERVER.away });
    expect(who).toMatchObject({ device: 'srv-k3x9q2', name: 'your server', mine: false });
    expect(ha.phoneLabel(who.name)).toBe('your server');
    expect(screen.pageState(who)).toBe('server');
    const html = render(createElement(screen.InHouse, { house: who.house!, saved: true }));
    expect(html).toContain('Home Assistant is handled by your server, Declan and Sarah');
    expect(html).toContain(`href="${SERVER.home}"`);
    expect(html).toContain(`href="${SERVER.away}"`);
    expect(html).not.toMatch(/<input|<select|Remove the token/);
  });

  it('a house whose server doesn’t run it: set it up on the server’s page; this phone can’t run its own', async () => {
    house();
    const who = await ha.haPhone();
    expect(who.house?.serverRuns).toBe(false);
    expect(screen.pageState(who)).toBe('setUpOnServer');
    const html = render(createElement(screen.InHouse, { house: who.house!, saved: false }));
    expect(html).toContain('Set it up on your server’s page');
    expect(html).toContain('In a server household, Home Assistant runs on your server, so every phone and browser shares one list');
    expect(html).toContain(`href="${SERVER.home}"`);
    expect(html).not.toMatch(/<input|<select/);
    // A token left from before can be removed (it isn't used here).
    expect(render(createElement(screen.InHouse, { house: who.house!, saved: true }))).toContain('Remove the token');
  });

  it('a server row with an odd address isn’t made a link', async () => {
    house();
    raw.exec(`UPDATE household SET v = '${JSON.stringify({ ...SERVER, home: 'javascript:alert(1)', away: null })}' WHERE k = 'server'`);
    const who = await ha.haPhone();
    expect(who.house?.home).toBeUndefined();
    expect(render(createElement(screen.InHouse, { house: who.house!, saved: false }))).not.toContain('href');
  });
});

describe('a phone in a house never claims ha:phone or runs its own', () => {
  it('refuses to claim, quietly or not, to turn on, and to save a token', async () => {
    house();
    await putKV(ha.HA_CONFIG, { enabled: true, address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list' });
    expect(await claimHaPhone()).toBe(false);
    expect(await claimHaPhone({ quietly: true })).toBe(false);
    expect(haRow()).toBeUndefined();
    await expect(ha.takeHomeAssistant()).rejects.toThrow(ha.HOUSE_RUNS_IT);
    await expect(ha.saveHaToken('eyJhbGciOiJIUzI1NiJ9.a-token-long-enough', 'http://homeassistant.local:8123')).rejects.toThrow(ha.HOUSE_RUNS_IT);
    expect(native.token).toBeUndefined();
    expect(await ha.stillTheHaPhone()).toBe(false);
    expect(haRow()).toBeUndefined();
    // Shown as off here, but what was saved stays as it was (the upgrade can still hand it over).
    expect((await ha.getHaConfig()).enabled).toBe(false);
    expect(await getKV<{ enabled: boolean }>(ha.HA_CONFIG)).toMatchObject({ enabled: true });
  });

  it('the Home Assistant phone before the handover doesn’t release the row in a house (it’s the server’s to change)', async () => {
    house();
    raw.exec(`INSERT INTO household_settings (k, v) VALUES ('ha:phone', '"${ME}"')`);
    expect((await ha.haPhone()).mine).toBe(true);
    await releaseHaPhone();
    expect(haRow()).toBe(`"${ME}"`);
  });

  it('a phone household still claims it as in 0.9.3', async () => {
    phoneHousehold();
    expect(await claimHaPhone()).toBe(true);
    expect(haRow()).toBe(`"${ME}"`);
  });
});

describe('every round on the phone runs in Java (0.9.4)', () => {
  it('runHaSync asks RestockNative.haRound, and the screens hear its status', async () => {
    native.answer = { ran: true, came: 2, went: 1, held: false, status: { okAt: '2026-11-10T06:00:00.000Z' } };
    const heard: unknown[] = [];
    const off = ha.onHaStatus((s) => heard.push(s));
    let changes = 0;
    const offChange = onChange(() => changes++);
    await putKV(ha.HA_CONFIG, { enabled: true, address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list' });
    changes = 0;
    const st = await ha.runHaSync({ manual: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(native.rounds).toEqual([{ manual: true }]);
    expect(st).toEqual({ okAt: '2026-11-10T06:00:00.000Z' });
    expect(heard).toEqual([{ okAt: '2026-11-10T06:00:00.000Z' }]);
    // What came in from Home Assistant: the screens refresh (and the household's sync sends it on).
    expect(changes).toBeGreaterThan(0);
    // No request from this side: Java made them, with its token.
    expect(native.requests).toEqual([]);
    off();
    offChange();
  });

  it('the TypeScript round is only for an Android side without haRound', async () => {
    native.unimplemented = true;
    native.token = 'eyJhbGciOiJIUzI1NiJ9.a-token-long-enough';
    await putKV(ha.HA_CONFIG, { enabled: true, address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list' });
    const st = await ha.runHaSync();
    expect(native.rounds).toHaveLength(1);
    expect(native.requests).toEqual(['/api/services/todo/get_items?return_response']);
    expect(st.okAt).toBeDefined();
  });

  it('a pairing started afresh on this side is told to Java straight away', async () => {
    native.answer = { ran: false, came: 0, went: 0, status: {} };
    const stop = ha.wireHomeAssistant(() => () => undefined);
    resetHaPairing();
    expect(native.resets).toBe(1);
    await ha.saveHaConfig({ address: 'http://other.local:8123' });
    expect(native.resets).toBe(2);
    stop();
    resetHaPairing();
    expect(native.resets).toBe(2);
  });

  it('a new list saves its settings and the fresh pairing together', async () => {
    await putKV(ha.HA_STATE, { pairs: [{ id: 'x', uid: 'y', r: { s: 'a', c: false }, h: { s: 'a', c: false } }], pick: [] });
    await ha.saveHaConfig({ address: 'http://homeassistant.local:8123', entity: 'todo.groceries' });
    expect(await getKV(ha.HA_STATE)).toEqual({ pairs: [], pick: [] });
    expect(await getKV(ha.HA_CONFIG)).toMatchObject({ entity: 'todo.groceries' });
  });
});

describe('deterministic line ids in the database (0.9.4)', () => {
  it('a line from an item gets haLineId(entity, uid), added only once', async () => {
    await putKV(ha.HA_CONFIG, { enabled: true, address: 'http://homeassistant.local:8123', entity: 'todo.groceries' });
    const store = ha.dbStore();
    const line = { text: 'milk', qty: 1, checked: false };
    const a = await store.addLine(line, 'u1');
    const b = await store.addLine({ ...line, text: 'milk again' }, 'u1');
    expect(a).toBe(haLineId('todo.groceries', 'u1'));
    expect(b).toBe(a);
    expect((await allListEntries()).map((e) => [e.id, e.text])).toEqual([[a, 'milk']]);
    // Without an item (a line of its own): a fresh "ha-" id.
    const c = await store.addLine(line);
    expect(c).toMatch(/^ha-/);
    expect(c).not.toBe(a);
  });
});
