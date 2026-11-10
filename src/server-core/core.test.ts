/// <reference types="node" />
// 0.9.4 (protocol v3): the core the Restock server runs (src/server-core/index.ts), on node:sqlite
// as the server does: the shared test vectors (tools/sync-test/vectors-v3.json, made with Node's own
// crypto), the engine as the server (role 'server'), and the node:sqlite adapter and migrations.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  b64u,
  base32,
  CORE,
  ecdh,
  formatRecovery,
  haKey,
  haLineId,
  handoverKey,
  joinKey,
  keepCutoff,
  keysFileKey,
  loginKeyOf,
  loginProof,
  macOk,
  memberJoinText,
  migrate,
  MIGRATIONS,
  openHa,
  openHandover,
  openJoin,
  openKeysFile,
  openRecovery,
  openRsf1,
  ownerOnly,
  parseAuthorization,
  parseServerRow,
  pkcs8Of,
  privOfPkcs8,
  publicOf,
  recoveryKeyOf,
  requestMac,
  requestText,
  sealHa,
  sealHandover,
  sealJoin,
  sealKeysFile,
  sealRecovery,
  sealRsf1,
  serverFileName,
  serverKeyOf,
  sessionKeyOf,
  signedText,
  signWithPkcs8,
  syncDbOfNode,
  unb64,
  unbase32,
  verifySig,
  webAuthorization,
  WebSyncEngine,
  allowedNameV3,
  type Entry,
  type SyncFileMessage,
} from './index';

const V = JSON.parse(readFileSync(new URL('../../tools/sync-test/vectors-v3.json', import.meta.url), 'utf8'));
const u = (s: string) => unb64(s);
const enc = (s: string) => new TextEncoder().encode(s);

