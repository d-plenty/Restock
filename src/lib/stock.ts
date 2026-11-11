// 0.9.9: stock, item by item. For each shop an item is bought at (its usual picks), what that shop
// last said about your branch: in stock, out of stock, or unknown. Only Woolworths (signed in) and
// Coles (with your branch number, and your second Coles too) say anything about your own branch;
// every other shop is "unknown" (an online stock flag isn't about your branch, so it isn't shown).
import { chainName } from '../shops';
import { secondBranch, stockAtBranch, stockKnown, storeChoice, type Product, type Settings } from '../types';

export type StockState = 'in' | 'out' | 'unknown';

export interface StockRow {
  chain: string;
  /** Where: "Coles Thuringowa", "Woolworths Kirwan", or the shop's name. */
  where: string;
  state: StockState;
  /** When it was last checked (ISO), when known. */
  at?: string;
  product: string;
}

type S = Pick<Settings, 'stores' | 'localPrices' | 'accounts'> | undefined;

/** A branch's name for a shop, from your picks: "Coles Thuringowa", else the shop's name. */
export function branchName(s: S, chain: string): string {
  const pick = s ? storeChoice(s as Settings, chain as never).primary : undefined;
  return stockAtBranch(s, chain) ?? pick ?? chainName(chain);
}

/** One row per shop (the first pick at each), plus your second Coles when its stock is checked. */
export function stockRows(products: Pick<Product, 'chain' | 'name' | 'inStock' | 'inStock2' | 'stockAt'>[], s: S): StockRow[] {
  const out: StockRow[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    if (!p.chain || p.chain === 'other' || seen.has(p.chain)) continue;
    seen.add(p.chain);
    const known = stockKnown(s, p.chain) && p.inStock !== undefined;
    out.push({
      chain: p.chain,
      where: branchName(s, p.chain),
      state: known ? (p.inStock ? 'in' : 'out') : 'unknown',
      at: known ? p.stockAt : undefined,
      product: p.name,
    });
    const second = p.chain === 'coles' ? secondBranch(s) : undefined;
    if (second)
      out.push({
        chain: p.chain,
        where: second,
        state: p.inStock2 === undefined ? 'unknown' : p.inStock2 ? 'in' : 'out',
        at: p.inStock2 === undefined ? undefined : p.stockAt,
        product: p.name,
      });
  }
  return out;
}

/** The short tag: "In stock", "Out at Coles Thuringowa", "Out everywhere checked" or "Stock unknown". */
export function stockTag(rows: StockRow[]): { kind: 'in' | 'some' | 'out' | 'unknown'; text: string } {
  const known = rows.filter((r) => r.state !== 'unknown');
  if (!known.length) return { kind: 'unknown', text: 'Stock unknown' };
  const outs = known.filter((r) => r.state === 'out');
  if (!outs.length) return { kind: 'in', text: 'In stock' };
  if (outs.length === known.length) return { kind: 'out', text: known.length === 1 ? `Out at ${outs[0].where}` : 'Out everywhere checked' };
  return { kind: 'some', text: `Out at ${outs[0].where}${outs.length > 1 ? ` +${outs.length - 1}` : ''}` };
}

/**
 * Where to shop by stock: the branch with the most of your list's items in stock, when it beats your
 * main branch of the same shop. "Go to Coles Kirwan: 2 items are out at Coles Thuringowa."
 */
export function branchAdvice(lines: StockRow[][]): string | undefined {
  // Rows come main branch first for each shop (stockRows), so the first one seen is your main branch.
  const main = new Map<string, string>();
  const byWhere = new Map<string, { chain: string; ins: number; outs: number }>();
  for (const rows of lines)
    for (const r of rows) {
      if (!main.has(r.chain)) main.set(r.chain, r.where);
      if (r.state === 'unknown') continue;
      const w = byWhere.get(r.where) ?? { chain: r.chain, ins: 0, outs: 0 };
      if (r.state === 'in') w.ins++;
      else w.outs++;
      byWhere.set(r.where, w);
    }
  for (const [chain, where] of main) {
    const m = byWhere.get(where);
    if (!m?.outs) continue;
    const other = [...byWhere].find(([k, v]) => k !== where && v.chain === chain && v.outs < m.outs);
    if (other) return `Go to ${other[0]}: ${m.outs} item${m.outs === 1 ? ' is' : 's are'} out at ${where}.`;
  }
  return undefined;
}
