import { describe, expect, it } from 'vitest';
import { pairingCode, serverCode, serverCodeAddresses, webPageCode } from './sync';
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

describe('Restock server codes (0.9.2)', () => {
  const invite = 'abcdefghijklmnopqrstuvwxyz012345';
  it('shows the addresses an Add a phone code would connect to, home first', () => {
    const code = `restock-server:2?a=https%3A%2F%2Frestock.example.com%2F&h=http%3A%2F%2F192.168.1.10%3A8787&i=${invite}`;
    expect(serverCode(code)).toBe(code);
    expect(serverCodeAddresses(code)).toEqual(['192.168.1.10:8787', 'restock.example.com']);
    expect(serverCodeAddresses(`restock-server:2?a=https%3A%2F%2Fsync.example.net&i=${invite}`)).toEqual(['sync.example.net']);
  });
  it("doesn't show what a person can't read, and keeps it short", () => {
    expect(serverCodeAddresses(`restock-server:2?h=%0Aevil&i=${invite}`)).toEqual(['evil']);
    expect(serverCodeAddresses(`restock-server:2?h=%E0%A4%A&i=${invite}`)).toEqual([]);
    expect(serverCodeAddresses(`restock-server:2?h=${'a'.repeat(300)}&i=${invite}`)[0]).toHaveLength(101);
  });
  it('takes only the web page codes it knows', () => {
    expect(webPageCode('restock-link:2?u=http%3A%2F%2F192.168.1.10%3A8787&s=abcdefgh12&k=AAAA')).toBeDefined();
    expect(webPageCode('javascript:alert(1)')).toBeUndefined();
    expect(serverCode('restock-server:2?h=x&i=short')).toBeUndefined();
  });
});
