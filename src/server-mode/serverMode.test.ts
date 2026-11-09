/// <reference types="node" />
// 0.9.2 server mode: the web's crypto against Node's (what Java does too), the merge rules ported
// from SyncEngine.java, the passphrase and file name rules, and a whole round against a folder.
// (tools/sync-test/web-parity.sh checks the merge against the phones' real Java code.)
import { createHmac, createPublicKey, generateKeyPairSync, pbkdf2Sync, sign as nodeSign, createECDH, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import initSqlJs from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import {
  b64u,
  derivePassphrase,
  newEcdhKey,
  openGift,
  openRsf1,
  openVault,
  openWebKeys,
  openWithAny,
  pointOf,
  publicOf,
  sealGift,
  sealRsf1,
  sealVault,
  sealWebKeys,
  serverKeyOf,
  signedText,
  signText,
  unb64,
  verifySig,
} from './crypto';
import { allowedName, isSyncFile, stripCard, webFileName, WebSyncEngine, type Entry } from './engine';
import { checkPassphrase } from './passphrase';
import { syncRound, type Remote } from './round';
import { syncDbOf } from './sqldb';
import type { SqlJsStatic } from 'sql.js';
import { migrate } from '../lib/sql/schema';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

async function engine(device = 'web-test') {
  const d = await createSqlJsDriver({ load: async () => SQL });
  await migrate(d);
  const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
  e.setMeta('device', device);
  return e;
}

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

describe('crypto, as Java and Node do it', () => {
  it('serverKey is HMAC-SHA256(householdKey, "restock-server-files-v1")', () => {
    const hk = randomBytes(32);
    expect(Buffer.from(serverKeyOf(hk)).toString('hex')).toBe(createHmac('sha256', hk).update('restock-server-files-v1').digest('hex'));
  });

  it('opens an RSF1 file sealed by Node like SyncFolder.seal (gzip, GCM with RSF1 as associated data)', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(Buffer.from('RSF1'));
    const body = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify({ device: 'a1', entries: [] })))), c.final(), c.getAuthTag()]);
    const file = Buffer.concat([Buffer.from('RSF1'), nonce, body]);
    expect(openRsf1(new Uint8Array(key), new Uint8Array(file))).toEqual({ device: 'a1', entries: [] });
    // and the other way
    const sealed = sealRsf1(new Uint8Array(key), { x: 1 });
    expect(Buffer.from(sealed.subarray(0, 4)).toString()).toBe('RSF1');
    expect(() => openRsf1(new Uint8Array(randomBytes(32)), sealed)).toThrow();
    const dec = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.subarray(4, 16)));
    dec.setAAD(Buffer.from('RSF1'));
    dec.setAuthTag(Buffer.from(sealed.subarray(sealed.length - 16)));
    const plain = Buffer.concat([dec.update(Buffer.from(sealed.subarray(16, sealed.length - 16))), dec.final()]);
    expect(JSON.parse(gunzipSync(plain).toString())).toEqual({ x: 1 });
  });

  it('opens with whichever key version fits, newest first', () => {
    const k1 = randomBytes(32),
      k2 = randomBytes(32);
    const f = sealRsf1(new Uint8Array(k1), { v: 1 });
    expect(openWithAny({ '1': b64u(k1), '2': b64u(k2) }, f)).toEqual({ keyv: 1, msg: { v: 1 } });
    expect(() => openWithAny({ '2': b64u(k2) }, f)).toThrow();
  });

  it('PBKDF2 gives Node’s bytes (fewer rounds here), split into authKey and vaultKey', async () => {
    const salt = randomBytes(16);
    const r = await derivePassphrase('Kettle under the mango tree', new Uint8Array(salt), 1000);
    const want = pbkdf2Sync(Buffer.from('Kettle under the mango tree'.normalize('NFKC')), salt, 1000, 64, 'sha256');
    expect(Buffer.from(r.auth).toString('hex')).toBe(want.subarray(0, 32).toString('hex'));
    expect(Buffer.from(r.vault).toString('hex')).toBe(want.subarray(32).toString('hex'));
    // NFKC: the same passphrase typed with a different form of a letter gives the same keys
    const a = await derivePassphrase('ﬁve green ducks on a pond', new Uint8Array(salt), 10);
    const b = await derivePassphrase('five green ducks on a pond', new Uint8Array(salt), 10);
    expect(a.auth).toEqual(b.auth);
  });

  it('a link gift sealed by Node’s ECDH and HKDF (as Java would) opens in the browser', () => {
    const browser = newEcdhKey();
    // The phone's side, with Node only: ECDH P-256 with the browser's SPKI public key.
    const phone = createECDH('prime256v1');
    phone.generateKeys();
    const shared = phone.computeSecret(Buffer.from(pointOf(browser.pub)));
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'restock-link-v2', 32));
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const gift = { keys: { '3': b64u(randomBytes(32)) }, keyv: 3, household: { name: 'Plenty house', owner_pub: 'x' } };
    const sealed = Buffer.concat([nonce, c.update(JSON.stringify(gift)), c.final(), c.getAuthTag()]);
    const phonePub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: phone.getPublicKey().subarray(1, 33).toString('base64url'), y: phone.getPublicKey().subarray(33).toString('base64url') }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
    expect(phonePub.length).toBe(91);
    expect(openGift(browser.priv, { pub: b64u(phonePub), sealed: b64u(sealed) })).toEqual(gift);
    // and the stand-in phone (tests) agrees with itself
    expect(openGift(browser.priv, sealGift(browser.pub, gift))).toEqual(gift);
    // someone else's key doesn't open it
    expect(() => openGift(newEcdhKey().priv, sealGift(browser.pub, gift))).toThrow();
  });

  it('webkeys files (RSE2) open with the web’s private key', () => {
    const w = newEcdhKey();
    const keys = { '4': b64u(randomBytes(32)) };
    const f = sealWebKeys(w.pub, keys);
    expect(Buffer.from(f.subarray(0, 4)).toString()).toBe('RSE2');
    expect(openWebKeys(w.priv, f)).toEqual(keys);
    expect(() => openWebKeys(newEcdhKey().priv, f)).toThrow();
  });

  it('the vault opens only with its vaultKey', () => {
    const vk = randomBytes(32);
    const k = newEcdhKey();
    const v = { webId: 'abcdefgh12345678', webPriv: b64u(k.priv), keys: { '1': b64u(randomBytes(32)) } };
    const sealed = sealVault(new Uint8Array(vk), v);
    expect(openVault(new Uint8Array(vk), sealed)).toEqual(v);
    expect(() => openVault(new Uint8Array(randomBytes(32)), sealed)).toThrow();
    expect(b64u(publicOf(k.priv))).toBe(b64u(k.pub));
  });

  it('checks household signatures made like Java’s SHA256withECDSA (DER, SPKI keys)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = b64u(publicKey.export({ type: 'spki', format: 'der' }));
    const e = { pk: 'name', stamp: 1762650000123, deleted: false, row: { k: 'name', v: 'Plenty house' } };
    const text = signedText(e);
    expect(text).toBe('restock-hh1|name|v=Plenty house|1762650000123');
    const sig = b64u(nodeSign('sha256', Buffer.from(text), privateKey));
    expect(verifySig(pub, text, sig)).toBe(true);
    expect(verifySig(pub, text.replace('Plenty', 'Forged'), sig)).toBe(false);
    expect(signedText({ pk: 'member:b2', stamp: 5, deleted: true })).toBe('restock-hh1|member:b2|-|5');
    // noble's own signature verifies too (the test helper)
    const priv = privateKey.export({ format: 'jwk' }).d!;
    expect(verifySig(pub, text, signText(unb64(priv), text))).toBe(true);
  });
});

