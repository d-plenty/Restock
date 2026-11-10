// Every shop Restock knows about, and which tab it belongs to.
//
// Shops are kept apart by section, so a search for potato chips only goes to supermarkets and
// a search for beer only goes to bottle shops. Each pantry item, shopping list line and category
// belongs to one section too. Mirrored for background price checks in Shops.java.

export type Section = 'pantry' | 'keg' | 'pharmacy';
export const SECTIONS: Section[] = ['pantry', 'keg', 'pharmacy'];
export const SECTION_NAMES: Record<Section, string> = { pantry: 'Pantry', keg: 'Keg', pharmacy: 'Health' };
/** "Added to your pantry / keg / Health list". */
export const SECTION_PLACE: Record<Section, string> = { pantry: 'your pantry', keg: 'your keg', pharmacy: 'your Health list' };
/** What the shops in each section are called in sentences. */
export const SECTION_SHOPS: Record<Section, string> = { pantry: 'supermarkets', keg: 'bottle shops', pharmacy: 'chemists' };

/**
 * 0.9.5: the shopping lists. Each tab's own (Groceries is the Pantry tab's), and General: a list only,
 * with no pantry and no shops of its own, for what Home Assistant adds that matches nothing (and for
 * anything put there by hand). Its lines are list_entries with section 'general'. For sharing it goes
 * with Groceries (listShareTab), so a phone that shares Groceries shares General too.
 */
export type ListSection = Section | 'general';
export const LIST_SECTIONS: ListSection[] = ['pantry', 'keg', 'pharmacy', 'general'];
/** The tab names on the list (phone and web). */
export const LIST_NAMES: Record<ListSection, string> = { pantry: 'Groceries', keg: 'Keg', pharmacy: 'Health', general: 'General' };
/** "Nothing on your General list", "tap the cart next to anything in your pantry". */
export const LIST_PLACE: Record<ListSection, string> = { ...SECTION_PLACE, general: 'your pantry' };
/** A list_entries section as stored: anything this version doesn't know is the grocery list. */
export const asListSection = (v: unknown): ListSection => (v === 'keg' || v === 'pharmacy' || v === 'general' ? v : 'pantry');
/** The tab a list's lines are shared with (household sync, the server, What this phone shares): General goes with Groceries. */
export const listShareTab = (s: ListSection | null | undefined): Section => (s === 'keg' || s === 'pharmacy' ? s : 'pantry');

export type GroceryChain = 'woolworths' | 'coles' | 'aldi';
export type LiquorChain =
  'danmurphys' | 'bws' | 'liquorland' | 'liquorlandwarehouse' | 'liquorlandcellars' | 'bottleo' | 'cellarbrations' | 'thirstycamel' | 'porters';
export type PharmacyChain =
  | 'chemistwarehouse'
  | 'mychemist'
  | 'amcal'
  | 'discountdrug'
  | 'guardian'
  | 'priceline'
  | 'soulpattinson'
  | 'terrywhite'
  | 'blooms'
  | 'goodprice'
  | 'pharmacy4less'
  | 'directchemist'
  | 'stardiscount'
  | 'capitalchemist'
  | 'nationalpharmacies'
  | 'chempro';
export type BuiltinChain = GroceryChain | LiquorChain | PharmacyChain;
/** A shop the person added themselves (a website and a name). */
export type CustomChain = `custom-${string}`;
export type Chain = BuiltinChain | CustomChain | 'other';
/** Any real shop (not "Other", which means a hand-typed price). */
export type StoreChain = Exclude<Chain, 'other'>;

/**
 * How Restock talks to a shop:
 * - woolworths / coles / aldi: the supermarkets' own apps' data.
 * - endeavour: Dan Murphy's and BWS, which run on the same system as Woolworths.
 * - web: any shop website. Restock finds its search page and reads the products and prices
 *   the page already carries for search engines, using the hidden browser when it needs to.
 */
export type ShopKind = GroceryChain | 'endeavour' | 'web';

export interface ShopDef {
  id: BuiltinChain;
  name: string;
  section: Section;
  kind: ShopKind;
  /** Dot colour on lists. */
  color: string;
  /** The shop's website. */
  website: string;
  /** Its search page, with {q} for the search words, when known. Otherwise it's found automatically. */
  search?: string;
  /** Another shop whose website has this shop's prices (Liquorland Warehouse uses liquorland.com.au). */
  pricesFrom?: BuiltinChain;
  /** Matches the shop's name on the map (OpenStreetMap brand or name). */
  map: RegExp;
  /** A word or two on the shop, shown in the picker. */
  note?: string;
  /** The shop's catalogue page, when known (otherwise it's looked for on the website). */
  catalogue?: { url: string; note: string };
}

