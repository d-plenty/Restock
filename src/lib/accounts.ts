import { RestockNative } from './sql/native';
import { getSettings, updateSettings } from './db';
import { isNative, viaBrowser } from '../stores/http';
import type { ShopAccount } from '../types';
import { tidyRecording, type RecordedCall } from './recording';

// Signing in to a shop's account inside Restock. You sign in on the shop's own website, in
// Restock's built-in browser: your password goes to the shop, never to Restock. Restock then asks
// the shop's website things as you (your store's prices and stock, filling your trolley), the way
// the website itself does. Only Woolworths needs this: Coles answers for any store by its number.

/** Woolworths' sign-in page, on its own site. */
const WOOLIES_SIGN_IN = '/shop/securelogin';

type Raw = Record<string, unknown>;

/** Finds the first value for any of these keys, anywhere in the shop's answer (case doesn't matter). */
function find(data: unknown, keys: string[], depth = 0): unknown {
  if (!data || typeof data !== 'object' || depth > 5) return undefined;
  for (const [k, v] of Object.entries(data as Raw)) if (keys.includes(k.toLowerCase()) && v !== null && v !== '') return v;
  for (const v of Object.values(data as Raw)) {
    const hit = find(v, keys, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** What Woolworths says about whoever is signed in to its website (its /apis/ui/Shopper answer). */
export function readShopper(data: unknown): ShopAccount {
  const guest = find(data, ['isguest', 'isanonymous']);
  const loggedIn = find(data, ['isloggedin', 'isauthenticated']);
  const signedIn = loggedIn === true || (guest === false && loggedIn !== false);
  const id = find(data, ['fulfilmentstoreid', 'pickupstoreid', 'storeid', 'storeno']);
  const name = find(data, ['fulfilmentstorename', 'pickupstorename', 'storename', 'storesuburb']);
  return {
    signedIn,
    storeId: id !== undefined && id !== 0 ? String(id) : undefined,
    storeName: typeof name === 'string' && name.trim() ? name.trim() : undefined,
    checkedAt: new Date().toISOString(),
  };
}

/** Asks Woolworths whether you're signed in, and which store your account shops at, and saves it. */
export async function checkWoolworths(): Promise<ShopAccount> {
  if (!isNative()) throw new Error('Signing in works in the Android app.');
  const r = await viaBrowser('woolworths', 'GET', '/apis/ui/Shopper');
  const text = r.text.trim();
  if (r.status >= 400 || !text.startsWith('{')) throw new Error(`Woolworths didn't answer (${r.status || 'no connection'})`);
  const account = readShopper(JSON.parse(text));
  const s = await getSettings();
  await updateSettings({ accounts: { ...(s.accounts ?? {}), woolworths: account } });
  return account;
}

/** Opens Woolworths' own sign-in page in Restock's browser, then checks how it went. */
export async function signInWoolworths(): Promise<ShopAccount> {
  if (!isNative()) throw new Error('Signing in works in the Android app.');
  await RestockNative.openStore({
    chain: 'woolworths',
    path: WOOLIES_SIGN_IN,
    message: 'Sign in to your Woolworths account. If it asks, pick your local shop (Pick up). Then tap Done.',
  });
  return checkWoolworths();
}

/** Opens Woolworths so you can choose your store (or sign out) on its website. */
export async function openWoolworths(message: string): Promise<void> {
  if (!isNative()) return;
  await RestockNative.openStore({ chain: 'woolworths', message });
}

/** Stops Restock using your Woolworths account (sign out on the website too, to end the session there). */
export async function stopUsingWoolworths(): Promise<void> {
  const s = await getSettings();
  await updateSettings({ accounts: { ...(s.accounts ?? {}), woolworths: { signedIn: false, checkedAt: new Date().toISOString() } } });
}

// ---------- Coles ----------

/**
 * Opens Coles in Restock's browser to sign in. Coles doesn't need this for your store's prices and
 * stock (its store number does that); it's for filling your Coles trolley, once a recording has
 * shown how Coles' website does it. Coles doesn't say who's signed in, so you confirm it.
 */
export async function signInColes(confirmed: () => Promise<boolean>): Promise<ShopAccount | undefined> {
  if (!isNative()) throw new Error('Signing in works in the Android app.');
  await RestockNative.openStore({ chain: 'coles', message: 'Tap "Log in" at the top of the page and sign in to your Coles account. Then tap Done.' });
  if (!(await confirmed())) return undefined;
  const account: ShopAccount = { signedIn: true, checkedAt: new Date().toISOString() };
  const s = await getSettings();
  await updateSettings({ accounts: { ...(s.accounts ?? {}), coles: account } });
  return account;
}

export async function stopUsingColes(): Promise<void> {
  const s = await getSettings();
  await updateSettings({ accounts: { ...(s.accounts ?? {}), coles: { signedIn: false, checkedAt: new Date().toISOString() } } });
}

// ---------- recording a trolley ----------

/**
 * Records what a shop's website does while you add one item to your trolley, so Restock can learn
 * to do it for you. Returns the tidied calls (the shop's own API only, personal details removed).
 */
export async function recordTrolley(chain: 'coles' | 'woolworths'): Promise<RecordedCall[]> {
  if (!isNative()) throw new Error('Recording works in the Android app.');
  const out = await RestockNative.openStore({
    chain,
    record: true,
    message: 'Recording. Add any one item to your trolley (or change how many). Then tap Done.',
  });
  return tidyRecording(out?.recording, chain === 'coles' ? 'https://www.coles.com.au/' : 'https://www.woolworths.com.au/');
}

// ---------- picking your Coles store (0.7.2) ----------

/** "…/find-stores/coles/qld/bohle-plains-0844" → { storeNo: '0844', name: 'Coles Bohle Plains' }. */
export function colesStoreFromPage(url: string): { storeNo: string; name: string } | undefined {
  const m = /\/find-stores\/(?:[^/?#]+\/)*([a-z0-9-]+?)-(\d{3,5})\/?(?:[?#].*)?$/i.exec(url.trim());
  if (!m) return undefined;
  const suburb = m[1]
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return { storeNo: m[2], name: `Coles ${suburb}` };
}

/**
 * Opens Coles' store finder in Restock's browser. As soon as you open your store's page, it closes
 * by itself and brings back that store's number (Coles keeps it at the end of the page's address),
 * so there's nothing to copy. Undefined if you close it first.
 */
export async function pickColesStore(): Promise<{ storeNo: string; name: string } | undefined> {
  if (!isNative()) throw new Error('Choosing your branch works in the Android app.');
  const out = await RestockNative.openStore({
    chain: 'coles',
    path: '/find-stores',
    pickStore: true,
    message: 'Search your suburb, then tap your Coles shop. Restock picks up its number by itself.',
  });
  return out && out.storePage ? colesStoreFromPage(out.storePage) : undefined;
}
