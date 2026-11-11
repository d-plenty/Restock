// 0.9.6: Import on the web's Data tab (docs/restock-import.md): a file merged on top of what the
// server has, never replacing or deleting anything, and never adding to the shopping list or pantry.
// Choose a file, the dry run ("Will add 12,000 products and 90,000 prices, skip 300 already there,
// ignore 12 it couldn't read"), then the two checks (Step 1 what it adds, Step 2 the passphrase
// again), then the import a chunk at a time with how far it is and Cancel. The words and the steps
// are in importFile.ts; the server checks everything again (server/src/v3/import.mjs).
import { useEffect, useId, useReducer, useRef } from 'react';
import { Icon, Sheet } from '../../ui/components';
import { ApiError, v3Send } from '../api';
import { confirmPassphrase, session } from '../session';
import { ADMIN_NOTE, canAdmin, errText } from './houseData';
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
} from './importFile';

export const IMPORT_HELP = 'https://github.com/d-plenty/Restock/blob/HEAD/docs/restock-import.md';

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
    <div className="dd-import-progress">
      <div className="loading-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={at}>
        <span style={{ width: `${Math.round(p * 1000) / 10}%` }} />
      </div>
      <span className="small num" aria-live="polite">
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
      {t.matched > 0 && <p className="small">{fmt(t.matched)} of the products are on the server already: only their new prices go in.</p>}
      {(why.length > 0 || costco) && (
        <ul className="small dd-import-why">
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
    <Sheet title={title} onClose={() => (s.busy ? onCancel() : onClose())}>
      <div className="dd-dialog">
        {s.file && <span className="dk-sub">{s.file}</span>}
        {s.phase === 'checking' && (
          <>
            <p className="small">Nothing is added yet: this only counts what the file would add.</p>
            <Progress at={s.at} of={s.chunks} label="Checked" />
            <div className="dd-dialog-btns">
              <span className="grow" />
              <button type="button" className="btn" onClick={onCancel} disabled={s.cancel}>
                {s.cancel ? 'Stopping…' : 'Cancel'}
              </button>
            </div>
          </>
        )}
        {s.phase === 'review' && (
          <>
            <span className="dk-eyebrow">Step 1 of 2</span>
            <div className="dd-stays">
              <strong>{dryRunLine(s.check)}</strong>
              <span className="small">Into the catalogue and price history only, marked imported. Nothing on the server is replaced or deleted, and nothing goes on the shopping list or in the pantry.</span>
            </div>
            <Lines t={s.check} />
            {s.read && s.read.notTaken.length > 0 && <p className="small">Not taken from this file (an import takes products and prices only): {s.read.notTaken.join(', ')}.</p>}
            {nothing && <p className="small">There's nothing new in this file for the server.</p>}
            <div className="dd-dialog-btns">
              <span className="grow" />
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={nothing || !canAdmin()} onClick={onContinue}>
                Continue
              </button>
            </div>
            {!canAdmin() && <span className="dk-sub">{ADMIN_NOTE}</span>}
          </>
        )}
        {s.phase === 'pass' && (
          <form
            className="house-form"
            onSubmit={(e) => {
              e.preventDefault();
              onImport();
            }}
          >
            <span className="dk-eyebrow">Step 2 of 2</span>
            <p className="small">
              {dryRunLine(s.check)} It goes to every phone in the household as the server's prices do. Big files take a few minutes; you can cancel, and what went in stays.
            </p>
            <label className="field" htmlFor={`${ids}-pass`}>
              <span className="small">Your passphrase</span>
            </label>
            <input ref={passRef} id={`${ids}-pass`} className="input" type="password" autoComplete="current-password" value={s.pass} onChange={(e) => onPass(e.target.value)} />
            {s.error && (
              <p className="banner red small" role="alert">
                {s.error}
              </p>
            )}
            <div className="dd-dialog-btns">
              <button type="button" className="btn" disabled={s.busy} onClick={onBack}>
                Back
              </button>
              <span className="grow" />
              <button type="submit" className="btn primary" disabled={s.busy || !s.pass}>
                {s.busy ? 'Checking…' : `Import ${fmt(s.check.prices)} ${s.check.prices === 1 ? 'price' : 'prices'}`}
              </button>
            </div>
          </form>
        )}
        {s.phase === 'importing' && (
          <>
            <p className="small">
              {s.at === 0 ? 'Checking your passphrase…' : `So far: ${fmt(s.done.products)} products and ${fmt(s.done.prices)} prices.`} Keep this page open.
            </p>
            <Progress at={s.at} of={s.chunks} label="Imported" />
            <div className="dd-dialog-btns">
              <span className="grow" />
              <button type="button" className="btn" onClick={onCancel} disabled={s.cancel}>
                {s.cancel ? 'Stopping after this part…' : 'Cancel'}
              </button>
            </div>
          </>
        )}
        {(s.phase === 'done' || s.phase === 'stopped') && (
          <>
            <p className={`banner ${s.phase === 'done' ? 'green' : 'amber'} small`} role="status">
              {s.phase === 'done' ? doneLine(s.done) : stoppedLine(s.done)}
            </p>
            {s.error && (
              <p className="banner red small" role="alert">
                {s.error}
              </p>
            )}
            <Lines t={s.done} />
            <div className="dd-dialog-btns">
              <span className="grow" />
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** The Import card, beside Download your data. `onDone` reloads the counts. */
export function ImportCard({ onDone }: { onDone?: () => void }) {
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
    <section className="card dd-card" aria-labelledby="dd-import">
      <div className="dd-card-head">
        <h2 id="dd-import">Import data</h2>
      </div>
      <p className="small dd-tight">
        Adds products and their prices from a file to what's on this server. It never replaces or deletes anything, and never adds to your shopping list or pantry. Imported prices are
        marked imported, apart from the prices your phones saw.
      </p>
      <div className="dd-export">
        <button type="button" className="dd-export-btn" disabled={s.busy} onClick={() => inputRef.current?.click()} aria-describedby="dd-im-sub">
          <Icon name="up" size={20} />
          <span className="grow">
            <strong>{s.phase === 'reading' ? 'Reading the file…' : 'Choose a file to import'}</strong>
            <span id="dd-im-sub" className="dk-sub">
              The Full export file (.json) or the CSV files (.zip) from this page, or a file you made in the same shape. Up to {LIMITS.fileMb} MB, {fmt(LIMITS.products)} products and{' '}
              {fmt(LIMITS.prices)} prices.
            </span>
          </span>
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept=".json,.zip,application/json,application/zip"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {s.phase === 'idle' && s.error && (
        <p className="banner red small" role="alert">
          {s.error}
        </p>
      )}
      <span className="dk-sub">
        A file you make yourself needs a format, a version, and products with their prices:{' '}
        <a href={IMPORT_HELP} target="_blank" rel="noreferrer">
          how to make a file
        </a>
        . Only import prices you're allowed to use: shops' websites have terms of use, and some don't allow collecting their prices with automated tools. Restock doesn't fetch shops
        for you here. Card numbers, PINs, passwords, keys and receipts are never imported, and Costco prices never go in or out.
      </span>
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
    </section>
  );
}
