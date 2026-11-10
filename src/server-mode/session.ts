// Server mode: signing in, the vault, linking with a phone, and keeping this tab's keys.
//
// - The passphrase becomes authKey (sent) and vaultKey (kept in this page's memory only).
// - The vault (on the server, sealed with vaultKey) holds the web's id, its ECDH private key and the
//   household's serverKeys. While the tab is open they're also in sessionStorage, so a reload
//   doesn't ask for the passphrase again; closing the tab forgets them.
// - Signed in with a phone: the keys come from the phone and stay for this tab only (no vaultKey).
//
// 0.9.4, a house (protocol v3, docs/server-protocol.md "v3"): no vault and no link. Sign-in is a
// challenge (the passphrase, and even v2's authKey, never cross the wire), the server hands the
// session the household's serverKeys sealed with the session's own key, and every request after
// that is MACed with it (api.ts). The session lives in sessionStorage, or in localStorage with "Keep
// me signed in on this computer".

import { api, api3, ApiError, setV3Auth, type Confirm, type SessionGift } from './api';
import {
  b64u,
  derivePassphrase,
  loginKeyOf,
  loginProof,
  newEcdhKey,
  openGift,
  openRsf1,
  openVault,
  publicOf,
  random,
  sealVault,
  sessionKeyOf,
  unb64,
  type LinkGift,
  type Vault,
} from './crypto';

export interface Session {
  user: string;
  webId: string;
  /** '' when signed in with a phone (no vault). */
  webPriv: string;
  webPub: string;
  keys: Record<string, string>;
  ownerPub?: string;
  household?: string;
  /** Signed in with a phone: the vault can't be opened or changed in this tab. */
  viaPhone?: boolean;
  /** 0.9.4: 3 for a house's session (no vault: webPriv and webPub are ''). */
  v?: 3;
  /** v3: the session's id and its key (base64url), for the request MACs and sealed answers. */
  sid?: string;
  sessionKey?: string;
  expires?: string | number;
  /** v3: kept in localStorage ("Keep me signed in on this computer"). */
  keep?: boolean;
}

const KEY = 'restock-server-session';
let vaultKey: Uint8Array | undefined;
/** The current passphrase's authKey (memory only, like vaultKey): the server wants it to change the passphrase. */
let authKey: Uint8Array | undefined;
let current: Session | undefined;

export const session = () => current;
export const canChangeVault = () => !!vaultKey && !!current && !current.viaPhone && current.v !== 3;

