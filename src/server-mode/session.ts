// Server mode: signing in, the vault, linking with a phone, and keeping this tab's keys.
//
// - The passphrase becomes authKey (sent) and vaultKey (kept in this page's memory only).
// - The vault (on the server, sealed with vaultKey) holds the web's id, its ECDH private key and the
//   household's serverKeys. While the tab is open they're also in sessionStorage, so a reload
//   doesn't ask for the passphrase again; closing the tab forgets them.
// - Signed in with a phone: the keys come from the phone and stay for this tab only (no vaultKey).

import { api, ApiError } from './api';
import { b64u, derivePassphrase, newEcdhKey, openGift, openVault, publicOf, random, sealVault, unb64, type LinkGift, type Vault } from './crypto';

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
}

const KEY = 'restock-server-session';
let vaultKey: Uint8Array | undefined;
/** The current passphrase's authKey (memory only, like vaultKey): the server wants it to change the passphrase. */
let authKey: Uint8Array | undefined;
let current: Session | undefined;

export const session = () => current;
export const canChangeVault = () => !!vaultKey && !!current && !current.viaPhone;

export function remember(s: Session | undefined): void {
  current = s;
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    // private mode: this tab keeps it in memory
  }
}

export function recall(): Session | undefined {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Session | null;
    if (s && typeof s.webId === 'string' && s.keys && typeof s.keys === 'object') current = s;
  } catch {
    // nothing kept
  }
  return current;
}

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
  if (current && canChangeVault()) {
    const k = newEcdhKey();
    const s: Session = { ...current, webId: newWebId(), webPriv: b64u(k.priv), webPub: b64u(k.pub) };
    await saveVault(s);
  }
  await api.logout(true);
  forget();
}

export async function signOut(): Promise<void> {
  await api.logout(false).catch(() => undefined);
  forget();
}
