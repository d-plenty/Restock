import { cachedSettings } from '../lib/db';
import { wooliesAccount } from '../types';
import { kindOf, type StoreChain } from '../shops';
import { aldi } from './aldi';
import { coles } from './coles';
import { costco } from './costco';
import { endeavourAdapter } from './endeavour';
import { connectionMode, NativeOnlyError } from './http';
import type { StoreAdapter } from './types';
import { webAdapter } from './web';
import { woolworths } from './woolworths';

export const ADAPTERS = { woolworths, coles, aldi };

export function adapterFor(chain: StoreChain | 'other'): StoreAdapter | undefined {
  if (chain === 'other') return undefined;
  // Test builds only (VITE_FAKE_STORES=1): canned results so the Add screen can be clicked through off-phone.
  if (import.meta.env.VITE_FAKE_STORES === '1') {
    const fake = fakeAdapter(chain);
    return { ...fake, searchAnonymous: (term) => fake.search(term) };
  }
  switch (kindOf(chain)) {
    case 'woolworths':
    case 'coles':
    case 'aldi':
      return withBackup(ADAPTERS[chain as keyof typeof ADAPTERS]);
    case 'costco':
      // 0.9.6: no hidden-browser backup and no retries: Costco is read once, on a phone, when Search is pressed.
      return costco;
    case 'endeavour':
      return endeavourAdapter(chain as 'danmurphys' | 'bws');
    case 'web':
      return webAdapter(chain);
    default:
      return undefined;
  }
}

/** Direct search first; if it fails for any reason, the same search through the hidden browser. */
function withBackup(a: StoreAdapter): StoreAdapter {
  const backup = a.searchBrowser;
  if (!backup) return a;
  return {
    ...a,
    async search(term, storeId, page) {
      // Browser mode, or signed in to Woolworths: ask from inside its website, as you, for your store.
      if (connectionMode() === 'browser' || (a.chain === 'woolworths' && wooliesAccount(cachedSettings()))) return backup(term, storeId, page);
      try {
        return await a.search(term, storeId, page);
      } catch (e) {
        if (e instanceof NativeOnlyError) throw e;
        return backup(term, storeId, page);
      }
    },
  };
}

const FAKE: Record<string, string[]> = {
  pantry: ['Diced Tomatoes 400g', 'Diced Tomatoes With Basil 400g', 'Tomato Paste 140g', 'Tomato Soup 500g'],
  keg: [
    'Great Northern Super Crisp Lager Cans 30 Pack 375ml',
    'Great Northern Original Cans 24 Pack 375ml',
    'Hahn Super Dry 6 x 330ml',
    'XXXX Gold Cans 30 Pack 375ml',
  ],
  pharmacy: ['Panadol Tablets 500mg 20 Pack', 'Panadol Rapid 20 Caplets', 'Nurofen 200mg 24 Tablets', 'Band-Aid Plastic Strips 40 Pack'],
};

