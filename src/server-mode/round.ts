// Server mode: one sync round with the server, the way SyncFolder.sync does it on a phone: new keys
// first (webkeys/), then every device's file that changed, the phones' archives, then the web's own
// file (if anything changed). No browser APIs here, so the Node tests run it against a folder.

import { b64u, openRsf1, openWebKeys, openWithAny, sealRsf1, unb64 } from './crypto';
import { sha256 } from '@noble/hashes/sha2';
import { isSyncFile, webFileName, type SyncFileMessage, type WebSyncEngine } from './engine';

export interface Remote {
  files(): Promise<{ name: string; size: number; version?: string; modified?: string }[]>;
  read(name: string): Promise<Uint8Array | null>;
  /** `ifMatch`: the version this write is based on (a server that checks it answers 412 if it changed). */
  write(name: string, bytes: Uint8Array, ifMatch?: string): Promise<{ version?: string } | unknown>;
}

export interface Keys {
  webId: string;
  webPriv: string;
  webPub: string;
  keys: Record<string, string>;
}

export interface RoundResult {
  received: number;
  phones: number;
  unread: number;
  archived: number;
  wrote: boolean;
  newKeys: boolean;
  /** When a phone's file was last written, newest first (for "Synced with your phones …"). */
  lastPhone?: string;
}

const ARCHIVE = /^archive\/[A-Za-z0-9_-]+\/\d{4}-\d{2}\.bin$/;

