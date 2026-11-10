// Server mode (0.9.2): the browser's side of the Restock server's end-to-end sealing
// (docs/server-protocol.md). Everything here is pure JavaScript (noble + fflate), because a page
// served over plain http on the home network isn't a "secure context" and gets no WebCrypto.
//
// - RSF1: the folder-sync file (SyncFolder.java): "RSF1" + 12-byte nonce + AES-256-GCM(gzip(JSON)),
//   with "RSF1" as the GCM associated data.
// - serverKey = HMAC-SHA256(householdKey, "restock-server-files-v1"): the phones seal every server
//   file with it; the web only ever has serverKeys, never the household key.
// - The link (and Sign in with a phone, and webkeys/): the phone works out an ECDH P-256 secret
//   with the browser's public key, HKDF-SHA256 (info "restock-link-v2") gives the AES-256-GCM key.
// - RSV2: the browser's vault, locked with the passphrase's vaultKey.
// - Household rows are signed by the owner phone (ECDSA P-256, SHA-256, DER), SyncHousehold.java.

import { gcm } from '@noble/ciphers/aes';
import { p256 } from '@noble/curves/nist';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

export const RSF1 = strToU8('RSF1');
export const RSV2 = strToU8('RSV2');
export const RSE2 = strToU8('RSE2');
export const LINK_INFO = 'restock-link-v2';
export const SERVER_KEY_INFO = 'restock-server-files-v1';
/** The passphrase's PBKDF2 rounds (docs/server-protocol.md). */
export const PBKDF2_ROUNDS = 600_000;

// ---------- bytes ----------

/** base64url without padding (what Restock writes); reading also takes plain base64. */
export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(s: string): Uint8Array {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(t)) throw new Error('not base64');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function startsWith(b: Uint8Array, magic: Uint8Array): boolean {
  if (b.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (b[i] !== magic[i]) return false;
  return true;
}

// ---------- RSF1 sealed files ----------

/** Opens a sealed sync file; throws if it isn't one or wasn't sealed with this key. */
export function openRsf1<T = Record<string, unknown>>(key: Uint8Array, bytes: Uint8Array): T {
  if (bytes.length < 4 + 12 + 16 || !startsWith(bytes, RSF1)) throw new Error('not a sync file');
  const plain = gcm(key, bytes.subarray(4, 16), RSF1).decrypt(bytes.subarray(16));
  return JSON.parse(strFromU8(gunzipSync(plain))) as T;
}

/** Seals a message the way SyncFolder.seal does. */
export function sealRsf1(key: Uint8Array, message: unknown): Uint8Array {
  const nonce = random(12);
  const body = gcm(key, nonce, RSF1).encrypt(gzipSync(strToU8(JSON.stringify(message))));
  return concat(RSF1, nonce, body);
}

/** Opens a file with whichever of the vault's server keys fits, newest first. */
export function openWithAny<T = Record<string, unknown>>(keys: Record<string, string>, bytes: Uint8Array): { keyv: number; msg: T } {
  const versions = Object.keys(keys)
    .map(Number)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => b - a);
  for (const v of versions) {
    try {
      return { keyv: v, msg: openRsf1<T>(unb64(keys[String(v)]), bytes) };
    } catch {
      // another key version
    }
  }
  throw new Error('none of this browser’s keys open it');
}

/** serverKey = HMAC-SHA256(householdKey, "restock-server-files-v1"). (The web never has the household key; tests do.) */
export function serverKeyOf(householdKey: Uint8Array): Uint8Array {
  return hmac(sha256, householdKey, strToU8(SERVER_KEY_INFO));
}

// ---------- the passphrase ----------

/**
 * PBKDF2-HMAC-SHA256(NFKC(passphrase), salt, 600000, 64 bytes): authKey (0–31, sent to the server)
 * and vaultKey (32–63, never leaves the browser). In a worker, so the page stays responsive.
 */
export async function derivePassphrase(passphrase: string, salt: Uint8Array, rounds = PBKDF2_ROUNDS): Promise<{ auth: Uint8Array; vault: Uint8Array }> {
  const bytes = await pbkdf2(strToU8(passphrase.normalize('NFKC')), salt, rounds);
  return { auth: bytes.slice(0, 32), vault: bytes.slice(32, 64) };
}

