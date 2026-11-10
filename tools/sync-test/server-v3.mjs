// 0.9.4: the server's web page as SyncServerV3Test needs it (protocol v3, docs/server-v3-design.md),
// with the server repo's own test clients (RESTOCK_SERVER_DIR/test/client.mjs): set the server up as a
// house, make Add a phone codes, remove a phone, list the phones, change Keep data for, and (a server
// still in v2 mode) make the Take this household code. One line of output per command.
//
//   node tools/sync-test/server-v3.mjs <command> <server url> <state file> [args...]
//
// Commands: setup <house name> | setup2 | invite <label> | invite2 | handover | remove <device> |
// phones | keep <months|null> | health | resend | history <product id>

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [cmd, url, stateFile, ...args] = process.argv.slice(2);
const dir = resolve(process.env.RESTOCK_SERVER_DIR || 'server');
const { Browser, V3Browser } = await import(pathToFileURL(join(dir, 'test/client.mjs')).href);

const PASS = 'kettle orbit lemon fence';
const ITER = 1000;
const state = (() => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
})();
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const fail = (what, r) => {
  console.error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  process.exit(1);
};

async function web3() {
  // A v2 sign-in first: a server updated from 0.9.3 learns the v3 login key from it.
  if (state.v2) {
    const b = new Browser(url);
    const l = await b.login('admin', PASS, ITER);
    if (l.status !== 200) fail('v2 sign-in', l);
  }
  const w = new V3Browser(url);
  const l = await w.login('admin', PASS, ITER);
  if (l.status !== 200) fail('sign-in', l);
  return w;
}

switch (cmd) {
  case 'setup': {
    const b = new Browser(url);
    await b.setup({ passphrase: PASS, iterations: ITER });
    save();
    const w = await web3();
    const r = await w.post('/api/v3/setup', { name: args[0] || 'Declan and Sarah' });
    if (r.status !== 200) fail('setup', r);
    console.log(JSON.stringify({ ok: true, name: r.body?.name ?? args[0] }));
    break;
  }
  case 'setup2': {
    const b = new Browser(url);
    await b.setup({ passphrase: PASS, iterations: ITER });
    state.v2 = true;
    save();
    console.log('{"ok":true}');
    break;
  }
  case 'invite': {
    const w = await web3();
    const r = await w.post('/api/v3/phones', { label: args[0] || 'Phone' });
    if (r.status !== 200) fail('invite', r);
    console.log(r.body.code);
    break;
  }
  case 'invite2': {
    const b = new Browser(url);
    const l = await b.login('admin', PASS, ITER);
    if (l.status !== 200) fail('v2 sign-in', l);
    const r = await b.post('/api/v2/invites');
    if (r.status !== 200) fail('invite', r);
    console.log(r.body.code);
    break;
  }
  case 'handover': {
    const w = await web3();
    const r = await w.post('/api/v3/handover', {});
    if (r.status !== 200) fail('handover', r);
    console.log(r.body.code);
    break;
  }
  case 'remove': {
    const w = await web3();
    const r = await w.removePhone(args[0]);
    if (r.status !== 200) fail('remove', r);
    console.log('{"ok":true}');
    break;
  }
  case 'phones': {
    const w = await web3();
    const r = await w.get('/api/v3/phones');
    if (r.status !== 200) fail('phones', r);
    console.log(JSON.stringify(r.body));
    break;
  }
  case 'keep': {
    const w = await web3();
    const now = await w.get('/api/v3/settings');
    const keepMonths = args[0] === 'null' ? null : Number(args[0]);
    // Keeping less needs the passphrase again and (0.9.5) the typed DELETE (sent always: only checked when it matters).
    const { autoDelete: _a, ...was } = now.body && typeof now.body === 'object' ? now.body : {};
    const r = await w.put('/api/v3/settings', { ...was, keepMonths, typed: 'DELETE', confirm: await w.confirm() });
    if (r.status !== 200) fail('settings', r);
    console.log(JSON.stringify(r.body));
    break;
  }
  case 'resend': {
    // 0.9.5: Ask phones to resend (Data page). Prints the status and the answer.
    const w = await web3();
    const r = await w.post('/api/v3/data/resend');
    console.log(JSON.stringify({ status: r.status, ...(r.body && typeof r.body === 'object' ? r.body : {}) }));
    break;
  }
  case 'history': {
    const w = await web3();
    const r = await w.get('/api/v3/history?product=' + encodeURIComponent(args[0] ?? ''));
    if (r.status !== 200) fail('history', r);
    console.log(JSON.stringify(r.body));
    break;
  }
  case 'health': {
    console.log(JSON.stringify(await (await fetch(url + '/api/v3/health')).json()));
    break;
  }
  default:
    console.error('unknown command ' + cmd);
    process.exit(2);
}