export async function syncRound(e: WebSyncEngine, remote: Remote, k: Keys, now = () => new Date().toISOString()): Promise<RoundResult> {
  const res: RoundResult = { received: 0, phones: 0, unread: 0, archived: 0, wrote: false, newKeys: false };
  const list = await remote.files();
  const names = list.map((f) => f.name);
  const version = (n: string) => {
    const f = list.find((x) => x.name === n);
    return f?.version ?? (f ? `${f.size}/${f.modified ?? ''}` : null);
  };
  const own = webFileName(k.webId);

  // A newer household key, sealed to this browser by a phone (after a phone was removed). Anyone
  // can seal a webkeys/ file to the web's public key (it's no secret), so what's in it is only a
  // candidate: a key version this browser already has is never replaced, and a new one is taken
  // only once it opens a phone's file that vouches for it (WebSyncEngine.vouches). Until then the
  // file is read again every round.
  const wk = `webkeys/${k.webId}.bin`;
  const candidates = new Map<string, string>();
  if (names.includes(wk) && e.fresh(wk, version(wk)) && k.webPriv) {
    const bytes = await remote.read(wk);
    if (bytes) {
      try {
        const got = openWebKeys(unb64(k.webPriv), bytes);
        for (const [v, key] of Object.entries(got)) if (k.keys[v] === undefined) candidates.set(v, key);
        if (!candidates.size) e.noteVersion(wk, version(wk));
      } catch {
        // not for this browser's key (an old one): leave it
      }
    }
  }
  /** A file none of the keys open: does a candidate open it, and does the file vouch for it? */
  const tryCandidates = (bytes: Uint8Array): SyncFileMessage | undefined => {
    for (const [v, key] of candidates) {
      let m: SyncFileMessage;
      try {
        m = openRsf1<SyncFileMessage>(unb64(key), bytes);
      } catch {
        continue;
      }
      if (!e.vouches(m)) continue;
      k.keys[v] = key;
      candidates.delete(v);
      res.newKeys = true;
      if (!candidates.size) e.noteVersion(wk, version(wk));
      return m;
    }
    return undefined;
  };

  const at = now();
  const readAll = async () => {
    res.unread = 0;
    for (const f of list) {
      const name = f.name;
      if (!isSyncFile(name) || name === own) continue;
      const ver = version(name);
      if (!e.fresh(name, ver)) continue;
      const bytes = await remote.read(name);
      if (!bytes) continue;
      const sum = b64u(sha256(bytes));
      if (sum === e.seenSum(name)) {
        e.noteVersion(name, ver);
        continue;
      }
      let m: SyncFileMessage;
      try {
        m = openWithAny<SyncFileMessage>(k.keys, bytes).msg;
      } catch {
        const got = candidates.size ? tryCandidates(bytes) : undefined;
        if (!got) {
          res.unread++;
          continue;
        }
        m = got;
      }
      e.noteVersion(name, ver);
      notePhotos(e, m.photos);
      const n = e.takeFile(name, sum, m, at);
      if (n < 0) continue;
      res.received += n;
      res.phones++;
      if (f.modified && (!res.lastPhone || f.modified > res.lastPhone)) res.lastPhone = f.modified;
    }
  };
  e.noteTabs();
  await readAll();
  if (e.noteTabs()) await readAll();

  // Prices and receipts the phones moved off themselves.
  for (const name of names) {
    if (!ARCHIVE.test(name)) continue;
    const ver = version(name);
    const vk = 'archive:' + name;
    if (ver !== null && e.meta('folder_ver:' + vk) === ver) continue;
    const bytes = await remote.read(name);
    if (!bytes) continue;
    try {
      const m = openWithAny<{ prices?: Record<string, unknown>[]; receipts?: Record<string, unknown>[]; photos?: Record<string, string> }>(k.keys, bytes).msg;
      notePhotos(e, m.photos);
      res.archived += e.takeArchive(m);
      e.noteVersion(vk, ver);
    } catch {
      res.unread++;
    }
  }

  // The web's own file. Every browser signed in to this server (a passphrase one, one signed in
  // with a phone) writes the same name: take in what another wrote first, so none loses another's
  // changes, and check just before writing that nobody wrote it meanwhile (If-Match too, for a
  // server that checks it). Three tries, then the next round.
  let listed = list;
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = listed.find((x) => x.name === own);
    const ownVer = f ? (f.version ?? `${f.size}/${f.modified ?? ''}`) : null;
    // Written last round, but the server didn't say which version that made: this is it.
    if (e.meta('own_ver') === 'pending') e.setMeta('own_ver', ownVer);
    if (f && ownVer !== e.meta('own_ver')) {
      const bytes = await remote.read(own);
      if (bytes) {
        try {
          const m = openWithAny<SyncFileMessage & { webPub?: unknown }>(k.keys, bytes).msg;
          // The web key the passphrase browser named in it (sealed, so the server can't change it).
          if (typeof m.webPub === 'string' && m.webPub) e.setMeta('own_webpub', m.webPub);
          const n = e.apply(m.entries);
          if (n > 0) e.tidyCategories();
          res.received += n;
        } catch {
          // sealed with a key this browser doesn't have: it's overwritten below
        }
      }
    }
    const keyv = Math.max(...Object.keys(k.keys).map(Number).filter(Number.isFinite));
    if (!Number.isFinite(keyv) || keyv <= 0) break;
    const out = e.ownFile(keyv, at, !!f && ownVer === e.meta('own_ver'));
    if (!out) break;
    // Phones only seal new keys to a webPub found inside a web's own sealed file (docs, Changes).
    // So only a browser that has the key pair names one: a browser signed in with a phone only
    // knows the webPub the server told it, and passes on the one already in the file instead.
    const webPub = k.webPriv ? k.webPub : e.meta('own_webpub');
    const sealed = sealRsf1(unb64(k.keys[String(keyv)]), { ...out.msg, ...(webPub ? { webPub } : {}) });
    if (attempt > 0 || f) {
      const now2 = await remote.files();
      const g = now2.find((x) => x.name === own);
      const v2 = g ? (g.version ?? `${g.size}/${g.modified ?? ''}`) : null;
      if (v2 !== ownVer) {
        listed = now2;
        continue;
      }
    }
    let answer: { version?: string } | undefined;
    try {
      answer = (await remote.write(own, sealed, ownVer ?? undefined)) as { version?: string } | undefined;
    } catch (err) {
      if ((err as { status?: number }).status === 412) {
        listed = await remote.files();
        continue;
      }
      throw err;
    }
    e.wroteOwn(out.mark);
    e.setMeta('own_ver', answer && typeof answer === 'object' && typeof answer.version === 'string' ? answer.version : 'pending');
    res.wrote = true;
    break;
  }
  if (res.phones > 0) e.setMeta('folder_at', at);
  e.setMeta('folder_unread', res.unread > 0 ? String(res.unread) : null);
  return res;
}

/** Remembers where a receipt photo is on the server (path → sha256), from a file's `photos` map. */
function notePhotos(e: WebSyncEngine, photos: Record<string, string> | undefined): void {
  if (!photos || typeof photos !== 'object') return;
  for (const [path, sum] of Object.entries(photos))
    if (/^receipts\/[A-Za-z0-9_-]{1,80}\.jpg$/.test(path) && typeof sum === 'string' && /^[0-9a-f]{64}$/.test(sum)) e.setMeta('photo:' + path, sum);
}
