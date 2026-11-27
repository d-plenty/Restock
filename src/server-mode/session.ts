// Server mode: signing in, and keeping this tab's keys.
//
// 0.9.4, a house (protocol v3, docs/server-protocol.md "v3"): no vault and no link. Sign-in is a
// challenge (the passphrase never crosses the wire), the server hands the session the household's
// serverKeys sealed with the session's own key, and every request after that is MACed with it
// (api.ts). The session lives in sessionStorage, or in localStorage with "Keep me signed in on this
// computer". Signed in with a phone: the keys come from the phone and stay for this tab only.
// 0.15.0: the 0.9.3 household's vault, passphrase and link sign-in are gone.

import { api3, ApiError, setV3Auth, type Confirm, type SessionGift } from './api';
import { b64u, derivePassphrase, loginKeyOf, loginProof, newEcdhKey, openRsf1, random, sessionKeyOf, unb64 } from './crypto';

export interface Session {
  user: string;
  webId: string;
  webPriv: string;
  webPub: string;
  keys: Record<string, string>;
  ownerPub?: string;
  household?: string;
  /** Signed in with a phone: the passphrase can't be changed in this tab. */
  viaPhone?: boolean;
  /** 0.18.0: the phone that signed it in (an admin phone's browser looks after the phones too). */
  viaDevice?: string;
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
let current: Session | undefined;

export const session = () => current;

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

export function forget(): void {
  remember(undefined);
}

export const signOutEverywhere = (): Promise<void> => signOutEverywhereV3();

export async function signOut(): Promise<void> {
  await api3.logout(false).catch(() => undefined);
  forget();
}

// ====================================================================================================
// 0.9.4, a house (v3)
// ====================================================================================================

/** The session built from what the server sealed for it (login, setup, GET /api/v3/session). */
function houseSession(user: string, sid: string, key: Uint8Array, gift: SessionGift, more: Partial<Session> = {}): Session {
  const h = gift.household && typeof gift.household === 'object' ? gift.household : undefined;
  return {
    user: gift.user ?? user,
    webId: gift.webId ?? '',
    webPriv: '',
    webPub: '',
    keys: { ...gift.keys },
    ownerPub: h?.owner_pub,
    household: h?.name,
    v: 3,
    sid,
    sessionKey: b64u(key),
    expires: gift.expires,
    viaPhone: gift.kind === 'phone' || undefined,
    ...(typeof (gift as { device?: unknown }).device === 'string' ? { viaDevice: (gift as { device: string }).device } : {}),
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
  // 0.9.5 (review): the household's owner key as the server has it now: a new household (Delete
  // everything, set up again) has another, and live.ts drops a copy of the old one.
  remember({ ...s, keys: { ...s.keys, ...g.keys }, webId: g.webId ?? s.webId, household: h?.name ?? s.household, ownerPub: h?.owner_pub ?? s.ownerPub });
  return fresh;
}

/** Set up this server (a fresh 0.9.4 server): it makes the house; this session gets its keys. */
export async function setUpHouse(name: string): Promise<Session> {
  const s = current;
  if (!s || s.v !== 3 || !s.sid || !s.sessionKey) throw new Error('Sign in first.');
  const r = await api3.setup(name.trim());
  const g = r && r.keys ? r : await api3.session();
  if (!g?.keys) throw new Error('The server set up the house but sent no keys. Sign in again.');
  const next = houseSession(s.user, s.sid, unb64(s.sessionKey), { ...g, household: g.household ?? { name: name.trim() } }, { keep: s.keep, viaPhone: s.viaPhone, viaDevice: s.viaDevice });
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
async function signOutEverywhereV3(): Promise<void> {
  await api3.logout(true);
  forget();
}
