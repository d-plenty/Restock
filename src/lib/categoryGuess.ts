// 0.11.2: a category for a new pantry item, from its name. Category was tucked away under "Category and
// alerts" when adding, so nearly everything landed in "Other". Now an item you add without choosing one
// goes where its name says (Shampoo → Bathroom), and Pantry offers to sort the ones already in "Other".
// The four categories the Pantry tab starts with are guessed, matched to your own categories by name
// (0.11.3: and categories you made yourself, where an item's name plainly fits); an item that fits
// none stays in "Other", and you can always move it.
import type { Category, Section } from '../types';

export type CategoryKind = 'pantry' | 'fridge' | 'cleaning' | 'bathroom';

const has = (words: string) => new RegExp(`\\b(?:${words})\\b`, 'i');

// Shelf things whose names sound like the fridge, a cleaner or the bathroom.
const SHELF_FIRST = has(
  'coconut (?:milk|cream)|long ?life|uht|creaming soda|cream soda|milk chocolate|peanut butter|butter (?:popcorn|chicken sauce)|triple butter|evaporated milk|condensed milk|powdered milk|milk powder|cream of|sour cream (?:and|&) (?:chives?|onion)|egg noodles|cooking spray|soap ?nuts',
);
const CLEANING = has(
  'dish ?wash\\w*|dishwasher|detergent|laundry|washing (?:powder|liquid)|cleaners?|bleach|disinfect\\w*|glen ?20|sponges?|scourers?|magic eraser|bin (?:bags?|liners?)|garbage bags?|toilet (?:block|cleaner|gel)|rinse aid|paper towels?|colour catcher|fabric softener|softener|stain remover|oven cleaner|window|mop|cling wrap|foil|baking paper|air freshener|fly spray|insect spray|surface (?:spray|wipes?)',
);
const BATHROOM = has(
  'shampoo|conditioner|body ?wash|shower gel|soaps?|hand ?wash|deodorants?|anti-?perspirant|tooth ?paste|tooth ?brush\\w*|mouth ?wash|floss|razors?|shaving|toilet (?:paper|tissue|rolls?)|tissues|sunscreen|moisturiser|lotion|cotton (?:buds|tips|balls)|tampons|pads|liners|nappies|baby wipes|make ?up|face wash|cleanser|hair (?:spray|gel|dye)|lip balm',
);
const FRIDGE = has(
  'milk|cheese|fetta|feta|yoghurts?|yogurts?|butter|margarine|cream|eggs?|frozen|ice ?cream|icy poles?|juice|bacon|ham|salami|chicken|mince|sausages?|sausage rolls?|steak|beef|lamb|pork|fish|prawns|salmon|wedges|potato gems|hash browns?|nuggets|pizza|peas|dips?|hummus|hommus|tofu|custard|fresh pasta|dumplings|spring rolls?|berries',
);
const PANTRY = has(
  'beans|sauce|pasta|spaghetti|rice|noodles|cereal|oats|muesli|flour|sugar|coffee|tea|chips|crisps|popcorn|biscuits?|cookies|crackers|corn thins|spread|nutella|vegemite|syrup|honey|jam|tomato(?:es)?|soup|stock|chocolate|milo|soft drink|lemonade|cola|soda|pasito|energy drink|cordial|water|bread|bagels?|wraps?|rolls|tuna|oil|vinegar|salt|pepper|spices?|herbs|chives|nuts|lollies|cake|muffins?|pancake|lentils|chickpeas|corn|coconut|mayonnaise|mustard|gravy|taco|tortillas?|apples?|bananas?|potatoes|onions?|carrots?|fruit|vegetables',
);