const G = (d: Omit<ShopDef, 'section'>): ShopDef => ({ ...d, section: 'pantry' });
const L = (d: Omit<ShopDef, 'section' | 'kind'> & { kind?: ShopKind }): ShopDef => ({ kind: 'web', ...d, section: 'keg' });
const P = (d: Omit<ShopDef, 'section' | 'kind'> & { kind?: ShopKind }): ShopDef => ({ kind: 'web', ...d, section: 'pharmacy' });

export const SHOPS: ShopDef[] = [
  G({
    id: 'woolworths',
    name: 'Woolworths',
    kind: 'woolworths',
    color: '#178841',
    website: 'https://www.woolworths.com.au',
    map: /\bwoolworths\b/i,
    catalogue: { url: 'https://www.woolworths.com.au/shop/catalogue', note: 'New specials every Wednesday.' },
  }),
  G({
    id: 'coles',
    name: 'Coles',
    kind: 'coles',
    color: '#e01a22',
    website: 'https://www.coles.com.au',
    map: /\bcoles\b(?!.*express)/i,
    catalogue: { url: 'https://www.coles.com.au/catalogues', note: 'New specials every Wednesday.' },
  }),
  G({
    id: 'aldi',
    name: 'Aldi',
    kind: 'aldi',
    color: '#00005f',
    website: 'https://www.aldi.com.au',
    map: /\baldi\b/i,
    catalogue: { url: 'https://www.aldi.com.au/special-buys', note: 'New Special Buys every Wednesday and Saturday.' },
  }),

  L({
    id: 'danmurphys',
    name: "Dan Murphy's",
    kind: 'endeavour',
    color: '#0d5c3b',
    website: 'https://www.danmurphys.com.au',
    search: 'https://www.danmurphys.com.au/search?searchTerm={q}',
    catalogue: { url: 'https://www.danmurphys.com.au/discover/catalogues', note: 'For your nearest branch.' },
    map: /dan murphy/i,
  }),
  L({
    id: 'bws',
    name: 'BWS',
    kind: 'endeavour',
    color: '#f26b21',
    website: 'https://bws.com.au',
    search: 'https://bws.com.au/search?searchTerm={q}',
    catalogue: { url: 'https://bws.com.au/discover/catalogue', note: 'For your nearest branch.' },
    map: /\bbws\b|beer wine spirits/i,
  }),
  L({
    id: 'liquorland',
    name: 'Liquorland',
    color: '#c8102e',
    website: 'https://www.liquorland.com.au',
    search: 'https://www.liquorland.com.au/search?q={q}',
    map: /liquorland(?!\s*(warehouse|cellars))/i,
  }),
  L({
    id: 'liquorlandwarehouse',
    name: 'Liquorland Warehouse',
    color: '#9e0b23',
    website: 'https://www.liquorland.com.au',
    pricesFrom: 'liquorland',
    map: /liquorland\s*warehouse|first choice/i,
    note: 'Prices from liquorland.com.au',
  }),
  L({
    id: 'liquorlandcellars',
    name: 'Liquorland Cellars',
    color: '#6d1022',
    website: 'https://www.liquorland.com.au',
    pricesFrom: 'liquorland',
    map: /liquorland\s*cellars|vintage cellars/i,
    note: 'Prices from liquorland.com.au',
  }),
  L({ id: 'bottleo', name: 'The Bottle-O', color: '#e4002b', website: 'https://www.thebottle-o.com.au', map: /bottle-?o\b/i }),
  L({ id: 'cellarbrations', name: 'Cellarbrations', color: '#8a1538', website: 'https://www.cellarbrations.com.au', map: /cellarbrations/i }),
  L({
    id: 'thirstycamel',
    name: 'Thirsty Camel',
    color: '#f3a712',
    website: 'https://www.thirstycamel.com.au',
    search: 'https://www.thirstycamel.com.au/search?q={q}',
    map: /thirsty camel/i,
  }),
  L({ id: 'porters', name: 'Porters Liquor', color: '#2b2a29', website: 'https://www.portersliquor.com.au', map: /porters/i }),

  P({
    id: 'chemistwarehouse',
    name: 'Chemist Warehouse',
    color: '#e3001b',
    website: 'https://www.chemistwarehouse.com.au',
    search: 'https://www.chemistwarehouse.com.au/search?query={q}',
    map: /chemist warehouse/i,
  }),
  P({
    id: 'mychemist',
    name: 'My Chemist',
    color: '#00a3e0',
    website: 'https://www.chemistwarehouse.com.au',
    pricesFrom: 'chemistwarehouse',
    map: /\bmy chemist\b/i,
    note: 'Prices from chemistwarehouse.com.au',
  }),
  P({ id: 'amcal', name: 'Amcal', color: '#d6006e', website: 'https://www.amcal.com.au', search: 'https://www.amcal.com.au/?s={q}', map: /amcal/i }),
  P({
    id: 'discountdrug',
    name: 'Discount Drug Stores',
    color: '#ffcc00',
    website: 'https://www.discountdrugstores.com.au',
    search: 'https://www.discountdrugstores.com.au/?s={q}',
    map: /discount drug/i,
  }),
  P({
    id: 'guardian',
    name: 'Guardian / PharmaSave',
    color: '#005eb8',
    website: 'https://www.guardianpharmacies.com.au',
    map: /guardian|pharmasave/i,
  }),
  P({
    id: 'priceline',
    name: 'Priceline Pharmacy',
    color: '#e5006d',
    website: 'https://www.priceline.com.au',
    search: 'https://www.priceline.com.au/search/{q}',
    map: /priceline/i,
  }),
  P({ id: 'soulpattinson', name: 'Soul Pattinson', color: '#0067b1', website: 'https://www.soulpattinson.com.au', map: /soul pattinson/i }),
  P({
    id: 'terrywhite',
    name: 'TerryWhite Chemmart',
    color: '#ed1c24',
    website: 'https://terrywhitechemmart.com.au',
    search: 'https://terrywhitechemmart.com.au/search?q={q}',
    map: /terry\s*white|chemmart/i,
  }),
  P({
    id: 'blooms',
    name: 'Blooms The Chemist',
    color: '#7ab800',
    website: 'https://www.bloomsthechemist.com.au',
    search: 'https://www.bloomsthechemist.com.au/shop/?search_query={q}',
    map: /blooms/i,
  }),
  P({
    id: 'goodprice',
    name: 'Good Price Pharmacy',
    color: '#e2231a',
    website: 'https://www.goodpricepharmacy.com.au',
    search: 'https://www.goodpricepharmacy.com.au/catalogsearch/result/?q={q}',
    map: /good price pharmacy/i,
  }),
  P({
    id: 'pharmacy4less',
    name: 'Pharmacy 4 Less',
    color: '#0091d0',
    website: 'https://www.pharmacy4less.com.au',
    search: 'https://www.pharmacy4less.com.au/?s={q}',
    map: /pharmacy\s*4\s*less/i,
  }),
  P({
    id: 'directchemist',
    name: 'Direct Chemist Outlet',
    color: '#ea5b0c',
    website: 'https://www.directchemistoutlet.com.au',
    search: 'https://www.directchemistoutlet.com.au/search?q={q}',
    map: /direct chemist/i,
  }),
  P({
    id: 'stardiscount',
    name: 'Star Discount Chemist',
    color: '#ffd200',
    website: 'https://www.stardiscountchemist.com.au',
    map: /star discount/i,
  }),
  P({
    id: 'capitalchemist',
    name: 'Capital Chemist',
    color: '#1d4f91',
    website: 'https://www.capitalchemist.com.au',
    search: 'https://www.capitalchemist.com.au/products?search={q}',
    map: /capital chemist/i,
  }),
  P({
    id: 'nationalpharmacies',
    name: 'National Pharmacies',
    color: '#00843d',
    website: 'https://www.nationalpharmacies.com.au',
    map: /national pharmacies/i,
  }),
  P({
    id: 'chempro',
    name: 'Chempro',
    color: '#00a99d',
    website: 'https://www.chempro.com.au',
    search: 'https://www.chempro.com.au/index.php?route=product/search&search={q}',
    map: /chempro/i,
  }),
];

