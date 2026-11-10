import { describe, expect, it } from 'vitest';
import { liftFor } from './toastLift';

const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 390 });

describe('toastLift: the Undo message clears the bars at the bottom', () => {
  it('sits above the tab bar alone at its usual place', () => {
    expect(liftFor([box(773, 844)], 844, 84)).toBe(84);
  });
  it('goes above Start shopping, the Save bar or the select bar, whichever is highest', () => {
    expect(liftFor([box(773, 844), box(702, 773)], 844, 84)).toBe(844 - 702 + 8);
    expect(liftFor([box(740, 844), box(450, 704)], 844, 126)).toBe(844 - 450 + 8);
  });
  it('ignores bars scrolled away up the page and empty ones', () => {
    expect(liftFor([box(100, 160), box(773, 844), box(500, 500)], 844, 84)).toBe(84);
  });
  it('uses the fallback with no bars', () => {
    expect(liftFor([], 844, 84)).toBe(84);
  });
});
