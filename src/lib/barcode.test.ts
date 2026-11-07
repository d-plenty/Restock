import { describe, expect, it } from 'vitest';
import { productCode } from './barcode';

describe('productCode', () => {
  it('keeps plain barcodes', () => {
    expect(productCode('9300633603205')).toBe('9300633603205');
    expect(productCode('93506742')).toBe('93506742');
    expect(productCode('012345678905')).toBe('012345678905');
  });
  it('turns GTIN-14 into the shelf barcode', () => {
    expect(productCode('09300633603205')).toBe('9300633603205');
  });
  it('reads GS1 Digital Link QR codes', () => {
    expect(productCode('https://id.gs1.org/01/09300633603205')).toBe('9300633603205');
    expect(productCode('https://brand.example.com.au/01/09300633603205/10/LOT42?17=270101')).toBe('9300633603205');
    expect(productCode('https://example.com/products/gtin/9300633603205')).toBe('9300633603205');
  });
  it('reads GS1 element strings from DataBar and Data Matrix', () => {
    expect(productCode('(01)09300633603205(17)270101')).toBe('9300633603205');
    expect(productCode('010930063360320517270101')).toBe('9300633603205');
    expect(productCode('0109300633603205\x1d10LOT42')).toBe('9300633603205');
  });
  it('rejects codes that are not products', () => {
    expect(productCode('https://www.coles.com.au/specials')).toBeUndefined();
    expect(productCode('WIFI:S:home;T:WPA;P:secret;;')).toBeUndefined();
    expect(productCode('hello')).toBeUndefined();
  });
});