export function remember(s: Session | undefined): void {
  current = s;
  setV3Auth(s?.v === 3 && s.sid && s.sessionKey ? { session: s.sid, key: unb64(s.sessionKey) } : undefined);
  try {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
    if (s) (s.keep && s.v === 3 ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode: this tab keeps it in memory
  }
}

export function recall(): Session | undefined {
  try {
    const kept = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
    const s = JSON.parse(kept ?? 'null') as Session | null;
    if (s && typeof s.webId === 'string' && s.keys && typeof s.keys === 'object') {
      // A kept v3 session that has run out isn't worth trying.
      const exp = typeof s.expires === 'number' ? s.expires : s.expires ? Date.parse(s.expires) : NaN;
      if (s.v === 3 && Number.isFinite(exp) && exp < Date.now()) remember(undefined);
      else remember(s);
    }
  } catch {
    // nothing kept
  }
  return current;
}

/** Is this tab signed in to a house (v3)? */
export const isHouseSession = () => current?.v === 3;

export function forget(): void {
  vaultKey = undefined;
  authKey = undefined;
  remember(undefined);
}

const newWebId = () => b64u(random(12));

function freshVault(): Vault {
  const k = newEcdhKey();
  return { webId: newWebId(), webPriv: b64u(k.priv), keys: {} };
}

const sessionOf = (user: string, v: Vault): Session => ({
  user,
  webId: v.webId,
  webPriv: v.webPriv,
  webPub: b64u(publicOf(unb64(v.webPriv))),
  keys: { ...v.keys },
  ownerPub: v.ownerPub,
  household: v.household,
});

const vaultOf = (s: Session): Vault => ({ webId: s.webId, webPriv: s.webPriv, keys: s.keys, ownerPub: s.ownerPub, household: s.household });

export type LoginResult = { mustChange: true } | { mustChange: false; session: Session };

/**
 * Signs in. Before a passphrase is set (the server says `setup`), the server's first-start password
 * (RESTOCK_PASSWORD) is sent as it is (it's only ever good for setting the passphrase); after that
 * only authKey goes. What was typed is never sent as it is to a server that has a passphrase: a
 * mistyped passphrase is most of the real one.
 */
export async function login(user: string, passphrase: string, onStep?: (what: string) => void): Promise<LoginResult> {
  const u = user.trim();
  const salt = (await api.salt(u)) as { salt: string; setup?: boolean };
  if (salt.setup) return setupLogin(u, passphrase);
  onStep?.('Unlocking…');
  const keys = await derivePassphrase(passphrase, unb64(salt.salt));
  const r = await api.login({ user: u, auth: b64u(keys.auth) });
  if (r.mustChange) return { mustChange: true };
  vaultKey = keys.vault;
  authKey = keys.auth;
  let v: Vault;
  if (r.vault) v = openVault(keys.vault, unb64(r.vault));
  else {
    const got = await api.getVault().catch(() => ({ vault: null }));
    v = got.vault ? openVault(keys.vault, unb64(got.vault)) : freshVault();
    if (!got.vault) await saveVault(sessionOf(u, v));
  }
  const s = sessionOf(u, v);
  remember(s);
  return { mustChange: false, session: s };
}

async function setupLogin(user: string, password: string): Promise<LoginResult> {
  const r = await api.login({ user, password });
  if (!r.mustChange) throw new ApiError(401, 'wrong', "That user name or passphrase isn't right.");
  return { mustChange: true };
}

/**
 * Sets (or changes) the passphrase. A new one means a new web id and key pair (the old ones may
 * be known to whoever had the old passphrase); the household's keys move across.
 */
export async function setPassphrase(user: string, passphrase: string): Promise<Session> {
  const salt = random(16);
  const keys = await derivePassphrase(passphrase, salt);
  const v = freshVault();
  if (current) {
    v.keys = { ...current.keys };
    v.ownerPub = current.ownerPub;
    v.household = current.household;
  }
  const sealed = b64u(sealVault(keys.vault, v));
  const webPub = b64u(publicOf(unb64(v.webPriv)));
  await api.setPassphrase({ salt: b64u(salt), auth: b64u(keys.auth), vault: sealed, webId: v.webId, webPub, ...(authKey ? { current: b64u(authKey) } : {}) });
  vaultKey = keys.vault;
  authKey = keys.auth;
  const s = sessionOf(user, v);
  remember(s);
  return s;
}

export async function saveVault(s: Session): Promise<void> {
  if (!vaultKey || s.viaPhone) return;
  await api.putVault({ vault: b64u(sealVault(vaultKey, vaultOf(s))), webId: s.webId, webPub: s.webPub });
}

/** New keys from a phone (a link, or webkeys/ after a rekey): into the session, and the vault when it can. */
export async function addKeys(gift: LinkGift): Promise<Session> {
  if (!current) throw new Error('Not signed in');
  const h = gift.household;
  const owner = typeof h === 'object' && h ? (h.owner_pub ?? h.ownerPub) : gift.owner_pub;
  const name = typeof h === 'object' && h ? h.name : typeof h === 'string' ? h : undefined;
  const s: Session = { ...current, keys: { ...current.keys, ...gift.keys }, ownerPub: current.ownerPub ?? owner, household: name ?? current.household };
  remember(s);
  await saveVault(s);
  return s;
}

/** The link code for a phone to scan: restock-link:2?u=<origin>&s=<id>&k=<web public key>. */
export const linkCode = (origin: string, id: string, pub: string) => `restock-link:2?u=${encodeURIComponent(origin)}&s=${encodeURIComponent(id)}&k=${pub}`;
export const loginCode = (origin: string, id: string, pub: string) => `restock-login:2?u=${encodeURIComponent(origin)}&s=${encodeURIComponent(id)}&k=${pub}`;
export const inviteCode = (home: string, away: string | undefined, invite: string) =>
  `restock-server:2?h=${encodeURIComponent(home)}${away ? `&a=${encodeURIComponent(away)}` : ''}&i=${encodeURIComponent(invite)}`;

/** Waits for a phone to answer a link or sign-in code (every 2 seconds, until `stop()` says so or it runs out). */
export async function waitForPhone(poll: () => Promise<{ pending?: boolean; pub?: string; sealed?: string }>, stop: () => boolean, ms = 10 * 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until && !stop()) {
    let r: { pending?: boolean; pub?: string; sealed?: string };
    try {
      r = await poll();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) throw new Error('That code ran out. Make a new one.');
      if (e instanceof ApiError && e.status === 0) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      throw e;
    }
    if (r.pub && r.sealed) return { pub: r.pub, sealed: r.sealed };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return undefined;
}

/** Link this browser with the household (once, after setting the passphrase). */
export async function startLink(): Promise<{ code: string; wait: (stop: () => boolean) => Promise<Session | undefined> }> {
  const s = current;
  if (!s || !s.webPriv) throw new Error('Sign in with your passphrase first.');
  const { id } = await api.linkStart();
  return {
    code: linkCode(location.origin, id, s.webPub),
    wait: async (stop) => {
      const got = await waitForPhone(() => api.linkPoll(id), stop);
      if (!got) return undefined;
      return addKeys(openGift(unb64(s.webPriv), got));
    },
  };
}

