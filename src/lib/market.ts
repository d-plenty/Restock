import { isNative } from '../stores/http';
import { clearMarket, getKV, marketStatus, refresh } from './db';
import { RestockNative } from './sql/native';

// Shared price history ("Judge new items from day one"): the phone downloads restock-prices'
// day-one files (Restock's own weekly collection on GitHub) for the shops it uses, and keeps a short
// summary per product (MarketData.java). 0.9.13: 8 weeks, 6 months or 12 months, and never from
// hotprices.org (the collector folds that in). The files are the same for everyone, so nothing about
// what you track leaves the phone.

export const MARKET_SOURCE = 'restock-prices';
/** Where the files are, for the words in Setup and Settings. */
export const MARKET_SOURCE_TEXT = "restock-prices (Restock's own weekly price collection, public on GitHub)";
const WINDOW_BASE = 'https://raw.githubusercontent.com/d-plenty/restock-prices/main/window/';

/** The three lengths, as Settings shows them. */
export const MARKET_WINDOWS = [
  { days: 56, label: '8 weeks' },
  { days: 182, label: '6 months' },
  { days: 365, label: '12 months' },
] as const;
export type MarketDays = (typeof MARKET_WINDOWS)[number]['days'];

/** The shops restock-prices collects. Others (bottle shops, chemists) have no shared history yet. */
export const MARKET_SHOPS = ['coles', 'woolworths', 'aldi', 'costco'] as const;

/**
 * Until the collector's window/index.json says (it lists each file's real size), a rough guide:
 * products per shop, and bytes per product in each download. A phone keeps one short summary per
 * product (about 120 bytes with its index) whichever length is chosen.
 */
const GUESS_PRODUCTS: Record<string, number> = { coles: 25_000, woolworths: 24_000, aldi: 6_000, costco: 3_500 };
const GUESS_BYTES_EACH: Record<MarketDays, number> = { 56: 14, 182: 24, 365: 36 };
const STORED_BYTES_EACH = 120;

export interface WindowIndex {
  shops?: Record<string, { to: string; products: number; bytes: Record<string, number> }>;
}

let indexCache: Promise<WindowIndex | undefined> | undefined;

/** window/index.json (a few hundred bytes), or undefined when it can't be fetched. */
export function windowIndex(): Promise<WindowIndex | undefined> {
  indexCache ??= fetch(`${WINDOW_BASE}index.json`, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<WindowIndex>) : undefined))
    .catch(() => undefined)
    .then((v) => {
      if (!v) indexCache = undefined; // try again next time
      return v;
    });
  return indexCache;
}

/**
 * Roughly what one length costs for these shops: the weekly download and what stays on the phone.
 * `measured`: from the collector's own file sizes, not a guess.
 */
export function windowCost(days: MarketDays, chains: readonly string[], index?: WindowIndex): { download: number; stored: number; measured: boolean; shops: string[] } {
  const shops = chains.filter((c) => (MARKET_SHOPS as readonly string[]).includes(c));
  let download = 0;
  let stored = 0;
  let measured = shops.length > 0;
  for (const c of shops) {
    const real = index?.shops?.[c];
    const products = real?.products ?? GUESS_PRODUCTS[c] ?? 5_000;
    const bytes = real?.bytes?.[String(days)];
    if (bytes === undefined) measured = false;
    download += bytes ?? products * GUESS_BYTES_EACH[days];
    stored += products * STORED_BYTES_EACH;
  }
  return { download, stored, measured, shops };
}

export interface MarketInfo {
  count: number;
  byChain: Record<string, number>;
  updatedAt?: string;
  lastTry?: { at: string; products: number; bytes: number; errors: Record<string, string>; days?: number; missing?: string[] };
}

export async function marketInfo(): Promise<MarketInfo> {
  const [s, lastTry] = await Promise.all([marketStatus(), getKV<MarketInfo['lastTry']>('marketImport')]);
  return { ...s, lastTry };
}

let running: Promise<{ products: number; bytes: number; errors: Record<string, string>; missing?: string[]; waitingForWifi?: boolean }> | undefined;

/** Download now. Resolves with how many products were summarised and how much was downloaded. */
export function downloadMarket(onProgress?: (chain: string, bytes: number, products: number) => void, opts: { onlyUnmetered?: boolean } = {}) {
  if (!running) running = doDownload(onProgress, opts).finally(() => (running = undefined));
  return running;
}

async function doDownload(onProgress: ((chain: string, bytes: number, products: number) => void) | undefined, opts: { onlyUnmetered?: boolean }) {
  if (!isNative()) throw new Error('Downloading shared price history works in the Android app.');
  const handle = await RestockNative.addListener('marketProgress', (e) => onProgress?.(e.chain, e.bytes, e.products));
  try {
    return await RestockNative.importMarket({ onlyUnmetered: !!opts.onlyUnmetered });
  } finally {
    await handle.remove();
    refresh();
  }
}

export async function removeMarket(): Promise<void> {
  await clearMarket();
}

export const megabytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
