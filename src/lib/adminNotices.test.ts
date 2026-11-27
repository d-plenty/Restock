import { describe, expect, it } from 'vitest';
import { phoneChanges } from './adminNotices';
import { isAdminAction } from '../server-mode/ui/houseData';

const p = (name: string, status = 'active', role = 'user') => ({ name, status, role });

describe('0.18.1: telling admins about the server phones', () => {
  it('says who joined, left, was removed, and became an admin or a user', () => {
    const before = { a: p('Sarah'), b: p('Dad'), c: p('Old tablet'), me: p('Me', 'active', 'admin') };
    const now = { a: p('Sarah', 'active', 'admin'), b: p('Dad', 'left'), c: p('Old tablet', 'removed'), d: p("Kid's iPad"), e: p('Gran', 'active', 'admin'), me: p('Me', 'active', 'user') };
    expect(phoneChanges(before, now, 'me')).toEqual(['Sarah is an admin now', 'Dad left', 'Old tablet was removed', "Kid's iPad joined", 'Gran joined as an admin']);
  });
  it('says nothing when nothing changed, or for a phone that was gone already', () => {
    const s = { a: p('Sarah'), b: p('Dad', 'removed') };
    expect(phoneChanges(s, { ...s })).toEqual([]);
    expect(phoneChanges({}, { b: p('Dad', 'removed') })).toEqual([]);
    expect(phoneChanges({ b: p('Dad', 'removed') }, { b: p('Dad') })).toEqual(['Dad joined again']);
  });
  it("Activity's Admin actions keep what an admin did, not sign-ins or changes sent", () => {
    expect(isAdminAction({ what: 'phone-role' })).toBe(true);
    expect(isAdminAction({ what: 'phone-removed' })).toBe(true);
    expect(isAdminAction({ what: 'changes-in' })).toBe(false);
    expect(isAdminAction({ what: 'signed-in' })).toBe(false);
  });
});
