// The iPhone's recall check against Android's Recalls.java on the same fixtures. Driven by recalls-parity.sh.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { matches, parseFsanzList, parseRss, readFsanzPage, safeLink, tokens, type Recall } from '../../src/ios/recalls';

const f = JSON.parse(readFileSync('tools/sync-test/recalls/fixtures.json', 'utf8'));
const java = JSON.parse(readFileSync(process.env.RECALLS_JAVA ?? 'tools/sync-test/out/recalls-java.json', 'utf8'));
const j = (r: Recall) => ({ id: r.id, source: r.source, title: r.title, url: r.url, date: r.date ?? null, reason: r.reason ?? null, dates: r.dates ?? null, whatToDo: r.whatToDo ?? null });

it('reads the FSANZ list as Android does', () => expect(parseFsanzList(f.fsanz).map(j)).toEqual(java.fsanz));
it('reads an RSS feed as Android does', () => expect(parseRss(f.rss, 'Product Safety Australia').map(j)).toEqual(java.rss));
it('reads an FSANZ recall page as Android does', () => {
  const page: Recall = { id: 'FSANZ:https://www.foodstandards.gov.au/x', source: 'FSANZ', title: 't', url: 'https://www.foodstandards.gov.au/x' };
  readFsanzPage(page, f.page);
  expect(j(page)).toEqual(java.page);
});
it('keeps only official links, as Android does', () => expect(f.links.map((l: [string, string]) => safeLink(l[0], l[1]))).toEqual(java.links));
it('splits names into the same words', () => expect(f.tokens.map((t: string) => tokens(t))).toEqual(java.tokens));
it('matches the same things', () =>
  expect(f.match.map((m: [string, string, string | null]) => matches({ id: 'x', source: 's', title: m[0], url: 'u' }, { kind: 'k', name: m[1], brand: m[2] ?? undefined }))).toEqual(java.match));
