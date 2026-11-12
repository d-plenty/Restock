import { useState } from 'react';
import { stockRows, stockTag, type StockRow } from '../lib/stock';
import { cachedSettings } from '../lib/db';
import type { Product } from '../types';
import { ChainDot, Sheet, timeAgo } from './components';

const WORDS: Record<StockRow['state'], string> = { in: 'In stock', out: 'Out of stock', unknown: 'Stock unknown' };

/** 0.9.9: why a shop's stock is unknown, in a few words. */
function whyUnknown(chain: string): string {
  if (chain === 'woolworths') return 'Sign in to Woolworths (Settings → Supermarkets (Pantry tab)) to see your branch’s stock.';
  if (chain === 'coles') return 'Pick your Coles branch (Settings → Supermarkets (Pantry tab)) to see its stock.';
  if (chain === 'aldi') return 'Aldi doesn’t say what’s in stock.';
  if (chain === 'costco') return 'Costco doesn’t say what’s in stock at a warehouse.';
  return 'This shop doesn’t tell Restock about stock at your branch.';
}

/**
 * 0.9.9: a small stock tag ("In stock", "Out at Coles Thuringowa", "Stock unknown") for an item or a
 * list line. Tap it: every shop and branch, in stock, out or unknown, and when it was checked.
 */
export function StockTag({ products, name }: { products: Pick<Product, 'chain' | 'name' | 'inStock' | 'inStock2' | 'stockAt'>[]; name: string }) {
  const [open, setOpen] = useState(false);
  const rows = stockRows(products, cachedSettings());
  if (!rows.length) return null;
  const tag = stockTag(rows);
  const cls = tag.kind === 'in' ? 'good' : tag.kind === 'unknown' ? 'normal' : 'wait';
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className={`tag ${cls} stock-tag`}
        aria-label={`${tag.text}. Tap for stock at each shop`}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {tag.text.toUpperCase()}
      </span>
      {open && (
        // The sheet sits inside a row that opens the item: taps in it stay in it.
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'contents' }}>
        <Sheet title={`Stock: ${name}`} onClose={() => setOpen(false)}>
          <div className="card flush">
            {rows.map((r) => (
              <div key={`${r.chain}-${r.where}`} className="row" style={{ alignItems: 'flex-start' }}>
                <ChainDot chain={r.chain as Product["chain"]} />
                <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="title" style={{ fontSize: 15 }}>
                    {r.where}
                  </span>
                  <span className="small">{r.state === 'unknown' ? whyUnknown(r.chain) : `${r.product}${r.at ? ` · checked ${timeAgo(r.at)}` : ''}`}</span>
                </span>
                <span className={`tag ${r.state === 'in' ? 'good' : r.state === 'out' ? 'wait' : 'normal'}`}>{WORDS[r.state].toUpperCase()}</span>
              </div>
            ))}
          </div>
          <p className="small">Stock is what each shop said at the last price check. It can change during the day.</p>
        </Sheet>
        </span>
      )}
    </>
  );
}
