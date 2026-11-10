// 0.9.2: the web app's merge (src/server-mode) against the phones' (SyncEngine.java), both ways.
// Driven by tools/sync-test/web-parity.sh, which compiles the Java side first. The Java side
// (SyncWebParity.java) makes a household and writes the phones' server files; this side reads them
// with the web's own code and must end up with the same rows as a stand-in web running the phones'
// code; then this side ticks and adds on the shopping list through the app's own db.ts, writes the
// web's file, and the Java side checks the phones took it in.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import initSqlJs from 'sql.js';
import { expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/lib/sql/schema';
import { createSqlJsDriver } from '../../src/lib/sql/sqljs';
import { addListEntry, getReceipt, getSettings, initDb, saveReceipt, updateListEntry, updateSettings } from '../../src/lib/db';
import { getHouseholdSettings, setHouseholdSettings } from '../../src/lib/householdSettings';
import { signedText, verifySig, b64u, newEcdhKey } from '../../src/server-mode/crypto';
import { WebSyncEngine } from '../../src/server-mode/engine';
import { syncDbOf } from '../../src/server-mode/sqldb';
import { syncRound, type Remote } from '../../src/server-mode/round';

const OUT = 'tools/sync-test/out';
const WORK = join(OUT, 'web-parity');
const CP = process.env.PARITY_CP ?? '';

type Rows = Record<string, Record<string, unknown>[]>;

function dirRemote(dir: string): Remote {
  return {
    async files() {
      return readdirSync(dir)
        .sort()
        .map((name) => {
          const s = statSync(join(dir, name));
          return { name, size: s.size, version: `${s.size}-${s.mtimeMs}` };
        });
    },
    async read(name) {
      try {
        return new Uint8Array(readFileSync(join(dir, name)));
      } catch {
        return null;
      }
    },
    async write(name, bytes) {
      writeFileSync(join(dir, name), bytes);
      const s = statSync(join(dir, name));
      return { version: `${s.size}-${s.mtimeMs}` };
    },
  };
}

const TABLES: [string, string][] = [
  ['categories', 'id'],
  ['products', 'id'],
  ['items', 'id'],
  ['list_entries', 'id'],
  ['cards', 'id'],
  ['prices', 'product_id, date'],
  ['household', 'k'],
  ['receipts', 'id'],
  ['household_settings', 'k'],
];

/** 0.9.3: the household's part of the settings, as stored (the order of shops isn't a setting). */
function shared(raw: unknown) {
  const s = (raw ?? {}) as Record<string, unknown>;
  const shops = ((s.customShops as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    website: c.website,
    section: c.section,
    search: c.search ?? null,
    createdAt: c.createdAt ?? '',
  }));
  return {
    enabledChains: [...((s.enabledChains as string[] | undefined) ?? [])].sort(),
    sections: { keg: !!(s.sections as Record<string, unknown> | undefined)?.keg, pharmacy: !!(s.sections as Record<string, unknown> | undefined)?.pharmacy },
    customShops: shops.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    shopAroundMin: Number(s.shopAroundMin),
    defaultThresholdPct: Number(s.defaultThresholdPct),
    listCompare: s.listCompare,
    productOrder: s.productOrder ?? null,
    recalls: !!(s.recalls as Record<string, unknown> | undefined)?.enabled,
  };
}
const tsSettings = (db: WebSyncEngine['db']) => JSON.parse(String(db.query("SELECT value FROM kv WHERE key = 'settings'")[0].value)) as unknown;

/** Numbers as numbers (Java writes 3.0 where JavaScript writes 3), the price's own id and stock left out. */
function norm(t: string, r: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (t === 'prices' && k === 'id') continue;
    if (t === 'products' && (k === 'in_stock' || k === 'stock_at' || k === 'in_stock_2')) continue;
    if (t === 'cards' && k === 'number') continue;
    o[k] = typeof v === 'number' ? Number(v) : v;
  }
  return o;
}

function dumpTs(db: WebSyncEngine['db']): Rows {
  const out: Rows = {};
  for (const [t, order] of TABLES) out[t] = db.query(`SELECT * FROM ${t} ORDER BY ${order}`).map((r) => norm(t, r));
  out.sync_log = db.query("SELECT tbl, pk, stamp, device, deleted, created FROM sync_log WHERE tbl <> '_seq' ORDER BY tbl, pk");
  return out;
}

function javaRows(file: string): Rows & { owner_pin?: string; settings?: unknown } {
  const j = JSON.parse(readFileSync(join(WORK, file), 'utf8')) as Rows & { owner_pin?: string; settings?: unknown };
  for (const [t] of TABLES) j[t] = j[t].map((r) => norm(t, r));
  return j;
}

/** The web's own new changes are stamped by its own clock, the stand-in's by the Java side's: those stamps differ. */
function logOf(rows: Rows, web: string) {
  return rows.sync_log.map((r) => ({ ...r, stamp: r.device === web ? 'own' : Number(r.stamp), created: r.device === web ? 'own' : Number(r.created), deleted: Number(r.deleted) }));
}