/** Sign in with a phone: a fresh key for this one sign-in; the keys stay in this tab only. */
export async function startPhoneLogin(): Promise<{ code: string; wait: (stop: () => boolean) => Promise<Session | undefined> }> {
  const k = newEcdhKey();
  const { id } = await api.qrStart();
  return {
    code: loginCode(location.origin, id, b64u(k.pub)),
    wait: async (stop) => {
      const got = await waitForPhone(() => api.qrPoll(id), stop, 2 * 60_000);
      if (!got) return undefined;
      const gift = openGift(k.priv, got);
      const web = await api.web();
      if (!web.webId) throw new Error("This server hasn't been set up with a passphrase yet. Sign in with the server's first password.");
      const h = gift.household;
      const s: Session = {
        user: web.user ?? 'admin',
        webId: web.webId,
        webPriv: '',
        webPub: web.webPub ?? '',
        keys: gift.keys,
        ownerPub: typeof h === 'object' && h ? (h.owner_pub ?? h.ownerPub) : gift.owner_pub,
        household: typeof h === 'object' && h ? h.name : typeof h === 'string' ? h : undefined,
        viaPhone: true,
      };
      vaultKey = undefined;
      authKey = undefined;
      remember(s);
      return s;
    },
  };
}

/**
 * Sign out everywhere: every session ends. This browser takes a new web id and key pair first
 * (whoever had a session may have seen the old ones), when it can change the vault.
 */
export async function signOutEverywhere(): Promise<void> {
  if (current?.v === 3) return signOutEverywhereV3();
  if (current && canChangeVault()) {
    const k = newEcdhKey();
    const s: Session = { ...current, webId: newWebId(), webPriv: b64u(k.priv), webPub: b64u(k.pub) };
    await saveVault(s);
  }
  await api.logout(true);
  forget();
}

export async function signOut(): Promise<void> {
  if (current?.v === 3) await api3.logout(false).catch(() => undefined);
  else await api.logout(false).catch(() => undefined);
  forget();
}

// ====================================================================================================
// 0.9.4, a house (v3)
// ====================================================================================================

/** The session built from what the server sealed for it (login, setup, GET /api/v3/session). */
export function houseSession(user: string, sid: string, key: Uint8Array, gift: SessionGift, more: Partial<Session> = {}): Session {
  const h = gift.household && typeof gift.household === 'object' ? gift.household : undefined;
  return {
    user: gift.user ?? user,
    webId: gift.webId ?? '',
    webPriv: '',
    webPub: '',
    keys: { ...(gift.keys ?? {}) },
    ownerPub: h?.owner_pub,
    household: h?.name,
    v: 3,
    sid,
    sessionKey: b64u(key),
    expires: gift.expires,
    viaPhone: gift.kind === 'phone' || undefined,
    ...more,
  };
}

/**
 * Signs in to a house: GET the challenge (the passphrase's salt, a one-off `c` and the server's kex
 * key), prove the passphrase with loginKey over `c` and a one-off ECDH key, and work out the same
 * session key the server does. `step` says what's happening (the passphrase takes a few seconds).
 */
export async function loginV3(user: string, passphrase: string, keep = false, step?: (what: string) => void): Promise<Session> {
  const u = user.trim();
  const ch = await api3.challenge(u);
  if (ch.setup) throw new ApiError(409, 'setup', "This server's passphrase isn't set yet. Open the server's setup page first.");
  step?.('Unlocking…');
  const keys = await derivePassphrase(passphrase, unb64(ch.salt));
  const loginKey = loginKeyOf(keys.auth);
  keys.auth.fill(0);
  keys.vault.fill(0);
  const e = newEcdhKey();
  const epub = b64u(e.pub);
  const r = await api3.login({ user: u, c: ch.c, epub, proof: loginProof(loginKey, ch.c, epub) });
  const sessionKey = sessionKeyOf(e.priv, unb64(ch.kex), unb64(ch.c), loginKey);
  let gift: SessionGift;
  try {
    gift = openRsf1<SessionGift>(sessionKey, unb64(r.sealed));
  } catch {
    // The server worked out another key: not the server this page came from, or a changed answer.
    throw new ApiError(0, 'sealed', "The server's answer didn't open. Check the address, and sign in again.");
  }
  const s = houseSession(u, r.session, sessionKey, { expires: r.expires, ...gift }, { keep });
  remember(s);
  return s;
}