describe('v3 test vectors (made with Node’s own crypto)', () => {
  const k = V.keys;

  it('keys: SPKI from the private key, PKCS#8 both ways (Java’s and Node’s encodings)', () => {
    for (const x of Object.values(k) as { priv: string; pkcs8: string; pub: string }[]) {
      expect(b64u(publicOf(u(x.priv)))).toBe(x.pub);
      expect(b64u(privOfPkcs8(u(x.pkcs8)))).toBe(x.priv); // Node's PKCS#8 (with the public key)
      // The short PKCS#8 we write reads in Node (and Java's PKCS8EncodedKeySpec) as the same key.
      const back = createPrivateKey({ key: Buffer.from(pkcs8Of(u(x.priv))), format: 'der', type: 'pkcs8' });
      expect(back.export({ format: 'jwk' }).d).toBe(x.priv);
    }
  });

  it('ECDH secrets are the x-coordinate, the same from either side', () => {
    expect(b64u(ecdh(u(k.serverKex.priv), u(k.phoneKex.pub)))).toBe(V.ecdh.serverPhone);
    expect(b64u(ecdh(u(k.phoneKex.priv), u(k.serverKex.pub)))).toBe(V.ecdh.serverPhone);
    expect(b64u(ecdh(u(k.serverKex.priv), u(k.phoneHandoverOneOff.pub)))).toBe(V.ecdh.handoverServer);
    expect(b64u(ecdh(u(k.browserOneOff.priv), u(k.serverKex.pub)))).toBe(V.ecdh.serverBrowser);
    expect(b64u(serverKeyOf(u(V.serverKey.householdKey)))).toBe(V.serverKey.serverKey);
  });

  it('RSJ3: the join answer, sealed to the phone’s kex key for this device', () => {
    const j = V.join;
    const key = joinKey(u(k.phoneKex.priv), u(k.serverKex.pub), u(j.n));
    expect(b64u(key)).toBe(j.key);
    expect(b64u(joinKey(u(k.serverKex.priv), u(k.phoneKex.pub), u(j.n)))).toBe(j.key);
    expect(b64u(sealJoin(key, j.device, j.plain, u(j.nonce)))).toBe(j.sealed);
    expect(openJoin(key, j.device, u(j.sealed))).toEqual(JSON.parse(j.plain));
    expect(() => openJoin(key, 'another', u(j.sealed))).toThrow();
  });

  it('a member join is signed with the phone’s household key over memberJoinText', () => {
    const m = V.memberJoin;
    expect(memberJoinText(m.body)).toBe(m.text);
    expect(verifySig(k.phoneSigning.pub, m.text, m.sig)).toBe(true);
    expect(verifySig(k.phoneSigning.pub, m.text + 'x', m.sig)).toBe(false);
  });

  it('RSE3: keys/<device>.bin', () => {
    const f = V.keysFile;
    const key = keysFileKey(u(k.serverKex.priv), u(k.phoneKex.pub));
    expect(b64u(key)).toBe(f.key);
    expect(b64u(sealKeysFile(key, f.device, JSON.parse(f.plain), u(f.nonce)))).toBe(f.file);
    expect(openKeysFile(keysFileKey(u(k.phoneKex.priv), u(k.serverKex.pub)), f.device, u(f.file))).toEqual(JSON.parse(f.plain));
    expect(() => openKeysFile(key, 'someone-else', u(f.file))).toThrow();
  });

  it('RSH3: the handover payload, sealed to the server’s kex key with the token', () => {
    const h = V.handover;
    const key = handoverKey(u(k.phoneHandoverOneOff.priv), u(k.serverKex.pub), u(h.token));
    expect(b64u(key)).toBe(h.key);
    expect(b64u(handoverKey(u(k.serverKex.priv), u(h.epub), u(h.token)))).toBe(h.key);
    expect(b64u(sealHandover(key, h.plain, u(h.nonce)))).toBe(h.sealed);
    const p = openHandover<{ owner_priv: string; owner_pubkey: string }>(key, u(h.sealed));
    expect(p).toEqual(JSON.parse(h.plain));
    // The owner key in it signs as Java would, and Node reads the signature.
    const text = 'restock-hh1|owner|v=srv-k3x9q2|5';
    const sig = signWithPkcs8(p.owner_priv, text);
    expect(nodeVerify('sha256', Buffer.from(text), createPublicKey({ key: Buffer.from(u(p.owner_pubkey)), format: 'der', type: 'spki' }), Buffer.from(u(sig)))).toBe(true);
  });

  it('RSA3: Home Assistant on upgrade', () => {
    const h = V.ha;
    const key = haKey(u(k.phoneKex.priv), u(k.serverKex.pub), u(h.n));
    expect(b64u(key)).toBe(h.key);
    expect(b64u(sealHa(key, h.device, h.plain, u(h.nonce)))).toBe(h.sealed);
    expect(openHa(key, h.device, u(h.sealed))).toEqual(JSON.parse(h.plain));
  });

  it('browser sign-in: loginKey, proof, sessionKey (both sides), the sealed answer; Sign in with a phone', () => {
    const l = V.login;
    const loginKey = loginKeyOf(u(l.authKey));
    expect(b64u(loginKey)).toBe(l.loginKey);
    expect(loginProof(loginKey, l.c, l.epub)).toBe(l.proof);
    const browser = sessionKeyOf(u(k.browserOneOff.priv), u(k.serverKex.pub), u(l.c), loginKey);
    const server = sessionKeyOf(u(k.serverKex.priv), u(l.epub), u(l.c), loginKey);
    expect(b64u(browser)).toBe(l.sessionKey);
    expect(b64u(server)).toBe(l.sessionKey);
    expect(openRsf1(browser, u(l.answer.sealed))).toEqual(l.answer.plain);
    const q = V.qrSession;
    expect(b64u(sessionKeyOf(u(k.browserOneOff.priv), u(k.serverKex.pub), u(q.id)))).toBe(q.sessionKey);
  });

  it('request MACs and the RestockWeb3 header', () => {
    const key = u(V.requests.sessionKey);
    for (const r of V.requests.cases) {
      const text = requestText(r.method, r.path, r.t, r.n, r.body);
      expect(text).toBe(r.text);
      expect(requestMac(key, text)).toBe(r.mac);
      expect(webAuthorization('SESSION-ID', key, r.method, r.path, r.body, r.t, r.n)).toBe(r.header);
      const p = parseAuthorization(r.header)!;
      expect(p.scheme).toBe('RestockWeb3');
      expect(macOk(key, requestText(r.method, r.path, Number(p.fields.t), p.fields.n, r.body), p.fields.m)).toBe(true);
      expect(macOk(key, requestText(r.method, r.path + 'x', Number(p.fields.t), p.fields.n, r.body), p.fields.m)).toBe(false);
    }
    expect(requestText('get', '/x', 1, 'n', undefined)).toBe(requestText('GET', '/x', 1, 'n', new Uint8Array(0)));
    expect(parseAuthorization('Restock2 d=a1, t=5, n=x, s=y')).toEqual({ scheme: 'Restock2', fields: { d: 'a1', t: '5', n: 'x', s: 'y' } });
    expect(parseAuthorization('Bearer x')).toBe(null);
  });

  it('haLineId', () => {
    for (const c of V.haLineId) expect(haLineId(c.entity, c.uid)).toBe(c.id);
    expect(haLineId('todo.a', 'x')).toMatch(/^ha-[0-9a-f]{24}$/);
  });

  it('the recovery key and the recovery copy (0.9.0’s format, SyncHousehold.java)', () => {
    const r = V.recovery;
    expect(base32(u(r.r))).toBe(r.base32);
    expect(b64u(unbase32(r.base32))).toBe(r.r);
    expect(formatRecovery(u(r.r))).toBe(r.formatted);
    expect(b64u(recoveryKeyOf(u(r.r)))).toBe(r.key);
    expect(sealRecovery(u(r.r), JSON.parse(r.plain), u(r.nonce))).toBe(r.row);
    expect(openRecovery(u(r.r), r.row)).toEqual(JSON.parse(r.plain));
  });

  it('the server row: signed by the owner key, owner-only, read back', () => {
    const s = V.serverRow;
    expect(signedText(s.entry)).toBe(s.text);
    expect(verifySig(k.owner.pub, s.text, s.sig)).toBe(true);
    expect(ownerOnly('server')).toBe(true);
    expect(parseServerRow(s.entry.row.v)).toMatchObject({ v: 3, sid: 'k3x9q2', kex: k.serverKex.pub, keepMonths: 12 });
    expect(parseServerRow('{"v":2}')).toBe(null);
    expect(parseServerRow(JSON.stringify({ ...JSON.parse(s.entry.row.v), keepMonths: 7 }))?.keepMonths).toBe(null);
  });

  it('keepCutoff', () => {
    for (const c of V.keepCutoff.cases) expect(keepCutoff(c.keepMonths, V.keepCutoff.now)).toBe(c.cutoff);
    expect(keepCutoff(5, V.keepCutoff.now)).toBe(null);
  });
});

