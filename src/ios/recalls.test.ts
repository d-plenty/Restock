import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCC, FSANZ, parseDate, recallCheckDue, recallNotice, receiptLines, runRecallCheck, TGA, tooOld, type RecallStore, type SavedRecall, type Thing } from './recalls';

// Recall alerts on iPhone and iPad: the check itself. That it reads and matches the lists exactly as
// Android does is checked against Recalls.java (tools/sync-test/recalls-parity.sh).

const f = JSON.parse(readFileSync('tools/sync-test/recalls/fixtures.json', 'utf8'));
const NOW = Date.parse('2026-11-25T04:00:00Z');

const store = (things: Thing[], before: Partial<{ saved: SavedRecall[]; dismissed: string[]; notified: string[] }> = {}) => {
  const s = { saved: before.saved ?? [], dismissed: before.dismissed ?? [], notified: before.notified ?? [], checkedAt: '' };
  const st: RecallStore = {
    load: async () => ({ saved: s.saved, dismissed: s.dismissed, notified: s.notified }),
    save: async (found, notified, checkedAt) => {
      s.saved = found;
      s.notified = notified;
      s.checkedAt = checkedAt;
    },
    things: async () => things,
  };
  return { st, s };
};
const pages: Record<string, string> = { [FSANZ]: f.fsanz, [ACCC]: f.rss, 'https://www.foodstandards.gov.au/food-recalls/recall-alert/acme-foods-creamy-peanut-butter-375g': f.page };
const get = async (url: string) => {
  if (!(url in pages)) throw new Error('HTTP 404');
  return pages[url];
};
const mine: Thing[] = [
  { kind: 'product', name: 'Acme Creamy Peanut Butter 375g', brand: 'Acme' },
  { kind: 'pantry', name: 'Milk' },
  { kind: 'list', name: 'Bright Home lavender dishwashing liquid' },
  { kind: 'product', name: 'Dairy Dell Vanilla Custard 1kg', brand: 'Dairy Dell' },
];

describe('the recall check on iPhone and iPad', () => {
  it('finds what might be yours, reads the notice, and skips very old notices', async () => {
    const { st, s } = store(mine);
    const r = await runRecallCheck(get, st, NOW);
    expect(r.checked).toBe(4); // two FSANZ, two from the feed (the one with no title is dropped); the TGA feed didn't answer
    expect(r.errors).toEqual({});
    expect(r.found).toBe(2); // the custard notice is from 2020
    expect(r.fresh).toBe(2);
    const pb = s.saved.find((o) => o.title.includes('Peanut'))!;
    expect(pb.affected).toEqual(['Acme Creamy Peanut Butter 375g']);
    expect(pb.reason).toMatch(/undeclared allergen/);
    expect(pb.whatToDo).toMatch(/should not eat/);
    expect(pb.foundAt).toBe(new Date(NOW).toISOString());
    expect(s.saved.find((o) => o.title.includes('Lavender'))?.affected).toEqual(['Bright Home lavender dishwashing liquid']);
    expect(s.notified.length).toBe(2);
    expect(s.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it('tells you about each one once, and never about one you dismissed', async () => {
    const first = store(mine);
    await runRecallCheck(get, first.st, NOW);
    const again = store(mine, { saved: first.s.saved, notified: first.s.notified });
    const r = await runRecallCheck(get, again.st, NOW + 86_400_000);
    expect(r.found).toBe(2);
    expect(r.fresh).toBe(0);
    expect(again.s.saved.find((o) => o.title.includes('Peanut'))?.foundAt).toBe(new Date(NOW).toISOString());
    const dismissed = store(mine, { dismissed: first.s.saved.map((o) => o.id) });
    expect((await runRecallCheck(get, dismissed.st, NOW)).fresh).toBe(0);
  });

  it('says which list did not answer, and still checks the others', async () => {
    const { st } = store(mine);
    const r = await runRecallCheck(async (url) => (url === FSANZ ? Promise.reject(new Error('HTTP 503')) : get(url)), st, NOW);
    expect(r.errors).toEqual({ FSANZ: 'HTTP 503' });
    expect(r.found).toBe(1);
    // The TGA feed is a bonus: it never counts as an error.
    expect(Object.keys((await runRecallCheck(async (url) => (url === TGA ? Promise.reject(new Error('x')) : get(url)), store(mine).st, NOW)).errors)).toEqual([]);
  });

  it('nothing of yours matches: nothing is found', async () => {
    const { st, s } = store([{ kind: 'pantry', name: 'Milk' }]);
    const r = await runRecallCheck(get, st, NOW);
    expect([r.found, r.fresh, s.saved.length]).toEqual([0, 0, 0]);
  });

  it('drops what it found more than 120 days ago, and holds a saved link to the official sites', async () => {
    const old: SavedRecall = { id: 'a', source: 'TGA', title: 't', url: 'http://evil.example/x', affected: ['x'], foundAt: new Date(NOW - 121 * 86_400_000).toISOString() };
    const kept: SavedRecall = { ...old, id: 'b', foundAt: new Date(NOW - 5 * 86_400_000).toISOString() };
    const { st, s } = store([], { saved: [old, kept] });
    await runRecallCheck(get, st, NOW);
    expect(s.saved.map((o) => o.id)).toEqual(['b']);
    expect(s.saved[0].url).toBe('https://www.tga.gov.au/safety/safety-alerts');
  });

  it('dates, receipt lines, the notification and when a check is due', () => {
    expect(new Date(parseDate('3 November 2026')!).getFullYear()).toBe(2026);
    expect(parseDate('Tue, 10 Nov 2026 09:00:00 +1100')).toBe(Date.parse('2026-11-09T22:00:00Z'));
    expect(parseDate('nonsense')).toBeUndefined();
    expect(tooOld('3 January 2020', NOW)).toBe(true);
    expect(tooOld(undefined, NOW)).toBe(false);
    expect(receiptLines('ACME PEANUT BUTTER 375G  $4.50\nMILK 2.00\nTOTAL')).toEqual(['ACME PEANUT BUTTER 375G']);
    expect(recallNotice({ id: 'x', source: 's', title: 'Acme PB', url: 'u', reason: 'Peanut.', affected: ['Acme PB 375g'], foundAt: '' })).toEqual({
      title: 'Possible recall: Acme PB',
      body: 'Peanut. Might be your Acme PB 375g. Tap for the official notice.',
    });
    expect(recallCheckDue(undefined, NOW)).toBe(true);
    expect(recallCheckDue(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe(false);
    expect(recallCheckDue(new Date(NOW - 21 * 3_600_000).toISOString(), NOW)).toBe(true);
  });
});