async function pbkdf2(pw: Uint8Array, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && globalThis.isSecureContext !== false) {
    try {
      const k = await subtle.importKey('raw', pw as BufferSource, 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: rounds }, k, 512));
    } catch {
      // fall through to the pure-JavaScript one
    }
  }
  if (typeof Worker !== 'undefined' && typeof window !== 'undefined') {
    try {
      return await inWorker(pw, salt, rounds);
    } catch {
      // no worker: below, on the page
    }
  }
  return pbkdf2Async(sha256, pw, salt, { c: rounds, dkLen: 64, asyncTick: 20 });
}

function inWorker(pw: Uint8Array, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./pbkdf2.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ out?: Uint8Array; error?: string }>) => {
      w.terminate();
      if (e.data.out) resolve(e.data.out);
      else reject(new Error(e.data.error ?? 'pbkdf2 failed'));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'worker failed'));
    };
    w.postMessage({ pw, salt, rounds });
  });
}

// ---------- the vault (RSV2) ----------

export interface Vault {
  webId: string;
  /** The web's ECDH P-256 private key (32 bytes, base64url). */
  webPriv: string;
  /** keyv → serverKey (base64url). */
  keys: Record<string, string>;
  /** The household's owner signing key (SPKI, base64url), from the link: pins household signatures. */
  ownerPub?: string;
  household?: string;
}

export function sealVault(vaultKey: Uint8Array, v: Vault): Uint8Array {
  const nonce = random(12);
  return concat(RSV2, nonce, gcm(vaultKey, nonce, RSV2).encrypt(strToU8(JSON.stringify(v))));
}

export function openVault(vaultKey: Uint8Array, bytes: Uint8Array): Vault {
  if (!startsWith(bytes, RSV2) || bytes.length < 4 + 12 + 16) throw new Error('not a vault');
  const v = JSON.parse(strFromU8(gcm(vaultKey, bytes.subarray(4, 16), RSV2).decrypt(bytes.subarray(16)))) as Vault;
  if (typeof v.webId !== 'string' || typeof v.webPriv !== 'string' || typeof v.keys !== 'object' || !v.keys) throw new Error('not a vault');
  return v;
}

// ---------- P-256 keys ----------

/** The DER start of a P-256 SubjectPublicKeyInfo (what Java's getEncoded() gives), before the 65-byte point. */
const SPKI_P256 = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

export function spkiOf(point: Uint8Array): Uint8Array {
  const raw = point.length === 65 ? point : p256.ProjectivePoint.fromHex(point).toRawBytes(false);
  return concat(SPKI_P256, raw);
}

/** A public key as SPKI (Java), or a raw point (33 or 65 bytes): the raw uncompressed point. */
export function pointOf(pub: Uint8Array): Uint8Array {
  if (pub.length === SPKI_P256.length + 65 && startsWith(pub, SPKI_P256)) return pub.slice(SPKI_P256.length);
  if (pub.length === 65 || pub.length === 33) return pub;
  throw new Error('not a P-256 public key');
}

export function newEcdhKey(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = p256.utils.randomPrivateKey();
  return { priv, pub: spkiOf(p256.getPublicKey(priv, false)) };
}

export function publicOf(priv: Uint8Array): Uint8Array {
  return spkiOf(p256.getPublicKey(priv, false));
}

/** The link's AES key: HKDF-SHA256(ECDH x-coordinate, no salt, "restock-link-v2", 32 bytes). */
export function linkKey(priv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  const shared = p256.getSharedSecret(priv, pointOf(theirPub), true).slice(1);
  return hkdf(sha256, shared, undefined, strToU8(LINK_INFO), 32);
}

/** nonce (12) + AES-256-GCM(key, JSON). What the phone posts as `sealed` for a link or a QR sign-in. */
export function sealLink(key: Uint8Array, message: unknown): Uint8Array {
  const nonce = random(12);
  return concat(nonce, gcm(key, nonce).encrypt(strToU8(JSON.stringify(message))));
}

export function openLink<T = Record<string, unknown>>(key: Uint8Array, sealed: Uint8Array): T {
  if (sealed.length < 12 + 16) throw new Error('too short');
  return JSON.parse(strFromU8(gcm(key, sealed.subarray(0, 12)).decrypt(sealed.subarray(12)))) as T;
}

/** What a phone hands the web in a link or a QR sign-in (docs/server-protocol.md). */
export interface LinkGift {
  keys: Record<string, string>;
  household?: string | { name?: string; owner_pub?: string; ownerPub?: string };
  owner_pub?: string;
}