// ---------- the engine as the server, on node:sqlite ----------

const NOW = Date.now();
const ent = (tbl: string, pk: string, stamp: number, device: string, row: Record<string, unknown> | null, more: Partial<Entry> = {}): Entry => ({
  tbl,
  pk,
  stamp,
  device,
  deleted: !row,
  created: more.created ?? stamp,
  ...(row ? { row } : {}),
  ...more,
});

async function house(opts: { keepFrom?: string | null } = {}) {
  const raw = new DatabaseSync(':memory:');
  await migrate(raw);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ownerPub = b64u(publicKey.export({ type: 'spki', format: 'der' }));
  const ownerPkcs8 = b64u(privateKey.export({ type: 'pkcs8', format: 'der' }));
  let keepFrom = opts.keepFrom ?? null;
  const e = new WebSyncEngine(syncDbOfNode(raw), verifySig, signedText, () => Date.now(), {
    role: 'server',
    sign: (text) => signWithPkcs8(ownerPkcs8, text),
    keepFrom: () => keepFrom,
  });
  e.setMeta('device', 'srv-k3x9q2');
  e.setMeta('name', 'Declan and Sarah');
  e.setMeta('owner_pin', ownerPub);
  e.writeHousehold('owner_pub', ownerPub);
  e.writeHousehold('owner', 'srv-k3x9q2');
  e.writeHousehold('name', 'Declan and Sarah');
  e.writeHousehold('tabs', 'pantry,keg,pharmacy');
  e.writeHousehold('receipts', '1');
  const sign = (x: Entry): Entry => ({ ...x, sig: b64u(nodeSign('sha256', Buffer.from(signedText(x as never)), privateKey)) });
  return { raw, e, ownerPub, sign, setKeep: (v: string | null) => (keepFrom = v) };
}

