// 0.10.3: the loyalty and member cards Restock knows, for naming a card when it's added (a search
// box: "Bunnings", "flybuys", "my dans") and drawing it in its shop's colours. Only the name and
// colours: no logos. Flybuys and Everyday Rewards also make member prices count (their program);
// every other card is a barcode with a name, kept the same way as before (program 'other', the
// name as its label), so nothing changes for phones on older versions.
import type { CardProgram, GiftBarcodeType, LoyaltyCard } from '../types';
import { guessBarcodeType } from './giftCards';

export interface CardBrand {
  id: string;
  name: string;
  /** Flybuys and Everyday Rewards: the program whose member prices count. */
  program: CardProgram;
  /** What it's for, under its name. */
  use: string;
  bg: string;
  ink: string;
  /** Other words people type for it. */
  aka?: string[];
}

export const CARD_BRANDS: CardBrand[] = [
  { id: 'flybuys', name: 'Flybuys', program: 'flybuys', use: 'Coles member prices, Liquorland, Kmart, Target', bg: '#0b2d72', ink: '#ffffff', aka: ['coles', 'coles flybuys', 'liquorland', 'kmart', 'target', 'fly buys'] },
  { id: 'everyday', name: 'Everyday Rewards', program: 'everyday', use: 'Woolworths member prices, BWS, Big W', bg: '#ff7d1a', ink: '#0e1b3d', aka: ['woolworths', 'woolworths rewards', 'woolies', 'bws', 'big w', 'everyday'] },
  { id: 'igarewards', name: 'IGA Rewards', program: 'other', use: 'IGA', bg: '#c8102e', ink: '#ffffff', aka: ['iga'] },
  { id: 'powerpass', name: 'Bunnings PowerPass', program: 'other', use: 'Bunnings trade', bg: '#0d5257', ink: '#ffffff', aka: ['bunnings', 'power pass'] },
  { id: 'babybunting', name: 'Baby Bunting membership', program: 'other', use: 'Baby Bunting', bg: '#007f86', ink: '#ffffff', aka: ['baby bunting'] },
  { id: 'petbarn', name: 'Petbarn Friends for Life', program: 'other', use: 'Petbarn', bg: '#00703c', ink: '#ffffff', aka: ['petbarn', 'friends for life'] },
  { id: 'petstock', name: 'Petstock Rewards', program: 'other', use: 'Petstock', bg: '#d0021b', ink: '#ffffff', aka: ['petstock'] },
  { id: 'priceline', name: 'Priceline Sister Club', program: 'other', use: 'Priceline Pharmacy', bg: '#d4006a', ink: '#ffffff', aka: ['priceline', 'sister club'] },
  { id: 'mydans', name: "My Dan's", program: 'other', use: "Dan Murphy's", bg: '#0d5c3b', ink: '#ffffff', aka: ['dan murphys', "dan murphy's", 'dans'] },
  { id: 'costco', name: 'Costco membership', program: 'other', use: 'Costco', bg: '#005daa', ink: '#ffffff', aka: ['costco'] },
  { id: 'myerone', name: 'MYER one', program: 'other', use: 'Myer', bg: '#1a1a1a', ink: '#ffffff', aka: ['myer'] },
  { id: 'qantas', name: 'Qantas Frequent Flyer', program: 'other', use: 'Qantas points', bg: '#d6001c', ink: '#ffffff', aka: ['qantas', 'qff'] },
  { id: 'velocity', name: 'Velocity Frequent Flyer', program: 'other', use: 'Velocity points', bg: '#8a1538', ink: '#ffffff', aka: ['velocity', 'virgin'] },
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The known card a loyalty card is: by its program, or its name. */
export function brandOf(c: Pick<LoyaltyCard, 'program' | 'label'>): CardBrand | undefined {
  if (c.program === 'flybuys' || c.program === 'everyday') return CARD_BRANDS.find((b) => b.id === c.program);
  const l = squash(c.label ?? '');
  return CARD_BRANDS.find((b) => b.program === 'other' && (squash(b.name) === l || b.aka?.some((a) => squash(a) === l)));
}

/** The known cards matching what's typed (all of them for nothing typed), best first. */
export function searchBrands(q: string): CardBrand[] {
  const t = squash(q);
  if (!t) return CARD_BRANDS;
  const score = (b: CardBrand) => {
    const words = [b.name, ...(b.aka ?? [])].map(squash);
    if (words.some((w) => w === t)) return 3;
    if (words.some((w) => w.startsWith(t))) return 2;
    if (words.some((w) => w.includes(t))) return 1;
    return 0;
  };
  return CARD_BRANDS.map((b) => [b, score(b)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([b]) => b);
}

/** The barcode a loyalty card is drawn with: the kind picked when it was added on this phone, or worked out from the number. */
export function loyaltyCodeType(c: Pick<LoyaltyCard, 'id' | 'number'>, picked?: Partial<Record<string, GiftBarcodeType>>): GiftBarcodeType {
  const t = picked?.[c.id];
  if (t) return t;
  // As before 0.10.3: a line barcode, unless the number can only be a QR code.
  return guessBarcodeType(c.number) === 'QR' ? 'QR' : 'CODE128';
}
