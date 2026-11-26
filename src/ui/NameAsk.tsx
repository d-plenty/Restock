// 0.16.0: "What should we call you?" (lib/myName.ts). The same box in three places: a step of the
// first setup (after Set up or Join), a sheet on Home once after updating, and Settings → Your name.
import { useState } from 'react';
import { cleanName, NAME_MAX, setMyName, skipName } from '../lib/myName';
import { Icon, More, Sheet } from './components';

/** The box and its buttons. `onDone` once saved or skipped. */
export function NameFields({ start = '', onDone, skipLabel = 'Skip for now', saveLabel = 'Continue', autoFocus = true }: { start?: string; onDone: () => void; skipLabel?: string | null; saveLabel?: string; autoFocus?: boolean }) {
  const [name, setName] = useState(start);
  const [busy, setBusy] = useState(false);
  const save = async (skip: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (skip) await skipName();
      else await setMyName(name);
    } finally {
      setBusy(false);
    }
    onDone();
  };
  return (
    <form
      className="name-ask"
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <p className="name-ask-line">A first name or a nickname. Anything works.</p>
      <label className="field">
        <span>Your name</span>
        <input
          className="input name-ask-input"
          value={name}
          maxLength={NAME_MAX + 10}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dec, Mum, the chef…"
          autoComplete="given-name"
          autoCapitalize="words"
          enterKeyHint="done"
          autoFocus={autoFocus}
        />
      </label>
      <div className="name-ask-actions">
        <button type="submit" className="btn primary block" disabled={busy || (!cleanName(name) && !start)}>
          {saveLabel}
        </button>
        {skipLabel && (
          <button type="button" className="btn ghost block" disabled={busy} onClick={() => void save(true)}>
            {skipLabel}
          </button>
        )}
      </div>
    </form>
  );
}

/** As a sheet: once after updating (Home), and from Settings. */
export function NameSheet({ start, onClose, fromSettings }: { start?: string; onClose: () => void; fromSettings?: boolean }) {
  return (
    <Sheet title="What should we call you?" onClose={fromSettings ? onClose : () => void skipName().then(onClose)}>
      <NameFields start={start} onDone={onClose} saveLabel={fromSettings ? 'Save' : 'Continue'} skipLabel={fromSettings ? null : 'Skip for now'} />
    </Sheet>
  );
}

/** Settings → the top: your name, with what it's for behind the ⓘ, and tap to change it. */
export function NameCard({ name }: { name?: string }) {
  const [editing, setEditing] = useState(false);
  const n = name?.trim();
  return (
    <>
      <div className="card flush name-card">
        <div className="row name-row">
          <button className="name-main" onClick={() => setEditing(true)} aria-label={n ? `Your name: ${n}. Change it` : 'Add your name'}>
            <span className="name-avatar" aria-hidden="true">
              {(n?.[0] ?? '?').toUpperCase()}
            </span>
            <span className="grow">
              <span className="title">{n || 'Add your name'}</span>
              <span className="small">Your name</span>
            </span>
          </button>
          <More title="Your name">
            <p>Restock says hello with it on Home.</p>
            <p>This phone is called by it in your household and on your Restock server (like &ldquo;{n || 'Sam'}&rsquo;s iPhone&rdquo;), unless you named the phone yourself.</p>
            <p>Your backups have it in their names, and restoring one brings it back.</p>
            <p>It stays on this phone. It isn&rsquo;t shared with the other phones as a setting.</p>
          </More>
          <button className="name-chev" onClick={() => setEditing(true)} aria-label="Change your name">
            <Icon name="chevron" size={18} />
          </button>
        </div>
      </div>
      {editing && <NameSheet start={n ?? ''} fromSettings onClose={() => setEditing(false)} />}
    </>
  );
}