/** Opens a phone's `{ pub, sealed }` answer with the browser's link private key. */
export function openGift(priv: Uint8Array, answer: { pub: string; sealed: string }): LinkGift {
  const gift = openLink<LinkGift>(linkKey(priv, unb64(answer.pub)), unb64(answer.sealed));
  if (!gift || typeof gift.keys !== 'object') throw new Error('no keys in it');
  for (const [v, k] of Object.entries(gift.keys)) if (!/^\d+$/.test(v) || unb64(k).length !== 32) throw new Error('odd key');
  return gift;
}

/** For tests (and the stand-in phone): seals a gift for a browser's public key. */
export function sealGift(browserPub: Uint8Array, gift: LinkGift): { pub: string; sealed: string } {
  const eph = newEcdhKey();
  return { pub: b64u(eph.pub), sealed: b64u(sealLink(linkKey(eph.priv, browserPub), gift)) };
}

/**
 * webkeys/<webId>.bin: "RSE2" + the phone's one-off public key (SPKI, 91 bytes) + nonce (12) +
 * AES-256-GCM(link key, JSON { keys: {keyv: serverKey} } or { keyv, key }).
 */
export function openWebKeys(webPriv: Uint8Array, bytes: Uint8Array): Record<string, string> {
  const n = SPKI_P256.length + 65;
  if (!startsWith(bytes, RSE2) || bytes.length < 4 + n + 12 + 16) throw new Error('not a webkeys file');
  const pub = bytes.subarray(4, 4 + n);
  const m = openLink<{ keys?: Record<string, string>; keyv?: number | string; key?: string }>(linkKey(webPriv, pub), bytes.subarray(4 + n));
  const out: Record<string, string> = { ...(m.keys ?? {}) };
  if (m.key && m.keyv !== undefined) out[String(m.keyv)] = m.key;
  for (const [v, k] of Object.entries(out)) if (!/^\d+$/.test(v) || unb64(k).length !== 32) throw new Error('odd key');
  return out;
}

export function sealWebKeys(webPub: Uint8Array, keys: Record<string, string>): Uint8Array {
  const eph = newEcdhKey();
  return concat(RSE2, eph.pub, sealLink(linkKey(eph.priv, webPub), { keys }));
}

// ---------- household signatures ----------

/** What a household change's signature covers (SyncHousehold.signed). */
export function signedText(entry: { pk: string; stamp: number; deleted?: boolean | string; row?: Record<string, unknown> | null }): string {
  const deleted = entry.deleted === true || entry.deleted === 'true';
  const v = deleted || !entry.row ? '-' : 'v=' + (entry.row.v === null || entry.row.v === undefined ? '' : String(entry.row.v));
  return `restock-hh1|${entry.pk}|${v}|${Math.trunc(Number(entry.stamp))}`;
}

/** SHA256withECDSA (DER) over the text, with a P-256 SPKI public key (both base64url, as Java writes them). */
export function verifySig(pub: string, text: string, sig: string): boolean {
  try {
    return p256.verify(unb64(sig), sha256(strToU8(text)), pointOf(unb64(pub)), { prehash: false, lowS: false, format: 'der' });
  } catch {
    return false;
  }
}

/** For tests: signs like Java's SHA256withECDSA. */
export function signText(priv: Uint8Array, text: string): string {
  return b64u(p256.sign(sha256(strToU8(text)), priv, { prehash: false, lowS: false }).toDERRawBytes());
}

export const sha256hex = (b: Uint8Array) => hex(sha256(b));

// ====================================================================================================
// 0.9.4, protocol v3 (docs/server-protocol.md "v3"): the server is the household's owner. Shared by
// the web app, the server (through the core build, src/server-core) and, ported, the phones (Java).
// Test vectors: tools/sync-test/vectors-v3.json (made with Node's own crypto, checked here).
//
// Conventions, everywhere below:
// - ECDH is P-256; its secret is the shared point's x-coordinate (32 bytes), as Java's KeyAgreement.
// - HKDF is HKDF-SHA256, 32 bytes out. "No salt" is RFC 5869's default (32 zero bytes).
// - A salt taken from a value sent as base64url (n, c, an invite, a token, an id) is its decoded bytes.
// - AES-256-GCM with a 12-byte random nonce and a 16-byte tag; `aad` is the associated data, as UTF-8.
// - Every key, nonce and blob in JSON or a QR code is base64url without padding.
// ====================================================================================================

