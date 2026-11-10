/// <reference types="node" />
// 0.9.4 (P5): the web app against a house (protocol v3): challenge sign-in, the session key, the
// request MACs, sealed answers and sealed bodies, a passphrase change, sign-in with a phone, the
// clock retry, and the round over v3 (no webkeys/, no archives, no webPub, the phones' shared
// specials). A stand-in server is made of the same P1 helpers the real one uses (crypto.ts), so
// this checks the web's side of each byte; tools/sync-test/server-web.mjs runs it against P2's.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { migrate } from '../lib/sql/schema';
import { api3, isV3, probeServer, setServerInfo, SEALED } from './api';
import {
  b64u,
  loginKeyOf,
  loginProof,
  macOk,
  newEcdhKey,
  openRsf1,
  parseAuthorization,
  requestText,
  sealRsf1,
  sessionKeyOf,
  signedText,
  unb64,
  verifySig,
} from './crypto';
import { WebSyncEngine } from './engine';
import { syncRound, sharedSectionOf, type Remote } from './round';
import { changeHousePassphrase, forget, loginV3, refreshHouseKeys, session, setUpHouse } from './session';
import { syncDbOf } from './sqldb';

const ROUNDS = 600_000;
const PASS = 'kettle under the mango tree';

/** A pretend v3 server: one user, one house, the web's side of every exchange checked byte by byte. */
function fakeHouse(opts: { mode?: string; keys?: Record<string, string> } = {}) {
  const kex = newEcdhKey();
  const salt = randomBytes(16);
  const authKey = new Uint8Array(pbkdf2Sync(PASS.normalize('NFKC'), salt, ROUNDS, 64, 'sha256').subarray(0, 32));
  let loginKey = loginKeyOf(authKey);
  const challenges = new Set<string>();
  const sessions = new Map<string, Uint8Array>();
  const nonces = new Set<string>();
  const seen: { method: string; path: string; sealed: boolean; body?: unknown }[] = [];
  let keys = opts.keys ?? { '1': b64u(randomBytes(32)) };
  let clockAhead = 0;
  const state = { mode: opts.mode ?? 'v3', name: 'Declan and Sarah' };

  const reply = (status: number, body: unknown, sealWith?: Uint8Array, headers: Record<string, string> = {}) =>
    sealWith
      ? new Response(sealRsf1(sealWith, body) as BodyInit, { status, headers: { 'Content-Type': SEALED, ...headers } })
      : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  async function fetchFn(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input), 'http://house.local');
    const path = url.pathname + url.search;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const raw = init.body ? new Uint8Array(init.body as ArrayBuffer) : new Uint8Array(0);
    const type = headers['Content-Type'] ?? '';

    if (path === '/api/v3/health') return reply(200, { ok: true, version: '0.9.4', api: 3, mode: state.mode, house: state.name });
    if (path.startsWith('/api/v3/login/challenge')) {
      const c = b64u(randomBytes(32));
      challenges.add(c);
      return reply(200, { salt: b64u(salt), c, kex: b64u(kex.pub) });
    }
    if (path === '/api/v3/login' && method === 'POST') {
      const b = JSON.parse(new TextDecoder().decode(raw)) as { user: string; c: string; epub: string; proof: string };
      if (!challenges.delete(b.c)) return reply(401, { error: 'challenge' });
      if (b.proof !== loginProof(loginKey, b.c, b.epub)) return reply(401, { error: 'wrong', message: "That user name or passphrase isn't right." });
      const sk = sessionKeyOf(kex.priv, unb64(b.epub), unb64(b.c), loginKey);
      const s = b64u(randomBytes(18));
      sessions.set(s, sk);
      return reply(200, { session: s, expires: Date.now() + 86_400_000, sealed: b64u(sealRsf1(sk, { keys: state.mode === 'new' ? {} : keys, keyv: 1, webId: 'w3web', household: { name: state.name, owner_pub: 'OWNER' } })) });
    }

    // Everything else: a session's MAC.
    const auth = parseAuthorization(headers.Authorization);
    if (!auth || auth.scheme !== 'RestockWeb3') return reply(401, { error: 'auth' });
    const { s, t, n, m } = auth.fields;
    const sk = sessions.get(s);
    if (!sk) return reply(401, { error: 'signed-out' });
    if (Math.abs(Number(t) - (Date.now() + clockAhead)) > 5 * 60_000)
      return reply(401, { error: 'clock' }, undefined, { 'X-Restock-Time': String(Date.now() + clockAhead) });
    if (nonces.has(n)) return reply(401, { error: 'replay' });
    nonces.add(n);
    if (!macOk(sk, requestText(method, path, t, n, raw), m)) return reply(401, { error: 'mac' });
    const body = type === SEALED ? openRsf1(sk, raw) : raw.length ? JSON.parse(new TextDecoder().decode(raw)) : undefined;
    seen.push({ method, path, sealed: type === SEALED, body });

    if (path === '/api/v3/session') return reply(200, { keys, keyv: Object.keys(keys).length, webId: 'w3web', household: { name: state.name, owner_pub: 'OWNER' } }, sk);
    if (path === '/api/v3/settings') return reply(200, { name: state.name, keepMonths: 12 }, sk);
    if (path === '/api/v3/setup' && method === 'POST') {
      state.mode = 'v3';
      state.name = (body as { name: string }).name;
      return reply(200, { keys, keyv: 1, webId: 'w3web', household: { name: state.name, owner_pub: 'OWNER' } }, sk);
    }
    if (path === '/api/v3/phones') return reply(200, { phones: [{ device: 'a1', label: "Declan's phone", status: 'active' }, { device: 'b2', label: "Sister's phone", status: 'removed', statusAt: '2026-11-03T00:00:00Z' }] }, sk);
    if (path === '/api/v3/passphrase') {
      const b = body as { c: string; proof: string; salt: string; auth: string };
      if (!challenges.delete(b.c) || b.proof !== loginProof(loginKey, b.c, s)) return reply(403, { error: 'current' });
      loginKey = loginKeyOf(unb64(b.auth));
      return reply(200, { ok: true });
    }
    return reply(404, { error: 'missing' });
  }
  return {
    fetchFn,
    seen,
    state,
    sessions,
    rekey: () => (keys = { ...keys, '2': b64u(randomBytes(32)) }),
    keys: () => keys,
    setClock: (ms: number) => (clockAhead = ms),
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  forget();
  setServerInfo(undefined);
});

