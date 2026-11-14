import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureDefaults, getSettings as savedSettings, initDb } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import {
  addDraftPart,
  afterSave,
  canLeave,
  discardDraft,
  draftState,
  getSettings,
  hasUnsaved,
  openDraft,
  saveDraft,
  stage,
  staged,
  updateSettings,
} from './settingsDraft';

// 0.9.5 (save): settings held until "Save settings" (settingsDraft.ts): the draft, Save, Discard,
// work that waits for Save, changes that aren't settings, and asking before leaving.

let SQL: SqlJsStatic;
let close: (() => void) | undefined;
beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(async () => {
  close?.();
  close = undefined;
  await initDb(await createSqlJsDriver({ load: async () => SQL }));
  await ensureDefaults();
});

describe('settings draft', () => {
  it('with no settings screen open, a change is saved at once (as before)', async () => {
    const ran: number[] = [];
    await updateSettings({ shopAroundMin: 5 });
    await afterSave('x', (s) => ran.push(s.shopAroundMin ?? -1));
    expect((await savedSettings()).shopAroundMin).toBe(5);
    expect(ran).toEqual([5]);
    expect(hasUnsaved()).toBe(false);
  });

  it('holds changes until Save, showing them meanwhile', async () => {
    close = openDraft();
    const before = (await savedSettings()).shopAroundMin;
    const shown = await updateSettings({ shopAroundMin: 10 });
    expect(shown.shopAroundMin).toBe(10);
    expect((await getSettings()).shopAroundMin).toBe(10);
    expect((await savedSettings()).shopAroundMin).toBe(before);
    expect(draftState()).toMatchObject({ open: true, dirty: true });
    expect(await saveDraft()).toBe(true);
    expect((await savedSettings()).shopAroundMin).toBe(10);
    expect(draftState().dirty).toBe(false);
    expect(draftState().savedAt).toBeGreaterThan(0);
  });

  it('a change put back to how it is saved is no change (Save greys out again)', async () => {
    close = openDraft();
    const was = (await savedSettings()).alerts;
    await updateSettings({ alerts: { ...was, daily: !was.daily } });
    expect(hasUnsaved()).toBe(true);
    await updateSettings({ alerts: { ...was } });
    expect(hasUnsaved()).toBe(false);
  });

  it('Discard goes back to the saved settings, and nothing waiting runs', async () => {
    close = openDraft();
    const ran: string[] = [];
    const epoch = draftState().epoch;
    await updateSettings({ shopAroundMin: 2 });
    await afterSave('schedule', () => ran.push('schedule'));
    discardDraft();
    expect(hasUnsaved()).toBe(false);
    expect((await getSettings()).shopAroundMin).toBe((await savedSettings()).shopAroundMin);
    expect(draftState().epoch).toBe(epoch + 1);
    await saveDraft();
    expect(ran).toEqual([]);
  });

  it('work that goes with a change runs once, after Save, with the saved settings', async () => {
    close = openDraft();
    const ran: number[] = [];
    await updateSettings({ checkIntervalHours: 6 });
    await afterSave('checks', (s) => ran.push(s.checkIntervalHours));
    await updateSettings({ checkIntervalHours: 12 });
    await afterSave('checks', (s) => ran.push(s.checkIntervalHours));
    expect(ran).toEqual([]);
    await saveDraft();
    expect(ran).toEqual([12]);
  });

  it('a change that is not a setting (what this phone shares) waits for Save too', async () => {
    close = openDraft();
    const applied: string[] = [];
    await stage('shares', { keg: true }, async () => void applied.push('keg on'), { keg: false });
    expect(staged('shares')).toEqual({ keg: true });
    expect(hasUnsaved()).toBe(true);
    // Back to how it is: no change.
    await stage('shares', { keg: false }, async () => void applied.push('keg off'), { keg: false });
    expect(hasUnsaved()).toBe(false);
    await stage('shares', { keg: true }, async () => void applied.push('keg on'), { keg: false });
    await saveDraft();
    expect(applied).toEqual(['keg on']);
    expect(staged('shares')).toBeUndefined();
  });

  it('parts of a page with their own changes are saved and thrown away with the rest', async () => {
    close = openDraft();
    let value = 'Home';
    let saved = 'Home';
    const off = addDraftPart({ dirty: () => value !== saved, save: async () => void (saved = value), discard: () => void (value = saved) });
    value = 'Beach house';
    expect(hasUnsaved()).toBe(true);
    discardDraft();
    expect(value).toBe('Home');
    value = 'Beach house';
    await saveDraft();
    expect(saved).toBe('Beach house');
    expect(hasUnsaved()).toBe(false);
    off();
  });

  it('a save that fails keeps the changes, and says why', async () => {
    close = openDraft();
    await updateSettings({ shopAroundMin: 5 });
    await stage('x', 1, async () => {
      throw new Error('The server is offline');
    });
    expect(await saveDraft()).toBe(false);
    expect(draftState().error).toBe('The server is offline');
    expect(hasUnsaved()).toBe(true);
  });

  // 0.9.5 (final review): Save used to clear the whole draft once saved, so a change made while it
  // was saving was lost.
  it('a change made while saving stays in the draft for the next Save', async () => {
    close = openDraft();
    await updateSettings({ shopAroundMin: 10 });
    const saving = saveDraft();
    await updateSettings({ shopAroundMin: 20, checkIntervalHours: 6 });
    expect(await saving).toBe(true);
    expect((await savedSettings()).shopAroundMin).toBe(10);
    expect(await getSettings()).toMatchObject({ shopAroundMin: 20, checkIntervalHours: 6 });
    expect(hasUnsaved()).toBe(true);
    expect(await saveDraft()).toBe(true);
    expect(await savedSettings()).toMatchObject({ shopAroundMin: 20, checkIntervalHours: 6 });
    expect(hasUnsaved()).toBe(false);
  });

  it('a change put back while saving (to how it was saved before) is kept too', async () => {
    close = openDraft();
    const was = (await savedSettings()).shopAroundMin;
    await updateSettings({ shopAroundMin: was + 9 });
    const saving = saveDraft();
    await updateSettings({ shopAroundMin: was });
    expect(await saving).toBe(true);
    expect((await savedSettings()).shopAroundMin).toBe(was + 9);
    expect((await getSettings()).shopAroundMin).toBe(was);
    expect(hasUnsaved()).toBe(true);
  });

  it('a change staged again while saving stays staged', async () => {
    close = openDraft();
    const applied: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await stage('share', 1, async () => {
      await gate;
      applied.push(1);
    });
    const saving = saveDraft();
    await new Promise((r) => setTimeout(r, 5));
    await stage('share', 2, async () => void applied.push(2));
    release();
    expect(await saving).toBe(true);
    expect(applied).toEqual([1]);
    expect(staged('share')).toBe(2);
    expect(await saveDraft()).toBe(true);
    expect(applied).toEqual([1, 2]);
    expect(hasUnsaved()).toBe(false);
  });

  it('closing the screen leaves the draft behind (back to the saved settings)', async () => {
    const shut = openDraft();
    await updateSettings({ shopAroundMin: 5 });
    shut();
    expect(hasUnsaved()).toBe(false);
    expect((await getSettings()).shopAroundMin).toBe((await savedSettings()).shopAroundMin);
  });
});