const BY_ID = new Map<string, ShopDef>(SHOPS.map((s) => [s.id, s]));
export const GROCERY: GroceryChain[] = ['woolworths', 'coles', 'aldi'];

/** A shop the person added: a name, a website, and which tab it's for. */
export interface CustomShop {
  id: CustomChain;
  name: string;
  website: string;
  section: Section;
  /** The search page with {q}, if they typed one in (otherwise found automatically). */
  search?: string;
  createdAt: string;
}

// The person's own shops, kept here so names and colours can be looked up anywhere. Set from
// settings whenever they're read (db.ts).
let custom: CustomShop[] = [];
export function setCustomShops(list: CustomShop[] | undefined) {
  custom = Array.isArray(list) ? list : [];
}
export const customShops = () => custom;

export const isCustom = (c: string | undefined): c is CustomChain => !!c && c.startsWith('custom-');
export const shopDef = (c: string | undefined): ShopDef | undefined => (c ? BY_ID.get(c) : undefined);
export const customShop = (c: string | undefined) => custom.find((s) => s.id === c);

export function chainName(c: Chain | string | undefined): string {
  if (!c) return 'Other';
  if (c === 'other') return 'Other';
  return shopDef(c)?.name ?? customShop(c)?.name ?? 'Other shop';
}