describe('merge rules (SyncEngine.apply)', () => {
  it('the later change wins; a tie goes to the larger device id', async () => {
    const e = await engine();
    e.apply([ent('items', 'i1', NOW, 'a1', { id: 'i1', name: 'Milk', created_at: 'x', section: 'pantry' })]);
    e.apply([ent('items', 'i1', NOW - 5, 'b2', { id: 'i1', name: 'Older', created_at: 'x', section: 'pantry' }, { created: NOW - 99 })]);
    expect(e.db.query("SELECT name FROM items WHERE id = 'i1'")[0].name).toBe('Milk');
    e.apply([ent('items', 'i1', NOW, 'b2', { id: 'i1', name: 'Tie, larger id', created_at: 'x', section: 'pantry' }, { created: NOW - 99 })]);
    expect(e.db.query("SELECT name FROM items WHERE id = 'i1'")[0].name).toBe('Tie, larger id');
  });

  it('a delete beats an edit made without knowing about it; only something made again after it comes back', async () => {
    const e = await engine();
    const made = NOW - 10_000;
    e.apply([ent('items', 'i1', made, 'a1', { id: 'i1', name: 'Tea', created_at: 'x', section: 'pantry' }, { created: made })]);
    e.apply([ent('items', 'i1', NOW - 100, 'a1', null, { created: made })]);
    e.apply([ent('items', 'i1', NOW, 'b2', { id: 'i1', name: 'Green tea', created_at: 'x', section: 'pantry' }, { created: made })]);
    expect(e.db.query("SELECT 1 FROM items WHERE id = 'i1'")).toEqual([]);
    e.apply([ent('items', 'i1', NOW + 10, 'b2', { id: 'i1', name: 'Tea again', created_at: 'x', section: 'pantry' }, { created: NOW + 10 })]);
    expect(e.db.query("SELECT name FROM items WHERE id = 'i1'")[0].name).toBe('Tea again');
  });

  it('a list line keeps the newer tick and the newer amount separately, and notes the merge as its own', async () => {
    const e = await engine('web-me');
    e.apply([ent('list_entries', 'l1', NOW, 'a1', { id: 'l1', text: 'Milk', checked: 0, qty: 1, created_at: 'x', section: 'pantry', checked_at: null, qty_at: null })]);
    // Ticked here (the web), then a phone's newer change brings an amount but an older tick.
    e.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'l1'", [NOW + 500]);
    e.apply([ent('list_entries', 'l1', NOW + 1_000_000, 'b2', { id: 'l1', text: 'Milk', checked: 0, checked_at: NOW + 100, qty: 4, qty_at: NOW + 900, created_at: 'x', section: 'pantry' })]);
    expect(e.db.query("SELECT checked, qty FROM list_entries WHERE id = 'l1'")[0]).toEqual({ checked: 1, qty: 4 });
    const log = e.db.query("SELECT stamp, device FROM sync_log WHERE pk = 'l1'")[0];
    expect(log.device).toBe('web-me');
  });

  it('household changes: owner-only ones need the owner’s signature once the owner key is known', async () => {
    const e = await engine();
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = b64u(publicKey.export({ type: 'spki', format: 'der' }));
    e.setMeta('owner_pin', pub);
    const signed = (x: Entry) => ({ ...x, sig: b64u(nodeSign('sha256', Buffer.from(signedText(x as never)), privateKey)) });
    e.apply([signed(ent('household', 'name', NOW, 'a1', { k: 'name', v: 'Plenty house' }))]);
    e.apply([ent('household', 'name', NOW + 10, 'b2', { k: 'name', v: 'Forged' })]);
    e.apply([{ ...ent('household', 'tabs', NOW + 10, 'b2', { k: 'tabs', v: 'pantry' }), sig: 'MEUCIQ' }]);
    expect(e.householdValue('name')).toBe('Plenty house');
    expect(e.householdValue('tabs')).toBe(null);
    // A phone's own member entry, before it has a key on record: its own word is enough.
    e.apply([ent('household', 'member:b2', NOW, 'b2', { k: 'member:b2', v: '{"name":"B"}' })]);
    expect(e.householdValue('member:b2')).toBe('{"name":"B"}');
    // ... but not someone else's.
    e.apply([ent('household', 'member:c3', NOW, 'b2', { k: 'member:c3', v: '{"name":"C"}' })]);
    expect(e.householdValue('member:c3')).toBe(null);
  });

  it('without an owner key yet: the first owner_pub that comes (from the owner) is pinned, like a phone that just joined', async () => {
    const e = await engine();
    e.apply([ent('household', 'owner', NOW, 'a1', { k: 'owner', v: 'a1' }), ent('household', 'owner_pub', NOW, 'a1', { k: 'owner_pub', v: 'PUB' })]);
    expect(e.meta('owner_pin')).toBe('PUB');
  });

  it('loyalty card numbers never reach the browser; sample items and receipts while not shared stay out', async () => {
    const e = await engine();
    e.apply([
      ent('cards', 'k1', NOW, 'a1', { id: 'k1', program: 'flybuys', label: 'Flybuys', number: '6008943212345678', created_at: 'x' }),
      ent('items', 'demo-1', NOW, 'a1', { id: 'demo-1', name: 'Sample', created_at: 'x' }),
      ent('receipts', 'r1', NOW, 'a1', { id: 'r1', scanned_at: 'x', section: 'pantry' }),
    ]);
    expect(e.db.query('SELECT number FROM cards')).toEqual([{ number: '' }]);
    expect(e.db.query('SELECT 1 FROM items')).toEqual([]);
    expect(e.db.query('SELECT 1 FROM receipts')).toEqual([]);
    expect(stripCard({ id: 'k', number: '1', barcode_format: 'x', label: 'L' })).toEqual({ id: 'k', label: 'L', number: '' });
  });

  it('prices are only added, once per product and time; products keep their own stock', async () => {
    const e = await engine();
    const p = { product_id: 'p1', date: '2026-11-01', price: 3, is_special: 0, member_only: 0, source: 'check' };
    e.apply([ent('products', 'p1', NOW, 'a1', { id: 'p1', chain: 'coles', name: 'Milk', created_at: 'x', in_stock: 1 })]);
    e.apply([ent('prices', 'p1|2026-11-01', NOW, 'a1', p)]);
    e.apply([ent('prices', 'p1|2026-11-01', NOW + 5, 'b2', { ...p, price: 9 })]);
    expect(e.db.query('SELECT price FROM prices')).toEqual([{ price: 3 }]);
    expect(e.db.query('SELECT in_stock FROM products')).toEqual([{ in_stock: null }]);
  });

  it('the web’s own file leaves out prices, the household and cards', async () => {
    const e = await engine('web-me');
    e.apply([
      ent('cards', 'k1', NOW, 'a1', { id: 'k1', program: 'flybuys', label: 'F', number: '1', created_at: 'x' }),
      ent('household', 'owner', NOW, 'a1', { k: 'owner', v: 'a1' }),
      ent('products', 'p1', NOW, 'a1', { id: 'p1', chain: 'coles', name: 'Milk', created_at: 'x' }),
      ent('prices', 'p1|d', NOW, 'a1', { product_id: 'p1', date: 'd', price: 3, source: 'check' }),
    ]);
    e.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('w1', 'Bread', 0, 'x', 1, 'pantry')");
    const out = e.ownFile(1, 'now', false)!;
    expect(out.msg.entries!.map((x) => x.tbl).sort()).toEqual(['list_entries', 'products']);
    expect(out.msg.device).toBe('web-me');
    e.wroteOwn(out.mark);
    expect(e.ownFile(1, 'now', true)).toBe(null);
    expect(e.ownFile(2, 'now', true)).not.toBe(null);
  });

  it('archives: prices and receipts added, a deleted receipt stays deleted', async () => {
    const e = await engine();
    e.apply([ent('household', 'receipts', NOW, 'a1', { k: 'receipts', v: '1' })]);
    e.apply([ent('receipts', 'r2', NOW, 'a1', null)]);
    const n = e.takeArchive({
      prices: [{ product_id: 'p1', date: '2025-01-01', price: 2, source: 'check' }, { product_id: 'p1', date: '2025-01-01', price: 5, source: 'check' }, { bad: 1 }],
      receipts: [{ id: 'r1', scanned_at: '2025-01-02', section: 'pantry' }, { id: 'r2', scanned_at: '2025-01-03', section: 'pantry' }],
    });
    expect(n).toBe(2);
    expect(e.db.query("SELECT COUNT(*) AS n FROM sync_log WHERE tbl = 'prices'")[0].n).toBe(0);
  });

  it('tidies categories of the same name to the smaller id', async () => {
    const e = await engine();
    e.apply([ent('categories', 'c-b', NOW, 'b2', { id: 'c-b', name: ' pantry', ord: 1, section: 'pantry' }), ent('categories', 'c-a', NOW, 'a1', { id: 'c-a', name: 'Pantry', ord: 0, section: 'pantry' })]);
    expect(e.tidyCategories()).toBe(1);
    expect(e.db.query('SELECT id FROM categories')).toEqual([{ id: 'c-a' }]);
  });
});