/** Which of the four starting Pantry categories a name fits, or undefined. */
export function categoryKind(name: string): CategoryKind | undefined {
  const n = name.replace(/[’']/g, '').trim();
  if (!n) return undefined;
  if (SHELF_FIRST.test(n)) return 'pantry';
  if (CLEANING.test(n)) return 'cleaning';
  if (BATHROOM.test(n)) return 'bathroom';
  if (FRIDGE.test(n)) return 'fridge';
  if (PANTRY.test(n)) return 'pantry';
  return undefined;
}

const KIND_OF_CATEGORY: [CategoryKind, RegExp][] = [
  ['fridge', /fridge|freez|frozen|dairy|chilled|cold/i],
  ['cleaning', /clean|laundry/i],
  ['bathroom', /bath|toiletr|personal/i],
  ['pantry', /pantry|cupboard|staples|dry goods/i],
];

// 0.11.3: categories you made yourself. A category named for the thing ("Coffee", "Whiskers") takes
// items with that word in their name, and a few common ones know what belongs in them ("Snacks":
// chips, biscuits). Only where the name makes it plain: anything else is left for the four above.
const OWN_KINDS: [RegExp, RegExp][] = [
  [/snack|treat/i, has('chips|crisps|popcorn|biscuits?|cookies|crackers|chocolates?|lollies|muesli bars?|nut bars?|pretzels|corn chips|twisties|shapes|rice crackers')],
  [/drink|beverage/i, has('soft drinks?|lemonade|cola|coke|pepsi|sodas?|cordial|juices?|mineral water|sparkling water|soda water|tonic water|energy drinks?|iced tea|kombucha|solo|creaming soda')],
  [/breakfast|cereal/i, has('cereals?|oats|muesli|granola|weet-?bix|porridge|corn ?flakes')],
  [/baking/i, has('flour|sugar|baking (?:powder|soda|paper)|cake mix|cake in a cup|yeast|cocoa|vanilla|icing')],
  [/\b(?:pets?|dogs?|cats?)\b/i, has('dogs?|cats?|kittens?|pupp(?:y|ies)|pets?|cat litter|kitty litter')],
  [/\b(?:baby|babies|bub)\b/i, has('napp(?:y|ies)|baby|wipes|formula')],
  [/meat|butcher|deli/i, has('bacon|ham|salami|chicken|mince|sausages?|steaks?|beef|lamb|pork')],
  [/fruit|veg|produce/i, has('apples?|bananas?|oranges?|mandarins?|grapes|berries|strawberries|blueberries|potato(?:es)?|onions?|carrots?|lettuce|tomato(?:es)?|avocados?|capsicums?|broccoli|mushrooms?|cucumbers?|spinach|lemons?|limes?|pumpkin')],
  [/bakery|bread/i, has('bread|bagels?|bread rolls?|wraps|muffins|crumpets|buns|loaf|loaves')],
  [/frozen|freezer/i, has('frozen|ice ?cream|icy poles?|wedges|potato gems|hash browns?|nuggets')],
];
/** Category words that say nothing about what goes in them. */
const VAGUE = new Set(['other', 'others', 'misc', 'food', 'foods', 'item', 'items', 'thing', 'things', 'stuff', 'extra', 'extras', 'more', 'general', 'house', 'home', 'shop', 'shopping', 'weekly', 'and', 'the', 'for', 'our', 'your']);
const stem = (w: string) => (w.length > 4 ? w.replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w);
const wordsOf = (t: string) => t.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** 0.11.3: one of your own categories this name plainly belongs in, or undefined. */
export function ownCategoryId(name: string, mine: Pick<Category, 'id' | 'name'>[]): string | undefined {
  const inName = new Set(wordsOf(name).map(stem));
  if (!inName.size) return undefined;
  // A category named for the thing itself: "Coffee" takes "Coffee pods".
  for (const c of mine) {
    if (KIND_OF_CATEGORY.some(([, rx]) => rx.test(c.name))) continue; // the four starting ones are worked out below
    const words = wordsOf(c.name).filter((w) => w.length >= 3 && !VAGUE.has(w));
    if (words.length && words.some((w) => inName.has(stem(w)))) return c.id;
  }
  // A category for a kind of thing: "Snacks" takes "Corn chips".
  for (const [cat, things] of OWN_KINDS) {
    if (!things.test(name)) continue;
    const c = mine.find((x) => cat.test(x.name));
    if (c) return c.id;
  }
  return undefined;
}

/**
 * The id of your category for this name, or undefined. `names` are the item's name first, then its
 * products' names (used when the item's own name says nothing: "Bickfords"). 0.11.3: a category you
 * made yourself comes first when the item's own name fits it (ownCategoryId).
 */
export function guessCategoryId(names: string[], categories: Pick<Category, 'id' | 'name' | 'section'>[], section: Section): string | undefined {
  if (section !== 'pantry') return undefined;
  const mine = categories.filter((c) => c.section === section);
  const own = names[0] ? ownCategoryId(names[0].replace(/[’']/g, ''), mine) : undefined;
  if (own) return own;
  for (const name of names) {
    const kind = categoryKind(name);
    if (!kind) continue;
    const rx = KIND_OF_CATEGORY.find(([k]) => k === kind)![1];
    return mine.find((c) => rx.test(c.name))?.id;
  }
  return undefined;
}

interface Rec {
  group: { id: string; name: string; categoryId?: string };
  options: { role: string; product: { name: string } }[];
}
/** The items with no category (or one that's gone) whose names fit one of yours: Pantry's "Sort them into categories". */
export function itemsToSort<R extends Rec>(recs: R[], categories: Pick<Category, 'id' | 'name' | 'section'>[], section: Section): { r: R; to: string }[] {
  return recs
    .filter((r) => !r.group.categoryId || !categories.some((c) => c.id === r.group.categoryId))
    .map((r) => ({ r, to: guessCategoryId([r.group.name, ...r.options.filter((o) => o.role === 'main').map((o) => o.product.name)], categories, section) }))
    .filter((x): x is { r: R; to: string } => !!x.to);
}
/** "Pantry, Cleaning and Bathroom": the categories they'd go to. */
export function sortTargets(toSort: { to: string }[], categories: Pick<Category, 'id' | 'name'>[]): string {
  const xs = [...new Set(toSort.map((x) => categories.find((c) => c.id === x.to)?.name ?? ''))].filter(Boolean);
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
