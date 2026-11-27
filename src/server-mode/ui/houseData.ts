// 0.9.4: what the web's house pages (protocol v3) read and change, in one place: the phones on the
// server (add with a name, rename, remove; removed and left ones listed), the browsers signed in,
// activity and logs, Keep data for, the encrypted backup, the recovery key, Home Assistant on the
// server, the household's default branch per shop, and what the phones shared of the specials.

import { useCallback, useEffect, useState } from 'react';
import { getSettings, queryRows, runOps } from '../../lib/db';
import { decode } from '../../lib/sharedSettings';
import { activeSections, chainName, enabledIn, SECTION_NAMES, type Section, type StoreChain } from '../../shops';
import { askPassword } from '../../lib/confirm';
import { api3, ApiError, isV3, type Browser, type Confirm, type HaConfig, type HouseSettings, type Phone } from '../api';
import { errText, phoneName } from './houseWords';
import { confirmPassphrase, session } from '../session';

export const house = () => isV3() && session()?.v === 3;
/** Removing phones and the server's settings need a passphrase sign-in (the server refuses a phone sign-in). */
export const canAdmin = () => !session()?.viaPhone;

/**
 * 0.9.4: the dangerous admin actions ask for the passphrase again: proves it (confirmPassphrase,
 * a few seconds) and does `run` with the proof. A wrong passphrase says so.
 */
async function withConfirm<T>(passphrase: string, run: (c: Confirm) => Promise<T>): Promise<T> {
  try {
    return await run(await confirmPassphrase(passphrase));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'current') throw new Error("That isn't your passphrase.");
    throw e;
  }
}

/** As withConfirm, asking for the passphrase in a sheet first (`detail` says what happens). Undefined if cancelled. */
export async function askThenConfirm<T>(title: string, detail: string, action: string, run: (c: Confirm) => Promise<T>): Promise<T | undefined> {
  const pass = await askPassword(title, { detail: `${detail} Type your passphrase to go ahead.`, action });
  if (!pass) return undefined;
  return withConfirm(pass, run);
}