describe('signing in to a house (v3)', () => {
  it('asks the server what it is: a 0.9.3 server (no /api/v3/health) is v2', async () => {
    globalThis.fetch = (async () => new Response('{"error":"missing"}', { status: 404 })) as typeof fetch;
    expect(await probeServer()).toEqual({ api: 2 });
    expect(isV3()).toBe(false);
    const h = fakeHouse({ mode: 'v2' });
    globalThis.fetch = h.fetchFn as typeof fetch;
    expect((await probeServer()).mode).toBe('v2');
    // A 0.9.4 server still in v2 mode keeps the 0.9.3 browser flow (vault, link) until the handover.
    expect(isV3()).toBe(false);
  });

  it('proves the passphrase over a challenge, works out the server’s session key, and opens the keys it sealed', async () => {
    const h = fakeHouse();
    globalThis.fetch = h.fetchFn as typeof fetch;
    await probeServer();
    expect(isV3()).toBe(true);
    const s = await loginV3('admin', PASS);
    expect(s.v).toBe(3);
    expect(s.keys).toEqual(h.keys());
    expect(s.webId).toBe('w3web');
    expect(s.household).toBe('Declan and Sarah');
    // The key this browser worked out is the one the server made.
    expect(unb64(s.sessionKey!)).toEqual(h.sessions.get(s.sid!));
    await expect(loginV3('admin', 'not the passphrase at all, no')).rejects.toThrow(/isn't right/);
  }, 30_000);

  it('MACs every request, opens sealed answers, and seals bodies with secrets', async () => {
    const h = fakeHouse();
    globalThis.fetch = h.fetchFn as typeof fetch;
    await probeServer();
    await loginV3('admin', PASS);
    const phones = await api3.phones();
    expect(phones.map((p) => p.status)).toEqual(['active', 'removed']);
    expect((await api3.settings()).keepMonths).toBe(12);
    // A body with a secret goes sealed (the fake server opens it with the session key).
    await api3.putHomeAssistant({ address: 'http://ha.local:8123', token: 'secret-token' }).catch(() => undefined);
    const put = h.seen.find((x) => x.path === '/api/v3/homeassistant');
    expect(put?.sealed).toBe(true);
    expect((put?.body as { token: string }).token).toBe('secret-token');
  }, 30_000);

  it('a clock refusal is retried once with the server’s time', async () => {
    const h = fakeHouse();
    globalThis.fetch = h.fetchFn as typeof fetch;
    await probeServer();
    await loginV3('admin', PASS);
    h.setClock(20 * 60_000);
    expect((await api3.settings()).name).toBe('Declan and Sarah');
  }, 30_000);

  it('changes the passphrase by proving the current one; a wrong current one is refused', async () => {
    const h = fakeHouse();
    globalThis.fetch = h.fetchFn as typeof fetch;
    await probeServer();
    await loginV3('admin', PASS);
    await expect(changeHousePassphrase('wrong wrong wrong wrong', 'a brand new passphrase for us')).rejects.toThrow(/current passphrase/);
    await changeHousePassphrase(PASS, 'a brand new passphrase for us');
    const body = h.seen.find((x) => x.path === '/api/v3/passphrase' && (x.body as { auth?: string }).auth)?.body as { salt: string; auth: string };
    expect(unb64(body.salt)).toHaveLength(16);
    expect(unb64(body.auth)).toHaveLength(32);
  }, 60_000);

  it('a fresh server: signed in with no keys, Set up this server gives the session its keys', async () => {
    const h = fakeHouse({ mode: 'new' });
    globalThis.fetch = h.fetchFn as typeof fetch;
    await probeServer();
    const s = await loginV3('admin', PASS);
    expect(Object.keys(s.keys)).toHaveLength(0);
    const next = await setUpHouse('Declan and Sarah');
    expect(next.keys).toEqual(h.keys());
    expect(session()?.household).toBe('Declan and Sarah');
    expect(h.seen.find((x) => x.path === '/api/v3/setup')?.body).toEqual({ name: 'Declan and Sarah' });
  }, 30_000);

  it('after a Remove rekeyed the household, the session asks for and takes the new key', async () => {
    const h = fakeHouse();
    globalThis.fetch = h.fetchFn as typeof fetch;
    await probeServer();
    await loginV3('admin', PASS);
    expect(await refreshHouseKeys()).toBe(false);
    h.rekey();
    expect(await refreshHouseKeys()).toBe(true);
    expect(Object.keys(session()!.keys).sort()).toEqual(['1', '2']);
  }, 30_000);
});

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

describe('the round over v3 (round.ts)', () => {
  it('skips webkeys/ and archives, names no webPub, and hands back what phones shared of the specials', async () => {
    const d = await createSqlJsDriver({ load: async () => SQL });
    await migrate(d);
    const e = new WebSyncEngine(syncDbOf(d.raw), verifySig, signedText);
    e.setMeta('device', 'web-w3web');
    const key = randomBytes(32);
    const files = new Map<string, Uint8Array>();
    const reads: string[] = [];
    files.set(
      'restock-sync-a1.bin',
      sealRsf1(new Uint8Array(key), {
        format: 'restock-sync',
        v: 1,
        device: 'a1',
        name: 'A',
        keyv: 1,
        at: 'x',
        top: 0,
        entries: [],
        specials: {
          at: '2026-11-10T01:00:00Z',
          lists: [{ chain: 'coles', items: [{ storeProductId: 'c1', name: 'Coles Diced Tomatoes 400g', price: 0.6, wasPrice: 1.2, imageUrl: 'http://bad/x.jpg' }, { name: 'no price' }] }],
        },
        catalogues: { coles: { url: 'https://www.coles.com.au/catalogues', note: 'Wednesdays' }, aldi: { url: 'javascript:alert(1)' } },
      }),
    );
    files.set('archive/a1/2025-01.bin', sealRsf1(new Uint8Array(key), { prices: [] }));
    files.set('webkeys/w3web.bin', new Uint8Array([1, 2, 3]));
    const remote: Remote = {
      files: async () => [...files.keys()].map((name) => ({ name, size: files.get(name)!.length, version: name })),
      read: async (name) => (reads.push(name), files.get(name) ?? null),
      write: async (name, bytes) => (files.set(name, bytes), { version: 'v1' }),
    };
    // Something of the web's own to send.
    e.db.exec("INSERT INTO list_entries (id, text, checked, qty, created_at, section) VALUES ('l1', 'Milk', 0, 1, 'x', 'pantry')");
    const r = await syncRound(e, remote, { webId: 'w3web', webPriv: '', webPub: '', keys: { '1': b64u(key) } }, undefined, { v3: true });
    expect(reads).not.toContain('archive/a1/2025-01.bin');
    expect(reads).not.toContain('webkeys/w3web.bin');
    expect(r.shared).toHaveLength(1);
    const sh = r.shared[0];
    expect(sh.device).toBe('a1');
    expect(sh.specials[0].items).toHaveLength(1);
    // Only https pictures and links are kept.
    expect(sh.specials[0].items[0].imageUrl).toBeUndefined();
    expect(sh.catalogues.coles.url).toBe('https://www.coles.com.au/catalogues');
    expect(sh.catalogues.aldi.url).toBeUndefined();
    const own = openRsf1<{ webPub?: string; device: string }>(new Uint8Array(key), files.get('restock-sync-web-w3web.bin')!);
    expect(own.device).toBe('web-w3web');
    expect(own.webPub).toBeUndefined();
  });

  it('a file whose specials are odd shares nothing', () => {
    expect(sharedSectionOf({ specials: 'x', catalogues: [] }, 'a1')).toBeUndefined();
    expect(sharedSectionOf({ specials: [{ chain: 'Not A Chain!', items: [] }] }, 'a1')).toBeUndefined();
    // A bare list of SpecialsList works too.
    expect(sharedSectionOf({ specials: [{ chain: 'woolworths', at: 't', items: [{ name: 'Tim Tam', price: 2.75 }] }] }, 'a1')?.specials[0].items[0].name).toBe('Tim Tam');
  });
});
