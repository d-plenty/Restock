// 0.18.3: the server page's Import a file (was DeskDataImport.tsx, the same steps in the page's own look).
// 0.9.6: Import on the web's Data tab (docs/restock-import.md): a file merged on top of what the
// server has, never replacing or deleting anything, and never adding to the shopping list or pantry.
// Choose a file, the dry run ("Will add 12,000 products and 90,000 prices, skip 300 already there,
// ignore 12 it couldn't read"), then the two checks (Step 1 what it adds, Step 2 the passphrase
// again), then the import a chunk at a time with how far it is and Cancel. The words and the steps
// are in importFile.ts; the server checks everything again (server/src/v3/import.mjs).
import { useEffect, useId, useReducer, useRef } from 'react';
import { Dialog } from './ui';
import { ApiError, v3Send } from '../api';
import { confirmPassphrase, session } from '../session';
import { ADMIN_NOTE, errText } from '../ui/houseWords';

const canAdmin = () => !session()?.viaPhone;
import {
  chunksOf,
  costcoLine,
  doneLine,
  dryRunLine,
  firstImport,
  ImportRefused,
  importReducer,
  LIMITS,
  problemLines,
  readImport,
  stoppedLine,
  type CheckAnswer,
  type ChunkAnswer,
  type ImportProduct,
  type ImportState,
  type Tally,
} from '../ui/importFile';

const IMPORT_HELP = 'https://github.com/d-plenty/Restock/blob/HEAD/docs/restock-import.md';

const fmt = (v: number) => v.toLocaleString('en-AU');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A request, once more after the wait the server asks for when it says "a lot at once" (429). */
async function send<T>(path: string, body: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await v3Send<T>('POST', path, body);
    } catch (e) {
      const after = e instanceof ApiError && e.status === 429 ? Number(e.extra?.retryAfter) : NaN;
      if (i >= 2 || !Number.isFinite(after) || after > 90) throw e;
      await wait(Math.max(1, after) * 1000);
    }
  }
}

const OLD = 'This server needs Restock server 0.9.6 or newer to import. Update it, then reload this page.';
function importError(e: unknown): string {
  if (e instanceof ImportRefused) return e.message;
  if (e instanceof ApiError) {
    if (e.status === 404 || e.status === 405) return OLD;
    if (e.code === 'current') return "That isn't your passphrase. Nothing was imported.";
    if (e.code === 'confirm') return 'Type your passphrase again. Nothing was imported.';
    if (e.status === 403 && session()?.viaPhone) return ADMIN_NOTE;
    return e.message;
  }
  return errText(e);
}

function Progress({ at, of, label }: { at: number; of: number; label: string }) {
  const p = of > 0 ? Math.min(1, at / of) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="sv-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={at}>
        <span style={{ width: `${Math.round(p * 1000) / 10}%`, background: 'var(--sv-green)' }} />
      </div>
      <span className="sv-small" aria-live="polite">
        {label}: {fmt(at)} of {fmt(of)} {of === 1 ? 'part' : 'parts'}
      </span>
    </div>
  );
}