describe('leaving with changes not saved', () => {
  it('nothing changed: goes without asking', async () => {
    close = openDraft();
    let asked = 0;
    expect(
      await canLeave(async () => {
        asked++;
        return 'keep';
      }),
    ).toBe(true);
    expect(asked).toBe(0);
  });

  it('Save: saves, then goes', async () => {
    close = openDraft();
    await updateSettings({ shopAroundMin: 5 });
    expect(await canLeave(async () => 'save')).toBe(true);
    expect((await savedSettings()).shopAroundMin).toBe(5);
  });

  it('Discard: throws them away, then goes', async () => {
    close = openDraft();
    const was = (await savedSettings()).shopAroundMin;
    await updateSettings({ shopAroundMin: was === 5 ? 2 : 5 });
    expect(await canLeave(async () => 'discard')).toBe(true);
    expect((await savedSettings()).shopAroundMin).toBe(was);
    expect(hasUnsaved()).toBe(false);
  });

  it('Keep editing: stays, changes kept', async () => {
    close = openDraft();
    await updateSettings({ shopAroundMin: 5 });
    expect(await canLeave(async () => 'keep')).toBe(false);
    expect(hasUnsaved()).toBe(true);
  });

  it('Save that fails: stays', async () => {
    close = openDraft();
    await stage('x', 1, async () => {
      throw new Error('offline');
    });
    expect(await canLeave(async () => 'save')).toBe(false);
  });

  it('two ways out at once ask once', async () => {
    close = openDraft();
    await updateSettings({ shopAroundMin: 5 });
    let asked = 0;
    let answer: (c: 'discard') => void = () => undefined;
    const ask = () => {
      asked++;
      return new Promise<'discard'>((r) => (answer = r));
    };
    const a = canLeave(ask);
    const b = canLeave(ask);
    answer('discard');
    expect(await a).toBe(true);
    expect(await b).toBe(false);
    expect(asked).toBe(1);
  });
});

describe('0.10.7 Save always saves', () => {
  it('a change the saved settings tidy (put in order) still leaves the draft', async () => {
    close = openDraft();
    await updateSettings({ hiddenTabs: ['pharmacy', 'keg'] });
    expect(hasUnsaved()).toBe(true);
    expect(await saveDraft()).toBe(true);
    expect(hasUnsaved()).toBe(false);
    expect((await savedSettings()).hiddenTabs).toEqual(['keg', 'pharmacy']);
  });

  it("closing a page brings back the draft of the page underneath, with its changes", async () => {
    const closeOuter = openDraft();
    await updateSettings({ shopAroundMin: 7 });
    const closeInner = openDraft();
    expect(hasUnsaved()).toBe(false);
    await updateSettings({ shopAroundMin: 9 });
    closeInner();
    expect(hasUnsaved()).toBe(true);
    expect((await getSettings()).shopAroundMin).toBe(7);
    expect(await saveDraft()).toBe(true);
    expect((await savedSettings()).shopAroundMin).toBe(7);
    closeOuter();
    expect(draftState().open).toBe(false);
  });
});
