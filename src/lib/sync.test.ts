import { describe, expect, it } from 'vitest';
import { householdIn, pairingCode } from './sync';

describe('sync pairing codes', () => {
  const key52 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST';
  it("reads 0.8.1's short code, and 0.8.0's", () => {
    expect(pairingCode(`RESTOCK:2:${key52}:192.168.1.20:47461`)).toBe(`RESTOCK:2:${key52}:192.168.1.20:47461`);
    expect(pairingCode(` restock:2:${key52.toLowerCase()}:192.168.1.20:47461 `)).toBe(`RESTOCK:2:${key52}:192.168.1.20:47461`);
    const old = `RESTOCK-SYNC:1:${'a'.repeat(43)}:10.0.0.2:47461:Plenty%20house`;
    expect(pairingCode(old)).toBe(old);
    expect(householdIn(old)).toBe('Plenty house');
  });
  it('turns other codes away', () => {
    expect(pairingCode('https://example.com')).toBeUndefined();
    expect(pairingCode('9300633603205')).toBeUndefined();
  });
});
