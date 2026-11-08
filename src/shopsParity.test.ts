import { describe, expect, it } from 'vitest';
import javaSource from '../android/app/src/main/java/family/plenty/restock/Shops.java?raw';
import { SHOPS } from './shops';

// Shops.java is the background checks' copy of the shop list. Read its add(...) lines and make
// sure every shop has the same tab, kind, website and price source as shops.ts.
function javaShops() {
  const out = new Map<string, { section: string; kind: string; website: string; pricesFrom: string | null }>();
  const line = /add\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*(null|"[^"]+")\);/g;
  for (const m of javaSource.matchAll(line)) {
    out.set(m[1], { section: m[2], kind: m[3], website: m[4], pricesFrom: m[5] === 'null' ? null : m[5].slice(1, -1) });
  }
  return out;
}

describe('Shops.java matches shops.ts', () => {
  const java = javaShops();

  it('has the same shops', () => {
    expect([...java.keys()].sort()).toEqual(SHOPS.map((s) => s.id).sort());
  });

  it.each(SHOPS.map((s) => [s.id, s] as const))('%s: same tab, kind, website and price source', (id, s) => {
    expect(java.get(id)).toEqual({ section: s.section, kind: s.kind, website: s.website, pricesFrom: s.pricesFrom ?? null });
  });

  it('prices My Chemist from Chemist Warehouse', () => {
    expect(java.get('mychemist')).toMatchObject({ website: 'https://www.chemistwarehouse.com.au', pricesFrom: 'chemistwarehouse' });
  });
});
