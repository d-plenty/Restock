// Every shop Restock knows about, and which tabs use it.
//
// Each tab searches only its own shops, so a search for potato chips goes to the shops picked for
// Pantry and a search for beer to the ones picked for Keg. Each pantry item, shopping list line and
// category belongs to one tab (section) too. Mirrored for background price checks in Shops.java.
//
// 0.10.3: a shop can be in more than one tab (Woolworths in Pantry and in Baby, for nappies):
// settings.shopTabs says which, by shop; a shop it doesn't mention is in its own tab only (its
// `section` below, which is also the tab it's shared with: shareTab). Baby and Pets are new tabs;
// for household sync they go with Groceries, as the General list does, so phones and servers
// still share three tabs.

/**
 * 0.10.7: custom sections. Baby and Pets stopped being built-in tabs: they're two of up to eight
 * sections people make themselves (a name, a colour, an icon and the shops to compare), and their
 * ids stay 'baby' and 'pets' so nothing anyone already has moves. The other six are c1–c6. Like
 * Baby and Pets, they're shared with Groceries for household sync (shareTab).
 */
export const CUSTOM_SLOTS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] as const;
export type CustomSlot = (typeof CUSTOM_SLOTS)[number];
export type CustomSection = 'baby' | 'pets' | CustomSlot;
export const CUSTOM_SECTIONS: CustomSection[] = ['baby', 'pets', ...CUSTOM_SLOTS];
export const MAX_CUSTOM = CUSTOM_SECTIONS.length;
export const isCustomSection = (s: unknown): s is CustomSection => typeof s === 'string' && (CUSTOM_SECTIONS as string[]).includes(s);
/** The same value for each of c1–c6 (for the tables below, filled in from each one's own name). */
export const slots = <T,>(v: T): Record<CustomSlot, T> => Object.fromEntries(CUSTOM_SLOTS.map((c) => [c, v])) as Record<CustomSlot, T>;

export type Section = 'pantry' | 'keg' | 'pharmacy' | 'baby' | 'pets' | CustomSlot;
export const SECTIONS: Section[] = ['pantry', 'keg', 'pharmacy', 'baby', 'pets', ...CUSTOM_SLOTS];
/** The tabs besides Pantry, in the order they're set up and shown in More. */
export const EXTRA_SECTIONS: Exclude<Section, 'pantry'>[] = ['keg', 'pharmacy', 'baby', 'pets', ...CUSTOM_SLOTS];
/** A section's name. Custom ones are filled in from settings (applyCustomSections). */
export const SECTION_NAMES: Record<Section, string> = { pantry: 'Pantry', keg: 'Bottle shop', pharmacy: 'Chemist', baby: 'Baby', pets: 'Pets', ...slots('Custom') };
/** "Added to your pantry / keg / Health list". */
export const SECTION_PLACE: Record<Section, string> = {
  pantry: 'your pantry',
  keg: 'your Bottle shop tab',
  pharmacy: 'your Chemist list',
  baby: 'your Baby list',
  pets: 'your Pets list',
  ...slots('your list'),
};
/** What the shops in each section are called in sentences. */
export const SECTION_SHOPS: Record<Section, string> = { pantry: 'supermarkets', keg: 'bottle shops', pharmacy: 'chemists', baby: 'shops', pets: 'shops', ...slots('shops') };

/**
 * A table by section whose custom sections' entries are worked out from each one's current name
 * ("Shops for Car stuff"): they follow a rename without the table being made again.
 */
export function withCustom<T, K extends string = Section>(base: Omit<Record<K, T>, CustomSection> & Partial<Record<CustomSection, T>>, fn: (name: string, id: CustomSection) => T): Record<K, T> {
  const out = { ...base } as Record<string, T>;
  for (const id of CUSTOM_SECTIONS) Object.defineProperty(out, id, { get: () => fn(SECTION_NAMES[id], id), enumerable: true, configurable: true });
  return out as Record<K, T>;
}

/** 0.10.7: the colours a custom section can be (tokens.css --tile-<colour>-bg / -ink, checked for contrast). */
export const CUSTOM_COLOURS = ['pink', 'blue', 'teal', 'purple', 'orange', 'amber', 'green', 'slate'] as const;
export type CustomColour = (typeof CUSTOM_COLOURS)[number];
export interface CustomDef {
  name: string;
  colour: CustomColour;
  /** An icon from Restock's pack ("pack:car"), or an emoji. */
  icon: string;
}
/**
 * An emoji (or a short run of them, like a flag) can stand in for a pack icon, the same in
 * SharedSettings.java: up to 16 characters, all from the emoji blocks (and the joiners, skin tones
 * and variation marks that build one), with at least one picture. 0.10.8: only emoji, not any
 * non-English letters (a word in the icon's box) or invisible marks that flip text around.
 */
