import { describe, expect, it } from 'vitest';
import { cleanName, unwrapImage } from './webPage';
import { flattenEndeavour } from './endeavour';

describe('pictures and names (0.7.6)', () => {
  it('uses the real picture behind a Next.js image link', () => {
    expect(
      unwrapImage(
        'https://www.chemistwarehouse.com.au/_next/image?url=https%3A%2F%2Fstatic.chemistwarehouse.com.au%2Fams%2Fmedia%2Fpi%2F149154%2FF2D_800.jpg&w=3840&q=75',
      ),
    ).toBe('https://static.chemistwarehouse.com.au/ams/media/pi/149154/F2D_800.jpg');
    expect(unwrapImage('https://x.com/a.jpg')).toBe('https://x.com/a.jpg');
  });
  it('drops a brand shown twice', () => {
    expect(cleanName('ApoHealth ApoHealth Paracetamol 500mg')).toBe('ApoHealth Paracetamol 500mg');
    expect(cleanName('Blackmores Bio C Blackmores Bio C 1000mg')).toBe('Blackmores Bio C 1000mg');
    expect(cleanName('Bonne Maman Jam')).toBe('Bonne Maman Jam');
  });
});

describe("Dan Murphy's and BWS packs (0.7.6)", () => {
  const item = (id: string, qty: string, type: string, price: number) => ({
    Stockcode: id,
    Name: 'Great Northern Original Lager Cans 375ml',
    Prices: { singleprice: { Value: price } },
    AdditionalDetails: [
      { Name: 'displayunitquantity', Value: qty },
      { Name: 'webpacktype', Value: type },
      { Name: 'liquorsize', Value: '375ML' },
    ],
  });
  it('says which is the single, the pack and the case', () => {
    const out = flattenEndeavour('bws', {
      Items: [{ Products: [item('1', '1', 'Can', 5.5), item('2', '6', 'Pack', 22), item('3', '30', 'Case', 68)] }],
    });
    expect(out.map((p) => p.name)).toEqual([
      'Great Northern Original Lager Cans 375ml',
      'Great Northern Original Lager Cans 375ml · 6 Pack',
      'Great Northern Original Lager Cans 375ml · Case of 30',
    ]);
    expect(out[2].size).toBe('30 x 375ML');
  });
});
