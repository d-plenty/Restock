// 0.16.0: "What should we call you?" (lib/myName.ts). The same box in three places: a step of the
// first setup (after Set up or Join), a sheet on Home once after updating, and Settings → Your name.
import { useState } from 'react';
import { cleanName, NAME_MAX, setMyName, skipName } from '../lib/myName';
import { Icon, Sheet } from './components';
import { deviceWord } from '../lib/platform';

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

/** What the name is used for (Settings → your name). */
function NameUses({ n }: { n?: string }) {
  // 0.17.0: what this is, in its own words: this iPad, this phone, this browser (the web page).
  const dev = deviceWord();
  const like = dev;
  return (
    <div className="name-uses">
      <p>Restock says hello with it on Home.</p>
      <p>This {dev} is called by it in your household and on your Restock server (like &ldquo;{n || 'Sam'}&rsquo;s {like}&rdquo;), unless you named the {dev} yourself.</p>
      <p>Your backups have it in their names, and restoring one brings it back.</p>
      <p className="small">It stays on this {dev}: it isn&rsquo;t shared with the other phones as a setting.</p>
    </div>
  );
}

/**
 * Settings → the top: your name. 0.17.0: a tap opens what it's used for with the name under it;
 * the keyboard only comes up when the name itself is tapped to change it (no ⓘ to find).
 */
export function NameCard({ name }: { name?: string }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const n = name?.trim();
  const close = () => {
    setOpen(false);
    setEditing(false);
  };
  return (
    <>
      <div className="card flush name-card">
        <button className="row name-row" onClick={() => setOpen(true)} aria-label={n ? `Your name: ${n}` : 'Add your name'}>
          <span className="name-avatar" aria-hidden="true">
            {(n?.[0] ?? '?').toUpperCase()}
          </span>
          <span className="grow">
            <span className="title">{n || 'Add your name'}</span>
            <span className="small">Your name</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      </div>
      {open && (
        <Sheet title="Your name" onClose={close}>
          {editing ? (
            <NameFields start={n ?? ''} onDone={close} saveLabel="Save" skipLabel={null} />
          ) : (
            <>
              <button className="row name-row name-edit" onClick={() => setEditing(true)} aria-label={n ? `${n}. Tap to change it` : 'Add your name'}>
                <span className="name-avatar" aria-hidden="true">
                  {(n?.[0] ?? '?').toUpperCase()}
                </span>
                <span className="grow">
                  <span className="title">{n || 'Add your name'}</span>
                  <span className="small">Tap to change it</span>
                </span>
                <Icon name="pencil" size={18} />
              </button>
              <NameUses n={n} />
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