export const RSJ3 = 'RSJ3';
export const RSE3 = 'RSE3';
export const RSH3 = 'RSH3';
export const RSA3 = 'RSA3';
export const JOIN_INFO = 'restock-join-v3';
export const KEYS_INFO = 'restock-keys-v3';
export const HANDOVER_INFO = 'restock-handover-v3';
export const HA_INFO = 'restock-ha-v3';
export const LOGIN_INFO = 'restock-login-v3';
export const SESSION_INFO = 'restock-session-v3';
export const MEMBER_JOIN = 'restock-member-v3';

/** The ECDH secret with a P-256 public key (SPKI or raw point): the shared x-coordinate, 32 bytes. */
export function ecdh(priv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return p256.getSharedSecret(priv, pointOf(theirPub), true).slice(1);
}

/** HKDF-SHA256, 32 bytes. `salt` undefined: no salt. */
export function hkdf32(ikm: Uint8Array, salt: Uint8Array | undefined, info: string): Uint8Array {
  return hkdf(sha256, ikm, salt, strToU8(info), 32);
}

/** nonce (12) + AES-256-GCM(key, aad, JSON). `nonce`: for test vectors only. */
export function sealJson(key: Uint8Array, aad: string, message: unknown, nonce: Uint8Array = random(12)): Uint8Array {
  return concat(nonce, gcm(key, nonce, strToU8(aad)).encrypt(strToU8(typeof message === 'string' ? message : JSON.stringify(message))));
}

/** Opens sealJson's bytes; throws if the key or the associated data is wrong. */
export function openJson<T = Record<string, unknown>>(key: Uint8Array, aad: string, sealed: Uint8Array): T {
  if (sealed.length < 12 + 16) throw new Error('too short');
  return JSON.parse(strFromU8(gcm(key, sealed.subarray(0, 12), strToU8(aad)).decrypt(sealed.subarray(12)))) as T;
}

// ---------- joining (RSJ3) ----------

/** key = HKDF(ECDH(server kex, phone kex), salt n, "restock-join-v3"). Either side's private key with the other's public. */
export function joinKey(priv: Uint8Array, theirPub: Uint8Array, n: Uint8Array): Uint8Array {
  return hkdf32(ecdh(priv, theirPub), n, JOIN_INFO);
}

/** What a join (or upgrade) answer's `sealed` opens to (docs/server-protocol.md "v3"). */
export interface JoinGift {
  format: 'restock-join';
  v: 3;
  device: string;
  label: string;
  seed: boolean;
  household: { name: string; hid: string; sid: string; owner_pub: string };
  keyv: number;
  /** keyv → household key, every version the server has (at least the current one). */
  keys: Record<string, string>;
  /** keyv → serverKey, every version (older files and archives stay readable). */
  serverKeys: Record<string, string>;
  /** This phone's own secret (the recovery copy holds it). */
  secret: string;
  server: { home: string; away?: string | null; keepMonths: number | null };
}

/** The join answer: nonce + AES-GCM(key, aad "RSJ3" + device, JSON). */
export const sealJoin = (key: Uint8Array, device: string, gift: JoinGift | unknown, nonce?: Uint8Array) => sealJson(key, RSJ3 + device, gift, nonce);
export const openJoin = (key: Uint8Array, device: string, sealed: Uint8Array) => openJson<JoinGift>(key, RSJ3 + device, sealed);

/** What a phone signs (its household key, my_priv) to join through the household: `member: true` joins. */
export function memberJoinText(b: { device: string; pub: string; kex: string; n: string }): string {
  return `${MEMBER_JOIN}\n${b.device}\n${b.pub}\n${b.kex}\n${b.n}`;
}

// ---------- keys after a rekey (RSE3) ----------

/** key = HKDF(ECDH(server kex, phone kex), no salt, "restock-keys-v3"). */
export function keysFileKey(priv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return hkdf32(ecdh(priv, theirPub), undefined, KEYS_INFO);
}

/** keys/<device>.bin = "RSE3" + nonce + AES-GCM(key, aad "RSE3" + device, JSON { keyv, keys }). */
export function sealKeysFile(key: Uint8Array, device: string, body: { keyv: number; keys: Record<string, string> }, nonce?: Uint8Array): Uint8Array {
  return concat(strToU8(RSE3), sealJson(key, RSE3 + device, body, nonce));
}

