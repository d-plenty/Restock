import { isNative } from '../stores/http';
import { clearMarket, getKV, marketStatus, refresh } from './db';
import { RestockNative } from './sql/native';

// Shared price history, for testing: the phone downloads hotprices.org's public Coles and
// Woolworths files and keeps a short summary per product (MarketData.java). The files are the
// same for everyone, so nothing about what you track leaves the phone.

export const MARKET_SOURCE = 'hotprices.org';
export const MARKET_URL = 'https://hotprices.org';
/**
 * Rough size of one full download (both files). Not measured yet: the files hold every price
 * change since 2023 for about 60,000 products. Update this once a real download reports its size.
 */
export const MARKET_SIZE_TEXT = 'about 10 to 40 MB';

export interface MarketInfo {
  count: number;
  byChain: Record<string, number>;
  updatedAt?: string;
  lastTry?: { at: string; products: number; bytes: number; errors: Record<string, string> };
}

export async function marketInfo(): Promise<MarketInfo> {
  const [s, lastTry] = await Promise.all([marketStatus(), getKV<MarketInfo['lastTry']>('marketImport')]);
  return { ...s, lastTry };
}

let running: Promise<{ products: number; bytes: number; errors: Record<string, string>; waitingForWifi?: boolean }> | undefined;

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