const phoneFile = (device: string, entries: Entry[], more: Partial<SyncFileMessage> = {}): SyncFileMessage => ({ format: 'restock-sync', v: 1, device, name: 'Phone ' + device, keyv: 1, at: new Date().toISOString(), top: 1, entries, ...more });
const item = (id: string, section: string, name = id) => ({ id, name, created_at: 'x', section });

describe('the engine as the server (role "server", node:sqlite)', () => {
  it('migrate brings node:sqlite to Restock’s schema (all of MIGRATIONS, once)', async () => {
    const raw = new DatabaseSync(':memory:');
    await migrate(raw);
    await migrate(raw); // again: nothing to do
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['items', 'list_entries', 'prices', 'receipts', 'household', 'household_settings', 'sync_log', 'sync_meta', 'sync_peers']));
    expect(CORE.protocol).toBe(3);
  });

  it('writeHousehold notes and signs the server’s changes; phones (and the web) accept them', async () => {
    const { e, ownerPub } = await house();
    e.writeHousehold('server', JSON.stringify({ v: 3, sid: 'k3x9q2', home: 'http://192.168.1.20:8787', away: null, kex: 'K', keepMonths: 12 }));
    expect(e.serverRow()?.keepMonths).toBe(12);
    const own = e.ownFile(1, 'now', false)!;
    const hh = own.msg.entries!.filter((x) => x.tbl === 'household');
    expect(hh.map((x) => x.pk).sort()).toEqual(['name', 'owner', 'owner_pub', 'receipts', 'server', 'tabs']);
    for (const x of hh) {
      expect(x.device).toBe('srv-k3x9q2');
      expect(verifySig(ownerPub, signedText(x), x.sig!)).toBe(true);
    }
    // A browser pinned to the owner key takes the server's file in, the server row too.
    const raw = new DatabaseSync(':memory:');
    await migrate(raw);
    const web = new WebSyncEngine(syncDbOfNode(raw), verifySig, signedText);
    web.setMeta('device', 'web-W1');
    web.setMeta('owner_pin', ownerPub);
    expect(web.takeFile(serverFileName('k3x9q2'), 'sum', own.msg, 'now')).toBeGreaterThan(0);
    expect(web.householdValue('owner')).toBe('srv-k3x9q2');
    expect(web.serverRow()?.sid).toBe('k3x9q2');
    // Deleting a row is signed too; the same value again changes nothing.
    const before = e.db.query("SELECT stamp FROM sync_log WHERE pk = 'name'")[0].stamp;
    expect(e.writeHousehold('name', 'Declan and Sarah')).toBe(null);
    expect(e.db.query("SELECT stamp FROM sync_log WHERE pk = 'name'")[0].stamp).toBe(before);
    const del = e.writeHousehold('member:gone', JSON.stringify({ name: 'x', pub: 'p' }));
    expect(del).not.toBe(null);
    const gone = e.writeHousehold('member:gone', null)!;
    expect(gone.deleted).toBe(true);
    expect(verifySig(ownerPub, signedText(gone), gone.sig!)).toBe(true);
    // Only the server signs.
    expect(() => web.writeHousehold('name', 'x')).toThrow();
  });

  it('a phone can’t change owner-only rows (server included); its own unsigned ones are refused once signed by the owner', async () => {
    const { e } = await house();
    e.takeFile('restock-sync-a1.bin', 's1', phoneFile('a1', [ent('household', 'server', NOW + 10_000, 'a1', { k: 'server', v: '{"v":3}' }), ent('household', 'owner', NOW + 10_000, 'a1', { k: 'owner', v: 'a1' })]), 'now');
    expect(e.householdValue('owner')).toBe('srv-k3x9q2');
    expect(e.householdValue('server')).toBe(null);
  });

  it('the server’s own file: everything but cards, prices of the last 60 days, `seen`; the web’s still leaves prices and the household out', async () => {
    const { e } = await house();
    const old = NOW - 61 * 24 * 3600 * 1000;
    e.takeFile(
      'restock-sync-a1.bin',
      's1',
      phoneFile('a1', [
        ent('products', 'p1', NOW, 'a1', { id: 'p1', chain: 'coles', name: 'Milk', created_at: 'x' }),
        ent('prices', 'p1|2026-11-01T00:00:00.000Z', NOW, 'a1', { product_id: 'p1', date: '2026-11-01T00:00:00.000Z', price: 3, source: 'check' }),
        ent('prices', 'p1|2026-08-01T00:00:00.000Z', old, 'a1', { product_id: 'p1', date: '2026-08-01T00:00:00.000Z', price: 2, source: 'check' }),
        ent('cards', 'k1', NOW, 'a1', { id: 'k1', program: 'flybuys', label: 'F', number: '6008943212345678', created_at: 'x' }),
        ent('items', 'i1', NOW, 'a1', item('i1', 'pantry')),
      ], { top: 7, shares: { tabs: ['pantry'], receipts: false, cards: true } }),
      'now',
    );
    // Card numbers never reach household.db.
    expect(e.db.query('SELECT number FROM cards')).toEqual([{ number: '' }]);
    const own = e.ownFile(1, 'now', false)!;
    const tbls = own.msg.entries!.map((x) => `${x.tbl}:${x.pk}`);
    expect(tbls).toEqual(expect.arrayContaining(['products:p1', 'items:i1', 'prices:p1|2026-11-01T00:00:00.000Z']));
    expect(tbls).not.toContain('prices:p1|2026-08-01T00:00:00.000Z');
    expect(tbls.some((t) => t.startsWith('cards:'))).toBe(false);
    expect(own.msg.seen).toEqual({ a1: 7 });
    expect(own.msg.name).toBe('Declan and Sarah');
    expect(e.sharesOf('a1')).toEqual({ tabs: ['pantry'], receipts: false, cards: true });
  });

  it('takes from each phone only what it shares (D9): records, moved deletes, and other people’s deletes stay out', async () => {
    const { e } = await house();
    // Phone b2 shares everything; it puts in a keg item and a pantry item.
    e.takeFile('restock-sync-b2.bin', 's1', phoneFile('b2', [ent('items', 'kb', NOW, 'b2', item('kb', 'keg')), ent('items', 'pb', NOW, 'b2', item('pb', 'pantry'))], { shares: { tabs: ['pantry', 'keg', 'pharmacy'], receipts: true, cards: false } }), 'now');
    // Phone a1 shares only groceries, but its file carries a keg item (a bug, or a forged file), a
    // receipt, a moved delete of b2's keg item, and a plain delete of it.
    const n = e.takeFile(
      'restock-sync-a1.bin',
      's2',
      phoneFile(
        'a1',
        [
          ent('items', 'ka', NOW, 'a1', item('ka', 'keg')),
          ent('items', 'pa', NOW, 'a1', item('pa', 'pantry')),
          ent('receipts', 'r1', NOW, 'a1', { id: 'r1', scanned_at: new Date().toISOString(), section: 'pantry' }),
          ent('items', 'kb', NOW + 5, 'a1', null, { moved: true, created: NOW - 1 }),
          ent('household_settings', 'tab:keg', NOW, 'a1', { k: 'tab:keg', v: 'true' }),
        ],
        { shares: { tabs: ['pantry'], receipts: false, cards: false } },
      ),
      'now',
    );
    expect(n).toBe(1);
    expect(e.lastDropped).toBe(4);
    const ids = e.db.query('SELECT id FROM items ORDER BY id').map((r) => r.id);
    expect(ids).toEqual(['kb', 'pa', 'pb']);
    expect(e.db.query('SELECT 1 FROM receipts')).toEqual([]);
    // A plain delete of someone else's keg item: refused. Of its own keg item (Also take what this
    // phone shared off the server): taken, and it goes to the other phones in the server's file.
    e.takeFile('restock-sync-a1.bin', 's3', phoneFile('a1', [ent('items', 'kb', NOW + 50, 'a1', null, { created: NOW - 1 })], { shares: { tabs: ['pantry'], receipts: false, cards: false } }), 'now');
    expect(e.db.query("SELECT 1 FROM items WHERE id = 'kb'").length).toBe(1);
    e.takeFile('restock-sync-a1.bin', 's4', phoneFile('a1', [ent('items', 'ka2', NOW, 'a1', item('ka2', 'keg'))], { shares: { tabs: ['pantry', 'keg'], receipts: false, cards: false } }), 'now');
    expect(e.db.query("SELECT 1 FROM items WHERE id = 'ka2'").length).toBe(1);
    e.takeFile('restock-sync-a1.bin', 's5', phoneFile('a1', [ent('items', 'ka2', NOW + 60, 'a1', null, { created: NOW - 1 })], { shares: { tabs: ['pantry'], receipts: false, cards: false } }), 'now');
    expect(e.db.query("SELECT 1 FROM items WHERE id = 'ka2'")).toEqual([]);
    const own = e.ownFile(1, 'now', false)!;
    expect(own.msg.entries!.find((x) => x.pk === 'ka2')).toMatchObject({ deleted: true });
    // Without `shares` (a 0.9.3 phone's file): as before, everything it sends.
    e.takeFile('restock-sync-c3.bin', 's6', phoneFile('c3', [ent('items', 'kc', NOW, 'c3', item('kc', 'keg'))]), 'now');
    expect(e.db.query("SELECT 1 FROM items WHERE id = 'kc'").length).toBe(1);
  });

  it('0.9.4 final fixes: take back only what that phone made; who made it travels; a moved delete never beats the same copy; a plain delete of a tab not synced stays out', async () => {
    const { e } = await house();
    const keg = { tabs: ['pantry', 'keg'], receipts: false, cards: false };
    const pantry = { tabs: ['pantry'], receipts: false, cards: false };
    // b2 makes a keg item; a1 changes it (the last to change it), and makes its own.
    e.takeFile('restock-sync-b2.bin', 't1', phoneFile('b2', [ent('items', 'kb', NOW, 'b2', item('kb', 'keg'))], { shares: keg }), 'now');
    e.takeFile(
      'restock-sync-a1.bin',
      't2',
      phoneFile('a1', [ent('items', 'kb', NOW + 10, 'a1', item('kb', 'keg', 'Cider'), { created: NOW, origin: 'b2' }), ent('items', 'ka', NOW + 10, 'a1', item('ka', 'keg'), { origin: 'a1' })], { shares: keg }),
      'now',
    );
    const origin = (pk: string) => e.db.query("SELECT origin FROM sync_log WHERE tbl = 'items' AND pk = ?", [pk])[0]?.origin;
    expect([origin('kb'), origin('ka')]).toEqual(['b2', 'a1']);
    // a1 stops sharing Keg and takes it back: plain deletes of both. Only its own goes.
    e.takeFile('restock-sync-a1.bin', 't3', phoneFile('a1', [ent('items', 'kb', NOW + 20, 'a1', null, { created: 0 }), ent('items', 'ka', NOW + 20, 'a1', null, { created: 0 })], { shares: pantry }), 'now');
    expect(e.db.query('SELECT id, name FROM items ORDER BY id')).toEqual([{ id: 'kb', name: 'Cider' }]);
    // The server's file says who made what, and carries the one delete.
    const own = e.ownFile(1, 'now', false)!;
    expect(own.msg.entries!.find((x) => x.pk === 'kb')).toMatchObject({ origin: 'b2', device: 'a1' });
    expect(own.msg.entries!.filter((x) => x.tbl === 'items' && x.deleted).map((x) => x.pk)).toEqual(['ka']);

    // A browser that syncs groceries only, with a keg copy of its own: the delete passes it by.
    const raw = new DatabaseSync(':memory:');
    await migrate(raw);
    const web = new WebSyncEngine(syncDbOfNode(raw), verifySig, signedText);
    web.setMeta('device', 'web-W1');
    web.db.exec("INSERT INTO household (k, v) VALUES ('tabs', 'pantry,keg,pharmacy')");
    web.setMeta('tabs', 'pantry,keg');
    web.apply([ent('items', 'ka', NOW + 10, 'a1', item('ka', 'keg'), { origin: 'a1' }), ent('items', 'kb', NOW + 10, 'a1', item('kb', 'keg', 'Cider'), { created: NOW, origin: 'b2' })]);
    expect(web.db.query("SELECT origin FROM sync_log WHERE pk = 'kb'")[0].origin).toBe('b2');
    // A moved delete with the copy's own stamp (a phone that stopped sharing Keg): never wins.
    web.apply([ent('items', 'kb', NOW + 10, 'a1', null, { created: NOW, moved: true })]);
    expect(web.db.query("SELECT 1 FROM items WHERE id = 'kb'").length).toBe(1);
    // A newer one (moved to a tab not shared) still goes.
    web.apply([ent('items', 'kb', NOW + 11, 'a1', null, { created: NOW, moved: true })]);
    expect(web.db.query("SELECT 1 FROM items WHERE id = 'kb'").length).toBe(0);
    web.setMeta('tabs', 'pantry');
    web.noteTabs();
    web.apply([ent('items', 'ka', NOW + 20, 'a1', null, { created: 0 })]);
    expect(web.db.query("SELECT 1 FROM items WHERE id = 'ka'").length).toBe(1);
    // Review fix: held, and taken in once Keg is synced again, without it coming again (the others
    // may have tidied it away by then; this copy, offered again, would bring it back everywhere).
    expect(web.db.query('SELECT tbl, pk FROM sync_held')).toEqual([{ tbl: 'items', pk: 'ka' }]);
    web.setMeta('tabs', 'pantry,keg');
    expect(web.noteTabs()).toBe(true);
    expect(web.db.query("SELECT 1 FROM items WHERE id = 'ka'").length).toBe(0);
    expect(web.db.query("SELECT deleted FROM sync_log WHERE tbl = 'items' AND pk = 'ka'")).toEqual([{ deleted: 1 }]);
    expect(web.db.query('SELECT 1 FROM sync_held').length).toBe(0);
    // An ordinary delete of a line someone else added, on a tab it syncs: taken in at once.
    web.apply([ent('list_entries', 'l1', NOW + 30, 'a1', { id: 'l1', text: 'Milk', checked: 0, qty: 1, created_at: 'x', section: 'pantry' }, { origin: 'b2' })]);
    web.apply([ent('list_entries', 'l1', NOW + 31, 'c3', null, { created: 0 })]);
    expect(web.db.query("SELECT 1 FROM list_entries WHERE id = 'l1'").length).toBe(0);
  });

  it('Keep data for: old prices and receipts never come in; prune drops them without deletes', async () => {
    const cut = new Date(NOW - 90 * 86_400_000).toISOString();
    const { e } = await house({ keepFrom: cut });
    const d = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
    const share = { tabs: ['pantry'], receipts: true, cards: false };
    e.takeFile(
      'restock-sync-a1.bin',
      's1',
      phoneFile(
        'a1',
        [
          ent('products', 'p1', NOW, 'a1', { id: 'p1', chain: 'coles', name: 'Milk', created_at: 'x' }),
          ent('products', 'p2', NOW, 'a1', { id: 'p2', chain: 'coles', name: 'Bread', created_at: 'x' }),
          ent('prices', 'p1|' + d(10), NOW, 'a1', { product_id: 'p1', date: d(10), price: 3, source: 'check' }),
          ent('prices', 'p1|' + d(200), NOW, 'a1', { product_id: 'p1', date: d(200), price: 2, source: 'check' }),
          // p2's only price is old: it's the latest, so it stays (pruneHistory's rule).
          ent('prices', 'p2|' + d(300), NOW, 'a1', { product_id: 'p2', date: d(300), price: 4, source: 'check' }),
          ent('receipts', 'r-new', NOW, 'a1', { id: 'r-new', scanned_at: d(5), section: 'pantry', pinned: 0 }),
          ent('receipts', 'r-old', NOW, 'a1', { id: 'r-old', scanned_at: d(200), section: 'pantry', pinned: 0 }),
          ent('receipts', 'r-pin', NOW, 'a1', { id: 'r-pin', scanned_at: d(200), section: 'pantry', pinned: 1 }),
        ],
        { shares: share },
      ),
      'now',
    );
    expect(e.db.query('SELECT product_id, price FROM prices ORDER BY product_id, date').map((r) => `${r.product_id}:${r.price}`)).toEqual(['p1:3', 'p2:4']);
    expect(e.db.query('SELECT id FROM receipts ORDER BY id').map((r) => r.id)).toEqual(['r-new', 'r-pin']);
    // An archive can't bring them back either.
    expect(e.takeArchive({ prices: [{ product_id: 'p1', date: d(150), price: 1, source: 'check' }, { product_id: 'p1', date: d(20), price: 5, source: 'check' }], receipts: [{ id: 'r-old2', scanned_at: d(150), section: 'pantry' }] })).toBe(1);
    // A new product's archive, oldest first (as phones write them): only its latest comes in.
    expect(e.takeArchive({ prices: [{ product_id: 'p3', date: d(400), price: 1, source: 'check' }, { product_id: 'p3', date: d(300), price: 2, source: 'check' }] })).toBe(1);
    expect(e.db.query("SELECT price FROM prices WHERE product_id = 'p3'")).toEqual([{ price: 2 }]);
    e.db.exec("DELETE FROM prices WHERE product_id = 'p3'");
    // A longer window later, then a shorter one: prune takes what's older, quietly.
    const log = () => e.db.query("SELECT COUNT(*) AS n FROM sync_log WHERE deleted = 1")[0].n;
    const deletesBefore = log();
    e.db.exec("UPDATE receipts SET scanned_at = ? WHERE id = 'r-new'", [d(100)]);
    const gone = e.prune(cut);
    expect(gone.prices).toBe(0);
    expect(gone.receipts.map((r) => r.id)).toEqual(['r-new']);
    expect(log()).toBe(deletesBefore);
    expect(e.db.query("SELECT 1 FROM sync_log WHERE tbl = 'receipts' AND pk = 'r-new'")).toEqual([]);
    const gone2 = e.prune(d(15));
    expect(gone2.prices).toBe(1); // p1's 20-day-old price; its latest and p2's only one stay
    expect(e.db.query('SELECT COUNT(*) AS n FROM prices')[0].n).toBe(2);
  });

  it('receipts: the household shares them, and this device can turn them off (share_receipts "0")', async () => {
    const { e } = await house();
    expect(e.shareReceipts()).toBe(true);
    e.setMeta('share_receipts', '0');
    expect(e.shareReceipts()).toBe(false);
    e.setMeta('share_receipts', null);
    e.writeHousehold('receipts', '0');
    expect(e.shareReceipts()).toBe(false);
  });

  it('compact: old deletes every member phone has seen, never the household’s', async () => {
    const { e } = await house();
    const old = NOW - 100 * 86_400_000;
    e.writeHousehold('member:a1', JSON.stringify({ name: 'A', pub: 'P' }));
    e.takeFile('restock-sync-a1.bin', 's1', phoneFile('a1', [ent('items', 'i1', old, 'a1', item('i1', 'pantry'), { created: old - 5 })]), 'now');
    e.takeFile('restock-sync-a1.bin', 's2', phoneFile('a1', [ent('items', 'i1', old + 1, 'a1', null, { created: old - 5 })]), 'now');
    expect(e.compact()).toBe(0); // a1 hasn't seen it yet
    const top = Number(e.db.query('SELECT MAX(seq) AS s FROM sync_log')[0].s);
    e.takeFile('restock-sync-a1.bin', 's3', phoneFile('a1', [], { seen: { 'srv-k3x9q2': top } }), 'now');
    expect(e.compact()).toBe(1);
    expect(e.db.query("SELECT 1 FROM sync_log WHERE pk = 'i1'")).toEqual([]);
  });

  it('file names a v3 server allows', () => {
    expect(allowedNameV3('keys/a1b2.bin')).toBe(true);
    expect(allowedNameV3(serverFileName('k3x9q2'))).toBe(true);
    expect(allowedNameV3('webkeys/abcdefgh.bin')).toBe(false);
    expect(allowedNameV3('restock-sync-keys-h1.json')).toBe(false);
    expect(allowedNameV3('keys/../x.bin')).toBe(false);
  });

  it('a whole file, sealed as a phone seals it, merged into node:sqlite', async () => {
    const { e, sign } = await house();
    const serverKey = serverKeyOf(enc('k'.repeat(32)));
    const sealed = sealRsf1(serverKey, phoneFile('a1', [sign(ent('household', 'name', NOW - 5, 'srv-k3x9q2', { k: 'name', v: 'Old name' })), ent('list_entries', 'l1', NOW, 'a1', { id: 'l1', text: 'Milk', checked: 0, qty: 1, created_at: 'x', section: 'pantry' })], { shares: { tabs: ['pantry'], receipts: false, cards: false } }));
    const m = openRsf1<SyncFileMessage>(serverKey, sealed);
    expect(e.takeFile('restock-sync-a1.bin', b64u(sealed.subarray(4, 16)), m, 'now')).toBe(1);
    expect(e.db.query('SELECT text FROM list_entries')).toEqual([{ text: 'Milk' }]);
    expect(e.householdValue('name')).toBe('Declan and Sarah'); // its older signed name doesn't win
  });
});
