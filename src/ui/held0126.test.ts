// 0.12.6: what the update says, read from the source (as ways0125.test.ts does).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('0.12.6: nothing is picked for you', () => {
  const add = read('./screens/Add.tsx');
  it('your first tick ticks nothing at your other shops', () => {
    expect(add).not.toContain('closestTo(');
    expect(add).not.toContain('autoFrom');
    expect(add).not.toContain("'Closest found · check it'");
  });
  it('a typed search that is sure of itself is not ticked for you', () => {
    expect(add).not.toContain('surePick(');
    expect(add).not.toContain('Best match for what you typed');
  });
  it('a scan ticks only the product with that barcode', () => {
    expect(add).toContain("filter(([, m]) => m.sure === 'barcode')");
    expect(add).not.toContain("for (const p of c.at) if (!m.has(p.chain)) m.set(p.chain, { sp: p, sure: 'same' });");
  });
  it('a shop with nothing ticked says Not added, with Find it and Not sold here', () => {
    expect(add).toContain("declined.has(c) ? 'Not sold here' : 'Not added'");
    expect(add).toContain('aria-label={`Find it at ${chainName(c)}`}');
    expect(add).not.toContain('Pick one myself');
    expect(add).not.toContain('Nothing close');
  });
});

describe('0.12.6: the General list comes along when you shop', () => {
  const list = read('./screens/List.tsx');
  it('the grocery list shows it folded, and shopping mode shows it at the bottom of every shop', () => {
    expect(list).toContain("section === 'pantry' && sectionsOn.includes('general')");
    expect(list).toContain('className="card flush fold list-general"');
    expect(list).toContain('General list · get anywhere');
    expect(list).toContain('general={generalToo}');
  });
  it('at one shop: lines with no shop picked, and lines picked for that shop', () => {
    expect(list).toContain("generalShown.filter((e) => v === 'all' || !e.chain || e.chain === v)");
  });
  it('the web page shows them in a column of their own', () => {
    expect(read('../server-mode/ui/DeskList.tsx')).toContain("key: 'general-list'");
  });
});

describe('0.12.6: a search that finds nothing offers the next step', () => {
  it('Pantry: Add, with what was typed carried over', () => {
    const pantry = read('./screens/Pantry.tsx');
    expect(pantry).toContain('<NoneFound');
    expect(pantry).toContain("nav.push({ name: 'add', section, toPantry: true, query: typed })");
  });
  it("a shop's specials: search that shop for it", () => {
    expect(read('./screens/ShopCatalogue.tsx')).toContain("nav.push({ name: 'add', section: base.section, toPantry: true, chain, query: cleanSearch(typed) })");
  });
  it('the web page says where the next step is done', () => {
    expect(read('../server-mode/ui/DeskPantry.tsx')).toContain('phoneOnly="Adding by shop search is done on a phone."');
  });
});

describe("0.12.6: a shop's specials say the kind of deal", () => {
  const shop = read('./screens/ShopCatalogue.tsx');
  it('no "Your item" on every tile', () => {
    expect(shop).not.toContain("'Your item'");
    expect(shop).toContain('className={`cat-tile-badge ${badge.tone}`}');
  });
  it("the ones Restock doesn't count as a special are shown after the real ones, and not counted", () => {
    expect(shop).toContain('doubtfulDeals(recs, chain');
    expect(shop).toContain('`${real} of yours on special`');
    expect(read('../lib/mySpecials.ts')).toContain('doubt(a) - doubt(b) || by[sort](a, b)');
  });
});

describe('0.12.6: one size for each kind of thing', () => {
  it('no dropdown or icon button carries a size of its own', () => {
    for (const f of ['Settings', 'Backups', 'Receipts', 'Item', 'HomeAssistant', 'Categories', 'List']) {
      const src = read(`./screens/${f}.tsx`);
      expect(src).not.toContain("height: 44, padding: '0 36px 0 10px'");
      expect(src).not.toContain('width: 36, height: 36');
    }
  });
  it('the same words everywhere for a shop that does not sell it', () => {
    expect(read('./screens/Item.tsx')).not.toContain('Not here');
  });
});
