import { describe, expect, it } from 'vitest';
import { deleteOn, expired, findDate, findShop, findTotal, itemLines, packName, parseReceipt } from './receipts';
import type { Receipt } from '../types';

const now = new Date('2026-11-07T10:00:00');

const WOOLIES = `W00LWORTHS
Woolworths Newtown
ABN 88 000 014 675
Bananas Cavendish 1.2kg          4.68
Milk Full Cream 2L               3.10
Vegemite 380g                    7.00
SUBTOTAL                        14.78
Savings                          2.00
TOTAL                          $14.78
EFTPOS                          14.78
GST included in total            0.64
07/11/26 09:14  Store 1234`;

const COLES = `Coles Supermarkets Australia
Coles Broadway
Tax Invoice
Pasta Penne 500g        1.20
Tuna 95g                2.00
Total for 2 items       3.20
Card                    3.20
Date: 5 Nov 2026`;

describe('reading receipts', () => {
  it('finds the shop, date and total', () => {
    expect(parseReceipt(WOOLIES, now)).toEqual({ shop: 'Woolworths', chain: 'woolworths', section: 'pantry', date: '2026-11-07', total: 14.78 });
    const c = parseReceipt(COLES, now);
    expect(c.chain).toBe('coles');
    expect(c.date).toBe('2026-11-05');
    expect(c.total).toBe(3.2);
  });

  it('ignores the subtotal, GST and savings', () => {
    expect(findTotal('Subtotal 20.00\nGST 1.82\nYou saved 4.00\nTOTAL 20.00\nChange 0.00')).toBe(20);
    expect(findTotal('Balance due\n$56.10')).toBe(56.1);
    // A misread total, with the card line agreeing on the real one.
    expect(findTotal('TOTAL $9.26\nCARD 9.20\nEFTPOS 9.20')).toBe(9.2);
  });

  it('reads Australian day-first dates and rejects impossible or future ones', () => {
    expect(findDate('03/04/2026', now)).toBe('2026-04-03');
    expect(findDate('31/02/2026 then 01-11-2026', now)).toBe('2026-11-01');
    expect(findDate('20/12/2026', now)).toBeUndefined();
    expect(findDate('Nov 2, 2026', now)).toBe('2026-11-02');
    expect(findDate('2026-10-30', now)).toBe('2026-10-30');
  });

  it('knows bottle shops and pharmacies', () => {
    expect(findShop('BWS\nBWS Marrickville\nTotal 30.00')).toMatchObject({ chain: 'bws', section: 'keg' });
    expect(findShop('Chemist Warehouse\nParacetamol 500mg 3.99')).toMatchObject({ chain: 'chemistwarehouse', section: 'pharmacy' });
    expect(findShop('Joe’s Corner Store\nMilk 3.00').chain).toBeUndefined();
  });

  it('picks out the item lines', () => {
    expect(itemLines(WOOLIES)).toEqual(['Bananas Cavendish 1.2kg', 'Milk Full Cream 2L', 'Vegemite 380g']);
  });

  it('reads the name off the front of a pack from the biggest words', () => {
    expect(
      packName([
        { text: 'NEW', height: 20, confidence: 90 },
        { text: 'Solo Hard', height: 80, confidence: 88 },
        { text: 'Lemon', height: 60, confidence: 91 },
        { text: '375mL 4.5% alc/vol', height: 18, confidence: 85 },
      ]),
    ).toBe('Solo Hard Lemon');
  });
});

describe('keeping receipts', () => {
  const r = (scannedAt: string, pinned = false) => ({ id: scannedAt, scannedAt, pinned, section: 'pantry' }) as Receipt;
  it('counts from the day it was scanned, and keeps pinned ones', () => {
    expect(deleteOn(r('2026-03-31T09:00:00'), 1)?.getDate()).toBe(30);
    expect(deleteOn(r('2026-03-31T09:00:00', true), 1)).toBeUndefined();
    expect(deleteOn(r('2026-03-31T09:00:00'), 0)).toBeUndefined();
    const list = [r('2026-07-01T09:00:00'), r('2026-08-20T09:00:00'), r('2026-01-01T09:00:00', true)];
    expect(expired(list, 3, now).map((x) => x.id)).toEqual(['2026-07-01T09:00:00']);
    expect(expired(list, 0, now)).toEqual([]);
  });
});

describe('a long receipt in several photos', () => {
  it('drops the lines that two photos both caught', async () => {
    const { joinPages } = await import('./receipts');
    const one = ['WOOLWORTHS', 'Bega Peanut Butter Smooth 470g 6.90', 'WW UHT Full Cream Milk 1L 1.75', 'Weet-Bix Cereal 1.2kg 7.00'].join('\n');
    const two = ['WW UHT Full Cream Milk 1L 1.75', 'Weet-Bix Cereal 1.2kg 7.0O', 'Weet-Bix Bites Wild Berry 500g 6.50', 'TOTAL $176.30'].join('\n');
    expect(joinPages([one, two]).split('\n')).toEqual([
      'WOOLWORTHS',
      'Bega Peanut Butter Smooth 470g 6.90',
      'WW UHT Full Cream Milk 1L 1.75',
      'Weet-Bix Cereal 1.2kg 7.00',
      'Weet-Bix Bites Wild Berry 500g 6.50',
      'TOTAL $176.30',
    ]);
  });

  it("keeps everything when the photos don't overlap", async () => {
    const { joinPages } = await import('./receipts');
    expect(joinPages(['a line one 1.00\nb line two 2.00', 'c line three 3.00'])).toBe('a line one 1.00\nb line two 2.00\nc line three 3.00');
  });
});
