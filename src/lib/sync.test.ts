import { describe, expect, it } from 'vitest';
import { pairingCode } from './sync';
import { qrSvg } from '../ui/screens/Sync';

describe('sync pairing codes (0.8.2)', () => {
  const token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  it('reads one-time codes, however they were typed or pasted', () => {
    expect(pairingCode(`RESTOCK:3:${token}:192.168.1.20:47461`)).toBe(`RESTOCK:3:${token}:192.168.1.20:47461`);
    expect(pairingCode(` restock:3:${token.toLowerCase()}:192.168.1.20:47461 `)).toBe(`RESTOCK:3:${token}:192.168.1.20:47461`);
    expect(pairingCode(`RESTOCK:3:ABCD EFGH IJKL MNOP QRST UVWX YZ:10.0.0.2:47461`)).toBe(`RESTOCK:3:${token}:10.0.0.2:47461`);
  });
  it('passes older codes on (so the phone can say to update) and turns others away', () => {
    expect(pairingCode(`RESTOCK:2:${'A'.repeat(52)}:1.2.3.4:5`)).toBeDefined();
    expect(pairingCode('https://example.com')).toBeUndefined();
    expect(pairingCode('9300633603205')).toBeUndefined();
  });
  it('draws a QR code that scales: a viewBox, a white border, one square per dark module', () => {
    const svg = qrSvg({ width: 2, height: 2, data: [0, 255, 255, 0] });
    expect(svg).toContain('viewBox="0 0 10 10"');
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(2);
    expect(svg).toMatch(/^<svg[^>]*width="100%"/);
  });
});
