// 0.11.2: a category for a new pantry item, from its name. Category was tucked away under "Category and
// alerts" when adding, so nearly everything landed in "Other". Now an item you add without choosing one
// goes where its name says (Shampoo → Bathroom), and Pantry offers to sort the ones already in "Other".
// Only the four categories the Pantry tab starts with are guessed, matched to your own categories by
// name; an item that fits none stays in "Other", and you can always move it.
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

/**
 * The id of your category for this name, or undefined. `names` are the item's name first, then its
 * products' names (used when the item's own name says nothing: "Bickfords").
 */
export function guessCategoryId(names: string[], categories: Pick<Category, 'id' | 'name' | 'section'>[], section: Section): string | undefined {
  if (section !== 'pantry') return undefined;
  const mine = categories.filter((c) => c.section === section);
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
