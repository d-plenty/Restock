// 0.12.9: what was asked for, held to the source and to the small pieces that do the work.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { version } from '../../package.json';
import { placedByPage, typesText } from '../lib/keyboard';
import { shouldOfferWhatsNew, WHATS_NEW } from '../lib/whatsNew';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const add = read('./screens/Add.tsx');
const app = read('./App.tsx');
const refresh = read('./refresh.tsx');
const css = read('./styles.css');
const tokens = read('./tokens.css');
const whatsNew = read('./screens/WhatsNew.tsx');

describe("0.12.9: What's new", () => {
  it('has this version first, in plain words', () => {
    expect(WHATS_NEW[0].version).toBe(version);
    for (const v of WHATS_NEW) {
      expect(v.changes.length).toBeGreaterThan(0);
      expect(v.about.trim()).not.toBe('');
      for (const c of v.changes) expect(c).not.toMatch(/\*\*|https?:/);
    }
    expect(new Set(WHATS_NEW.map((v) => v.version)).size).toBe(WHATS_NEW.length);
  });
  it('is offered once after an update, never on a new install', () => {
    expect(shouldOfferWhatsNew(version, '0.12.8', true)).toBe(true);
    expect(shouldOfferWhatsNew(version, undefined, true)).toBe(true);
    expect(shouldOfferWhatsNew(version, version, true)).toBe(false);
    expect(shouldOfferWhatsNew(version, undefined, false)).toBe(false);
    expect(shouldOfferWhatsNew('9.9.9', '0.12.8', true)).toBe(false); // a version with nothing written
    // a server's web page: a browser's first visit isn't asked, an update after that is
    expect(shouldOfferWhatsNew(version, undefined, true, false)).toBe(false);
    expect(shouldOfferWhatsNew(version, '0.12.8', true, false)).toBe(true);
  });
  it('the box has the two buttons, and the page ends with Done and the GitHub page', () => {
    expect(whatsNew).toMatch(/btn primary block" onClick=\{onRead\}>\s*See what's new/);
    expect(whatsNew).toMatch(/btn block" onClick=\{onSkip\}>\s*I'll figure it out/);
    expect(whatsNew.indexOf('Done')).toBeLessThan(whatsNew.indexOf('Open the GitHub page'));
    expect(whatsNew).toMatch(/href=\{RELEASES\} target="_blank" rel="noreferrer"/);
    expect(read('./screens/Settings.tsx')).toMatch(/row\("What's new"/);
    expect(read('../server-mode/ui/DeskSettings.tsx')).toMatch(/name: 'whatsnew'/);
    expect(app).toMatch(/top\.name === 'whatsnew' && <WhatsNewScreen \/>/);
  });
});

describe('0.12.9: one slim checking line', () => {
  it('is one fixed line under the clock, and the page moves by that line only', () => {
    expect(tokens).toMatch(/--top: calc\(var\(--bar-top\) \+ var\(--check-h, 0px\)\)/);
    expect(css).toMatch(/:root\.checking \{\s*--check-h:/);
    expect(css).toMatch(/\.check-line \{\s*position: fixed;\s*top: var\(--bar-top\);/);
    expect(css).not.toMatch(/\.check-strip|\.refresh-status/);
  });
  it('shows on every screen but Home, which has its own', () => {
    expect(app).toMatch(/\(shownTab !== 'home' \|\| !!top\) && <CheckLine \/>/);
    expect(refresh).not.toMatch(/CheckStrip|const status =/);
    for (const f of ['./screens/Pantry.tsx', './screens/List.tsx']) expect(read(f)).not.toMatch(/full\.status/);
  });
});

describe('0.12.9: Add another product', () => {
  it('has Done on the bottom edge from the start', () => {
    expect(add).toMatch(/\{addingToItem && attachGroup && picks\.size === 0 && \(\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*<div className="sticky-cta add-done">/);
    expect(add).toMatch(/<Icon name="check" size=\{18\} \/> Done/);
    expect(add).not.toMatch(/add-mini-done/);
  });
  it('says which group a product of this item is in', () => {
    expect(add).toMatch(/inRole === 'alt' \? 'Also happy with' : inRole === 'main' \? 'Products I buy'/);
  });
});

describe('0.12.9: the keyboard opens where you go to type', () => {
  const el = (tag: string, attrs: Record<string, string | boolean> = {}) =>
    ({ tagName: tag, getAttribute: (k: string) => (typeof attrs[k] === 'string' ? attrs[k] : null), readOnly: !!attrs.readOnly, disabled: !!attrs.disabled, contains: () => false }) as unknown as EventTarget;
  it('knows a text box from a tick box', () => {
    expect(typesText(el('INPUT', { type: 'search' }))).toBe(true);
    expect(typesText(el('INPUT'))).toBe(true);
    expect(typesText(el('TEXTAREA'))).toBe(true);
    expect(typesText(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(typesText(el('INPUT', { type: 'file' }))).toBe(false);
    expect(typesText(el('INPUT', { type: 'text', readOnly: true }))).toBe(false);
    expect(typesText(el('BUTTON'))).toBe(false);
    expect(typesText(null)).toBe(false);
  });
  it('asks for the keyboard only when the page placed the cursor', () => {
    const box = el('INPUT', { type: 'search' });
    const button = el('BUTTON');
    expect(placedByPage(box, { target: button, at: 1000 }, 1100)).toBe(true); // a button opened the screen
    expect(placedByPage(box, { target: box, at: 1000 }, 1100)).toBe(false); // the box itself was tapped
    expect(placedByPage(box, { target: box, at: 1000 }, 5000)).toBe(true); // an old tap doesn't count
    expect(placedByPage(button, { target: null, at: 0 }, 1000)).toBe(false);
  });
  it('Add opens ready to type unless it was opened with something to show', () => {
    expect(add).toMatch(/autoFocus=\{!query && !barcode && !scan && !preTickProp && !fromScans && !forLine\}/);
    expect(add).toMatch(/autoFocus=\{!defaultName\.trim\(\)\}/);
    expect(read('../lib/sql/native.ts')).toMatch(/showKeyboard\(\): Promise<void>/);
  });
});
