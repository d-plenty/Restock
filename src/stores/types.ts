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
  /** 0.9.6: what only Costco's pages say (src/stores/costco.ts). Kept on this phone, like everything from Costco. */
  costco?: CostcoInfo;
}

/** What a Costco page says about a product, beyond price and size. */
export interface CostcoInfo {
  /** Costco's item number ("51210"). */
  itemNumber?: string;
  /** The product page. */
  url?: string;
  /** Where the page files it ("Online Grocery / Snacks"). */
  category?: string;
  /** 'included': the price includes delivery. 'checkout': Business Delivery, shipping added at checkout. */
  delivery?: 'included' | 'checkout';
  /** "Minimum purchase of 2": the least you can buy online. */
  minQty?: number;
  /** States Costco says it can't ship this to ("WA"). */
  cantShipTo?: string[];
  /** "Member Only Item": no price shown without a membership. */
  memberOnlyItem?: boolean;
  /** Costco's own unit price, in the unit it was given in. */
  ownUnit?: { text: string; perBase: number; unit: 'g' | 'ml' | 'ea' };
  /** What the page says is saved on a special, with the dates it's valid. */
  save?: number;
  validFrom?: string;
  validTo?: string;
  /** How many items are in the pack ("36 x 40g" is 36), when the name says. */
  count?: number;
  /** The price for one item in the pack, when there's a count. */
  perItem?: number;
  /** Where the size came from: the product's name, or worked out from Costco's unit price (estimated). */
  sizeFrom?: 'name' | 'estimated';
  /** The labelled lines to show on the product ("Online price, includes delivery", "Minimum 2 when buying online"). */
  notes: string[];
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
