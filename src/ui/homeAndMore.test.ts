// 0.12.5: what the update says, read from the source. 0.15.1: what can be seen and tapped is checked by using the screens (screens/homeAndMore.behaviour.test.tsx); these are the rest.
import { readSource } from '../lib/readSource';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readSource(new URL(p, import.meta.url));

describe('0.12.5: Home and More', () => {
  it('the starts inside it are Chemist and Bottle shop, then the ready-made ones, then Your own', () => {
    const cs = read('./screens/CustomSections.tsx');
    expect(cs.indexOf("name: 'Chemist'")).toBeGreaterThan(-1);
    expect(cs.indexOf("name: 'Chemist'")).toBeLessThan(cs.indexOf("name: 'Bottle shop'"));
    expect(cs.indexOf("name: 'Bottle shop'")).toBeLessThan(cs.indexOf("name: 'Baby'"));
    for (const n of ['Baby', 'Pets', 'Automotive', 'Tools', 'Office', 'Your own']) expect(cs).toContain(n);
  });
  it('setup never lists Bottle shops or Chemists unless that tab is already on', () => {
    // 0.13.0: nor then: they have no tile of their own at all
    expect(read('./screens/Setup.tsx')).toContain('TILES.filter((t) => !isTabTile(t.id))');
  });
});

describe('0.12.5: the Add screen', () => {
  const add = read('./screens/Add.tsx');
  it('the first results say Recommended', () => {
    expect(add).toContain('<span className="rec-tag">Recommended</span>');
  });
  it("a shop's page ends with Next shop and Finish: review and add; finishing leaves unopened shops empty", () => {
    expect(add).toContain('Finish: review and add');
    expect(add).toContain('const finishEarly = () => {');
    expect(add).toContain("'Not added'");
  });
  it('the bar says Review and add', () => {
    expect(add).toContain('{picks.size} picked · Review and add');
  });
  it('the review sheet has the name and category first, then the picks, then Alerts', () => {
    const top = add.indexOf('className="review-top"');
    const cards = add.indexOf('{matchCards}', top);
    const alerts = add.indexOf('<span>Alerts and savings</span>');
    expect(top).toBeGreaterThan(0);
    expect(cards).toBeGreaterThan(top);
    expect(alerts).toBeGreaterThan(cards);
    expect(add).not.toContain('Name, category and alerts');
  });
});

describe('0.12.5: the shopping list', () => {
  const list = read('./screens/List.tsx');
  it("the line's page has the product's details and the shop's page, and folds the editing away", () => {
    expect(list).toContain('{shown && <DetailsPanel product={shown} />}');
    expect(list).toContain('<span>Edit this item</span>');
    expect(list).toContain("{editOpen ? 'Save' : 'Done'}");
  });
  it('shopping mode keeps plain lines ("3 × Juice"), with the same i and the same page', () => {
    const mode = list.slice(list.indexOf('function ShoppingMode('));
    expect(mode).toContain('<RowInfo name={name} onOpen={() => setEditing(e)} />');
    expect(mode).toContain('<EditEntry');
    expect(mode).not.toContain('list-row-qty');
    expect(mode).toContain('{qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}');
  });
});

describe('0.12.5: the pantry item page', () => {
  const item = read('./screens/Item.tsx');
  it('What I buy opens by itself when something in it needs you', () => {
    expect(item).toContain('const whatOpen = !mains.length || !!rec.mixedUnits || !!rec.shelf;');
  });
});
