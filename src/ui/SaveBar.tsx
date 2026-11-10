import { useEffect, useState } from 'react';
import { addDraftPart, draftChanged, draftState, onDraft, openDraft, saveDraft, type DraftPart, type DraftState } from '../lib/settingsDraft';
import { Icon } from './components';

// 0.9.5 (save): "Save settings", on the phone and the web (settingsDraft.ts).

/** How long "Saved" shows after saving. */
const SAVED_MS = 4000;

/**
 * Holds this screen's settings changes until Save. Call once at the top of a settings screen.
 * On the web, closing the tab with changes not saved asks too.
 */
export function useSettingsDraft(): void {
  useEffect(() => {
    const close = openDraft();
    const warn = (e: BeforeUnloadEvent) => {
      if (!draftState().dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      close();
    };
  }, []);
}

/** A part of a settings screen with its own changes (not the settings), saved with the rest. */
export function useDraftPart(part: DraftPart, deps: unknown[]): void {
  useEffect(() => addDraftPart(part), deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => draftChanged());
}

export function useDraftState(): DraftState & { justSaved: boolean } {
  const [s, setS] = useState(draftState);
  const [, tick] = useState(0);
  useEffect(() => onDraft(() => setS(draftState())), []);
  const justSaved = !s.dirty && s.savedAt !== undefined && Date.now() - s.savedAt < SAVED_MS;
  useEffect(() => {
    if (!justSaved || s.savedAt === undefined) return;
    const t = window.setTimeout(() => tick((n) => n + 1), SAVED_MS - (Date.now() - s.savedAt) + 20);
    return () => window.clearTimeout(t);
  }, [justSaved, s.savedAt]);
  return { ...s, justSaved };
}

/** The big green button. Greyed out with nothing to save; says "Saved" once it has. */
export function SaveButton({ className = '', label = 'Save settings' }: { className?: string; label?: string }) {
  const s = useDraftState();
  return (
    <button
      type="button"
      className={`btn primary save-green ${className}`}
      disabled={!s.dirty || s.saving}
      aria-disabled={!s.dirty || s.saving}
      onClick={() => void saveDraft()}
    >
      {s.justSaved ? (
        <>
          <Icon name="check" size={18} stroke={3} /> Saved
        </>
      ) : s.saving ? (
        'Saving…'
      ) : (
        label
      )}
    </button>
  );
}

/** What the bar says next to the button, and for screen readers. */
export function saveStatusText(s: DraftState & { justSaved: boolean }): string {
  if (s.error) return `Couldn't save: ${s.error}`;
  if (s.saving) return 'Saving';
  if (s.dirty) return 'Unsaved changes';
  if (s.justSaved) return 'Saved';
  return 'No changes to save';
}

/** Phone: a bar at the bottom of a settings screen, above the tabs: "Unsaved changes · Save settings". */
export function SaveBar({ label, onlyWhenChanged }: { label?: string; onlyWhenChanged?: boolean }) {
  const s = useDraftState();
  const text = saveStatusText(s);
  // On a page that's mostly buttons that run now: only once something's waiting to be saved.
  if (onlyWhenChanged && !s.dirty && !s.justSaved && !s.error && !s.saving) return null;
  return (
    <div className={`save-bar${s.dirty ? ' dirty' : ''}`} data-keep="1">
      <span className={`save-bar-text${s.error ? ' err' : ''}`} role="status" aria-live="polite">
        {s.justSaved && <Icon name="check" size={16} stroke={3} />} {text}
      </span>
      <SaveButton label={label} />
    </div>
  );
}

/** Web: the same, as a status line and the button, for the page header and the page's foot. */
export function DeskSave({ foot }: { foot?: boolean }) {
  const s = useDraftState();
  const text = saveStatusText(s);
  return (
    <div className={`dk-save${foot ? ' foot' : ''}${s.dirty ? ' dirty' : ''}`}>
      <span className={`dk-save-text${s.error ? ' err' : ''}`} role={foot ? undefined : 'status'} aria-live={foot ? undefined : 'polite'}>
        {text}
      </span>
      <SaveButton className="dk-save-btn" />
    </div>
  );
}