const CUSTOM_COLORS = ['#6b4fbb', '#0b7285', '#a61e4d', '#5c940d', '#e67700', '#364fc7'];
export function shopColor(c: Chain | string | undefined): string {
  const d = shopDef(c);
  if (d) return d.color;
  const i = custom.findIndex((s) => s.id === c);
  return i >= 0 ? CUSTOM_COLORS[i % CUSTOM_COLORS.length] : '#a9a699';
}

/** Which tab a shop belongs to. Hand-typed prices ("other") go with whatever item they're on. */
export function sectionOf(c: Chain | string | undefined): Section {
  return shopDef(c)?.section ?? customShop(c)?.section ?? 'pantry';
}

/** The shop's website, for opening it or finding its search page. */
export function websiteOf(c: Chain | string): string | undefined {
  return shopDef(c)?.website ?? customShop(c)?.website;
}

/** How Restock fetches this shop's prices. Custom shops are read like any website. */
export function kindOf(c: Chain | string): ShopKind | undefined {
  if (isCustom(c)) return customShop(c) ? 'web' : undefined;
  return shopDef(c)?.kind;
}

/** The shop whose website holds this shop's prices (itself, or Liquorland for its Warehouse and Cellars). */
export const priceSource = (c: StoreChain): StoreChain => shopDef(c)?.pricesFrom ?? c;

/** Every shop in a section, built-in first then the person's own. */
export function shopsIn(section: Section): { id: StoreChain; name: string; note?: string; custom?: boolean }[] {
  return [
    ...SHOPS.filter((s) => s.section === section).map((s) => ({ id: s.id as StoreChain, name: s.name, note: s.note })),
    ...custom.filter((s) => s.section === section).map((s) => ({ id: s.id, name: s.name, note: hostOf(s.website), custom: true })),
  ];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The shops picked in this section. */
export function enabledIn(enabled: readonly string[], section: Section): StoreChain[] {
  return enabled.filter((c): c is StoreChain => c !== 'other' && sectionOf(c) === section && (!!shopDef(c) || !!customShop(c)));
}

/**
 * The shops to search in this section: one per website, so Liquorland, Liquorland Warehouse
 * and Liquorland Cellars only search liquorland.com.au once.
 */
export function searchChainsIn(enabled: readonly string[], section: Section): StoreChain[] {
  return [...new Set(enabledIn(enabled, section).map(priceSource))];
}

/** A tab is shown when it's switched on and at least one of its shops is picked. Pantry always shows. */
export function sectionOn(settings: { sections?: Partial<Record<Section, boolean>>; enabledChains: readonly string[] }, section: Section): boolean {
  if (section === 'pantry') return true;
  return !!settings.sections?.[section] && enabledIn(settings.enabledChains, section).length > 0;
}

export const activeSections = (settings: Parameters<typeof sectionOn>[0]): Section[] => SECTIONS.filter((s) => sectionOn(settings, s));
/** 0.9.5: the shopping lists shown (List tab and the web): the tabs that are on, then General, always. */
export const listSectionsOn = (settings: Parameters<typeof sectionOn>[0]): ListSection[] => [...activeSections(settings), 'general'];

/** Starting categories for each tab. */
export const DEFAULT_SECTION_CATEGORIES: Record<Section, string[]> = {
  pantry: ['Pantry', 'Fridge & freezer', 'Cleaning', 'Bathroom'],
  keg: ['Beer', 'Wine', 'Spirits', 'Mixers & other'],
  pharmacy: ['Medicine', 'First aid', 'Vitamins', 'Personal care'],
};