export function openKeysFile(key: Uint8Array, device: string, bytes: Uint8Array): { keyv: number; keys: Record<string, string> } {
  if (!startsWith(bytes, strToU8(RSE3))) throw new Error('not a keys file');
  const m = openJson<{ keyv: number; keys: Record<string, string> }>(key, RSE3 + device, bytes.subarray(4));
  if (!Number.isInteger(m.keyv) || m.keyv < 1 || !m.keys || typeof m.keys !== 'object') throw new Error('odd keys file');
  for (const [v, k] of Object.entries(m.keys)) if (!/^\d+$/.test(v) || unb64(k).length !== 32) throw new Error('odd key');
  return m;
}

// ---------- the handover (RSH3) and Home Assistant's token (RSA3) ----------

/** key = HKDF(ECDH(phone's one-off key, server kex), salt token, "restock-handover-v3"). */
export function handoverKey(priv: Uint8Array, theirPub: Uint8Array, token: Uint8Array): Uint8Array {
  return hkdf32(ecdh(priv, theirPub), token, HANDOVER_INFO);
}

/** POST /api/v3/handover/<token> `sealed`: nonce + AES-GCM(key, aad "RSH3", JSON). */
export const sealHandover = (key: Uint8Array, payload: unknown, nonce?: Uint8Array) => sealJson(key, RSH3, payload, nonce);
export const openHandover = <T = Record<string, unknown>>(key: Uint8Array, sealed: Uint8Array) => openJson<T>(key, RSH3, sealed);

/** key = HKDF(ECDH(server kex, phone kex), salt n, "restock-ha-v3") (the upgrade's `n`). */
export function haKey(priv: Uint8Array, theirPub: Uint8Array, n: Uint8Array): Uint8Array {
  return hkdf32(ecdh(priv, theirPub), n, HA_INFO);
}

/** POST /api/v3/upgrade `ha`: nonce + AES-GCM(key, aad "RSA3" + device, JSON { address, entity, enabled, token, state }). */
export const sealHa = (key: Uint8Array, device: string, payload: unknown, nonce?: Uint8Array) => sealJson(key, RSA3 + device, payload, nonce);
export const openHa = <T = Record<string, unknown>>(key: Uint8Array, device: string, sealed: Uint8Array) => openJson<T>(key, RSA3 + device, sealed);

// ---------- browsers: sign-in, sessions, request MACs ----------

/** loginKey = HKDF(authKey, no salt, "restock-login-v3"). What the server keeps; the passphrase never crosses. */
export const loginKeyOf = (authKey: Uint8Array) => hkdf32(authKey, undefined, LOGIN_INFO);

/** proof = HMAC-SHA256(loginKey, "restock-login-v3\n" + c + "\n" + epub), c and epub as sent (base64url). */
export const loginProof = (loginKey: Uint8Array, c: string, epub: string) => b64u(hmac(sha256, loginKey, strToU8(`${LOGIN_INFO}\n${c}\n${epub}`)));

/**
 * sessionKey = HKDF(ECDH(server kex, epub) ‖ loginKey, salt c, "restock-session-v3") for a passphrase
 * sign-in; for Sign in with a phone, HKDF(ECDH(server kex, epub), salt id, "restock-session-v3").
 */
export function sessionKeyOf(priv: Uint8Array, theirPub: Uint8Array, salt: Uint8Array, loginKey?: Uint8Array): Uint8Array {
  const shared = ecdh(priv, theirPub);
  return hkdf32(loginKey ? concat(shared, loginKey) : shared, salt, SESSION_INFO);
}

const bodyBytes = (body: Uint8Array | string | null | undefined) => (body === null || body === undefined ? new Uint8Array(0) : typeof body === 'string' ? strToU8(body) : body);

/** What a phone signs and a browser MACs: METHOD\nPATH_AND_QUERY\nt\nn\nhex(sha256(body)) (v2's text). */
export function requestText(method: string, path: string, t: number | string, n: string, body?: Uint8Array | string | null): string {
  return `${method.toUpperCase()}\n${path}\n${t}\n${n}\n${hex(sha256(bodyBytes(body)))}`;
}

/** m = HMAC-SHA256(sessionKey, requestText), base64url. */
export const requestMac = (sessionKey: Uint8Array, text: string) => b64u(hmac(sha256, sessionKey, strToU8(text)));

/** The header a browser sends: `RestockWeb3 s=<session>, t=<ms>, n=<nonce>, m=<mac>`. `t`, `n`: tests only. */
export function webAuthorization(session: string, sessionKey: Uint8Array, method: string, path: string, body?: Uint8Array | string | null, t = Date.now(), n = b64u(random(16))): string {
  return `RestockWeb3 s=${session}, t=${t}, n=${n}, m=${requestMac(sessionKey, requestText(method, path, t, n, body))}`;
}