const EMOJI_PART = (c: number) =>
  (c >= 0x1f000 && c <= 0x1faff) || // pictures, flags, skin tones
  (c >= 0x2600 && c <= 0x27bf) || // ☀ ✂ ✈ ❤
  (c >= 0x2300 && c <= 0x23ff) || // ⌚ ⏰
  (c >= 0x2b00 && c <= 0x2bff) || // ⬆ ⭐
  (c >= 0x2190 && c <= 0x21ff) || // ↔
  (c >= 0x25a0 && c <= 0x25ff) || // ▪ ◼
  (c >= 0xe0020 && c <= 0xe007f) || // tag letters (some flags)
  [0x00a9, 0x00ae, 0x203c, 0x2049, 0x2122, 0x2139, 0x24c2, 0x2934, 0x2935, 0x3030, 0x303d, 0x3297, 0x3299].includes(c);
const EMOJI_GLUE = (c: number) => c === 0x200d || c === 0xfe0f || c === 0xfe0e || c === 0x20e3;
export function isEmojiIcon(s: string): boolean {
  if (!s || s.length > 16) return false;
  let picture = false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (EMOJI_PART(c)) picture = true;
    else if (!EMOJI_GLUE(c)) return false;
  }
  return picture;
}
/** Letters that are invisible or turn text around (bidi controls, zero-width spaces), never in a name. */
const HIDDEN = /[\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
/** The pack's icons (components.tsx PACK_ICONS has the drawings). */
export const PACK_ICON_IDS = [
  'bottle', 'paw', 'car', 'tools', 'papers', 'office', 'plant', 'roller', 'bulb', 'gift', 'shirt', 'book',
  'gamepad', 'dumbbell', 'tent', 'fishing', 'couch', 'phone', 'spray', 'scissors', 'ball', 'coffee', 'wine', 'star',
] as const;
/**
 * A custom section's name, colour and icon as it may be kept, or undefined (0.10.7). Used for
 * settings and for the household's shared rows (sharedSettings.ts custom:<id>; SharedSettings.java).
 */
export function checkCustomDef(v: unknown): CustomDef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.replace(/[ \t\n\r\f\v]+/g, ' ').trim() : '';
  if (!name || name.length > 30 || /[\u0000-\u001f\u007f<>]/.test(name) || HIDDEN.test(name)) return undefined;
  if (!(CUSTOM_COLOURS as readonly string[]).includes(o.colour as string)) return undefined;
  const icon = typeof o.icon === 'string' ? o.icon.trim() : '';
  const okIcon = (icon.startsWith('pack:') && (PACK_ICON_IDS as readonly string[]).includes(icon.slice(5))) || isEmojiIcon(icon);
  if (!okIcon) return undefined;
  return { name, colour: o.colour as CustomColour, icon };
}

/** What Baby and Pets look like until someone changes them. */
export const CUSTOM_DEFAULTS: Partial<Record<CustomSection, CustomDef>> = {
  baby: { name: 'Baby', colour: 'pink', icon: 'pack:bottle' },
  pets: { name: 'Pets', colour: 'blue', icon: 'pack:paw' },
};
/** A custom section's name, colour and icon. */
export function customDef(s: { customSections?: Partial<Record<CustomSection, CustomDef>> } | undefined, id: CustomSection): CustomDef {
  return s?.customSections?.[id] ?? CUSTOM_DEFAULTS[id] ?? { name: 'Custom', colour: 'slate', icon: 'pack:star' };
}
/** Puts each custom section's own name into the tables above (called whenever settings load or change). */
export function applyCustomSections(s: { customSections?: Partial<Record<CustomSection, CustomDef>> } | undefined) {
  const icons: Partial<Record<string, string>> = {};
  for (const id of CUSTOM_SECTIONS) {
    const d = customDef(s, id);
    SECTION_NAMES[id] = d.name;
    SECTION_PLACE[id] = `your ${d.name} list`;
    LIST_NAMES[id] = d.name;
    icons[id] = d.icon;
  }
  for (const fn of iconListeners) fn(icons);
}
/** Told each custom section's icon when settings change (components.tsx setSectionIcons). */
const iconListeners = new Set<(icons: Partial<Record<string, string>>) => void>();
export const onSectionIcons = (fn: (icons: Partial<Record<string, string>>) => void) => void iconListeners.add(fn);
/** 0.10.3: the tab a section's records are shared with (household sync): Baby and Pets go with Groceries. */
export type ShareTab = 'pantry' | 'keg' | 'pharmacy';
export const SHARE_TABS: ShareTab[] = ['pantry', 'keg', 'pharmacy'];
export const shareTab = (s: string | null | undefined): ShareTab => (s === 'keg' || s === 'pharmacy' ? s : 'pantry');