it.skipIf(!CP)('the web merges the phones’ files like a phone, and the phones take in the web’s', async () => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, 'files'), { recursive: true });
  const java = spawn('java', ['-cp', CP, 'family.plenty.restock.SyncWebParity', OUT, WORK], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  const waiting = new Map<string, () => void>();
  createInterface({ input: java.stdout }).on('line', (l) => {
    lines.push(l);
    if (!l.startsWith('CHECK') && !l.startsWith('READY') && !l.startsWith('DONE')) console.log('[java]', l);
    waiting.get(l.trim())?.();
  });
  const until = (what: string) => new Promise<void>((res, rej) => {
    if (lines.includes(what)) return res();
    waiting.set(what, res);
    java.once('exit', (c) => rej(new Error(`java ended (${c}) before ${what}`)));
  });
  const done = new Promise<number>((res) => java.on('exit', (c) => res(c ?? 1)));

  await until('READY 1');
  const hh = JSON.parse(readFileSync(join(WORK, 'household.json'), 'utf8')) as { keyv: number; serverKey: string; owner_pub: string };
  const SQL = await initSqlJs();
  const driver = await createSqlJsDriver({ load: async () => SQL });
  await initDb(driver);
  const db = syncDbOf(driver.raw);
  const engine = new WebSyncEngine(db, verifySig, signedText);
  engine.setMeta('device', 'web-parityref');
  engine.setMeta('name', 'Web');
  engine.setMeta('owner_pin', hh.owner_pub);
  const k = newEcdhKey();
  const keys = { webId: 'parityref', webPriv: b64u(k.priv), webPub: b64u(k.pub), keys: { [String(hh.keyv)]: hh.serverKey } };
  const remote = dirRemote(join(WORK, 'files'));
  // 0.9.3: the web's settings start as the app's defaults (as the Java stand-in's do).
  await updateSettings({ onboarded: true }, { local: true });

  const r1 = await syncRound(engine, remote, keys);
  expect(r1.phones).toBeGreaterThanOrEqual(3); // read twice: the first pass turned receipts on (SyncFolder does the same)
  expect(r1.unread).toBe(0);
  const ts1 = dumpTs(db);
  const j1 = javaRows('java-1.json');
  for (const [t] of TABLES) expect(ts1[t], `round 1: ${t}`).toEqual(j1[t]);
  expect(logOf(ts1, 'web-parityref'), 'round 1: sync_log').toEqual(logOf(j1, 'web-parityref'));
  expect(engine.meta('owner_pin')).toBe(j1.owner_pin);
  // 0.9.3: household settings: the same rows (above), applied to the settings the same way.
  expect(shared(tsSettings(db)), 'round 1: settings').toEqual(shared(j1.settings));
  const hs = await getHouseholdSettings();
  expect(hs?.defaultThresholdPct).toBe(25);
  expect(hs?.shopAroundMin).toBe(3);
  expect(hs?.tabs.pantry?.customShops.map((c) => [c.id, c.search ?? null])).toEqual([['custom-xyz', null]]);
  expect((await getSettings()).enabledChains).toContain('custom-xyz');
  // The card came without its number; the forged household name didn't come at all.
  expect(db.query("SELECT number FROM cards WHERE id = 'k1'")[0].number).toBe('');
  expect(db.query("SELECT v FROM household WHERE k = 'name'")[0].v).toBe('Plenty house');
  expect(db.query("SELECT checked, qty FROM list_entries WHERE id = 'l1'")[0]).toEqual({ checked: 1, qty: 3 });
  // 0.9.3: a file's author is its name, on both sides: one that names another device inside is
  // refused; another browser's own file brings its line but not its loyalty card or household change.
  expect(db.query("SELECT id FROM list_entries WHERE id IN ('forged1', 'forged2')")).toEqual([]);
  expect(db.query("SELECT text FROM list_entries WHERE id = 'webother1'")).toEqual([{ text: 'From another browser' }]);
  expect(db.query("SELECT 1 FROM cards WHERE id = 'k9'")).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM prices")[0].n).toBeGreaterThan(0);

  // The web's own changes, through the app's own code.
  await updateListEntry('l2', { checked: true });
  await updateListEntry('l3', { qty: 6 });
  await addListEntry({ id: 'web-l1', text: 'Bread rolls', checked: false, createdAt: new Date().toISOString(), section: 'pantry', qty: 1 });
  const r = await getReceipt('r1');
  expect(r).toBeTruthy();
  await saveReceipt({ ...r!, note: 'Checked on the web' });
  // 0.9.3: and household settings, as the web's Settings will change them.
  const after = await setHouseholdSettings({ shopAroundMin: 9, tabs: { pantry: { chains: ['coles', 'woolworths', 'custom-xyz'] } } });
  expect(after?.shopAroundMin).toBe(9);
  expect(after?.tabs.pantry?.chains.sort()).toEqual(['coles', 'custom-xyz', 'woolworths']);
  expect(db.query("SELECT device FROM sync_log WHERE tbl = 'household_settings' AND pk = 'shopAroundMin'")[0].device).toBe('web-parityref');
  const w = await syncRound(engine, remote, keys);
  expect(w.wrote).toBe(true);
  java.stdin.write('GO 1\n');

  await until('READY 2');
  await syncRound(engine, remote, keys);
  const ts2 = dumpTs(db);
  const j2 = javaRows('java-2.json');
  for (const [t] of TABLES) expect(ts2[t], `round 2: ${t}`).toEqual(j2[t]);
  expect(logOf(ts2, 'web-parityref'), 'round 2: sync_log').toEqual(logOf(j2, 'web-parityref'));
  expect(shared(tsSettings(db)), 'round 2: settings').toEqual(shared(j2.settings));
  expect(db.query("SELECT 1 FROM receipts WHERE id = 'r1'")).toEqual([]);
  java.stdin.write('GO 2\n');
  const code = await done;
  const checks = lines.filter((l) => l.startsWith('CHECK'));
  for (const c of checks) console.log(c);
  expect(checks.filter((c) => c.includes('FAIL'))).toEqual([]);
  expect(checks.length).toBeGreaterThan(5);
  expect(code).toBe(0);
}, 120_000);