function fakeAdapter(chain: StoreChain): StoreAdapter {
  const section =
    kindOf(chain) === 'endeavour' || /liquor|bottle|cellar|camel|porters/.test(chain)
      ? 'keg'
      : ['woolworths', 'coles', 'aldi', 'costco'].includes(chain)
        ? 'pantry'
        : 'pharmacy';
  const names = FAKE[section];
  const brand = chain === 'aldi' ? 'Remano' : chain === 'coles' ? 'Coles' : chain === 'woolworths' ? 'Woolworths' : '';
  // A scannable test product: Earth Choice dishwashing liquid, at Woolworths and Coles but not Aldi.
  const CODE = '9310692112198';
  const earth = (id: string, name: string, size: string, price: number, barcode?: string) => ({
    chain,
    storeProductId: `${chain}-${id}`,
    name,
    brand: 'Earth Choice',
    size,
    price,
    barcode,
    isSpecial: false,
    memberOnly: false,
  });
  return {
    chain,
    pages: ['woolworths', 'coles', 'aldi'].includes(chain),
    search: async (term: string, _storeId?: string, page = 1) => {
      const grocer = chain === 'woolworths' || chain === 'coles';
      // "western star": Woolworths and Coles sell it, Aldi only has things with "star" in them (0.8.6).
      const fake = (id: string, name: string, size: string, price: number) => ({ ...earth(id, name, size, price), brand: undefined });
      if (/^western star$/i.test(term.trim()))
        return chain === 'aldi'
          ? [fake('st1', 'Chocolate Drizzle Stars 150g', '150g', 3.49), fake('st2', '4 Star Grass Fed Beef Mince 500g', '500g', 8.99), fake('st3', '2 Star Beef Mince 500g', '500g', 6.49)]
          : [
              { ...fake('ws1', 'Western Star Salted Butter Block 250g', '250g', 5.5), brand: 'Western Star' },
              { ...fake('ws2', 'Western Star Salted Butter Block 500g', '500g', 8), brand: 'Western Star' },
              { ...fake('ws3', 'Western Star Original Spreadable Butter Blend Tub 500g', '500g', 7), brand: 'Western Star' },
            ];
      if (/^butter$/i.test(term.trim()) && chain === 'aldi')
        return [fake('b1', 'Salted Butter 500g', '500g', 6.39), fake('b2', 'Unsalted Butter 500g', '500g', 6.39), fake('b3', 'Spreadable Dairy Blend 500g', '500g', 5.49)];
      // "milk": two pages of results, to try "Show more" and "Get more" (0.8.5).
      if (/^milk$/i.test(term.trim())) {
        const kinds = ['Full Cream Milk', 'Light Milk', 'Skim Milk', 'Lactose Free Milk', 'Oat Milk', 'Almond Milk', 'Chocolate Milk', 'Farmhouse Unhomogenised Milk'];
        const sizes = ['1L', '2L', '3L'];
        const all = kinds.flatMap((k, i) => sizes.map((sz, j) => ({ k, sz, n: i * 3 + j })));
        const per = 14;
        return all.slice((page - 1) * per, page * per).map(({ k, sz, n }) => ({
          chain,
          storeProductId: `${chain}-milk-${n}`,
          name: `${brand} ${k} ${sz}`.trim(),
          size: sz,
          price: 1.6 + n * 0.21,
          isSpecial: n === 4,
          memberOnly: false,
        }));
      }
      // "solo": cans in packs of 10, 24 and 30, bottles and mini cans, and a Zero Sugar that isn't the same (0.9.1, Other sizes).
      if (/\bsolo\b/i.test(term) && grocer) {
        const solo = (id: string, name: string, size: string, price: number) => ({ ...fake(id, name, size, price), brand: 'Solo' });
        return chain === 'coles'
          ? [
              solo('so1', 'Solo Original Lemon Soft Drink Cans Multipack 375ml', '30 Pack', 33),
              solo('so2', 'Solo Original Lemon Soft Drink Cans Multipack 375ml', '10 Pack', 20),
              solo('so3', 'Solo Original Lemon Soft Drink Bottle', '1.25L', 3.9),
              solo('so4', 'Solo Zero Sugar Lemon Soft Drink Cans Multipack 375ml', '10 Pack', 20),
            ]
          : [
              solo('so1', 'Solo Original Lemon Soft Drink Cans 375mL x 10 pack', '375mL x 10 pack', 21),
              solo('so2', 'Solo Original Lemon Soft Drink Cans 375mL x 24 pack', '375mL x 24 pack', 27),
              solo('so3', 'Solo Original Lemon Soft Drink Cans 375mL x 30 pack', '375mL x 30 pack', 32),
              solo('so4', 'Solo Original Lemon Soft Drink Bottle 1.25L', '1.25L', 4),
              solo('so5', 'Solo Original Lemon Soft Drink Mini Cans 250mL x 6 pack', '250mL x 6 pack', 6.6),
              solo('so6', 'Solo Zero Sugar Lemon Soft Drink Cans 375mL x 10 pack', '375mL x 10 pack', 21),
            ];
      }
      // localStorage fakeNoBarcode=1: the shops can't find it by barcode (like the real Woolworths sometimes).
      const noCode = (() => {
        try {
          return localStorage.getItem('fakeNoBarcode') === '1';
        } catch {
          return false;
        }
      })();
      if (term === CODE)
        return grocer && !noCode
          ? [
              earth(
                'ec9',
                'Earth Choice Tough On Grease Green Tea & Lime Dishwashing Liquid 900mL',
                '900mL',
                4.5,
                chain === 'woolworths' ? CODE : undefined,
              ),
            ]
          : [];
      // localStorage fakeThinColes=1: Coles's name search for the brand misses the product (as the real one did).
      const thin = (() => {
        try {
          return localStorage.getItem('fakeThinColes') === '1';
        } catch {
          return false;
        }
      })();
      const ultra = () =>
        earth(
          'ec9',
          `Earth Choice Tough On Grease Green Tea & Lime Dishwashing Liquid${chain === 'coles' ? ' Ultra Concentrate' : ''} 900mL`,
          '900mL',
          chain === 'coles' ? 4.2 : 4.5,
        );
      if (/earth choice dishwashing liquid/i.test(term))
        return grocer ? [ultra(), earth('ec1', 'Earth Choice Dishwashing Liquid 1L', '1L', 2.65)] : [];
      if (/^dishwashing liquid$/i.test(term.trim()))
        return [
          {
            ...earth('d1', chain === 'aldi' ? 'Green Action Dishwashing Liquid 500ml' : `${brand} Dishwashing Liquid 500mL`, '500ml', 2.79),
            brand: undefined,
          },
          { ...earth('d2', 'Dishwashing Liquid Original 950ml', '950ml', 2.99), brand: undefined },
          { ...earth('d3', 'Dishwashing Liquid Lemon Fragrance 1L', '1L', 1.39), brand: undefined },
          { ...earth('d4', 'Laundry Liquid 2L', '2L', 1.99), brand: undefined },
        ];
      if (/earth choice/i.test(term) && chain === 'coles' && thin)
        return [earth('cove', 'Cove By Earth Choice Surface Cleaner Refill 125mL', '125mL', 2.4)];
      if (/earth choice/i.test(term)) {
        if (!grocer)
          return [
            { ...earth('shiraz', 'Shiraz 750ml', '750ml', 3.29), brand: undefined },
            { ...earth('tofu', 'Firm Tofu 450g', '450g', 2.59), brand: undefined },
          ];
        return [
          earth('ec1', 'Earth Choice Dishwashing Liquid 1L', '1L', 2.65),
          earth('ec2', 'Earth Choice Window Cleaner 600mL', '600mL', 3.55),
          earth('ec3', 'Earth Choice Wool Wash 1L', '1L', 2.8),
          earth('ec4', 'Earth Choice Shower Cleaner 600mL', '600mL', 4.5),
          earth('ec5', 'Earth Choice Fabric Softener 1L', '1L', 2.7),
          earth('ec6', 'Earth Choice Laundry Liquid 1L', '1L', 3.3),
          earth(
            'ec9',
            `Earth Choice Tough On Grease Green Tea & Lime Dishwashing Liquid${chain === 'coles' ? ' Ultra Concentrate' : ''} 900mL`,
            '900mL',
            chain === 'coles' ? 4.2 : 4.5,
          ),
        ];
      }
      return names.map((name, i) => ({
        chain,
        storeProductId: `${chain}-${i}`,
        name: `${brand} ${name}`.trim(),
        size: name.match(/\d+(?:\.\d+)?\s*(?:g|ml)\b/)?.[0],
        price: section === 'keg' ? 54 + i * 3 - (chain.length % 4) : 0.95 + i * 0.4 + (chain === 'aldi' ? -0.1 : 0) + (chain.length % 3) * 0.15,
        isSpecial: i === 1,
        wasPrice: i === 1 ? (section === 'keg' ? 72 : 1.8) : undefined,
        memberOnly: false,
      }));
    },
  };
}

export * from './types';