/**
 * 0.9.5: the shopping lists. Each tab's own (Groceries is the Pantry tab's), and General: a list only,
 * with no pantry and no shops of its own, for what Home Assistant adds that matches nothing (and for
 * anything put there by hand). Its lines are list_entries with section 'general'. For sharing it goes
 * with Groceries (listShareTab), so a phone that shares Groceries shares General too.
 */
export type ListSection = Section | 'general';
export const LIST_SECTIONS: ListSection[] = ['pantry', 'keg', 'pharmacy', 'baby', 'pets', ...CUSTOM_SLOTS, 'general'];
/** The tab names on the list (phone and web). */
export const LIST_NAMES: Record<ListSection, string> = { pantry: 'Groceries', keg: 'Bottle shop', pharmacy: 'Chemist', baby: 'Baby', pets: 'Pets', ...slots('Custom'), general: 'General' };
/** "Nothing on your General list", "tap the cart next to anything in your pantry". */
export const LIST_PLACE: Record<ListSection, string> = { ...SECTION_PLACE, general: 'your pantry' };
/** A list_entries section as stored: anything this version doesn't know is the grocery list. */
export const asListSection = (v: unknown): ListSection =>
  v === 'keg' || v === 'pharmacy' || v === 'general' || isCustomSection(v) ? v : 'pantry';
/** The tab a list's lines are shared with (household sync, the server, What this phone shares): General goes with Groceries. */
export const listShareTab = (s: ListSection | null | undefined): ShareTab => shareTab(s);

export type GroceryChain = 'woolworths' | 'coles' | 'aldi' | 'costco';
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
/** 0.10.3 (beta): IGA, and the baby, pet and big box shops. Read from their websites ('web'). */
export type MoreChain = 'iga' | 'babybunting' | 'bigw' | 'kmart' | 'target' | 'petbarn' | 'petstock' | 'petcircle' | 'bunnings';
/** 0.11.3 (beta): more shops to pick from, all read from their websites ('web') and none tried on a phone before release. */
export type Chain0113 =
  | 'foodworks'
  | 'drakes'
  | 'harrisfarm'
  | 'spudshed'
  | 'foodland'
  | 'nqr'
  | 'supabarn'
  | 'liquorlegends'
  | 'bottlemart'
  | 'babykingdom'
  | 'babyland'
  | 'babyvillage'
  | 'bestfriendspets'
  | 'peto'
  | 'budgetpet'
  | 'petquarters'
  | 'supercheap'
  | 'repco'
  | 'autobarn'
  | 'autopro'
  | 'burson'
  | 'mitre10'
  | 'totaltools'
  | 'sydneytools'
  | 'homehardware'
  | 'bcf'
  | 'anaconda'
  | 'kings'
  | 'tentworld'
  | 'kathmandu'
  | 'rebel'
  | 'decathlon'
  | 'jbhifi'
  | 'officeworks'
  | 'goodguys'
  | 'harveynorman'
  | 'binglee'
  | 'spotlight'
  | 'lincraft'
  | 'ikea'
  | 'adairs'
  | 'pillowtalk'
  | 'mecca'
  | 'adorebeauty'
  | 'rejectshop'
  | 'cheapaschips'
  | 'reddot';
export type BuiltinChain = GroceryChain | LiquorChain | PharmacyChain | MoreChain | Chain0113;
/** A shop the person added themselves (a website and a name). */
export type CustomChain = `custom-${string}`;
export type Chain = BuiltinChain | CustomChain | 'other';
/** Any real shop (not "Other", which means a hand-typed price). */
export type StoreChain = Exclude<Chain, 'other'>;

/**
 * How Restock talks to a shop:
 * - woolworths / coles / aldi: the supermarkets' own apps' data.
 * - costco (0.9.6): costco.com.au's public pages, read on a phone only, only when Search is pressed
 *   (src/stores/costco.ts). Off by default and per phone (settings.costco), never in enabledChains.
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
  /** 0.10.3: the heading it's under in the shop picker (otherwise its tab's). */
  group?: ShopGroup;
  /** 0.10.3: "Choose your store" opens the shop's website to pick it there (IGA: prices are each branch's own). */
  pickOnSite?: string;
}

/** 0.10.3: the headings in the shop picker, every tab's picker listing every shop under them. */
export type ShopGroup =
  | 'supermarket' | 'pharmacy' | 'bottle' | 'baby' | 'pet' | 'bigbox'
  // 0.11.3
  | 'auto' | 'hardware' | 'outdoors' | 'sport' | 'electronics' | 'home' | 'beauty' | 'variety'
  | 'other';