/** Loads something from the server, with Reload; `undefined` while loading. */
export function useServer<T>(load: () => Promise<T>, deps: unknown[] = []): { data?: T; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && (setData(d), setError(undefined)),
      (e) => live && setError(errText(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ---------- phones ----------

function sortPhones(list: Phone[]): Phone[] {
  const active = (p: Phone) => !p.status || p.status === 'active';
  return [...list].sort((a, b) => Number(active(b)) - Number(active(a)) || (active(a) ? phoneName(a).localeCompare(phoneName(b)) : (b.statusAt ?? '').localeCompare(a.statusAt ?? '')));
}

export const usePhonesV3 = () => useServer(async () => sortPhones(await api3.phones()));

/** An Add a phone code for a phone with this name: the whole restock-server:3 text, and when it runs out. */
export async function newPhoneCode(label: string, admin = false): Promise<{ code: string; until: number }> {
  const r = await api3.addPhone(label.trim(), admin);
  const until =
    typeof r.expiresIn === 'number'
      ? Date.now() + r.expiresIn * (r.expiresIn > 100_000 ? 1 : 1000)
      : typeof r.expires === 'number'
        ? r.expires
        : r.expires
          ? Date.parse(r.expires)
          : Date.now() + 10 * 60_000;
  return { code: r.code, until };
}

// ---------- browsers ----------

export const useBrowsers = () => useServer(() => api3.browsers());
export const browserKind = (b: Browser) => (b.kind === 'phone' ? 'Signed in with a phone' : 'Signed in with the passphrase');
export const isThisBrowser = (b: Browser) => b.current === true || b.id === session()?.sid;


export const useActivity = (logs: boolean) => useServer(() => (logs ? api3.logs() : api3.activity()), [logs]);

// ---------- the server's settings ----------

// 0.9.5 (final review): 0.9.4's KEEP_CHOICES and keepLabel ("Until I delete") are gone: Auto delete's words are in lib/autoDelete.ts.

export const useHouseSettings = () => useServer<HouseSettings>(() => api3.settings());
/** `confirm`: keeping less (data is deleted) needs the passphrase again. */
export const saveHouseSettings = (s: HouseSettings, confirm?: Confirm) => api3.putSettings(s, confirm);

/** The recovery key, to save (shown once the admin asks, with the passphrase again). */
export async function recoveryKey(passphrase: string): Promise<string> {
  const r = await withConfirm(passphrase, (c) => api3.recovery(c));
  const k = r.recovery ?? r.key;
  if (!k) throw new Error("The server didn't send the recovery key.");
  return k;
}

/** Downloads the encrypted backup (D15): the server seals it with this passphrase before it leaves. */
export async function downloadEncryptedBackup(passphrase: string, signIn: string): Promise<string> {
  const { bytes, name } = await withConfirm(signIn, (c) => api3.backup(passphrase, c));
  const file = name ?? `restock-server-backup-${new Date().toISOString().slice(0, 10)}.bin`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  a.download = file;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
  return file;
}

// ---------- Home Assistant on the server ----------

export const useHa = () => useServer<HaConfig>(() => api3.homeAssistant());

// ---------- the household's default branch per shop (design section 15) ----------

/**
 * `branch:<chain>` in household_settings: { name, storeNo? }. The branch phones use for that shop
 * when they haven't picked their own (each phone's own pick still wins). A store number only for
 * Coles (its prices and stock at a store).
 */
export interface DefaultBranch {
  name: string;
  storeNo?: string;
}
export const BRANCH_PREFIX = 'branch:';
const CHAIN = /^[a-z0-9-]{1,60}$/;

export function checkBranch(v: unknown): DefaultBranch | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80) return undefined;
  const storeNo = typeof o.storeNo === 'string' && /^\d{3,5}$/.test(o.storeNo) ? o.storeNo : undefined;
  return { name: o.name.trim(), ...(storeNo ? { storeNo } : {}) };
}

async function defaultBranches(): Promise<Map<string, DefaultBranch>> {
  const rows = await queryRows<{ k: string; v: string }>(`SELECT k, v FROM household_settings WHERE k LIKE 'branch:%'`).catch(() => []);
  const out = new Map<string, DefaultBranch>();
  for (const r of rows) {
    const b = checkBranch(decode(r.v));
    if (b) out.set(r.k.slice(BRANCH_PREFIX.length), b);
  }
  return out;
}

/** Sets (or, with null, clears) a shop's default branch for the household; it goes out with the next sync. */
export async function setDefaultBranch(chain: string, b: DefaultBranch | null): Promise<void> {
  if (!CHAIN.test(chain)) throw new Error('Not a shop Restock knows.');
  const k = BRANCH_PREFIX + chain;
  if (!b) return runOps([{ sql: 'DELETE FROM household_settings WHERE k = ?', params: [k] }]);
  const ok = checkBranch(b);
  if (!ok) throw new Error('Type the branch name, like "Coles Kirwan".');
  await runOps([{ sql: 'INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)', params: [k, JSON.stringify(ok)] }]);
}

/** The household's shops (the ones picked on each tab that's on), with their default branch. */
export async function branchShops(): Promise<{ section: Section; title: string; shops: { chain: StoreChain; name: string; branch?: DefaultBranch }[] }[]> {
  const [s, branches] = await Promise.all([getSettings(), defaultBranches()]);
  return activeSections(s).map((section) => ({
    section,
    title: section === 'pantry' ? 'Groceries' : SECTION_NAMES[section],
    shops: enabledIn(s.enabledChains, section).map((chain) => ({ chain, name: chainName(chain), branch: branches.get(chain) })),
  }));
}

// ---------- specials and catalogues, from what the phones shared ----------

export const https = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

export interface ShopLinks {
  chain: StoreChain;
  name: string;
  website?: string;
  specials?: string;
  catalogue?: string;
  catalogueNote?: string;
}

export * from './houseWords';
