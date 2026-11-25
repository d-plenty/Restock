// 0.13.0: what was asked for, held to the source and to the small pieces that do the work.
import { readSource } from '../lib/readSource';
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addGroup, allGroups, allListEntries, ensureDefaults, getGroup, initDb, nowIso, readingsFor } from '../lib/db';
import { loadDemo, REAL_SET, removeDemo } from '../lib/demo';
import { allPicks, PICKS_ABOUT, PICKS_TITLE, picksYouHave } from '../lib/makerPicks';
import { nameKey } from '../lib/sameName';
import { checkSettings } from '../lib/settingsCheck';
import { checkValue, keysFor, settingTab } from '../lib/sharedSettings';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { applyCustomSections, CUSTOM_DEFAULTS, customDef, isCustomSection, isMadeSection, MADE_SECTIONS, PACK_ICON_IDS, SECTION_NAMES, shareTab, withCustom } from '../shops';
import { addPicks, picksSaid } from './screens/Picks';
import { ZERO_HOLD_MS } from './Stepper';

const read = (p: string) => readSource(new URL(p, import.meta.url));

beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await ensureDefaults();
});

describe('0.13.0: shopping mode', () => {
  const list = read('./screens/List.tsx');
  it('your cards sit inside the navy top, and the titles are bigger', () => {
    const top = list.slice(list.indexOf('<div className="shopmode-top">'), list.indexOf('<div className="shopmode-sort">'));
    expect(top).toContain('className="chips shopmode-cards"');
    expect(top).toContain('shopmode-title');
    expect(read('./styles.css')).toMatch(/\.shopmode-top > \.shopmode-cards \{[^}]*flex: 0 0 100%/);
  });
});

