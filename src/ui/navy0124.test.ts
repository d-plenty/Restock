import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('0.12.4: one navy top on every screen', () => {
  const css = read('./styles.css');
  it("every screen's title bar is the navy top, with curved bottom corners", () => {
    const rule = css.slice(css.indexOf('.navy-top,\n.navy-cont,\n.screen > .topbar {'));
    expect(rule).toContain('background: var(--more-top)');
    expect(rule.slice(0, 400)).toContain('border-radius: 0 0 var(--r-xl) var(--r-xl)');
  });
  it('Home, Pantry, the list, Add and the setup pages put their titles in it', () => {
    for (const f of ['./screens/Home.tsx', './screens/Pantry.tsx', './screens/List.tsx', './screens/Add.tsx', './screens/Setup.tsx']) {
      expect(read(f), f).toContain('className="navy-top');
    }
  });
  it('the main button on navy is gold, and what you type there is dark on white', () => {
    expect(css).toMatch(/:is\(\.navy-top, \.navy-cont, \.screen > \.topbar\) \.btn\.primary \{\s*background: var\(--gold\)/);
    expect(css).toMatch(/:is\(\.navy-top, \.navy-cont\) :is\(input, select, textarea, \.search-field\) \{\s*color: var\(--ink\)/);
  });
  it('the list and Add say Change, with an arrow, to switch', () => {
    for (const f of ['./screens/List.tsx', './screens/Add.tsx']) expect(read(f), f).toMatch(/Change(\{' '\})? ?\s*<span className=\{switching \? 'turn-up' : 'turn-down'\}>/);
  });
  it('each shop on the list still folds and opens', () => {
    expect(read('./screens/List.tsx')).toContain('className="grow shop-head-main" onClick={toggle} aria-expanded={isOpen}');
  });
});

describe('0.12.4: the Add screen is search or scan', () => {
  const add = read('./screens/Add.tsx');
  it('has no More ways to add and no Change shops', () => {
    expect(add).not.toContain('More ways to add{');
    expect(add).not.toContain('toggleMoreWays');
    expect(add).not.toMatch(/>\s*Change shops\s*</);
  });
  it('offers Add manually only once you have searched or scanned', () => {
    expect(add).toContain('Add manually');
    expect(add).toContain('{(!!searchedFor || !!scanned || anyResults) && !changing && (');
    expect(add).not.toContain("Can't find it? Add it by hand");
  });
  it('keeps Scan several and the pack photo, by Add manually', () => {
    const at = add.indexOf('className="add-manual-more"');
    expect(at).toBeGreaterThan(0);
    expect(add.slice(at, at + 900)).toContain('Find it from a photo of the pack');
    expect(add.slice(at, at + 900)).toContain('Scan several barcodes');
  });
});

describe('0.12.4: the starter screen and the map', () => {
  it('a new phone asks no shop for its specials on Home', () => {
    const home = read('./screens/Home.tsx');
    expect(home).not.toContain('loadSpecials');
    expect(home).toContain('Add what you buy');
  });
  it('the map library is the patched one, its worker is bundled, and its credit box stays off', () => {
    const pkg = JSON.parse(read('../../package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['maplibre-gl']).toBe('6.18.0');
    const map = read('./StoreMap.tsx');
    expect(map).toContain("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url");
    expect(map).toContain('setWorkerUrl');
    expect(map).toContain('attributionControl: false');
  });
});

describe('0.12.4: tick as many as you buy as one item', () => {
  const add = read('./screens/Add.tsx');
  const pick = add.slice(add.indexOf('const pickOne = (sp: StoreProduct) => {'), add.indexOf('// 0.12.0: what Restock found at your other shops is picked for you'));
  it('a second + adds to your picks (it used to start over), and + on a ticked one unticks it', () => {
    expect(pick).toContain('if (picks.has(k)) {');
    expect(pick).toContain('key !== k');
    expect(pick).toContain('if (picks.size > 0) {');
    expect(pick).not.toContain('p.chain !== sp.chain), [k, sp]]'); // one per shop
  });
  it("a closest-found Restock ticked itself steps aside for your own pick at that shop; a good match stays", () => {
    expect(pick).toContain("autoFrom.get(keyOf(x)) === 'like'");
  });
  it('the first tick does not open the sheet by itself', () => {
    expect(pick).toContain('if (preTickProp || rankQ.barcode) setPanelOpen(true);');
  });
  it("one shop's results end with Finished at <shop>, which goes to the next shop and then your picks", () => {
    expect(add).toContain('Finished at {chainName(view)}');
    expect(add).toContain('const nextShopAfter = (c: Chain): Chain | undefined => shopsInTurn[shopsInTurn.indexOf(c) + 1];');
    expect(add).toContain('if (picks.size > 0) setPanelOpen(true);');
  });
  it('each pick on the sheet has Remove, and each shop has More', () => {
    expect(add).toContain('aria-label={`Remove ${sp.name} at ${chainName(c)}`}');
    expect(add).toContain('aria-label={`Pick more at ${chainName(c)}`}');
  });
  it('an unticked + is green on white; ticked, a white tick on green', () => {
    const css = read('./styles.css');
    expect(css).toMatch(/span\.plus-btn:not\(\.on\) \{\s*background: var\(--surface\);\s*color: var\(--green-ink\)/);
  });
});