export const SHOP_GROUPS: { id: ShopGroup; name: string }[] = [
  { id: 'supermarket', name: 'Supermarkets' },
  { id: 'pharmacy', name: 'Chemists' },
  { id: 'bottle', name: 'Bottle shops' },
  { id: 'baby', name: 'Baby shops' },
  { id: 'pet', name: 'Pet shops' },
  { id: 'bigbox', name: 'Big box shops' },
  { id: 'auto', name: 'Automotive' },
  { id: 'hardware', name: 'Hardware and garden' },
  { id: 'outdoors', name: 'Outdoors and camping' },
  { id: 'sport', name: 'Sport' },
  { id: 'electronics', name: 'Electronics and office' },
  { id: 'home', name: 'Home and craft' },
  { id: 'beauty', name: 'Health and beauty' },
  { id: 'variety', name: 'Discount variety' },
  { id: 'other', name: 'Other shops' },
];
const GROUP_OF: Record<Section, ShopGroup> = { pantry: 'supermarket', keg: 'bottle', pharmacy: 'pharmacy', baby: 'baby', pets: 'pet', ...slots('other' as ShopGroup) };
export const groupOf = (d: ShopDef): ShopGroup => d.group ?? GROUP_OF[d.section];

const G = (d: Omit<ShopDef, 'section'>): ShopDef => ({ ...d, section: 'pantry' });
const L = (d: Omit<ShopDef, 'section' | 'kind'> & { kind?: ShopKind }): ShopDef => ({ kind: 'web', ...d, section: 'keg' });
const P = (d: Omit<ShopDef, 'section' | 'kind'> & { kind?: ShopKind }): ShopDef => ({ kind: 'web', ...d, section: 'pharmacy' });
/** 0.10.3: a shop read from its website, whose own tab is `section`. */
const W = (section: Section, d: Omit<ShopDef, 'section' | 'kind'>): ShopDef => ({ kind: 'web', ...d, section });

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

  // 0.9.7: Costco is a supermarket like the others: picked with the shops (enabledChains), off by
  // default, shared with the household and the server. Searched only when Search is pressed.
  G({
    id: 'costco',
    name: 'Costco',
    kind: 'costco',
    color: '#5b6b7a',
    website: 'https://www.costco.com.au',
    map: /\bcostco\b/i,
    note: 'Online prices, delivery included',
    catalogue: { url: 'https://www.costco.com.au/warehouse-savings', note: "Costco's warehouse savings for members." },
    group: 'other',
  }),
  // 0.10.3 (beta): IGA. Each IGA is independently owned and sets its own prices, so its prices are
  // the store picked on IGA's own shopping website (pickOnSite), read like any shop's website.
  W('pantry', {
    id: 'iga',
    name: 'IGA',
    color: '#e3001b',
    website: 'https://www.igashop.com.au',
    map: /\biga\b/i,
    note: "Your branch's own prices, from IGA's shopping website",
    pickOnSite: 'Enter your postcode and choose your IGA branch at the top of the page (sign in if you like). Then tap Done.',
    catalogue: { url: 'https://www.igashop.com.au/specials/1', note: 'Specials at the branch you picked.' },
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
    // 0.12.8: its shop moved: "/?s=" now opens its front page (no products, so it read as blocked)
    search: 'https://pharmacy4less.com.au/search.php?search_query={q}&section=product',
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

  // 0.10.3 (beta): baby, pet and big box shops, read from their websites like the chemists.
  W('baby', { id: 'babybunting', name: 'Baby Bunting', color: '#00a6a6', website: 'https://www.babybunting.com.au', map: /baby bunting/i }),
  W('pets', { id: 'petbarn', name: 'Petbarn', color: '#00843d', website: 'https://www.petbarn.com.au', map: /petbarn/i }),
  W('pets', { id: 'petstock', name: 'Petstock', color: '#e4002b', website: 'https://www.petstock.com.au', map: /petstock/i }),
  W('pets', {
    id: 'petcircle',
    name: 'Pet Circle',
    color: '#ff6b00',
    website: 'https://www.petcircle.com.au',
    search: 'https://www.petcircle.com.au/search?q={q}',
    map: /pet circle/i,
    note: 'Online only, delivered',
  }),
  W('baby', { id: 'bigw', name: 'Big W', color: '#0055a5', website: 'https://www.bigw.com.au', search: 'https://www.bigw.com.au/search?text={q}', map: /big ?w\b/i, group: 'bigbox' }),
  W('baby', { id: 'kmart', name: 'Kmart', color: '#e2231a', website: 'https://www.kmart.com.au', search: 'https://www.kmart.com.au/search/?searchTerm={q}', map: /\bkmart\b/i, group: 'bigbox' }),
  W('baby', { id: 'target', name: 'Target', color: '#cc0000', website: 'https://www.target.com.au', map: /\btarget\b/i, group: 'bigbox' }),
  W('pets', {
    id: 'bunnings',
    name: 'Bunnings',
    color: '#0d5257',
    website: 'https://www.bunnings.com.au',
    search: 'https://www.bunnings.com.au/search/products?q={q}',
    map: /bunnings/i,
    group: 'hardware',
  }),

  // 0.11.3 (beta): more shops under each heading, and eight new headings. Each is read from its
  // website like the chemists, with its search page found from its home page (no saved address), and
  // none was tried on a phone before release: the shop test (Settings) says how each one goes.
  W('pantry', { id: 'foodworks', name: 'Foodworks', color: '#e31837', website: 'https://www.foodworks.com.au', map: /food\s?works/i }),
  W('pantry', { id: 'drakes', name: 'Drakes', color: '#d71920', website: 'https://www.drakes.com.au', map: /\bdrakes\b/i, note: 'SA and Queensland' }),
  W('pantry', { id: 'harrisfarm', name: 'Harris Farm Markets', color: '#00704a', website: 'https://www.harrisfarm.com.au', map: /harris farm/i }),
  W('pantry', { id: 'spudshed', name: 'Spudshed', color: '#f58220', website: 'https://www.spudshed.com.au', map: /spud\s?shed/i, note: 'Western Australia' }),
  W('pantry', { id: 'foodland', name: 'Foodland', color: '#e2001a', website: 'https://www.foodlandsa.com.au', map: /\bfoodland\b/i, note: 'South Australia' }),
  W('pantry', { id: 'nqr', name: 'NQR', color: '#ed1c24', website: 'https://www.nqr.com.au', map: /\bnqr\b/i, note: 'Victoria' }),
  W('pantry', { id: 'supabarn', name: 'Supabarn', color: '#007a33', website: 'https://www.supabarn.com.au', map: /supabarn/i }),
  L({ id: 'liquorlegends', name: 'Liquor Legends', color: '#f7941d', website: 'https://liquorlegends.com.au', map: /liquor legends/i }),
  L({ id: 'bottlemart', name: 'Bottlemart', color: '#c8102e', website: 'https://www.bottlemart.com.au', map: /bottlemart/i }),
  W('baby', { id: 'babykingdom', name: 'Baby Kingdom', color: '#5b2d8e', website: 'https://www.babykingdom.com.au', map: /baby kingdom/i }),
  W('baby', { id: 'babyland', name: 'Babyland', color: '#00a0df', website: 'https://www.babyland.com.au', map: /\bbabyland\b/i }),
  W('baby', { id: 'babyvillage', name: 'Baby Village', color: '#6fbe44', website: 'https://www.babyvillage.com.au', map: /baby village/i }),
  W('pets', { id: 'bestfriendspets', name: 'Best Friends Pets', color: '#f15a29', website: 'https://www.bestfriendspets.com.au', map: /best friends/i }),
  W('pets', { id: 'peto', name: 'PETO (My Pet Warehouse)', color: '#00a3ad', website: 'https://peto.com.au', map: /\bpeto\b|my pet warehouse/i }),
  W('pets', { id: 'budgetpet', name: 'Budget Pet Products', color: '#e31b23', website: 'https://www.budgetpetproducts.com.au', map: /budget pet/i, note: 'Online only, delivered' }),
  W('pets', { id: 'petquarters', name: 'PETQuarters', color: '#0072ce', website: 'https://www.petquarters.com.au', map: /pet\s?quarters/i }),
  W('pets', { id: 'supercheap', name: 'Supercheap Auto', color: '#e2231a', website: 'https://www.supercheapauto.com.au', map: /super\s?cheap/i, group: 'auto' }),
  W('pets', { id: 'repco', name: 'Repco', color: '#d0021b', website: 'https://www.repco.com.au', map: /\brepco\b/i, group: 'auto' }),
  W('pets', { id: 'autobarn', name: 'Autobarn', color: '#ffcb05', website: 'https://www.autobarn.com.au', map: /autobarn/i, group: 'auto' }),
  W('pets', { id: 'autopro', name: 'Autopro', color: '#0054a6', website: 'https://autopro.com.au', map: /\bautopro\b/i, group: 'auto' }),
  W('pets', { id: 'burson', name: 'Burson Auto Parts', color: '#00529b', website: 'https://www.burson.com.au', map: /\bburson/i, group: 'auto' }),
  W('pets', { id: 'mitre10', name: 'Mitre 10', color: '#0055a4', website: 'https://www.mitre10.com.au', map: /mitre\s?10/i, group: 'hardware' }),
  W('pets', { id: 'totaltools', name: 'Total Tools', color: '#e4002b', website: 'https://www.totaltools.com.au', map: /total tools/i, group: 'hardware' }),
  W('pets', { id: 'sydneytools', name: 'Sydney Tools', color: '#ffd100', website: 'https://sydneytools.com.au', map: /sydney tools/i, group: 'hardware' }),
  W('pets', { id: 'homehardware', name: 'Home Timber & Hardware', color: '#00843d', website: 'https://www.homehardware.com.au', map: /home (timber|hardware)/i, group: 'hardware' }),
  W('pets', { id: 'bcf', name: 'BCF', color: '#f47b20', website: 'https://www.bcf.com.au', map: /\bbcf\b|boating camping fishing/i, group: 'outdoors' }),
  W('pets', { id: 'anaconda', name: 'Anaconda', color: '#00693c', website: 'https://www.anacondastores.com', map: /\banaconda\b/i, group: 'outdoors' }),
  W('pets', { id: 'kings', name: 'Kings (4WD Supacentre)', color: '#f26522', website: 'https://www.4wdsupacentre.com.au', map: /4wd supa\s?centre|adventure kings/i, group: 'outdoors' }),
  W('pets', { id: 'tentworld', name: 'Tentworld', color: '#00a651', website: 'https://www.tentworld.com.au', map: /tentworld/i, group: 'outdoors' }),
  W('pets', { id: 'kathmandu', name: 'Kathmandu', color: '#231f20', website: 'https://www.kathmandu.com.au', map: /kathmandu/i, group: 'outdoors' }),
  W('pets', { id: 'rebel', name: 'Rebel', color: '#e4002b', website: 'https://www.rebelsport.com.au', map: /\brebel\b/i, group: 'sport' }),
  W('pets', { id: 'decathlon', name: 'Decathlon', color: '#0082c3', website: 'https://www.decathlon.com.au', map: /decathlon/i, group: 'sport' }),
  W('pets', { id: 'jbhifi', name: 'JB Hi-Fi', color: '#ffe600', website: 'https://www.jbhifi.com.au', map: /jb hi-?fi/i, group: 'electronics' }),
  W('pets', { id: 'officeworks', name: 'Officeworks', color: '#0061a8', website: 'https://www.officeworks.com.au', map: /officeworks/i, group: 'electronics' }),
  W('pets', { id: 'goodguys', name: 'The Good Guys', color: '#0072bc', website: 'https://www.thegoodguys.com.au', map: /good guys/i, group: 'electronics' }),
  W('pets', { id: 'harveynorman', name: 'Harvey Norman', color: '#0054a6', website: 'https://www.harveynorman.com.au', map: /harvey norman/i, group: 'electronics' }),
  W('pets', { id: 'binglee', name: 'Bing Lee', color: '#e30613', website: 'https://www.binglee.com.au', map: /bing lee/i, group: 'electronics' }),
  W('pets', { id: 'spotlight', name: 'Spotlight', color: '#e4002b', website: 'https://www.spotlightstores.com', map: /\bspotlight\b/i, group: 'home' }),
  W('pets', { id: 'lincraft', name: 'Lincraft', color: '#d6006e', website: 'https://www.lincraft.com.au', map: /lincraft/i, group: 'home' }),
  W('pets', { id: 'ikea', name: 'IKEA', color: '#0058a3', website: 'https://www.ikea.com/au/en/', map: /\bikea\b/i, group: 'home' }),
  W('pets', { id: 'adairs', name: 'Adairs', color: '#1d1d1b', website: 'https://www.adairs.com.au', map: /\badairs\b/i, group: 'home' }),
  W('pets', { id: 'pillowtalk', name: 'Pillow Talk', color: '#6d6e71', website: 'https://www.pillowtalk.com.au', map: /pillow talk/i, group: 'home' }),
  W('pets', { id: 'mecca', name: 'Mecca', color: '#c8102e', website: 'https://www.mecca.com/en-au/', map: /\bmecca\b/i, group: 'beauty' }),
  W('pets', { id: 'adorebeauty', name: 'Adore Beauty', color: '#f4a6b7', website: 'https://www.adorebeauty.com.au', map: /adore beauty/i, group: 'beauty', note: 'Online only, delivered' }),
  W('pets', { id: 'rejectshop', name: 'The Reject Shop', color: '#e2231a', website: 'https://www.rejectshop.com.au', map: /reject shop/i, group: 'variety' }),
  W('pets', { id: 'cheapaschips', name: 'Cheap as Chips', color: '#ed1c24', website: 'https://www.cheapaschips.com.au', map: /cheap as chips/i, group: 'variety' }),
  W('pets', { id: 'reddot', name: 'Red Dot', color: '#e30613', website: 'https://www.reddot.com.au', map: /\bred dot\b/i, group: 'variety', note: 'Western Australia' }),
];

/** 0.10.3: the shops marked Beta in the picker (besides every shop on a Beta tab). */
export const BETA_SHOPS: readonly string[] = ['costco', 'iga', 'babybunting', 'petbarn', 'petstock', 'petcircle', 'bigw', 'kmart', 'target', 'bunnings',
  // 0.11.3
  'foodworks', 'drakes', 'harrisfarm', 'spudshed', 'foodland', 'nqr', 'supabarn', 'liquorlegends', 'bottlemart', 'babykingdom', 'babyland', 'babyvillage', 'bestfriendspets', 'peto', 'budgetpet', 'petquarters', 'supercheap', 'repco', 'autobarn', 'autopro', 'burson', 'mitre10', 'totaltools', 'sydneytools', 'homehardware', 'bcf', 'anaconda', 'kings', 'tentworld', 'kathmandu', 'rebel', 'decathlon', 'jbhifi', 'officeworks', 'goodguys', 'harveynorman', 'binglee', 'spotlight', 'lincraft', 'ikea', 'adairs', 'pillowtalk', 'mecca', 'adorebeauty', 'rejectshop', 'cheapaschips', 'reddot',
];

/**
 * 0.11.3: the shops whose prices are shared: sent to restock-prices and downloaded as shared history
 * (lib/priceShare.ts, lib/market.ts, PriceShare.java SHOPS). Costco was one until 0.11.3. A phone
 * keeps the Costco history it already downloaded; nothing new is fetched or sent.
 */
export const SHARED_PRICE_SHOPS = ['coles', 'woolworths', 'aldi'] as const;

const BY_ID = new Map<string, ShopDef>(SHOPS.map((s) => [s.id, s]));
export const GROCERY: GroceryChain[] = ['woolworths', 'coles', 'aldi'];

/**
 * 0.9.6: shops that live on one phone only. Costco is switched on in that phone's own Settings
 * (settings.costco), so it is never in enabledChains and never picked for the household: not shared
 * with other phones or the server, and left out of backups, exports and the shared price pack.
 */
// 0.9.7: none any more (Costco is an ordinary shop). Kept so older code paths stay simple.
export const LOCAL_ONLY_SHOPS: readonly string[] = [];
/** 0.9.7: Costco is asked only when someone presses Search (or Check at Costco): never by a scan, a follow-up, Check now, the background or a connection test. */
export const isPressOnlyShop = (c: string | undefined): boolean => c === 'costco';
export const isLocalOnlyShop = (c: string | undefined): boolean => !!c && LOCAL_ONLY_SHOPS.includes(c);

// Costco picked with the shops (costcoStateOf), kept here so any screen can ask.
let costcoOn = false;
let costcoNotAt = new Set<string>();
export function setCostcoState(c: { on?: boolean; buyOnline?: boolean; notAt?: string[] } | undefined) {
  costcoOn = !!c?.on;
  costcoNotAt = new Set(Array.isArray(c?.notAt) ? c.notAt : []);
}
/** 0.9.7: Costco is on when it's picked with the shops (enabledChains), like any other shop. */
export const costcoStateOf = (s: { enabledChains?: readonly string[]; costco?: { notAt?: string[] } } | undefined) =>
  s ? { on: !!s.enabledChains?.includes('costco'), notAt: s.costco?.notAt } : undefined;
/** 0.9.6 (review L1): did this phone say "Not at Costco" for this item? Kept on the phone (settings.costco.notAt), never in the shared item. */
export const costcoNotHere = (groupId: string | undefined): boolean => !!groupId && costcoNotAt.has(groupId);
/** Is Costco switched on on this phone? Never true on the server or the web page. */
export const costcoIsOn = () => costcoOn;
/** Do Costco prices count when working out the cheapest shop? Only when switched on and "I buy from Costco online" is ticked. */
// 0.9.7: always: Costco is only there when picked, and counts like any shop.
export const costcoDecides = () => true;

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

/**
 * A shop's own tab (the one it's shared with, and the one it's in when settings.shopTabs doesn't
 * say). Hand-typed prices ("other") go with whatever item they're on.
 */
export function sectionOf(c: Chain | string | undefined): Section {
  return shopDef(c)?.section ?? customShop(c)?.section ?? 'pantry';
}

// 0.10.3: which tabs each shop is in (settings.shopTabs), kept here like the person's own shops so
// any screen can ask. Set from settings whenever they're read (db.ts).
let shopTabsNow: Partial<Record<string, Section[]>> = {};
export function setShopTabs(m: Partial<Record<string, readonly string[]>> | undefined) {
  const out: Partial<Record<string, Section[]>> = {};
  if (m && typeof m === 'object')
    for (const [k, v] of Object.entries(m)) if (Array.isArray(v)) out[k] = SECTIONS.filter((s) => v.includes(s));
  shopTabsNow = out;
}
/** The tabs a shop is in: what settings.shopTabs says, or its own tab. */
export function tabsOf(c: Chain | string | undefined, m: Partial<Record<string, readonly string[]>> = shopTabsNow): Section[] {
  const t = c ? m[c] : undefined;
  if (Array.isArray(t)) return SECTIONS.filter((s) => t.includes(s));
  return [sectionOf(c)];
}
/** Can this shop's things be on this tab's list (its own tab, or one it's picked for)? `m`: these settings' shopTabs (a screen's unsaved ones). */
export const shopOnTab = (c: Chain | string | undefined, section: Section, m?: Partial<Record<string, readonly string[]>>): boolean =>
  tabsOf(c, m ?? shopTabsNow).includes(section);

/**
 * 0.10.3: a shop picked (on) or not for one tab: the new enabledChains and shopTabs. A shop in no
 * tab any more comes out of enabledChains, and a shop in just its own tab needs no shopTabs entry.
 */
export function pickForTab(
  s: { enabledChains: readonly string[]; shopTabs?: Partial<Record<string, readonly string[]>> },
  chain: string,
  section: Section,
  on: boolean,
): { enabledChains: StoreChain[]; shopTabs: Partial<Record<string, Section[]>> } {
  const map: Partial<Record<string, Section[]>> = {};
  for (const [k, v] of Object.entries(s.shopTabs ?? {})) if (Array.isArray(v)) map[k] = SECTIONS.filter((x) => v.includes(x));
  const was = s.enabledChains.includes(chain) ? tabsOf(chain, map) : [];
  const now = SECTIONS.filter((x) => (x === section ? on : was.includes(x)));
  let enabled = s.enabledChains.filter((c) => c !== chain) as StoreChain[];
  if (now.length) {
    const at = s.enabledChains.indexOf(chain);
    enabled = at >= 0 ? (s.enabledChains as StoreChain[]).slice() : [...enabled, chain as StoreChain];
  }
  if (!now.length || (now.length === 1 && now[0] === sectionOf(chain))) delete map[chain];
  else map[chain] = now;
  return { enabledChains: enabled, shopTabs: map };
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

/** 0.10.3: every shop, under its picker heading (built-in ones; the person's own go under Other). */
export function shopsByGroup(): { group: ShopGroup; name: string; shops: { id: StoreChain; name: string; note?: string; custom?: boolean }[] }[] {
  return SHOP_GROUPS.map((g) => ({
    group: g.id,
    name: g.name,
    shops: [
      ...SHOPS.filter((s) => groupOf(s) === g.id).map((s) => ({ id: s.id as StoreChain, name: s.name, note: s.note })),
      ...(g.id === 'other' ? custom.map((s) => ({ id: s.id, name: s.name, note: hostOf(s.website), custom: true })) : []),
    ],
  })).filter((g) => g.shops.length);
}

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
export function enabledIn(enabled: readonly string[], section: Section, m?: Partial<Record<string, readonly string[]>>): StoreChain[] {
  const out = enabled.filter(
    (c): c is StoreChain => c !== 'other' && c !== 'costco' && !isLocalOnlyShop(c) && shopOnTab(c, section, m) && (!!shopDef(c) || !!customShop(c)),
  );
  // 0.9.6: Costco, when it's picked, comes after the other shops (0.10.3: on each tab it's picked for).
  return enabled.includes('costco') && shopOnTab('costco', section, m) ? [...out, 'costco'] : out;
}

/**
 * The shops to search in this section: one per website, so Liquorland, Liquorland Warehouse
 * and Liquorland Cellars only search liquorland.com.au once.
 */
export function searchChainsIn(enabled: readonly string[], section: Section): StoreChain[] {
  return [...new Set(enabledIn(enabled, section).map(priceSource))];
}

/** A tab is shown when it's switched on and at least one of its shops is picked. Pantry always shows. */
export function sectionOn(
  settings: { sections?: Partial<Record<Section, boolean | undefined>>; enabledChains: readonly string[]; shopTabs?: Partial<Record<string, readonly string[]>> },
  section: Section,
): boolean {
  if (section === 'pantry') return true;
  return !!settings.sections?.[section] && enabledIn(settings.enabledChains, section, settings.shopTabs).length > 0;
}

export const activeSections = (settings: Parameters<typeof sectionOn>[0]): Section[] => SECTIONS.filter((s) => sectionOn(settings, s));
/** 0.9.5: the shopping lists shown (List tab and the web): the tabs that are on, then General, always. */
export const listSectionsOn = (settings: Parameters<typeof sectionOn>[0]): ListSection[] => [...activeSections(settings), 'general'];

/** Starting categories for each tab. */
export const DEFAULT_SECTION_CATEGORIES: Record<Section, string[]> = {
  pantry: ['Pantry', 'Fridge & freezer', 'Cleaning', 'Bathroom'],
  keg: ['Beer', 'Wine', 'Spirits', 'Mixers & other'],
  pharmacy: ['Medicine', 'First aid', 'Vitamins', 'Personal care'],
  baby: ['Nappies & wipes', 'Feeding', 'Bath & skin care', 'Health'],
  pets: ['Food', 'Treats', 'Litter & cleaning', 'Health & care'],
  ...slots(['Things']),
};
