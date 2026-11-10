// 0.9.2: a stand-in browser for the phones' server check (SyncServerTest.java, run by run.sh). It
// signs in to the real server (server/), makes Add a phone codes, link and QR sign-in codes, and
// opens what the phone sealed with the web app's own code (src/server-mode/crypto.ts), so the
// phone's sealing is checked against what the browser really does.
//
//   node tools/sync-test/server-web.mjs <command> <server address> <state file> [more]
// Prints JSON (or a code) on one line.
//
// 0.9.4 (P5): a house (protocol v3), signed in as the web app signs in (src/server-mode/session.ts,
// api.ts: the challenge, the session key, RestockWeb3 MACs, sealed answers):
//   setup3 <base> <state> [house name]   first start (admin/admin → the passphrase, as the setup page
//                                        does), then sign in and Set up this server
//   login3 <base> <state>                sign in again (a new session)
//   addphone3 <base> <state> <label>     an Add a phone code (restock-server:3?…)
//   phones3 | browsers3 | settings3 | session3 | activity3 | logs3 <base> <state>
//   rename3 <base> <state> <device> <label> · remove3 <base> <state> <device>
//   keep3 <base> <state> <3|6|9|12|null> · handover3 <base> <state> (v2 mode: the handover code)
//   GET3 <base> <state> <path>           any GET, its answer opened
// The passphrase rounds are RESTOCK_TEST_ROUNDS (default 600000, as the web app; the setup step and
// sign-in must use the same).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The server's own test client. The server has its own repo; run.sh passes where it is.
const serverDir = resolve(process.env.RESTOCK_SERVER_DIR || 'server');
const { Browser } = await import(pathToFileURL(resolve(serverDir, 'test/client.mjs')).href);
import {
  b64u,
  derivePassphrase,
  loginKeyOf,
  loginProof,
  newEcdhKey,
  openGift,
  openRsf1,
  openWebKeys,
  sealRsf1,
  sessionKeyOf,
  unb64,
  webAuthorization,
} from '../../src/server-mode/crypto.ts';

const PASSPHRASE = process.env.RESTOCK_TEST_PASSPHRASE || 'kettle orbit lemon fence carpet';
const ROUNDS = Number(process.env.RESTOCK_TEST_ROUNDS || 600000);
const SEALED = 'application/x-restock-sealed';

/** One v3 request as the web app sends it: MACed with the session key; JSON or sealed body; the answer opened. */
async function call3(st, method, path, body, { seal = false } = {}) {
  const key = unb64(st.sessionKey);
  const bytes = body === undefined ? null : seal ? sealRsf1(key, body) : new TextEncoder().encode(JSON.stringify(body));
  const headers = { Authorization: webAuthorization(st.sid, key, method, path, bytes) };
  if (bytes) headers['Content-Type'] = seal ? SEALED : 'application/json';
  const r = await fetch(base.replace(/\/+$/, '') + path, { method, headers, body: bytes ?? undefined });
  const type = r.headers.get('content-type') || '';
  const buf = new Uint8Array(await r.arrayBuffer());
  let out;
  if (type.startsWith(SEALED)) out = openRsf1(key, buf);
  else {
    try {
      out = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      out = { bytes: buf.length };
    }
  }
  return { status: r.status, body: out };
}

/** 0.9.4: the passphrase again for a dangerous admin action, as session.ts confirmPassphrase does. */
async function confirm3(st) {
  const r = await fetch(base.replace(/\/+$/, '') + '/api/v3/login/challenge?user=admin');
  const ch = await r.json();
  return { c: ch.c, proof: loginProof(unb64(st.loginKey), ch.c, st.sid) };
}

/** Signs in to a house, as session.ts loginV3 does. */
async function login3(st) {
  const j = async (path, init) => {
    const r = await fetch(base.replace(/\/+$/, '') + path, init);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const ch = await j('/api/v3/login/challenge?user=admin');
  if (ch.status !== 200) fail('challenge: ' + JSON.stringify(ch.body));
  const keys = await derivePassphrase(PASSPHRASE, unb64(ch.body.salt), ROUNDS);
  const loginKey = loginKeyOf(keys.auth);
  const e = newEcdhKey();
  const epub = b64u(e.pub);
  const r = await j('/api/v3/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', c: ch.body.c, epub, proof: loginProof(loginKey, ch.body.c, epub) }),
  });
  if (r.status !== 200) fail('login3: ' + JSON.stringify(r.body));
  const sk = sessionKeyOf(e.priv, unb64(ch.body.kex), unb64(ch.body.c), loginKey);
  st.sid = r.body.session;
  st.sessionKey = b64u(sk);
  st.loginKey = b64u(loginKey);
  st.gift = openRsf1(sk, unb64(r.body.sealed));
  return st.gift;
}


const [cmd, base, stateFile, ...rest] = process.argv.slice(2);

function load() {
  const s = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const b = new Browser(base);
  for (const [k, v] of s.jar ?? []) b.jar.set(k, v);
  return { s, b };
}
function save(s, b) {
  s.jar = [...b.jar];
  writeFileSync(stateFile, JSON.stringify(s));
}
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v));
const fail = (m) => {
  console.error(m);
  process.exit(1);
};
const newWebId = () => b64u(crypto.getRandomValues(new Uint8Array(12)));

