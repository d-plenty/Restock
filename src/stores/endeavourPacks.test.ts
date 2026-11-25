import { describe, expect, it } from 'vitest';
import { countIn, flattenEndeavour, mapEndeavourAll, unitOf } from './endeavour';

// 0.10.7: Dan Murphy's sells one stock code as a pack and a case. Before, the case's name went out
// with the pack's price ("4 Pines Dark Lager Can 6x4x375mL" at $17.99, which is the 4 pack).

const dm = (name: string, prices: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  Stockcode: '123',
  Name: name,
  Prices: prices,
  AdditionalDetails: [{ Name: 'webliquorsize', Value: '375ML' }],
  ...extra,
});

describe('0.10.7 Dan Murphy\'s packs and cases', () => {
  it('reads what a price is for', () => {
    expect(unitOf('per case of 24')).toEqual({ kind: 'case', qty: 24 });
    expect(unitOf('Pack (4)')).toEqual({ kind: 'pack', qty: 4 });
    expect(unitOf('per bottle')).toEqual({ kind: 'single', qty: 1 });
    expect(unitOf('2 for $55')).toBeUndefined();
    expect(unitOf(undefined)).toBeUndefined();
  });

  it('reads the count in the name', () => {
    expect(countIn('4 Pines Dark Lager Can 6x4x375mL')).toMatchObject({ base: { kind: 'pack', qty: 4 }, all: 24 });
    expect(countIn('Adnams Broadside 500mLx12')).toMatchObject({ base: { kind: 'single', qty: 1 }, all: 12 });
    expect(countIn('4 Pines Pale Ale Can 6X375ml')).toMatchObject({ base: { kind: 'pack', qty: 6 } });
    expect(countIn('4 Pines Dark Lager Can 6x4x375mL')!.cut('4 Pines Dark Lager Can 6x4x375mL')).toBe('4 Pines Dark Lager Can 375mL');
    expect(countIn('Adnams Broadside 500mLx12')!.cut('Adnams Broadside 500mLx12')).toBe('Adnams Broadside 500mL');
    expect(countIn('Penfolds Bin 389 750mL')).toBeUndefined();
  });

  it('splits a pack and a case into two items, each with its own price', () => {
    const out = mapEndeavourAll('danmurphys', dm('4 Pines Dark Lager Can 6x4x375mL', { singleprice: { Value: 17.99 }, caseprice: { Value: 89.99 } }));
    expect(out.map((p) => [p.name, p.size, p.price])).toEqual([
      ['4 Pines Dark Lager Can 375mL · 4 Pack', '4 x 375ML', 17.99],
      ['4 Pines Dark Lager Can 375mL · Case of 24', '24 x 375ML', 89.99],
    ]);
    expect(out[1].storeProductId).toBe('123-case');
  });

  it('uses the shop\'s own words when it gives them', () => {
    const out = mapEndeavourAll(
      'danmurphys',
      dm('Adnams Broadside Strong Original 500mLx12', { singleprice: { Value: 8.99, Message: 'per bottle' }, caseprice: { Value: 99, Message: 'per case of 12' } }),
    );
    expect(out.map((p) => [p.name, p.price])).toEqual([
      ['Adnams Broadside Strong Original 500mL', 8.99],
      ['Adnams Broadside Strong Original 500mL · Case of 12', 99],
    ]);
  });

  it('a multi-buy is a deal on several, not the price of one', () => {
    const [one] = mapEndeavourAll('danmurphys', dm('4 Pines Pale Ale Can 6X375ml', { singleprice: { Value: 27.99 }, promoprice: { Value: 55, Message: '2 for $55' } }));
    expect(one.price).toBe(27.99);
    expect(one.promo).toBe('2 for $55');
  });

  it('a special on the case stays on the case', () => {
    const out = mapEndeavourAll(
      'danmurphys',
      dm('Great Northern Original 24x375mL', { singleprice: { Value: 22, Message: 'per pack of 6' }, caseprice: { Value: 62, Message: 'per case of 24' }, promoprice: { Value: 55, Message: 'per case' } }),
    );
    expect(out.map((p) => [p.name, p.price, p.wasPrice, p.isSpecial])).toEqual([
      ['Great Northern Original 375mL · 6 Pack', 22, undefined, false],
      ['Great Northern Original 375mL · Case of 24', 55, 62, true],
    ]);
  });

  it('leaves BWS alone (it lists each pack under its own stock code already)', () => {
    const out = flattenEndeavour('bws', { Products: [{ Products: [dm('Carlton Dry 6x330mL', { singleprice: { Value: 22 }, caseprice: { Value: 62 } })] }] });
    expect(out).toHaveLength(1);
  });

  it('one price and no count: one item, as before', () => {
    expect(mapEndeavourAll('danmurphys', dm('Penfolds Bin 389 750mL', { singleprice: { Value: 89 } }))).toHaveLength(1);
  });
});

describe('0.10.7 the size is said once', () => {
  it('a pack name already says its size', async () => {
    const { nameHasSize } = await import('../lib/naming');
    expect(nameHasSize('4 Pines Dark Lager Can 375mL · Case of 24', '24 x 375ML')).toBe(true);
    expect(nameHasSize('Carlton Dry 330ml · 6 Pack', '6 x 330ML')).toBe(true);
    expect(nameHasSize('Stone & Wood Radler Can 330mL', '330mL')).toBe(true);
    expect(nameHasSize('Carlton Dry', '6 x 330ML')).toBe(false);
  });
});
