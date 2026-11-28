// 0.18.0: the phones on the household's Restock server, from an admin phone (Settings → Sync →
// Restock server → Phones and tablets). The server says which phones are admins: an admin adds
// phones and tablets (a code to scan, for a user or an admin), renames them, makes them admins or
// users, and removes them, as the web page does. Every request and answer goes sealed with the
// household's server key (RestockNative.serverAdmin), and the server checks each one.
import { RestockNative } from './sql/native';
import type { Phone } from '../server-mode/api';

export type Role = 'admin' | 'user';
export type { Phone };

/**
 * One request. 0.18.1: after a phone is removed the household has a new key, and the server answers
 * with it: an answer this phone can't open yet means it hasn't taken the new key, so it syncs (and
 * takes it) and asks once more.
 */
async function admin(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ask = () => RestockNative.serverAdmin({ method, path, ...(body ? { body } : {}) });
  try {
    return await ask();
  } catch (e) {
    if (method === 'DELETE' || !/couldn.t be opened with this household.s keys/i.test(e instanceof Error ? e.message : String(e))) throw e;
    await RestockNative.syncNow().catch(() => undefined);
    return ask();
  }
}

/** What this phone is on its server; null on a server from before 0.18.0 (no roles there) or out of reach. */
export async function myRole(): Promise<Role | null> {
  try {
    const r = await admin('GET', '/me');
    return r.role === 'admin' ? 'admin' : 'user';
  } catch {
    return null;
  }
}

const active = (p: Phone) => !p.status || p.status === 'active';
export const phoneLabel = (p: Phone) => p.label || p.name || 'Phone';

/** The server's phones: this one first, then the others on it by name, then removed and left ones. */
export async function serverPhones(): Promise<Phone[]> {
  const r = await admin('GET', '/phones');
  const list = Array.isArray(r.phones) ? (r.phones as Phone[]) : [];
  return [...list].sort((a, b) => Number(active(b)) - Number(active(a)) || Number(!!b.me) - Number(!!a.me) || phoneLabel(a).localeCompare(phoneLabel(b)));
}

/** A code for a new phone or tablet: the whole restock-server:3 text, and when it runs out. */
/** `replaces`: 0.18.4, a lost phone the new one takes the place of (its role, and its backup to put back). */
export async function newCode(label: string, makeAdmin: boolean, replaces?: string): Promise<{ code: string; until: number }> {
  const r = await admin('POST', '/phones', { label: label.trim(), ...(makeAdmin && !replaces ? { admin: true } : {}), ...(replaces ? { replaces } : {}) });
  const secs = typeof r.expiresIn === 'number' ? r.expiresIn : 600;
  if (typeof r.code !== 'string' || !r.code.startsWith('restock-server:3?')) throw new Error("The server's answer had no code in it.");
  return { code: r.code, until: Date.now() + secs * 1000 };
}

export const renamePhone = (device: string, label: string) => admin('PATCH', `/phones/${encodeURIComponent(device)}`, { label: label.trim() });
export const setRole = (device: string, role: Role) => admin('PATCH', `/phones/${encodeURIComponent(device)}`, { role });

/** Remove: it stops syncing, and the household gets a new key (this phone takes it at its next sync). */
export async function removePhone(device: string): Promise<void> {
  await admin('DELETE', `/phones/${encodeURIComponent(device)}`, {});
  // 0.18.1: waited for, so the list that shows next opens with the new key (it didn't, now and then).
  await RestockNative.syncNow().catch(() => undefined);
}
