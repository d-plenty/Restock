import { describe, expect, it } from 'vitest';
import { chainOf, distanceKm, overpassQuery, parseAreas, parseStores } from './places';

describe('nearby stores', () => {
  it('measures distance', () => {
    // Townsville CBD to Bohle Plains is about 13 km.
    expect(distanceKm(-19.259, 146.818, -19.31, 146.69)).toBeGreaterThan(12);
    expect(distanceKm(-19.259, 146.818, -19.31, 146.69)).toBeLessThan(15);
  });

  it('reads Nominatim places', () => {
    const areas = parseAreas([
      {
        lat: '-19.31',
        lon: '146.69',
        display_name: 'Bohle Plains, Townsville, Queensland, 4817, Australia',
        address: { suburb: 'Bohle Plains', state: 'Queensland', postcode: '4817' },
      },
    ]);
    expect(areas).toEqual([{ label: 'Bohle Plains QLD 4817', lat: -19.31, lon: 146.69 }]);
  });

  it('recognises the chains and skips Coles Express', () => {
    expect(chainOf({ brand: 'Coles', name: 'Coles' })).toBe('coles');
    expect(chainOf({ name: 'Woolworths Metro' })).toBe('woolworths');
    expect(chainOf({ brand: 'ALDI' })).toBe('aldi');
    expect(chainOf({ name: 'Coles Express' })).toBeUndefined();
    // 0.10.3: IGA is one of Restock's supermarkets now.
    expect(chainOf({ name: 'IGA Kirwan' })).toBe('iga');
    expect(chainOf({ name: 'Foodworks' })).toBeUndefined();
  });

  it('reads Overpass results, nearest first, with a suburb in the name', () => {
    const stores = parseStores(
      {
        elements: [
          {
            type: 'way',
            center: { lat: -19.29, lon: 146.75 },
            tags: { shop: 'supermarket', brand: 'Coles', name: 'Coles', 'addr:suburb': 'Kirwan' },
          },
          { type: 'node', lat: -19.3, lon: 146.7, tags: { shop: 'supermarket', brand: 'ALDI', name: 'ALDI Burdell' } },
          { type: 'node', lat: -19.3, lon: 146.7, tags: { shop: 'supermarket', name: 'Foodworks' } },
        ],
      },
      { lat: -19.31, lon: 146.69 },
    );
    expect(stores.map((s) => s.name)).toEqual(['ALDI Burdell', 'Coles Kirwan']);
    expect(stores[0].km).toBeLessThan(stores[1].km);
  });

  it('builds a valid Overpass query', () => {
    const q = overpassQuery(-19.31, 146.69, 25000);
    expect(q).toContain('nwr["shop"="supermarket"](around:25000,-19.31000,146.69000)');
    expect(q).not.toContain('~'); // no slow regex matching
  });
});
