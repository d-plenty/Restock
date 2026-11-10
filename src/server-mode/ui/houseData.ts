// 0.9.4: what the web's house pages (protocol v3) read and change, in one place: the phones on the
// server (add with a name, rename, remove; removed and left ones listed), the browsers signed in,
// activity and logs, Keep data for, the encrypted backup, the recovery key, Home Assistant on the
// server, the household's default branch per shop, and what the phones shared of the specials.

import { useCallback, useEffect, useState } from 'react';
import { getSettings, queryRows, runOps } from '../../lib/db';
import { decode } from '../../lib/sharedSettings';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, enabledIn, SECTION_NAMES, shopDef, websiteOf, type Section, type StoreChain } from '../../shops';
import { askPassword } from '../../lib/confirm';
import { api3, ApiError, isV3, serverInfo, type Activity, type Browser, type Confirm, type HaConfig, type HouseSettings, type Phone } from '../api';
import { sharedSpecials, type SharedSpecials } from '../live';
import { confirmPassphrase, session } from '../session';

export const house = () => isV3() && session()?.v === 3;
/** Removing phones and the server's settings need a passphrase sign-in (the server refuses a phone sign-in). */
export const canAdmin = () => !session()?.viaPhone;
export const ADMIN_NOTE = 'Signed in with a phone: sign in with the passphrase to change this.';
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 0.9.4: the dangerous admin actions ask for the passphrase again: proves it (confirmPassphrase,
 * a few seconds) and does `run` with the proof. A wrong passphrase says so.
 */
