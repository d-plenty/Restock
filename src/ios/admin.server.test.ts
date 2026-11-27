// 0.18.3: an admin iPhone (ios/house.ts, the code the iPhone and iPad run) against the real Restock
// server: "Is this you?" for a browser signing in, Server admin's settings and addresses, a risky
// change proved with the passphrase over the phone's own id, and the last admin phone kept. Needs the
// server's code next door:
//   RESTOCK_SERVER_REPO=/path/to/restock-server npx vitest run src/ios/admin.server.test.ts
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { initDb, updateSettings } from '../lib/db';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { AsyncSyncEngine } from '../server-mode/engine';
import { asyncSyncDbOf, syncDbOf } from '../server-mode/sqldb';
import { derivePassphrase, loginKeyOf, loginProof, signedText, signWithPkcs8, unb64, verifySig } from '../server-mode/crypto';
import { House, type Http } from './house';
import { ADMIN_PATHS } from './sync';

const SERVER = process.env.RESTOCK_SERVER_REPO ?? '';
const http: Http = async (o) => {
  const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body as unknown as BodyInit | undefined });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: r.status, headers, bytes: new Uint8Array(await r.arrayBuffer()) };
};

async function phone() {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
  const sign = (text: string, priv: string | null) => signWithPkcs8(priv ?? '', text);
  const e = new AsyncSyncEngine(asyncSyncDbOf(syncDbOf(driver.raw)), verifySig, signedText, () => Date.now(), { role: 'phone', sign });
  return { e, house: new House(e, http) };
}

describe('0.18.3: what an admin phone may ask its server for', () => {
  it('Server admin, and nothing else', () => {
    for (const p of ['/me', '/phones', '/phones/p1234', '/approvals', '/approvals/abcdefghijklmnopqrstuvwx', '/confirm/challenge', '/settings', '/activity?limit=150', '/browsers', '/homeassistant', '/homeassistant/test', '/data/summary', '/data/autodelete', '/recovery', '/server/log', '/server/updates', '/server/restart'])
      expect(ADMIN_PATHS.test(p), p).toBe(true);
    for (const p of ['/files', '/data/export', '/data/delete', '/data/delete-everything', '/passphrase', '/backup', '/username', '/phones/../files', '/settings?x=1', '/activity?limit=1;x'])
      expect(ADMIN_PATHS.test(p), p).toBe(false);
  });
});

describe.skipIf(!SERVER)('0.18.3: an admin iPhone on the real server', () => {
  it('says yes to a browser signing in, looks after Server settings, and proves the passphrase for risky changes', async () => {
    const H = await import(/* @vite-ignore */ `${SERVER}/test/helpers.mjs`);
    const t = await H.house();
    const { e, house } = await phone();
    const code = (await t.web.post('/api/v3/phones', { label: "Declan's iPhone" })).body.code as string;
    await house.join(code);
    const device = await e.device();
    expect((await t.web.req('PATCH', '/api/v3/phones/' + device, { json: { role: 'admin' } })).status).toBe(200);
    // It says its version with each request (X-Restock-App): an admin phone on 0.18.3 can say yes.
    const me = await house.sealed('GET', '/me');
    expect(me).toMatchObject({ role: 'admin', device });

    // A browser signs in with the passphrase: it waits for the phone.
    const web = t.web3();
    const l = await web.login('admin', H.PASS, H.ITER);
    expect(l.approve).toBeTruthy();
    const list = (await house.sealed('GET', '/approvals')).approvals as { id: string; number: string; what: string; words: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: l.approve.number, what: 'sign-in', words: 'sign in' });
    await house.sealed('POST', `/approvals/${list[0].id}`, { yes: true });
    expect((await web.signInStatus()).body.status).toBe('yes');
    expect(web.gift.keys).toBeTruthy();

    // Server settings from the phone.
    const s = await house.sealed('PUT', '/settings', { away: 'restock-server.plenty.family', sessionHours: 24 });
    expect(s).toMatchObject({ away: 'https://restock-server.plenty.family', sessionHours: 24 });
    await expect(house.sealed('PUT', '/settings', { away: 'http://restock-server.plenty.family' })).rejects.toThrow(/https/);

    // The recovery key: the passphrase, proved over this phone's id (as lib/serverAdmin.ts proveFor does).
    const ch = (await house.sealed('GET', '/confirm/challenge')) as { salt: string; c: string; user: string };
    expect(ch.user).toBe('admin');
    const keys = await derivePassphrase(H.PASS, unb64(ch.salt), H.ITER);
    const r = await house.sealed('POST', '/recovery', { confirm: { c: ch.c, proof: loginProof(loginKeyOf(keys.auth), ch.c, 'phone:' + device) } });
    expect(typeof r.recovery).toBe('string');
    // A wrong passphrase is refused.
    const ch2 = (await house.sealed('GET', '/confirm/challenge')) as { salt: string; c: string };
    const wrong = await derivePassphrase('not it at all, no', unb64(ch2.salt), H.ITER);
    await expect(house.sealed('POST', '/recovery', { confirm: { c: ch2.c, proof: loginProof(loginKeyOf(wrong.auth), ch2.c, 'phone:' + device) } })).rejects.toThrow(/current passphrase/);

    // The only admin phone can't be made a user, from the web page either.
    const only = await t.web.req('PATCH', '/api/v3/phones/' + device, { json: { role: 'user' } });
    expect(only.status).toBe(409);
  }, 60_000);
});
