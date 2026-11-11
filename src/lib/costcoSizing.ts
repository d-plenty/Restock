import type { Sizing } from '../types';
import { packSize } from './units';

// 0.9.6: Costco's pack size, for unitPrice.ts. Most Costco sizes are in the name ("36 x 40g") and are read like
// any shop's. When the name has none, stores/costco.ts works a size out from Costco's own unit price and
// writes it as "1.5kg (estimated)". This reads that back as an estimated size, so the comparison price says
// "(estimated)" and the person can confirm it, instead of passing for a size the shop gave.

const ESTIMATED = /\(estimated\)\s*$/i;

/** The size of a Costco product when it was worked out from Costco's unit price (an estimate); otherwise nothing (read the words as usual). */
export function costcoEstimatedSize(p: { chain?: string; name: string; size?: string }): { size: NonNullable<Sizing['size']>; packCount?: number } | undefined {
  if (p.chain !== 'costco' || !p.size || !ESTIMATED.test(p.size)) return undefined;
  const s = packSize(p.size.replace(ESTIMATED, ''), undefined);
  if (!s || s.unit === 'ea') return undefined;
  return { size: { qty: s.qty, unit: s.unit, basis: 'estimated', from: 'costco' }, packCount: packSize(undefined, p.name)?.count };
}