describe('0.13.0: adding', () => {
  const add = read('./screens/Add.tsx');
  it('three buttons from a tab, each saying what it does', () => {
    expect(add).toMatch(/and shopping list\s*<\/AddBtn>[\s\S]{0,160}<AddBtn target="list"[\s\S]{0,300}Shopping list only, just this once/);
    expect(add).not.toContain('And put it on my shopping list');
  });
  it('only what is kept needs a name', () => {
    expect(add).toMatch(/if \(!name\.trim\(\) && target !== 'list'\)/);
    expect(add).toMatch(/const itemName = name\.trim\(\) \|\| onceName\(/);
    expect(read('../server-mode/ui/WebShopSearch.tsx')).toMatch(/if \(!name\.trim\(\) && target !== 'list'\)/);
  });
});

describe('0.13.0: how many', () => {
  it('a line at 0 waits about two seconds, then comes off the list, and plus keeps it', () => {
    expect(ZERO_HOLD_MS).toBe(2000);
    const s = read('./Stepper.tsx');
    expect(s).toMatch(/setZero\(true\);\s*timer\.current = setTimeout\(\(\) => go\.current\?\.\(\), ZERO_HOLD_MS\)/);
    expect(s).toMatch(/if \(zero\) \{\s*if \(timer\.current !== undefined\) clearTimeout\(timer\.current\);/);
    expect(s).toContain('taken off your shopping list'); // through act(): it can be undone
  });
  it("a tab's row shows it only once the item is on the list", () => {
    expect(read('./simple.tsx')).toMatch(/entry \? <Stepper key=\{entry\.id\} e=\{entry\} name=\{rec\.group\.name\} small \/> : <ListButton/);
    expect(read('./screens/Pantry.tsx')).toMatch(/entry=\{entries\.find\(\(e\) => !e\.checked && e\.groupId === r\.group\.id\)\}/);
  });
});

describe('0.13.0: every tab but Pantry is one you made', () => {
  it('Bottle shop and Chemist have a name, colour and icon like the rest', () => {
    expect(MADE_SECTIONS.slice(0, 2)).toEqual(['keg', 'pharmacy']);
    expect(isMadeSection('keg') && isMadeSection('pharmacy') && isMadeSection('c3')).toBe(true);
    expect(isMadeSection('pantry')).toBe(false);
    expect(customDef(undefined, 'keg')).toEqual({ name: 'Bottle shop', colour: 'amber', icon: 'pack:keg' });
    expect(customDef(undefined, 'pharmacy')).toEqual({ name: 'Chemist', colour: 'green', icon: 'pack:cross' });
    for (const d of Object.values(CUSTOM_DEFAULTS)) expect(PACK_ICON_IDS as readonly string[]).toContain(d!.icon.slice(5));
  });
  it('a rename is followed everywhere, and put back', () => {
    const titles = withCustom<string>({ pantry: 'Groceries', keg: 'Bottle shop', pharmacy: 'Chemist' }, (n) => `Shops for ${n}`);
    applyCustomSections({ customSections: { pharmacy: { name: 'Health', colour: 'teal', icon: 'pack:star' } } });
    expect(SECTION_NAMES.pharmacy).toBe('Health');
    expect(titles.pharmacy).toBe('Shops for Health');
    expect(titles.pantry).toBe('Groceries');
    applyCustomSections(undefined);
    expect(SECTION_NAMES.pharmacy).toBe('Chemist');
  });
  it('they are still shared on their own, and so is their look', () => {
    expect(isCustomSection('keg')).toBe(false);
    expect(shareTab('keg')).toBe('keg');
    expect(settingTab('custom:keg', '{}')).toBe('keg');
    expect(settingTab('custom:c2', '{}')).toBe('pantry');
    const def = { name: 'Grog', colour: 'amber', icon: 'pack:keg' };
    expect(checkValue('custom:keg', def)).toEqual(def);
    expect(checkValue('custom:pantry', def)).toBeUndefined();
    const s = { customSections: { keg: def, c1: { name: 'Tools', colour: 'orange', icon: 'pack:tools' } } };
    expect(keysFor(s, new Set(['pantry']))).toContain('custom:c1');
    expect(keysFor(s, new Set(['pantry']))).not.toContain('custom:keg');
    expect(keysFor(s, new Set(['keg']))).toContain('custom:keg');
  });
  it('settings keep their look, and no tab is hidden any more', () => {
    const s = checkSettings({ sections: { keg: true, pharmacy: false }, customSections: { keg: { name: 'Grog', colour: 'amber', icon: 'pack:keg' } }, hiddenTabs: ['keg'] });
    expect(s.customSections?.keg?.name).toBe('Grog');
    expect(s.hiddenTabs).toBeUndefined();
  });
  it('made, edited and shown the same way', () => {
    const stores = read('./screens/Stores.tsx');
    expect(stores).not.toContain('SectionSwitch');
    expect(stores).toMatch(/isMadeSection\(section\) &&\s*\(on \? \(\s*<CustomSectionHead/);
    expect(read('./screens/Setup.tsx')).toContain('TILES.filter((t) => !isTabTile(t.id))');
    const more = read('./screens/More.tsx');
    expect(more).toContain('more-tile-beta');
    expect(more).toMatch(/className=\{`more-tile tile-colour-\$\{customDef\(settings, s\)\.colour\}`\}/);
    const cs = read('./screens/CustomSections.tsx');
    expect(cs).toMatch(/slot: 'keg', more: true, adult: true/); // 18+ is still asked
    expect(cs).toContain("I'm 18 or over");
  });
  it('every tab has Edit, with items or without', () => {
    const p = read('./screens/Pantry.tsx');
    expect(p).toMatch(/recs\.length === 0 && \(\s*<button className="btn small edit-btn"/);
    expect(p).toMatch(/\{editing && \(\s*<button className="btn small block edit-cats" onClick=\{\(\) => nav\.push\(\{ name: 'stores', section \}\)\}>/);
  });
});

describe('0.13.0: the walkthrough uses real items', () => {
  it('twenty of them, ten on the shopping list, from Coles, Woolworths and Aldi only', async () => {
    expect(REAL_SET.groups).toHaveLength(20);
    expect(REAL_SET.listed).toHaveLength(10);
    for (const g of REAL_SET.groups)
      for (const p of [g.usual, ...(g.same ?? []), ...(g.alts ?? [])]) {
        expect(['coles', 'woolworths', 'aldi']).toContain(p.chain);
        expect(p.current.price).toBeGreaterThan(0);
        expect(p.normal).toBeGreaterThan(0);
      }
    await loadDemo();
    const groups = await allGroups();
    expect(groups).toHaveLength(20);
    expect(groups.every((g) => g.id.startsWith('demo-') && (g.section ?? 'pantry') === 'pantry')).toBe(true);
    const lines = await allListEntries();
    expect(lines).toHaveLength(10);
    expect(lines.every((e) => e.id.startsWith('demo-') && e.groupId?.startsWith('demo-'))).toBe(true);
    const milk = await getGroup('demo-full-cream-milk');
    const r = (await readingsFor([milk!.usualProductId!])).get(milk!.usualProductId!)!;
    expect(r.every((x) => x.source === 'demo')).toBe(true); // example prices: never shared, never checked
  });
  it('all of it goes when the walkthrough ends', async () => {
    await loadDemo();
    await removeDemo();
    expect(await allGroups()).toHaveLength(0);
    expect(await allListEntries()).toHaveLength(0);
  });
});

describe('0.13.0: see what Declan and Sarah use', () => {
  const picks = allPicks();
  it('every pantry item of theirs, Coles, Woolworths and Aldi products only, no prices', () => {
    expect(picks).toHaveLength(126);
    expect(new Set(picks.map((p) => nameKey(p.name))).size).toBe(126); // no two with one name
    for (const p of picks) {
      expect(p.main.length).toBeGreaterThan(0);
      for (const x of [...p.main, ...p.alts]) {
        expect(['coles', 'woolworths', 'aldi']).toContain(x.chain);
        expect(x.storeProductId).toBeTruthy();
        expect(x.price).toBeUndefined();
      }
    }
    expect(PICKS_TITLE).toBe('See what Declan and Sarah use');
    expect(PICKS_ABOUT).toMatch(/Declan and Sarah make Restock/);
  });
  it('knows which ones you already have, whatever the capitals', () => {
    const have = picksYouHave(picks, [{ name: 'full cream MILK' }, { name: ' eggs. ' }, { name: 'Something else' }]);
    expect([...have].map((n) => picks[n].name).sort()).toEqual(['Eggs', 'Full cream milk']);
  });
  it('adds to the pantry only, and never touches an item you already have', async () => {
    await addGroup({ id: 'mine', name: 'full cream milk', usualProductId: undefined, sameProductIds: [], altProductIds: [], alertLevel: 'never', section: 'pantry', createdAt: nowIso() });
    const want = picks.filter((p) => ['Full cream milk', 'Eggs', 'Butter'].includes(p.name));
    expect(await addPicks(want)).toEqual({ added: 2, skipped: 1 });
    const groups = await allGroups();
    expect(groups).toHaveLength(3);
    expect(await getGroup('mine')).toMatchObject({ name: 'full cream milk', alertLevel: 'never', sameProductIds: [] });
    const eggs = groups.find((g) => g.name === 'Eggs')!;
    expect(eggs.section ?? 'pantry').toBe('pantry');
    expect(eggs.usualProductId).toBeTruthy();
    expect(await allListEntries()).toHaveLength(0); // nothing on the shopping list
    // adding the same ones again adds nothing
    expect(await addPicks(want)).toEqual({ added: 0, skipped: 3 });
    expect(picksSaid(47, 3)).toBe('47 items added to your pantry. 3 skipped: already in your pantry');
    expect(picksSaid(1, 0)).toBe('1 item added to your pantry');
  });
  it('is offered in Settings and at the bottom of the Pantry', () => {
    expect(read('./screens/Settings.tsx')).toMatch(/row\(PICKS_TITLE,/);
    expect(read('./screens/Pantry.tsx')).toMatch(/section === 'pantry' && !editing && !serverMode && picksOn && <PicksOffer/);
    expect(read('./screens/Picks.tsx')).toContain("No thanks, I'll add my own");
  });
});