export async function withConfirm<T>(passphrase: string, run: (c: Confirm) => Promise<T>): Promise<T> {
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

const TAB_WORD: Record<string, string> = { pantry: 'Pantry, Shopping list', keg: 'Keg', pharmacy: 'Pharmacy' };

/** "Shares Pantry, Shopping list, Keg · receipts" (what the phone said it shares, D9). */
export function sharesText(p: Phone): string {
  const s = p.shares;
  if (!s) return p.api === 2 ? 'Shares what the household shared (Restock 0.9.3)' : 'Shares nothing yet';
  const bits = (s.tabs ?? []).map((t) => TAB_WORD[t] ?? t);
  if (s.receipts) bits.push('receipts');
  if (s.cards) bits.push('loyalty cards');
  return bits.length ? `Shares ${bits.join(', ')}` : 'Shares nothing';
}

export const phoneName = (p: Phone) => p.label || p.name || 'Phone';

export function dayText(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

/** Active ones first (by name), then removed and left ones, newest first. */
export function sortPhones(list: Phone[]): Phone[] {
  const active = (p: Phone) => !p.status || p.status === 'active';
  return [...list].sort((a, b) => Number(active(b)) - Number(active(a)) || (active(a) ? phoneName(a).localeCompare(phoneName(b)) : (b.statusAt ?? '').localeCompare(a.statusAt ?? '')));
}

export const usePhonesV3 = () => useServer(async () => sortPhones(await api3.phones()));

/** An Add a phone code for a phone with this name: the whole restock-server:3 text, and when it runs out. */
export async function newPhoneCode(label: string): Promise<{ code: string; until: number }> {
  const r = await api3.addPhone(label.trim());
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

// ---------- activity and logs ----------

type Detail = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.length < 120 ? v : undefined);
const fileWord = (f: unknown) => {
  const n = str(f) ?? '';
  if (/^restock-sync-srv-/.test(n)) return "the server's file";
  if (/^restock-sync-web-/.test(n)) return "the web page's changes";
  if (/^restock-sync-/.test(n)) return 'its changes';
  if (n.startsWith('archive/')) return 'older prices';
  if (n.startsWith('photos/')) return 'a photo';
  if (n.startsWith('keys/')) return 'new keys';
  return 'a file';
};

/**
 * What happened, in words, from srv_log's `what` and `detail` (the server notes the one who did it
 * as `device`, and what it was done to in `detail`). Unknown ones show as they are, tidied.
 */
const ACT: Record<string, (d: Detail, name: (device: unknown) => string | undefined) => string> = {
  upload: (d) => `sent ${fileWord(d.file)}`,
  write: (d) => `sent ${fileWord(d.file)}`,
  fetch: (d) => `fetched ${fileWord(d.file)}`,
  delete: (d) => `deleted ${fileWord(d.file)}`,
  'changes-in': (d) => (typeof d.changes === 'number' ? `brought ${d.changes} change${d.changes === 1 ? '' : 's'}` : 'brought changes'),
  'phone-joined': (d) => (d.how === 'member' ? 'joined through the household' : d.how === 'bring' ? 'brought its household onto the server' : 'joined'),
  'phone-upgraded': () => 'moved to Restock 0.9.4',
  'phone-left': () => 'left',
  'phone-removed': (d, name) => `removed ${str(d.name) ?? name(d.device) ?? 'a phone'}`,
  'phone-renamed': (d) => `renamed a phone ${str(d.label) ?? ''}`.trim(),
  'invite-made': (d) => (str(d.label) ? `made a code to add ${str(d.label)}` : 'made a code to add a phone'),
  'signed-in': (d) => (d.kind === 'phone' ? 'signed a browser in with a phone' : 'signed in'),
  login: () => 'signed in',
  'login-failed': () => 'a wrong passphrase was tried',
  'locked-out': () => 'locked out after wrong tries',
  'browser-signed-out': () => 'signed a browser out',
  'signed-out-everywhere': () => 'signed out everywhere',
  'passphrase-changed': () => 'changed the passphrase',
  'passphrase-change-refused': () => 'was refused a new passphrase (not the current one)',
  'passphrase-reset': () => 'the passphrase was reset',
  'set-up': (d) => `set up the server${str(d.name) ? ` as ${str(d.name)}` : ''}`,
  'house-made': (d) => `made the house${str(d.name) ? ` ${str(d.name)}` : ''}`,
  'handover-code': () => 'made a handover code',
  'handover-done': () => 'took the household over from the owner phone',
  'handover-refused': () => "couldn't take the household over (nothing changed)",
  'handover-rolled-back': () => 'undid an unfinished handover (nothing changed)',
  'household-brought': () => 'brought its household onto the server',
  'household-taken-back': () => 'took the household back with the recovery key',
  'settings-changed': (d) => (d.keepMonths === null ? 'set Keep data for to Until I delete' : typeof d.keepMonths === 'number' ? `set Keep data for to ${d.keepMonths} months` : 'changed the settings'),
  pruned: () => 'deleted data older than Keep data for',
  'recovery-key-shown': () => 'looked at the recovery key',
  'backup-downloaded': () => 'downloaded an encrypted backup',
  'home-assistant-changed': (d) => (d.enabled === true ? 'turned Home Assistant on' : d.enabled === false ? 'turned Home Assistant off' : 'changed Home Assistant'),
  'home-assistant-refused': () => "was refused running Home Assistant (the server runs it)",
  'web-sign-in-approved': () => 'let a browser sign in',
  trashed: (d) => `moved ${fileWord(d.file)} to the trash (kept 30 days)`,
  'trash-emptied': () => 'emptied files over 30 days old from the trash',
  'photo-kept': () => 'let go of a photo another phone put on the server',
  merged: (d) => (typeof d.changes === 'number' ? `had ${d.changes} change${d.changes === 1 ? '' : 's'} merged` : typeof d.added === 'number' ? `had ${d.added} older price${d.added === 1 ? '' : 's'} kept` : 'had a file merged'),
  'merge-failed': (d) => `couldn't merge a file${str(d.error) ? `: ${str(d.error)}` : ''}`,
  'merge-unreadable': () => "couldn't open a file (another key?)",
  compacted: () => 'tidied old deletes',
  'home-assistant': (d) => `synced the shopping list with Home Assistant${typeof d.came === 'number' ? ` (${d.came} in, ${d.went ?? 0} out)` : ''}`,
  'home-assistant-failed': (d) => `couldn't reach Home Assistant${str(d.message) ? `: ${str(d.message)}` : ''}`,
  'server-row-updated': () => 'told the phones where it is',
};

/** "Declan's phone", "This browser", "A browser", "The server", from who did it (`device`). */
export function whoOf(a: Activity, phones: Phone[] | undefined): string {
  const d = a.device ?? a.by;
  if (!d) return a.who && a.who !== 'Web page' ? a.who : a.who === 'Web page' ? 'A browser' : 'The server';
  if (d.startsWith('srv-')) return 'The server';
  if (d.startsWith('web')) return d === `web-${session()?.webId}` ? 'This browser' : 'A browser';
  const p = phones?.find((x) => x.device === d);
  return p ? phoneName(p) : (a.who ?? 'A removed phone');
}

export function whatOf(a: Activity, phones?: Phone[]): string {
  const d: Detail = a.detail && typeof a.detail === 'object' ? (a.detail as Detail) : {};
  const name = (device: unknown) => {
    const p = phones?.find((x) => x.device === device);
    return p ? phoneName(p) : undefined;
  };
  const f = ACT[a.what];
  if (f) return f(d, name);
  return a.what.replace(/[-_]/g, ' ') + (typeof a.detail === 'string' && a.detail.length < 160 ? ` · ${a.detail}` : '');
}

/** A row about something going wrong (shown in red). */
export const isTrouble = (a: Activity) => a.kind === 'error' || /failed|refused|unreadable|locked/.test(a.what);

export const useActivity = (logs: boolean) => useServer(() => (logs ? api3.logs() : api3.activity()), [logs]);

// ---------- the server's settings ----------

export const KEEP_CHOICES: { months: number | null; label: string }[] = [
  { months: 3, label: '3 months' },
  { months: 6, label: '6 months' },
  { months: 9, label: '9 months' },
  { months: 12, label: '12 months' },
  { months: null, label: 'Until I delete' },
];
export const keepLabel = (m: number | null | undefined) => KEEP_CHOICES.find((c) => c.months === (m === undefined ? 12 : m))?.label ?? `${m} months`;

export const useHouseSettings = () => useServer<HouseSettings>(() => api3.settings());
/** `confirm`: keeping less (data is deleted) needs the passphrase again. */
export const saveHouseSettings = (s: HouseSettings, confirm?: Confirm) => api3.putSettings(s, confirm);
/** "Delete older data now" (Until I delete): prices, receipts and logs before this day. */
export const pruneBefore = (iso: string, confirm: Confirm) => api3.prune(iso, confirm);

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

export async function defaultBranches(): Promise<Map<string, DefaultBranch>> {
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

/** The shops' own specials pages, where Restock knows them for sure. */
export const SPECIALS_URL: Partial<Record<string, string>> = {
  woolworths: 'https://www.woolworths.com.au/shop/browse/specials',
  coles: 'https://www.coles.com.au/on-special',
  aldi: 'https://www.aldi.com.au/special-buys',
};

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

/** Every shop the household follows, by tab, with its website, specials and catalogue links (like the phone). */
export async function followedShops(): Promise<{ section: Section; title: string; shops: ShopLinks[] }[]> {
  const [s, shared] = await Promise.all([getSettings(), sharedSpecials()]);
  return activeSections(s)
    .map((section) => ({
      section,
      title: section === 'pantry' ? 'Groceries' : SECTION_NAMES[section],
      shops: enabledIn(s.enabledChains, section).map((chain) => {
        const known = shopDef(chain)?.catalogue;
        const found = shared.catalogues[chain];
        return {
          chain,
          name: chainName(chain),
          website: https(websiteOf(chain)),
          specials: SPECIALS_URL[chain],
          catalogue: https(known?.url) ?? https(found?.url),
          catalogueNote: known?.note ?? found?.note,
        };
      }),
    }))
    .filter((g) => g.shops.length > 0);
}

export const useShared = () => useLive<SharedSpecials>(sharedSpecials, []);
export const useFollowed = () => useLive(followedShops, []);

/** "Restock 0.9.4 server · v3", for About. */
export const serverLine = () => {
  const i = serverInfo();
  return i?.version ? `Restock server ${i.version}` : 'Restock server';
};
