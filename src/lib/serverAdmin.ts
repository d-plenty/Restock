// 0.18.3: Server admin on an admin phone (Settings → Sync → Restock server → Server admin): what the
// server's web page does, from the phone. The requests for a yes (sign-ins and risky changes on the
// web page), Data and how long it's kept, Activity, and Server settings: the household, the
// addresses, signing in, Home Assistant and updates. Every request and answer is sealed with the
// household's server key (RestockNative.serverAdmin), and the server checks this phone is an admin.
// Risky changes from here prove the passphrase, as the web page does, over this phone's own id.
import { RestockNative } from './sql/native';
import { syncInfo } from './sync';
import { b64u, derivePassphrase, loginKeyOf, loginProof, openBackupKey, random, sealBackupKey, unb64 } from '../server-mode/crypto';
import type { Activity, Browser, HaConfig, HouseSettings, Updates } from '../server-mode/api';
import type { DataSummary } from '../server-mode/ui/houseWords';

export type { Activity, Browser, HaConfig, HouseSettings, Updates, DataSummary };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = <T>(method: Method, path: string, body?: Record<string, unknown>) => RestockNative.serverAdmin({ method, path, ...(body ? { body } : {}) }) as Promise<T>;

/** A request for a yes, as the admin phone sees it. */
export interface Approval {
  id: string;
  what: string;
  /** "sign in", "delete data", … (what the browser wants to do). */
  words: string;
  number: string;
  browser: string;
  ip: string | null;
  asked: string;
  expires: string;
}

/** What /me says: the role, the server's version, and (an admin) the updates and how many requests wait. */
export interface Me {
  device: string;
  role: 'admin' | 'user';
  label: string | null;
  server?: string;
  updates?: Updates;
  waiting?: number;
}

export const me = () => call<Me>('GET', '/me');
export const approvals = async () => (await call<{ approvals?: Approval[] }>('GET', '/approvals')).approvals ?? [];
export const answer = (id: string, yes: boolean) => call<{ ok: boolean }>('POST', `/approvals/${encodeURIComponent(id)}`, { yes });

export const settings = () => call<HouseSettings>('GET', '/settings');
export const putSettings = (s: Partial<HouseSettings> & Record<string, unknown>) => call<HouseSettings>('PUT', '/settings', s);
export const activity = async (limit = 100) => (await call<{ activity?: Activity[] }>('GET', `/activity?limit=${limit}`)).activity ?? [];
export const browsers = async () => (await call<{ browsers?: Browser[] }>('GET', '/browsers')).browsers ?? [];
export const endBrowser = (id: string) => call<unknown>('DELETE', `/browsers/${encodeURIComponent(id)}`);
export const homeAssistant = () => call<HaConfig>('GET', '/homeassistant');
export const putHomeAssistant = (c: HaConfig & { token?: string }) => call<HaConfig>('PUT', '/homeassistant', c as Record<string, unknown>);
export const testHomeAssistant = () => call<{ ok?: boolean; message?: string }>('POST', '/homeassistant/test', {});
export const summary = () => call<DataSummary>('GET', '/data/summary');
export const serverLog = () => call<{ text: string; lines: number }>('GET', '/server/log');
export const updates = () => call<Updates>('GET', '/server/updates');

/**
 * The passphrase, proved without it leaving the phone: the server's salt and a one-off challenge,
 * the passphrase worked into the sign-in key (a few seconds), and a proof over the challenge and
 * this phone's id. Wrong: the server says "That isn't the current passphrase."
 */
export async function proveFor(passphrase: string): Promise<{ c: string; proof: string }> {
  const ch = await call<{ salt: string; c: string; user: string }>('GET', '/confirm/challenge');
  const info = await syncInfo();
  if (!info.device) throw new Error("This phone's id on the server isn't known yet. Sync, then try again.");
  const keys = await derivePassphrase(passphrase, unb64(ch.salt));
  const key = loginKeyOf(keys.auth);
  keys.auth.fill(0);
  keys.vault.fill(0);
  return { c: ch.c, proof: loginProof(key, ch.c, 'phone:' + info.device) };
}

/** How long data is kept (null: until deleted). Keeping less deletes what's older now: the passphrase and DELETE. */
export async function setKeep(months: number | null, passphrase?: string): Promise<void> {
  await call('PUT', '/data/autodelete', { months, ...(passphrase ? { typed: 'DELETE', confirm: await proveFor(passphrase) } : {}) });
}

/** The recovery key, with the passphrase. */
export async function recoveryKey(passphrase: string): Promise<string> {
  const r = await call<{ recovery?: string }>('POST', '/recovery', { confirm: await proveFor(passphrase) });
  if (!r.recovery) throw new Error("The server didn't send the recovery key.");
  return r.recovery;
}
export const recoverySaved = () => call('POST', '/recovery', { saved: true });

/**
 * 0.18.4: a new passphrase, from the phone: the current one proved over this phone's id, and the new
 * one worked into its sign-in key here with a new salt. Neither leaves the phone. Every browser is
 * signed out. The phone backups' key (when they're on) is opened with the old one and sealed with the
 * new one in the same request, so the backups still open.
 */
export async function changePassphrase(current: string, next: string): Promise<void> {
  const ch = await call<{ salt: string; c: string }>('GET', '/confirm/challenge');
  const info = await syncInfo();
  if (!info.device) throw new Error("This phone's id on the server isn't known yet. Sync, then try again.");
  const old = await derivePassphrase(current, unb64(ch.salt));
  const proof = loginProof(loginKeyOf(old.auth), ch.c, 'phone:' + info.device);
  const salt = random(16);
  const fresh = await derivePassphrase(next, salt);
  try {
    const key = await call<{ sealed?: string }>('GET', '/backupkey');
    let backupSealed: string | undefined;
    if (key.sealed) {
      const priv = openBackupKey(old.vault, key.sealed);
      backupSealed = sealBackupKey(fresh.vault, priv);
      priv.fill(0);
    }
    await call('POST', '/passphrase', { c: ch.c, proof, salt: b64u(salt), auth: b64u(fresh.auth), ...(backupSealed ? { backupSealed } : {}) });
  } finally {
    for (const k of [old.auth, old.vault, fresh.auth, fresh.vault]) k.fill(0);
  }
}
