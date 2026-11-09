// 0.9.2: a stand-in browser for the phones' server check (SyncServerTest.java, run by run.sh). It
// signs in to the real server (server/), makes Add a phone codes, link and QR sign-in codes, and
// opens what the phone sealed with the web app's own code (src/server-mode/crypto.ts), so the
// phone's sealing is checked against what the browser really does.
//
//   node tools/sync-test/server-web.mjs <command> <server address> <state file> [more]
// Prints JSON (or a code) on one line.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The server's own test client. The server has its own repo; run.sh passes where it is.
const serverDir = resolve(process.env.RESTOCK_SERVER_DIR || 'server');
const { Browser } = await import(pathToFileURL(resolve(serverDir, 'test/client.mjs')).href);
import { b64u, newEcdhKey, openGift, openWebKeys, sealRsf1, unb64 } from '../../src/server-mode/crypto.ts';

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
  default:
    fail('unknown command ' + cmd);
}
