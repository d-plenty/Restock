import { getSettings as savedSettings, updateSettings as saveSettings } from './db';
import { changed } from './live';
import type { Settings } from '../types';

// 0.9.5 (save): settings are held until "Save settings".
//
// A settings screen opens a draft while it's showing (useSettingsDraft, ui/SaveBar.tsx). While one
// is open, the settings screens' getSettings and updateSettings (imported from here instead of
// db.ts) read and change the draft, not the saved settings. Work that goes with a change (setting
// up the background checks again, deleting older prices) waits for Save too (afterSave), and so do
// changes that aren't settings (what this phone shares with the server: stage). "Save settings"
// writes them all; leaving asks "Save your changes?" first (canLeave). With no draft open (the
// setup steps, say), everything here is saved straight away, as before.

export type LeaveChoice = 'save' | 'discard' | 'keep';

/** Something on the screen that isn't the settings (the web's household settings, say). */
export interface DraftPart {
  dirty: () => boolean;
  save: () => Promise<void>;
  discard: () => void;
}

interface Draft {
  id: number;
  patch: Partial<Settings>;
  after: Map<string, (s: Settings) => unknown>;
  staged: Map<string, { value: unknown; apply: () => Promise<unknown> }>;
}
/** Parts on the screen (they may mount just before the screen opens its draft, so kept apart from it). */
const parts = new Set<DraftPart>();

/** `epoch` goes up each time changes are thrown away, so typed-in boxes can start again from what's saved. */
export type DraftState = { open: boolean; dirty: boolean; saving: boolean; savedAt?: number; error?: string; epoch: number };

let draft: Draft | undefined;
/** 0.10.7: the screens underneath's drafts (Settings → a section's page): back to theirs when it closes. */
const below: Draft[] = [];
let nextId = 1;
let saving = false;
let savedAt: number | undefined;
let error: string | undefined;
let epoch = 0;
const listeners = new Set<() => void>();
const emit = () => {
  listeners.forEach((fn) => fn());
};