function Lines({ t }: { t: Tally }) {
  const why = problemLines(t);
  const costco = costcoLine(t);
  return (
    <>
      {t.matched > 0 && <p className="sv-small">{fmt(t.matched)} of the products are on the server already: only their new prices go in.</p>}
      {(why.length > 0 || costco) && (
        <ul className="sv-small" style={{ margin: 0, paddingLeft: 18 }}>
          {costco && <li>{costco}</li>}
          {why.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The import's sheet: the dry run, the two checks, the import, the end. */
function ImportSheet({ s, onContinue, onBack, onPass, onImport, onCancel, onClose }: {
  s: ImportState;
  onContinue: () => void;
  onBack: () => void;
  onPass: (v: string) => void;
  onImport: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const passRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.phase === 'pass') passRef.current?.focus();
  }, [s.phase]);
  const title =
    s.phase === 'checking'
      ? 'Checking the file'
      : s.phase === 'review'
        ? 'Import this file?'
        : s.phase === 'pass'
          ? 'Last check: import it?'
          : s.phase === 'importing'
            ? 'Importing'
            : s.phase === 'done'
              ? 'Imported'
              : 'Import stopped';
  const nothing = s.check.products + s.check.prices === 0;
  return (
    <Dialog title={title} onClose={() => (s.busy ? onCancel() : onClose())}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {s.file && <span className="sv-small">{s.file}</span>}
        {s.phase === 'checking' && (
          <>
            <p className="sv-small">Nothing is added yet: this only counts what the file would add.</p>
            <Progress at={s.at} of={s.chunks} label="Checked" />
            <div className="sv-actions">
              <span className="sv-grow" />
              <button type="button" className="sv-btn" onClick={onCancel} disabled={s.cancel}>
                {s.cancel ? 'Stopping…' : 'Cancel'}
              </button>
            </div>
          </>
        )}
        {s.phase === 'review' && (
          <>
            <span className="sv-eyebrow">Step 1 of 2</span>
            <div className="sv-note" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <strong>{dryRunLine(s.check)}</strong>
              <span className="sv-small">Into the catalogue and price history only, marked imported. Nothing on the server is replaced or deleted, and nothing goes on the shopping list or in the pantry.</span>
            </div>
            <Lines t={s.check} />
            {s.read && s.read.notTaken.length > 0 && <p className="sv-small">Not taken from this file (an import takes products and prices only): {s.read.notTaken.join(', ')}.</p>}
            {nothing && <p className="sv-small">There's nothing new in this file for the server.</p>}
            <div className="sv-actions">
              <span className="sv-grow" />
              <button type="button" className="sv-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="sv-btn primary" disabled={nothing || !canAdmin()} onClick={onContinue}>
                Continue
              </button>
            </div>
            {!canAdmin() && <span className="sv-small">{ADMIN_NOTE}</span>}
          </>
        )}
        {s.phase === 'pass' && (
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              onImport();
            }}
          >
            <span className="sv-eyebrow">Step 2 of 2</span>
            <p className="sv-small">
              {dryRunLine(s.check)} It goes to every phone in the household as the server's prices do. Big files take a few minutes; you can cancel, and what went in stays.
            </p>
            <label className="sv-field" htmlFor={`${ids}-pass`}>
              <span className="sv-small">Your passphrase</span>
            </label>
            <input ref={passRef} id={`${ids}-pass`} className="sv-input" type="password" autoComplete="current-password" value={s.pass} onChange={(e) => onPass(e.target.value)} />
            {s.error && (
              <p className="sv-error" role="alert">
                {s.error}
              </p>
            )}
            <div className="sv-actions">
              <button type="button" className="sv-btn" disabled={s.busy} onClick={onBack}>
                Back
              </button>
              <span className="sv-grow" />
              <button type="submit" className="sv-btn primary" disabled={s.busy || !s.pass}>
                {s.busy ? 'Checking…' : `Import ${fmt(s.check.prices)} ${s.check.prices === 1 ? 'price' : 'prices'}`}
              </button>
            </div>
          </form>
        )}
        {s.phase === 'importing' && (
          <>
            <p className="sv-small">
              {s.at === 0 ? 'Checking your passphrase…' : `So far: ${fmt(s.done.products)} products and ${fmt(s.done.prices)} prices.`} Keep this page open.
            </p>
            <Progress at={s.at} of={s.chunks} label="Imported" />
            <div className="sv-actions">
              <span className="sv-grow" />
              <button type="button" className="sv-btn" onClick={onCancel} disabled={s.cancel}>
                {s.cancel ? 'Stopping after this part…' : 'Cancel'}
              </button>
            </div>
          </>
        )}
        {(s.phase === 'done' || s.phase === 'stopped') && (
          <>
            <p className={s.phase === 'done' ? 'sv-ok-text' : 'sv-note'} role="status">
              {s.phase === 'done' ? doneLine(s.done) : stoppedLine(s.done)}
            </p>
            {s.error && (
              <p className="sv-error" role="alert">
                {s.error}
              </p>
            )}
            <Lines t={s.done} />
            <div className="sv-actions">
              <span className="sv-grow" />
              <button type="button" className="sv-btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The Import card, beside Download your data. `onDone` reloads the counts. */
/** Import a file: a button (on Data) that opens the file picker, then the steps in a dialog. `onDone` reloads the counts. */
export function ImportButton({ onDone }: { onDone?: () => void }) {
  const [s, dispatch] = useReducer(importReducer, undefined, firstImport);
  const inputRef = useRef<HTMLInputElement>(null);
  const chunks = useRef<ImportProduct[][]>([]);
  const cancel = useRef(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
      cancel.current = true;
    },
    [],
  );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    cancel.current = false;
    dispatch({ t: 'reading', file: file.name });
    try {
      if (file.size > LIMITS.fileMb * 1024 * 1024) throw new ImportRefused(`That file is ${Math.round(file.size / 1024 / 1024)} MB. Import takes files up to ${LIMITS.fileMb} MB: split it into smaller files.`);
      // Let "Reading the file…" show before the work.
      await wait(30);
      const read = readImport(new Uint8Array(await file.arrayBuffer()), file.name);
      chunks.current = chunksOf(read.products);
      dispatch({ t: 'read', read, chunks: chunks.current.length });
      for (let i = 0; i < chunks.current.length; i++) {
        if (cancel.current || !live.current) break;
        const a = await send<CheckAnswer>('/api/v3/data/import/check', { products: chunks.current[i] });
        dispatch({ t: 'checked', at: i + 1, answer: a });
      }
      dispatch({ t: 'review' });
    } catch (e) {
      dispatch({ t: 'fail', error: importError(e) });
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const run = async () => {
    if (s.phase !== 'pass' || !s.pass) return;
    const pass = s.pass;
    cancel.current = false;
    let id: string | undefined;
    dispatch({ t: 'start' });
    try {
      const proof = await confirmPassphrase(pass);
      const started = await send<{ import: string }>('/api/v3/data/import/start', { confirm: proof });
      id = started.import;
    } catch (e) {
      dispatch({ t: 'refused', error: importError(e) });
      return;
    }
    let failed: string | undefined;
    for (let i = 0; i < chunks.current.length; i++) {
      if (cancel.current) break;
      try {
        const a = await send<ChunkAnswer>('/api/v3/data/import/chunk', { import: id, n: i, products: chunks.current[i] });
        dispatch({ t: 'sent', at: i + 1, answer: a });
      } catch (e) {
        failed = `It stopped at part ${i + 1} of ${chunks.current.length}: ${importError(e)}`;
        break;
      }
    }
    const stopped = cancel.current || !!failed;
    try {
      await send('/api/v3/data/import/finish', { import: id, cancelled: stopped });
    } catch {
      // It ends by itself after 10 minutes; what went in stays.
    }
    if (failed) dispatch({ t: 'fail', error: failed });
    dispatch({ t: 'finished', how: stopped ? (failed ? 'failed' : 'cancelled') : 'finished' });
    onDone?.();
  };

  // While it imports, the page can't be left by mistake.
  useEffect(() => {
    if (s.phase !== 'importing') return;
    const stay = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [s.phase]);

  const open = s.phase !== 'idle' && s.phase !== 'reading';
  return (
    <>
      <button type="button" className="sv-btn" disabled={s.busy} onClick={() => inputRef.current?.click()} title={`A Restock export (.json), its CSV files (.zip), or a file in the same shape (up to ${LIMITS.fileMb} MB). How to make one: ${IMPORT_HELP}`}>
        {s.phase === 'reading' ? 'Reading the file…' : 'Import a file'}
      </button>
      <input ref={inputRef} type="file" className="sv-skip" tabIndex={-1} aria-hidden="true" accept=".json,.zip,application/json,application/zip" onChange={(e) => void pick(e.target.files?.[0])} />
      {s.phase === 'idle' && s.error && (
        <Dialog title="That file didn't import" onClose={() => dispatch({ t: 'close' })}>
          <p className="sv-error" role="alert">
            {s.error}
          </p>
          <p className="sv-small">
            Import adds products and their prices, marked imported, and never replaces or deletes anything. Only import prices you're allowed to use.{' '}
            <a href={IMPORT_HELP} target="_blank" rel="noreferrer">
              How to make a file
            </a>
          </p>
          <div className="sv-actions">
            <button className="sv-btn primary" type="button" onClick={() => dispatch({ t: 'close' })}>
              OK
            </button>
          </div>
        </Dialog>
      )}
      {open && (
        <ImportSheet
          s={s}
          onContinue={() => dispatch({ t: 'continue' })}
          onBack={() => dispatch({ t: 'back' })}
          onPass={(v) => dispatch({ t: 'pass', v })}
          onImport={() => void run()}
          onCancel={() => {
            cancel.current = true;
            dispatch({ t: 'cancel' });
          }}
          onClose={() => dispatch({ t: 'close' })}
        />
      )}
    </>
  );
}