describe('names and passphrases', () => {
  it('file names the server allows', () => {
    expect(allowedName('restock-sync-a1b2.bin')).toBe(true);
    expect(allowedName(webFileName('AbCd_123-xyzXYZ00'))).toBe(true);
    expect(allowedName('archive/a1/2026-08.bin')).toBe(true);
    expect(allowedName('archive/a1/2026-13.bin')).toBe(false);
    expect(allowedName('photos/' + 'a'.repeat(64) + '.bin')).toBe(true);
    expect(allowedName('photos/../x.bin')).toBe(false);
    expect(allowedName('../restock-sync-a.bin')).toBe(false);
    expect(allowedName('webkeys/abcdefgh.bin')).toBe(true);
    expect(isSyncFile('restock-sync-keys-h1.json')).toBe(false);
    expect(isSyncFile('restock-sync-a1.bin')).toBe(true);
  });

  it('a passphrase: 20 characters or 4 words, not common, not the user name', () => {
    expect(checkPassphrase('admin', 'admin').ok).toBe(false);
    expect(checkPassphrase('password123', 'admin').ok).toBe(false);
    expect(checkPassphrase('correct horse battery staple', 'admin').ok).toBe(false);
    expect(checkPassphrase('Declan2026', 'declan').ok).toBe(false);
    expect(checkPassphrase('aaaaaaaaaaaaaaaaaaaaaaaa', 'admin').ok).toBe(false);
    expect(checkPassphrase('short one', 'admin').ok).toBe(false);
    expect(checkPassphrase('kettle under the mango tree', 'admin').ok).toBe(true);
    expect(checkPassphrase('Tr0ub4dor&3-Bohle-Plains!', 'admin').ok).toBe(true);
    expect(checkPassphrase('kettle under the mango tree', 'admin').score).toBeGreaterThanOrEqual(2);
  });
});

