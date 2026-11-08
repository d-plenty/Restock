import { describe, expect, it } from 'vitest';
import { likeThis } from './searchHelp';
import type { StoreProduct } from '../stores/types';

const sp = (chain: string, name: string, price: number, size?: string): StoreProduct => ({
  chain: chain as StoreProduct['chain'],
  storeProductId: name,
  name,
  size,
  price,
  isSpecial: false,
  memberOnly: false,
});

describe('like the one you ticked (0.7.6)', () => {
  const aldi = sp('aldi', 'Toilet Tissue 3 Ply 24 Pack', 8.39, '24 pack');
  const woolies = [
    sp('woolworths', 'Vevelle White 1 Ply Toilet Tissue each', 1.75, '1 each'),
    sp('woolworths', 'Sorbent Flushable Wipes Hypo-Allergenic 40 pack', 3.8, '40 pack'),
    sp('woolworths', 'Quilton 3 Ply Toilet Tissue 24 pack', 11.5, '24 pack'),
    sp('woolworths', 'Woolworths Essentials Toilet Tissue 2 Ply 24 pack', 7.9, '24 pack'),
    sp('woolworths', 'Naturale Recycled 3 Ply Toilet Tissue 12 pack', 4.9, '12 pack'),
  ];
  it('a 24 pack at a similar price, not a single roll or wipes', () => {
    const got = likeThis(aldi, woolies, 'Toilet Tissue 3 Ply', 'toilet paper').map((p) => p.name);
    expect(got[0]).toMatch(/24 pack/);
    expect(got).not.toContain('Sorbent Flushable Wipes Hypo-Allergenic 40 pack');
    expect(got.indexOf('Vevelle White 1 Ply Toilet Tissue each')).toBe(-1);
  });
  it('still offers something when nothing is close in price', () => {
    const got = likeThis(aldi, [sp('coles', 'Kleenex Toilet Tissue 3 Ply 30 pack', 25, '30 pack')], 'Toilet Tissue 3 Ply', 'toilet paper');
    expect(got).toHaveLength(1);
  });
});
