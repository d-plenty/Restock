// 0.12.5: what the update says, read from the source (as navy0124.test.ts does).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('0.12.5: Home and More', () => {
  it('Home has no Settings cog', () => {
    expect(read('./screens/Home.tsx')).not.toContain('aria-label="Settings"');
  });
  it('More offers one Create a custom tab button, and never Bottle shop or Chemist by themselves', () => {
    const more = read('./screens/More.tsx');
    expect(more).toContain('Create a custom tab');
    expect(more).not.toContain('Set up ${SECTION_NAMES[s]}');
    expect(more).not.toContain('notYet');
  });
  it('the starts inside it are Chemist and Bottle shop, then the ready-made ones, then Your own', () => {
    const cs = read('./screens/CustomSections.tsx');
    expect(cs.indexOf("id: 'pharmacy', name: 'Chemist'")).toBeLessThan(cs.indexOf("id: 'keg', name: 'Bottle shop'"));
    for (const n of ['Baby', 'Pets', 'Automotive', 'Tools', 'Office', 'Your own']) expect(cs).toContain(n);
  });
  it('setup never lists Bottle shops or Chemists unless that tab is already on', () => {
    expect(read('./screens/Setup.tsx')).toContain('TILES.filter((t) => !isTabTile(t.id) || !!s.sections[t.id])');
  });
});

describe('0.12.5: the Add screen', () => {
  const add = read('./screens/Add.tsx');
  it('More ways to add is one button that opens to four ways', () => {
    const at = add.indexOf('className="add-more-ways"');
    expect(at).toBeGreaterThan(0);
    const block = add.slice(at, at + 3600);
    for (const t of ['More ways to add', 'Add manually', 'Scan several barcodes', 'Find it from a photo', 'Scan a receipt']) expect(block).toContain(t);
    expect(add).not.toContain('Scan a receipt to keep it');
    expect(add).not.toContain('add-manual-more');
  });
  it('the first results say Recommended', () => {
    expect(add).toContain('<span className="rec-tag">Recommended</span>');
  });
  it("a shop's page ends with Next shop and Finish: review and add; finishing leaves unopened shops empty", () => {
    expect(add).toContain('Finish: review and add');
    expect(add).toContain('const finishEarly = (from: Chain) => {');
    expect(add).toContain('if (declined.has(c) || skipped.has(c) || [...picks.values()].some((p) => p.chain === c)) continue;');
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
  it('a line has How many on it, and the i beside its price', () => {
    expect(list).toContain('className="list-row-qty"');
    const info = list.indexOf('{!selecting && <RowInfo name={title} onOpen={openRow} />}');
    expect(info).toBeGreaterThan(0);
    expect(list.indexOf('className="num list-row-price"', info)).toBeGreaterThan(info);
  });
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
  it('has the best price at each shop, then folds that all look the same', () => {
    expect(item).toContain('Best price at each shop');
    expect(item.match(/<details className="card flush fold"/g)?.length).toBe(3);
    expect(item).toContain('Also happy with (alternative product)');
    expect(item).toContain("Cheaper swaps you'd also accept");
    expect(item).not.toContain("'None yet'");
  });
  it('What I buy opens by itself when something in it needs you', () => {
    expect(item).toContain('const whatOpen = !mains.length || !!rec.mixedUnits || !!rec.shelf;');
  });
});