export function onDraft(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function draftState(): DraftState {
  return { open: !!draft, dirty: hasUnsaved(), saving, savedAt, error, epoch };
}

/** Opens a draft for the screen showing now. Returns the function that closes it (leaving unsaved changes behind). */
export function openDraft(): () => void {
  const d: Draft = { id: nextId++, patch: {}, after: new Map(), staged: new Map() };
  if (draft) below.push(draft);
  draft = d;
  savedAt = undefined;
  error = undefined;
  emit();
  return () => {
    // 0.10.7: back on the screen underneath, its own draft (and its Save) carry on. Before, closing
    // a page left no draft at all, so the page underneath saved straight away, or not at all.
    const at = below.indexOf(d);
    if (at >= 0) below.splice(at, 1);
    if (draft !== d) return;
    draft = below.pop();
    changed();
    emit();
  };
}

export const draftOpen = () => !!draft;

export function hasUnsaved(): boolean {
  if (!draft) return false;
  if (Object.keys(draft.patch).length || draft.staged.size) return true;
  for (const p of parts) if (p.dirty()) return true;
  return false;
}

/** A part of the screen with its own changes, saved with the rest. Returns the function that removes it. */
export function addDraftPart(p: DraftPart): () => void {
  parts.add(p);
  emit();
  return () => {
    parts.delete(p);
    emit();
  };
}

/** Tell the Save bar a part's changes changed (it asks dirty() again). */
export const draftChanged = () => emit();

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The settings as the screen shows them: saved, with the draft's changes on top. */
export async function getSettings(): Promise<Settings> {
  const s = await savedSettings();
  return draft ? { ...s, ...draft.patch } : s;
}

/**
 * Changes the settings: in the draft while a settings screen is open (returning the settings as
 * they'll be), else saved now. A change put back to how it's saved is no change.
 */
export async function updateSettings(patch: Partial<Settings>, opts: { local?: boolean } = {}): Promise<Settings> {
  if (!draft || opts.local) return saveSettings(patch, opts);
  const d = draft;
  const saved = await savedSettings();
  for (const [k, v] of Object.entries(patch) as [keyof Settings, unknown][]) {
    // While saving, `saved` may be about to change: keep the change, and Save sorts it out after.
    if (same(saved[k], v) && !saving) delete d.patch[k];
    else (d.patch as Record<string, unknown>)[k] = structuredClone(v);
  }
  savedAt = undefined;
  changed();
  emit();
  return { ...saved, ...d.patch };
}

/**
 * Work that goes with a settings change, run once it's saved (now, with no draft open). The same
 * key runs once, with the settings as saved.
 */
export async function afterSave(key: string, fn: (s: Settings) => unknown, now?: Settings): Promise<void> {
  if (draft) {
    draft.after.set(key, fn);
    return;
  }
  await fn(now ?? (await savedSettings()));
}

/**
 * A change that isn't a setting (what this phone shares with the server), held until Save. The
 * screen shows `staged(key)` instead of what's there now. Staging the value that's there now
 * (`current`) takes the change back.
 */
export async function stage<T>(key: string, value: T, apply: () => Promise<unknown>, current?: T): Promise<void> {
  if (!draft) {
    await apply();
    return;
  }
  if (current !== undefined && same(current, value)) draft.staged.delete(key);
  else draft.staged.set(key, { value, apply });
  savedAt = undefined;
  emit();
}

export function staged<T>(key: string): T | undefined {
  return draft?.staged.get(key)?.value as T | undefined;
}

/** "Save settings": the changes, then what goes with them. False if something couldn't be saved (the draft stays). */
/**
 * 0.9.12: for a button that acts straight away on what's saved (Check now, Sync now): saves what's
 * waiting for Save first, so it acts on what the screen shows. False if that save failed.
 */
export async function saveFirst(): Promise<boolean> {
  if (!draft || !hasUnsaved()) return true;
  return saveDraft();
}

export async function saveDraft(): Promise<boolean> {
  const d = draft;
  if (!d || saving) return false;
  saving = true;
  error = undefined;
  emit();
  try {
    // 0.9.5 (final review): what this Save sends, as it is now. Changes made while it saves stay
    // in the draft for the next Save (only what was saved, as it was saved, leaves the draft).
    const patch = structuredClone(d.patch);
    const staging = [...d.staged];
    const afterNow = [...d.after];
    const s = Object.keys(patch).length ? await saveSettings(patch) : await savedSettings();
    // 0.10.7: what was saved leaves the draft, even when the saved settings tidy it (an emptied
    // field, a list put in order). Before, those stayed "Unsaved changes", so Save seemed to do
    // nothing. A change made while saving (not what was sent) stays for the next Save.
    for (const k of Object.keys(patch) as (keyof Settings)[]) if (same(d.patch[k], patch[k])) delete d.patch[k];
    for (const [k, x] of staging) {
      await x.apply();
      if (d.staged.get(k) === x) d.staged.delete(k);
    }
    for (const p of [...parts]) if (p.dirty()) await p.save();
    for (const [k, fn] of afterNow) if (d.after.get(k) === fn) d.after.delete(k);
    const after = afterNow.map(([, fn]) => fn);
    for (const fn of after) {
      try {
        await fn(s);
      } catch (e) {
        console.error('after saving settings', e);
      }
    }
    savedAt = Date.now();
    return true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    saving = false;
    changed();
    emit();
  }
}

/** Throw the changes away: back to the saved settings. */
export function discardDraft(): void {
  const d = draft;
  if (!d) return;
  d.patch = {};
  d.staged.clear();
  d.after.clear();
  for (const p of [...parts]) p.discard();
  epoch++;
  savedAt = undefined;
  error = undefined;
  changed();
  emit();
}

/** Before leaving a screen: true to go on. With changes not saved, asks Save · Discard · Keep editing. */
let asking: Promise<boolean> | undefined;
export function canLeave(ask: () => Promise<LeaveChoice>): Promise<boolean> {
  if (!hasUnsaved()) return Promise.resolve(true);
  // Asked already (two ways out pressed at once): one question, and the second way waits for it.
  if (asking) return asking.then(() => false);
  asking = decide(ask).finally(() => (asking = undefined));
  return asking;
}
async function decide(ask: () => Promise<LeaveChoice>): Promise<boolean> {
  const choice = await ask();
  if (choice === 'keep') return false;
  if (choice === 'discard') {
    discardDraft();
    return true;
  }
  return saveDraft();
}