/** Reads `Restock2 d=…, t=…` or `RestockWeb3 s=…, m=…`: its scheme and fields, or null. */
export function parseAuthorization(header: string | null | undefined): { scheme: string; fields: Record<string, string> } | null {
  const m = /^\s*(Restock2|RestockWeb3)\s+(.+)$/.exec(header ?? '');
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const part of m[2].split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { scheme: m[1], fields };
}

/** A MAC (base64url) checked in constant time. */
export function macOk(sessionKey: Uint8Array, text: string, mac: string): boolean {
  let want: Uint8Array, got: Uint8Array;
  try {
    want = unb64(requestMac(sessionKey, text));
    got = unb64(mac);
  } catch {
    return false;
  }
  if (want.length !== got.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want[i] ^ got[i];
  return d === 0;
}

// ---------- keys in Java's encodings ----------

const PKCS8_P256 = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02,
  0x01, 0x01, 0x04, 0x20,
]);

/** A P-256 private key as PKCS#8 DER (what Java's PKCS8EncodedKeySpec and Node's createPrivateKey read). */
export const pkcs8Of = (priv: Uint8Array) => concat(PKCS8_P256, priv);

/** The 32-byte private key from a P-256 PKCS#8 DER (Java's getEncoded(), Node's export, with or without the public key). */
export function privOfPkcs8(der: Uint8Array): Uint8Array {
  // The ECPrivateKey inside: SEQUENCE { INTEGER 1, OCTET STRING (32) privateKey, ... }.
  for (let i = 0; i + 37 <= der.length; i++) {
    if (der[i] === 0x02 && der[i + 1] === 0x01 && der[i + 2] === 0x01 && der[i + 3] === 0x04 && der[i + 4] === 0x20) {
      if (der[i - 2] !== 0x30) continue;
      return der.slice(i + 5, i + 37);
    }
  }
  throw new Error('not a P-256 private key');
}

/** A new ECDSA/ECDH P-256 key pair as Java keeps them: PKCS#8 private and SPKI public, both base64url. */
export function newJavaKeyPair(): { priv: string; pub: string } {
  const k = newEcdhKey();
  return { priv: b64u(pkcs8Of(k.priv)), pub: b64u(k.pub) };
}

/** Signs like Java's SHA256withECDSA with a PKCS#8 private key (base64url): the owner key from a handover. */
export const signWithPkcs8 = (privPkcs8: string, text: string) => signText(privOfPkcs8(unb64(privPkcs8)), text);

// ---------- the recovery key (0.9.0, SyncHousehold.java) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, capitals, no padding (SyncWire.base32). */
export function base32(b: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const x of b) {
    buffer = ((buffer << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s.trim().toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('not base32');
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 20 random bytes; shown as "ABCD-EFGH-…" (formatRecovery), kept as base32 (sync_meta recovery). */
export const RECOVERY_BYTES = 20;

/** "ABCD-EFGH-…": 32 letters and numbers in eights of four (SyncHousehold.formatRecovery). */
export const formatRecovery = (r: Uint8Array) => (base32(r).match(/.{1,4}/g) ?? []).join('-');

/** The recovery copy's key: SHA-256("restock-recovery" ‖ r) (SyncHousehold.recoveryKey). */
export const recoveryKeyOf = (r: Uint8Array) => sha256(concat(strToU8('restock-recovery'), r));

/** What the household's `recovery` row holds, sealed (SyncHousehold.saveRecovery). */
export interface RecoveryCopy {
  /** device → that phone's secret (base64url). */
  secrets: Record<string, string>;
  owner_priv: string;
  owner_pubkey: string;
  /** The current household key (base64url) and its version, as a string. */
  key: string;
  keyv: string;
  oldkey?: string;
  oldkey_until?: string;
}

/** The `recovery` row's value: base64url(nonce + AES-GCM(recoveryKey, no aad, JSON)) (SyncWire.seal). */
export const sealRecovery = (r: Uint8Array, copy: RecoveryCopy, nonce?: Uint8Array) => b64u(sealJson(recoveryKeyOf(r), '', copy, nonce));
export const openRecovery = (r: Uint8Array, row: string) => openJson<RecoveryCopy>(recoveryKeyOf(r), '', unb64(row));