const { s, b } = load();
switch (cmd) {
  case 'setup': {
    // First start: admin / admin, then a passphrase (quick rounds: the server never sees them) and the web's key.
    const k = newEcdhKey();
    s.webId = newWebId();
    s.webPriv = b64u(k.priv);
    s.webPub = b64u(k.pub);
    await b.setup({ passphrase: 'kettle orbit lemon fence carpet', iterations: 1000, webId: s.webId, webPub: s.webPub });
    save(s, b);
    out({ webId: s.webId });
    break;
  }
  case 'invite': {
    const r = await b.post('/api/v2/invites', {});
    if (r.status !== 200) fail('invite: ' + JSON.stringify(r.body));
    out(r.body.code);
    break;
  }
  case 'link': {
    const r = await b.post('/api/v2/link', {});
    if (r.status !== 200) fail('link: ' + JSON.stringify(r.body));
    out(`restock-link:2?u=${encodeURIComponent(rest[0] ?? base)}&s=${r.body.id}&k=${s.webPub}`);
    break;
  }
  case 'linkget': {
    const r = await b.get('/api/v2/link/' + rest[0]);
    if (r.body.status !== 'done') out({ status: r.status, body: r.body });
    else out({ status: 'done', gift: openGift(unb64(s.webPriv), r.body) });
    break;
  }
  case 'qrlogin': {
    // A browser that isn't signed in: its own state file, a fresh ECDH key just for this.
    const k = newEcdhKey();
    const r = await b.post('/api/v2/qrlogin', {});
    if (r.status !== 200) fail('qrlogin: ' + JSON.stringify(r.body));
    s.qrPriv = b64u(k.priv);
    save(s, b);
    out(`restock-login:2?u=${encodeURIComponent(base)}&s=${r.body.id}&k=${b64u(k.pub)}`);
    break;
  }
  case 'qrget': {
    const r = await b.get('/api/v2/qrlogin/' + rest[0]);
    if (r.body.status !== 'done') {
      out({ status: r.status, body: r.body });
      break;
    }
    const gift = openGift(unb64(s.qrPriv), r.body);
    save(s, b);
    const files = await b.get('/api/v2/files');
    out({ status: 'done', gift, files: files.status });
    break;
  }
  case 'webkeys': {
    const r = await b.raw('GET', '/api/v2/files/webkeys/' + (rest[0] ?? s.webId) + '.bin');
    if (r.status !== 200) {
      out({ status: r.status });
      break;
    }
    out({ status: 200, keys: openWebKeys(unb64(s.webPriv), new Uint8Array(await r.arrayBuffer())) });
    break;
  }
  case 'newweb': {
    // The browser makes itself a new key (as after Sign out everywhere): the phones haven't seen proof of it yet.
    const k = newEcdhKey();
    const id = newWebId();
    const r = await b.put('/api/v2/web', { webId: id, webPub: b64u(k.pub) });
    if (r.status !== 200) fail('newweb: ' + JSON.stringify(r.body));
    Object.assign(s, { webId: id, webPriv: b64u(k.priv), webPub: b64u(k.pub) });
    save(s, b);
    out({ webId: id });
    break;
  }
  case 'webfile': {
    // The web's own sync file, sealed with a serverKey: names its webPub, and carries `entries`
    // (and, for the review checks, the device it claims to be).
    const [keyB64, entries = '[]', device] = rest;
    const file = sealRsf1(unb64(keyB64), {
      format: 'restock-sync',
      v: 1,
      device: device || 'web-' + s.webId,
      name: 'Restock on the web',
      keyv: 1,
      at: new Date().toISOString(),
      top: 0,
      seen: {},
      entries: JSON.parse(entries),
      webPub: s.webPub,
    });
    const r = await b.raw('PUT', '/api/v2/files/restock-sync-web-' + s.webId + '.bin', { body: file });
    out({ status: r.status });
    break;
  }
  case 'setup3': {
    // The setup page's step (v2's first-start login and passphrase), then the web app's: sign in, Set up this server.
    await b.setup({ passphrase: PASSPHRASE, iterations: ROUNDS });
    save(s, b);
    await login3(s);
    const r = await call3(s, 'POST', '/api/v3/setup', { name: rest[0] || 'Declan and Sarah' });
    if (r.status !== 200) fail('setup3: ' + JSON.stringify(r.body));
    s.gift = r.body;
    save(s, b);
    out({ webId: r.body.webId, keyv: r.body.keyv, keys: r.body.keys, household: r.body.household });
    break;
  }
  case 'login3': {
    const g = await login3(s);
    save(s, b);
    out({ webId: g.webId, keyv: g.keyv, keys: g.keys, household: g.household, mode: g.mode });
    break;
  }
  case 'addphone3': {
    const r = await call3(s, 'POST', '/api/v3/phones', { label: rest[0] || 'Phone' });
    if (r.status !== 200) fail('addphone3: ' + JSON.stringify(r.body));
    out(r.body.code);
    break;
  }
  case 'phones3':
  case 'browsers3':
  case 'settings3':
  case 'session3':
  case 'activity3':
  case 'logs3': {
    const r = await call3(s, 'GET', '/api/v3/' + cmd.slice(0, -1));
    out(r);
    break;
  }
  case 'rename3': {
    out(await call3(s, 'PATCH', '/api/v3/phones/' + encodeURIComponent(rest[0]), { label: rest[1] }));
    break;
  }
  case 'remove3': {
    out(await call3(s, 'DELETE', '/api/v3/phones/' + encodeURIComponent(rest[0]), { confirm: await confirm3(s) }));
    break;
  }
  case 'keep3': {
    out(await call3(s, 'PUT', '/api/v3/settings', { keepMonths: rest[0] === 'null' ? null : Number(rest[0]), confirm: await confirm3(s) }));
    break;
  }
  case 'handover3': {
    // v2 mode: the passphrase browser's cookie session asks for the code.
    const r = await b.post('/api/v3/handover', {});
    if (r.status !== 200) fail('handover3: ' + JSON.stringify(r.body));
    out(r.body.code);
    break;
  }
  case 'GET3': {
    out(await call3(s, 'GET', rest[0]));
    break;
  }
  default:
    fail('unknown command ' + cmd);
}