/** Sign in with a phone (v3): the code carries a one-off key; the phone approves; the server gives the keys. */
export async function startPhoneLoginV3(): Promise<{ code: string; wait: (stop: () => boolean) => Promise<Session | undefined> }> {
  const e = newEcdhKey();
  const epub = b64u(e.pub);
  const { id, kex } = await api3.qrStart(epub);
  return {
    code: `restock-login:3?u=${encodeURIComponent(location.origin)}&s=${encodeURIComponent(id)}&k=${epub}`,
    wait: async (stop) => {
      const until = Date.now() + 2 * 60_000;
      while (Date.now() < until && !stop()) {
        let r: Awaited<ReturnType<typeof api3.qrPoll>>;
        try {
          r = await api3.qrPoll(id);
        } catch (err) {
          if (err instanceof ApiError && (err.status === 404 || err.status === 410)) throw new Error('That code ran out. Make a new one.');
          if (err instanceof ApiError && err.status === 0) {
            await new Promise((res) => setTimeout(res, 3000));
            continue;
          }
          throw err;
        }
        if (r.session && r.sealed) {
          const key = sessionKeyOf(e.priv, unb64(kex), unb64(id));
          const gift = openRsf1<SessionGift>(key, unb64(r.sealed));
          const s = houseSession('admin', r.session, key, { expires: r.expires, kind: 'phone', ...gift }, { viaPhone: true });
          remember(s);
          return s;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
      return undefined;
    },
  };
}

/** New keys from the server for this session (after a Remove rekeyed the household): true when some came. */
export async function refreshHouseKeys(): Promise<boolean> {
  const s = current;
  if (!s || s.v !== 3 || !s.sid || !s.sessionKey) return false;
  const g = await api3.session().catch(() => null);
  if (!g?.keys) return false;
  const fresh = Object.entries(g.keys).some(([v, k]) => s.keys[v] !== k);
  const h = g.household && typeof g.household === 'object' ? g.household : undefined;
  remember({ ...s, keys: { ...s.keys, ...g.keys }, webId: g.webId ?? s.webId, household: h?.name ?? s.household, ownerPub: s.ownerPub ?? h?.owner_pub });
  return fresh;
}

/** Set up this server (a fresh 0.9.4 server): it makes the house; this session gets its keys. */
export async function setUpHouse(name: string): Promise<Session> {
  const s = current;
  if (!s || s.v !== 3 || !s.sid || !s.sessionKey) throw new Error('Sign in first.');
  const r = await api3.setup(name.trim());
  const g = r && r.keys ? r : await api3.session();
  if (!g?.keys) throw new Error('The server set up the house but sent no keys. Sign in again.');
  const next = houseSession(s.user, s.sid, unb64(s.sessionKey), { ...g, household: g.household ?? { name: name.trim() } }, { keep: s.keep, viaPhone: s.viaPhone });
  remember(next);
  return next;
}

/**
 * Changes a house's passphrase: the current one is proved over a fresh challenge (`proof` =
 * HMAC(current loginKey, "restock-login-v3\n" + c + "\n" + session id)), and the new one's salt and
 * authKey go sealed with the session key. Other browsers are signed out; this one carries on.
 */
export async function changeHousePassphrase(currentPass: string, next: string): Promise<void> {
  const s = current;
  if (!s || s.v !== 3 || !s.sid) throw new Error('Sign in first.');
  const ch = await api3.challenge(s.user);
  const old = await derivePassphrase(currentPass, unb64(ch.salt));
  const proof = loginProof(loginKeyOf(old.auth), ch.c, s.sid);
  const salt = random(16);
  const fresh = await derivePassphrase(next, salt);
  try {
    await api3.passphrase({ c: ch.c, proof, salt: b64u(salt), auth: b64u(fresh.auth) });
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'current' || e.status === 403)) throw new Error("That isn't the current passphrase.");
    throw e;
  }
}

/**
 * 0.9.4: the passphrase again, before the dangerous admin actions (the recovery key, the backup,
 * deleting data, Remove a phone): proved over a fresh challenge and bound to this session, as a
 * passphrase change proves the current one. The passphrase never leaves this page.
 */
export async function confirmPassphrase(passphrase: string): Promise<Confirm> {
  const s = current;
  if (!s || s.v !== 3 || !s.sid) throw new Error('Sign in with your passphrase first.');
  if (s.viaPhone) throw new Error('Sign in with your passphrase to do that.');
  const ch = await api3.challenge(s.user);
  const keys = await derivePassphrase(passphrase, unb64(ch.salt));
  return { c: ch.c, proof: loginProof(loginKeyOf(keys.auth), ch.c, s.sid) };
}

/** Sign out everywhere (v3): every browser's session ends, this one's too. Phones keep syncing. */
export async function signOutEverywhereV3(): Promise<void> {
  await api3.logout(true);
  forget();
}
