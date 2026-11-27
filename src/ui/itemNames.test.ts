// 0.12.7: what was asked for, held to the source so it can't quietly come back.
import { readSource } from '../lib/readSource';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readSource(new URL(p, import.meta.url));
const add = read('./screens/Add.tsx');
const list = read('./screens/List.tsx');
const item = read('./screens/Item.tsx');
const sizes = read('./OtherSizes.tsx');
const comps = read('./components.tsx');
const tokens = read('./tokens.css');
const css = read('./styles.css');

describe('0.12.7: the name is yours', () => {
  it('a new item is never named for you: the box is empty, with one idea to tap', () => {
    expect(add).not.toMatch(/setName\(genericName\(/);
    expect(add).toMatch(/<NameFirst/);
    expect(read('./screens/NameFirst.tsx')).toMatch(/Use "\$\{idea\}"|Use &quot;|Use “|Use "/);
  });
  it('saving without a name is stopped, on the phone and the web', () => {
    expect(add).toMatch(/setNameMissing\(true\)/);
  });
  it('a category is chosen only when Restock is sure', () => {
    expect(add).toMatch(/confidentCategoryId\(/);
  });
});

describe('0.12.7: Also happy with, while adding', () => {
  it('the review page has both groups and saves the alternatives', () => {
    expect(add).toMatch(/Products I buy/); // 0.12.8: renamed from What I buy
    expect(add).toMatch(/Also happy with \(alternative product\)/);
    expect(add).toMatch(/Make it an alternative/);
    expect(add).toMatch(/Move to Products I buy/); // 0.12.8: was "Make it what I buy"
    expect(add).toMatch(/addItemFromPicks\([^)]*altPicks\)/s);
  });
});

describe('0.12.7: shopping', () => {
  it('General comes along from every list (the web page uses the same list screen)', () => {
    expect(list).not.toMatch(/section === 'pantry' \? general/);
  });
  it('Start shopping asks which shops, with none chosen, then where first', () => {
    expect(list).toMatch(/Which shops today\?/);
    expect(list).toMatch(/useState<StoreChain\[\]>\(\[\]\)/);
    expect(list).toMatch(/Where are you first\?/);
    expect(list).not.toMatch(/>\s*Change shops\s*</);
    expect(list).not.toMatch(/function PickShops/);
  });
  it('the trip is planned by lib/tripPlan, alternatives are tagged, and nothing drops off', () => {
    expect(list).toMatch(/tripRecs\(/);
    expect(list).toMatch(/ALTERNATIVE/);
    expect(list).toMatch(/Cheaper at \$\{/);
    expect(list).toMatch(/Not at today's shops/);
  });
  it('every shop you chose keeps its page', () => {
    expect(list).toMatch(/here\(s\)\.length > 0 \|\| chosen\.includes\(s as StoreChain\)/);
  });
});

describe('0.12.7: the ⓘ and the was-date', () => {
  it('the ⓘ is never on the photo', () => {
    const more = comps.slice(comps.indexOf('export function MoreInfo'), comps.indexOf('export function MoreInfo') + 1600);
    expect(more).not.toMatch(/info-dot|more-info-dot/);
    expect(item).toMatch(/<RowInfo/);
    expect(sizes).toMatch(/<RowInfo/);
  });
  it('"Was $5.80 - 01/09/2026" is said in words, and flagged past 14 days, without calling it fake', () => {
    expect(comps).toMatch(/was-since\$\{was\.old \? ' old' : ''\}/);
    expect(css).toMatch(/\.tag\.was-since\.old \{[^}]*--red-bg/s);
    const tag = comps.slice(comps.indexOf('export function PromoTag'), comps.indexOf('export function PromoTag') + 700);
    expect(tag).not.toMatch(/fake/i);
  });
});

describe('0.12.7: the look', () => {
  it('true black: the page is black, the bars are not, and cards are a step lighter', () => {
    const i = tokens.indexOf(":root[data-black='1'][data-theme][data-style]");
    const block = tokens.slice(i, tokens.indexOf('}', i));
    expect(block).toMatch(/--bg: #000000/);
    expect(block).not.toMatch(/--(tabbar|shade|chrome)-bg: #000000/);
    expect(block).not.toMatch(/--surface: #0a0a0a/);
  });
  it('the Shopping list title is the same big title as the other tabs, with the list named under it', () => {
    expect(list).toMatch(/<h1 className="list-title">Shopping list<\/h1>/);
    expect(list).toMatch(/list-switch which-list/);
  });
});