/** An owner signing key and a signed household record, as SyncHousehold.java makes them. */
function ownerKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = b64u(publicKey.export({ type: 'spki', format: 'der' }));
  const sign = (x: Entry): Entry => ({ ...x, sig: b64u(nodeSign('sha256', Buffer.from(signedText(x as never)), privateKey)) });
  return { pub, sign, nameEntry: sign(ent('household', 'name', NOW - 1000, 'a1', { k: 'name', v: 'Plenty house' })) };
}

describe('a whole round (round.ts)', () => {
  function memRemote(files: Map<string, Uint8Array>): Remote {
    let n = 0;
    const ver = new Map<string, string>();
    return {
      async files() {
        return [...files.keys()].sort().map((name) => ({ name, size: files.get(name)!.length, version: ver.get(name) ?? b64u(files.get(name)!.subarray(4, 16)) }));
      },
      async read(name) {
        return files.get(name) ?? null;
      },
      async write(name, bytes, ifMatch) {
        void ifMatch;
        files.set(name, bytes);
        ver.set(name, 'v' + ++n);
        return { version: ver.get(name) };
      },
    };
  }

  it('takes in phones, archives and new keys, writes its own file with webPub, and two browsers keep each other’s changes', async () => {
    const key1 = randomBytes(32),
      key2 = randomBytes(32);
    const files = new Map<string, Uint8Array>();
    const w = newEcdhKey();
    // Like a real phone's file: the household's records (signed by the owner) come along every time.
    const owner = ownerKey();
    const phoneFile = (keyv: number, k: Buffer, entries: Entry[]) =>
      sealRsf1(new Uint8Array(k), { format: 'restock-sync', v: 1, device: 'a1', name: 'A', keyv, at: 'x', top: 1, entries: [owner.nameEntry, ...entries], photos: { 'receipts/r1.jpg': 'f'.repeat(64) } });
    files.set('restock-sync-a1.bin', phoneFile(1, key1, [ent('list_entries', 'l1', NOW, 'a1', { id: 'l1', text: 'Milk', checked: 0, qty: 1, created_at: 'x', section: 'pantry' })]));
    files.set('archive/a1/2025-01.bin', sealRsf1(new Uint8Array(key1), { format: 'restock-archive', prices: [{ product_id: 'p', date: '2025-01-01', price: 1, source: 'check' }] }));
    files.set('restock-sync-zz.bin', sealRsf1(new Uint8Array(randomBytes(32)), { device: 'zz' }));
    const remote = memRemote(files);
    const a = await engine('web-W1');
    a.setMeta('owner_pin', owner.pub); // from the link, as live.ts does
    const keys = { webId: 'W1', webPriv: b64u(w.priv), webPub: b64u(w.pub), keys: { '1': b64u(key1) } as Record<string, string> };
    const r = await syncRound(a, remote, keys);
    expect(r).toMatchObject({ received: 2, unread: 1, archived: 1, wrote: true });
    expect(a.meta('photo:receipts/r1.jpg')).toBe('f'.repeat(64));
    const own = openRsf1<{ webPub: string; device: string; entries: Entry[] }>(new Uint8Array(key1), files.get(webFileName('W1'))!);
    expect(own.webPub).toBe(b64u(w.pub));
    expect(own.device).toBe('web-W1');
    // Nothing changed: not written again.
    expect((await syncRound(a, remote, keys)).wrote).toBe(false);

    // A rekey: a phone leaves the new key in webkeys/; the phones' files move to it.
    files.set('webkeys/W1.bin', sealWebKeys(w.pub, { '2': b64u(key2) }));
    files.set('restock-sync-a1.bin', phoneFile(2, key2, [ent('list_entries', 'l2', NOW, 'a1', { id: 'l2', text: 'Eggs', checked: 0, qty: 1, created_at: 'x', section: 'pantry' })]));
    const r2 = await syncRound(a, remote, keys);
    expect(r2.newKeys).toBe(true);
    expect(keys.keys['2']).toBe(b64u(key2));
    expect(a.db.query("SELECT 1 FROM list_entries WHERE id = 'l2'").length).toBe(1);
    expect(r2.wrote).toBe(true); // sealed with the new key now
    expect(() => openRsf1(new Uint8Array(key2), files.get(webFileName('W1'))!)).not.toThrow();

    // A second browser signed in as the same user (same web id, its own copy).
    const b = await engine('web-W1');
    b.setMeta('owner_pin', owner.pub);
    await syncRound(b, remote, { ...keys });
    b.db.exec("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'l1'", [Date.now()]);
    await syncRound(b, remote, { ...keys });
    a.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('fromA', 'Bread', 0, 'x', 1, 'pantry')");
    await syncRound(a, remote, keys);
    const final = openRsf1<{ entries: Entry[] }>(new Uint8Array(key2), files.get(webFileName('W1'))!);
    const ids = final.entries.filter((x) => x.tbl === 'list_entries').map((x) => [x.pk, (x.row as { checked?: number })?.checked]);
    expect(ids).toEqual(expect.arrayContaining([['l1', 1], ['fromA', 0]]));
  });

  // From the 0.9.2 security review: each of these failed before its fix.
  const roundSetup = async () => {
    const key1 = randomBytes(32);
    const files = new Map<string, Uint8Array>();
    const w = newEcdhKey();
    const owner = ownerKey();
    const phoneFile = (k: Buffer, entries: Entry[], device = 'a1', household: Entry[] = [owner.nameEntry]) =>
      sealRsf1(new Uint8Array(k), { format: 'restock-sync', v: 1, device, name: 'A', keyv: 1, at: 'x', top: 1, entries: [...household, ...entries] });
    files.set('restock-sync-a1.bin', phoneFile(key1, [ent('list_entries', 'l1', NOW, 'a1', { id: 'l1', text: 'Milk', checked: 0, qty: 1, created_at: 'x', section: 'pantry' })]));
    const e = await engine('web-W1');
    e.setMeta('owner_pin', owner.pub);
    const keys = { webId: 'W1', webPriv: b64u(w.priv), webPub: b64u(w.pub), keys: { '1': b64u(key1) } as Record<string, string> };
    const remote = memRemote(files);
    await syncRound(e, remote, keys);
    return { key1, files, w, owner, phoneFile, e, keys, remote };
  };

  it('a webkeys/ file anyone made (it only takes the public webPub) gets no key into the browser', async () => {
    const { key1, files, w, phoneFile, e, keys, remote } = await roundSetup();
    // Someone with the server's data folder: a "new" key, and a key for the version the browser has.
    const evil = randomBytes(32);
    files.set('webkeys/W1.bin', sealWebKeys(w.pub, { '1': b64u(evil), '7': b64u(evil) }));
    // ...and a phone file sealed with it, even one that names a real phone and copies an unsigned record.
    files.set('restock-sync-a1.bin', phoneFile(evil, [ent('items', 'evil', NOW, 'a1', { id: 'evil', name: 'Injected', created_at: 'x', section: 'pantry' })], 'a1', [ent('household', 'name', NOW, 'a1', { k: 'name', v: 'Plenty house' })]));
    e.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('mine', 'Bread', 0, 'x', 1, 'pantry')");
    const r = await syncRound(e, remote, keys);
    expect(r.newKeys).toBe(false);
    expect(keys.keys).toEqual({ '1': b64u(key1) });
    expect(e.db.query("SELECT 1 FROM items WHERE id = 'evil'")).toEqual([]);
    // The web's own file is still sealed with the household's key, not the made-up one.
    expect(r.wrote).toBe(true);
    expect(() => openRsf1(new Uint8Array(key1), files.get(webFileName('W1'))!)).not.toThrow();
    expect(() => openRsf1(new Uint8Array(evil), files.get(webFileName('W1'))!)).toThrow();
  });

  it('a real rekey still comes in: the new key opens a phone file the owner signed', async () => {
    const { files, w, owner, phoneFile, e, keys, remote } = await roundSetup();
    const key2 = randomBytes(32);
    files.set('webkeys/W1.bin', sealWebKeys(w.pub, { '2': b64u(key2) }));
    // Before any phone file uses it: nothing yet, and webkeys/ is read again next time.
    let r = await syncRound(e, remote, keys);
    expect(r.newKeys).toBe(false);
    expect(keys.keys['2']).toBeUndefined();
    files.set('restock-sync-a1.bin', phoneFile(key2, [ent('list_entries', 'l2', NOW, 'a1', { id: 'l2', text: 'Eggs', checked: 0, qty: 1, created_at: 'x', section: 'pantry' })], 'a1', [owner.sign(ent('household', 'tabs', NOW, 'a1', { k: 'tabs', v: 'pantry,keg,pharmacy' }))]));
    r = await syncRound(e, remote, keys);
    expect(r.newKeys).toBe(true);
    expect(keys.keys['2']).toBe(b64u(key2));
    expect(e.db.query("SELECT 1 FROM list_entries WHERE id = 'l2'").length).toBe(1);
  });

  it('a browser signed in with a phone never names the webPub the server told it', async () => {
    const { key1, files, e: passphraseBrowser, keys } = await roundSetup();
    const real = openRsf1<{ webPub?: string }>(new Uint8Array(key1), files.get(webFileName('W1'))!).webPub;
    expect(real).toBe(keys.webPub);
    // The phone-signed-in browser: no webPriv; its webPub came from GET /api/v2/web, which whoever
    // has the server's data folder can change.
    const evil = newEcdhKey();
    const viaPhone = await engine('web-W1');
    const remote = memRemote(files);
    viaPhone.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('t', 'Tea', 0, 'x', 1, 'pantry')");
    const r = await syncRound(viaPhone, remote, { webId: 'W1', webPriv: '', webPub: b64u(evil.pub), keys: { '1': b64u(key1) } });
    expect(r.wrote).toBe(true);
    const own = openRsf1<{ webPub?: string; entries: Entry[] }>(new Uint8Array(key1), files.get(webFileName('W1'))!);
    expect(own.entries.some((x) => x.pk === 't')).toBe(true);
    expect(own.webPub).toBe(real); // the one the passphrase browser sealed in, not the server's
    void passphraseBrowser;
    // With no web file yet it names none at all.
    const fresh = new Map<string, Uint8Array>();
    const lone = await engine('web-W2');
    lone.db.exec("INSERT INTO list_entries (id, text, checked, created_at, qty, section) VALUES ('t', 'Tea', 0, 'x', 1, 'pantry')");
    await syncRound(lone, memRemote(fresh), { webId: 'W2', webPriv: '', webPub: b64u(evil.pub), keys: { '1': b64u(key1) } });
    expect(openRsf1<{ webPub?: string }>(new Uint8Array(key1), fresh.get(webFileName('W2'))!).webPub).toBeUndefined();
  });
});

