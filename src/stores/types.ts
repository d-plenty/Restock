import type { Chain } from '../types';

/** A product as one store reports it right now. */
export interface StoreProduct {
  chain: Chain;
  storeProductId: string;
  name: string;
  brand?: string;
  size?: string;
  barcode?: string;
  imageUrl?: string;
  price?: number;
  wasPrice?: number;
  isSpecial: boolean;
  memberOnly: boolean;
  promo?: string;
  unitPriceText?: string;
  /** Online stock as the store reports it; undefined when the store doesn't say. */
  inStock?: boolean;
}

export interface StoreAdapter {
  chain: Exclude<Chain, 'other'>;
  /**
   * Search the store by text (used when adding items). Price refreshes run in native code.
   * `page` (from 1) asks for the next lot of results, for shops that can (see `pages`).
   */
  search(term: string, storeId?: string, page?: number): Promise<StoreProduct[]>;
  /** The same search through the store's own page in a hidden browser (the backup connection). */
  searchBrowser?(term: string, storeId?: string, page?: number): Promise<StoreProduct[]>;
  /** The shop can hand over more results, a page at a time (0.8.5). */
  pages?: boolean;
  /**
   * 0.9.1: the same search (first page), without your sign-in: on the cookies in its own jar only
   * (http.ts request's `anonymous`), never the in-app browser's, and never through the hidden
   * browser, even if a direct request is turned away. For barcode lookups (jar "lookup").
   */
  searchAnonymous?(term: string, jar: string): Promise<StoreProduct[]>;
}
