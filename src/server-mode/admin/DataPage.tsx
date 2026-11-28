// 0.18.3: Data. What the household's phones have shared with this server: the space it takes, each
// kind with how many and how big (Export on each), how long it's kept, Delete some or everything,
// Import a file and Download a backup. Keeping less, deleting and the backup need the passphrase;
// the first two a yes on an admin phone too (the server asks for it, PhoneYes.tsx shows it).
import { useId, useState } from 'react';
import { api3, ApiError } from '../api';
import { confirmPassphrase, session } from '../session';
import { checkPassphrase } from '../passphrase';
import { data, deleteError, fullExport, KIND_NAME, WORD, WORD_ALL, type DataKind, type DataSummary, type RestockExport } from '../ui/houseWords';
import { exportTables, fileBase, withoutCostco, xlsxOf, XLSX_TYPE } from '../ui/exportFiles';
import { ImportButton } from './ImportData';
import { bytes, Card, change, count, Dialog, errText, Loading, LoadError, Lock, mount, PageHead, saveFile, Seg, toast, useLoad } from './ui';

const COLOURS: Record<string, string> = { prices: 'var(--blue)', receipts: 'var(--sv-green)', stats: 'var(--sv-gold)', other: 'var(--sv-soft)', logs: 'var(--line-2)', backups: 'var(--dash)' };

/** The export's tables for one kind (Export on its row). */
const TABLES: Record<string, string[]> = {
  prices: ['products', 'prices'],
  receipts: ['receipts'],
  stats: ['spending', 'ticked'],
  other: ['items', 'list', 'categories', 'inventory', 'aliases', 'shops', 'settings'],
};
const KEEP: { value: number | 'off'; label: string }[] = [
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
  { value: 24, label: '2 years' },
  { value: 'off', label: 'Until deleted' },
];

function howMany(k: string, s: DataSummary): string {
  const x = s.kinds;
  if (k === 'prices') return `${count(x.prices.count, 'price')}, for ${count(x.prices.products, 'product')}`;
  if (k === 'receipts') return `${count(x.receipts.count, 'receipt')}${x.receipts.photos ? `, ${count(x.receipts.photos, 'photo')}` : ''}`;
  if (k === 'stats') return count(x.stats.count, 'purchase');
  if (k === 'logs') return count(x.logs.count, 'line');
  if (k === 'backups') return count(x.backups.count, 'file');
  return 'Pantry, lists, categories and settings';
}
const sizeOf = (k: string, s: DataSummary) => (k === 'other' ? s.other : (s.kinds[k as DataKind]?.bytes ?? 0));
const NAMES: Record<string, string> = { ...KIND_NAME, other: 'Pantry, lists and the rest' };

async function exportKind(kind: string, setBusy: (b: string | undefined) => void) {
  setBusy(kind);
  try {
    const full: RestockExport = withoutCostco(await fullExport());
    const want = TABLES[kind] ?? Object.keys(full.tables);
    const tables = exportTables({ tables: Object.fromEntries(Object.entries(full.tables).filter(([t]) => want.includes(t))) });
    saveFile(`${fileBase(kind === 'other' ? 'pantry-and-lists' : kind)}.xlsx`, xlsxOf(tables) as BlobPart, XLSX_TYPE);
  } catch (e) {
    toast(errText(e));
  } finally {
    setBusy(undefined);
  }
}

export function DataPage() {
  const sum = useLoad(() => data.summary());
  const [busy, setBusy] = useState<string>();
  const [deleting, setDeleting] = useState<'some' | 'all'>();
  const [backup, setBackup] = useState(false);
  const s = sum.data;
  const rows = ['prices', 'receipts', 'stats', 'other', 'logs', 'backups'];
  const total = s ? Math.max(1, s.total) : 1;
  const keep = s?.autoDelete.months ?? null;

  const setKeep = async (v: number | 'off') => {
    const months = v === 'off' ? null : v;
    // Keeping less (or turning it on) deletes what's older now: the word and the passphrase first.
    const deletes = months !== null && (keep === null || months < keep);
    if (!deletes) {
      await change(() => data.setAutoDelete(months), months === null ? 'Kept until you delete it' : `Kept for ${KEEP.find((k) => k.value === v)?.label}`);
      return sum.reload();
    }
    const pass = await askDanger(`Only keep ${KEEP.find((k) => k.value === v)?.label}?`, `Anything older is deleted now, and each night after. ${WORD} and your passphrase to go ahead.`, WORD);
    if (!pass) return;
    await change(async () => data.setAutoDelete(months, WORD, await confirmPassphrase(pass)), 'Changed. Older data was deleted.');
    sum.reload();
  };

  return (
    <>
      <PageHead title="Data" sub="What the household's phones have shared with this server. It stays here, on your own computer.">
        <div className="sv-row wrap">
          <ImportButton onDone={sum.reload} />
          <button className="sv-btn primary" type="button" onClick={() => setBackup(true)} disabled={!!session()?.viaPhone} title={session()?.viaPhone ? 'Sign in with the passphrase to download a backup' : undefined}>
            Download a backup
          </button>
        </div>
      </PageHead>
      {sum.error && <LoadError error={sum.error} onRetry={sum.reload} />}
      <Card>
        <div className="sv-row wrap">
          <h2 className="sv-grow">Space used</h2>
          {s?.disk && <span className="sv-small">{`${bytes(s.total)} of ${bytes(s.disk.free)} free on this computer`}</span>}
        </div>
        {!s && !sum.error && <Loading label="Measuring" />}
        {s && (
          <>
            <div className="sv-bar" role="img" aria-label={rows.map((k) => `${NAMES[k]} ${bytes(sizeOf(k, s))}`).join(', ')}>
              {rows.map((k) => (
                <span key={k} style={{ width: `${(sizeOf(k, s) / total) * 100}%`, background: COLOURS[k] }} />
              ))}
            </div>
            <div className="sv-tbl-wrap">
              <table className="sv-tbl">
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">How many</th>
                    <th scope="col">Size</th>
                    <th scope="col">
                      <span className="sv-skip">Export</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((k) => (
                    <tr key={k}>
                      <td>
                        <span className="sv-dot" style={{ background: COLOURS[k] }} />
                        {NAMES[k]}
                      </td>
                      <td data-label="How many">{howMany(k, s)}</td>
                      <td data-label="Size">{bytes(sizeOf(k, s))}</td>
                      <td style={{ textAlign: 'right' }}>
                        {TABLES[k] && (
                          <button className="sv-btn sm" type="button" disabled={!!busy} onClick={() => void exportKind(k, setBusy)} aria-label={`Export ${NAMES[k]} (Excel)`}>
                            {busy === k ? 'Exporting…' : 'Export'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sv-row wrap">
              <span className="sv-small sv-grow">{s.measured === 'estimate' ? 'Sizes are close estimates.' : ''} Exports are Excel files. Costco's prices are never exported.</span>
              <button className="sv-btn sm" type="button" disabled={!!busy} onClick={() => void exportEverything(setBusy)}>
                {busy === 'all' ? 'Exporting…' : 'Export everything (.json)'}
              </button>
            </div>
          </>
        )}
      </Card>
      <div className="sv-grid2">
        <Card title="How long data is kept">
          <Seg label="How long data is kept" options={KEEP} value={keep === null ? 'off' : (keep as number)} onChange={(v) => void setKeep(v)} disabled={!s} />
          <p className="sv-small">Older prices, receipts and logs are deleted here each night (in the 3 o'clock hour). Phones keep their own 8 weeks either way.</p>
          <Lock>Keeping less needs the passphrase and a yes on an admin phone</Lock>
        </Card>
        <Card title="Delete data">
          <p className="sv-small">By kind, or everything before a date. You'll see exactly what goes first, then type {WORD} and your passphrase.</p>
          <div className="sv-row wrap">
            <button className="sv-btn danger" type="button" onClick={() => setDeleting('some')} disabled={!s}>
              Delete some…
            </button>
            <button className="sv-btn danger" type="button" onClick={() => setDeleting('all')} disabled={!s}>
              Delete everything…
            </button>
          </div>
          <Lock />
        </Card>
      </div>
      {deleting === 'some' && s && (
        <DeleteSome
          summary={s}
          onClose={() => {
            setDeleting(undefined);
            sum.reload();
          }}
        />
      )}
      {deleting === 'all' && <DeleteEverything onClose={() => setDeleting(undefined)} />}
      {backup && <BackupDialog onClose={() => setBackup(false)} />}
    </>
  );
}

async function exportEverything(setBusy: (b: string | undefined) => void) {
  setBusy('all');
  try {
    const full = withoutCostco(await fullExport());
    saveFile(`${fileBase()}.json`, JSON.stringify(full, null, 1), 'application/json');
  } catch (e) {
    toast(errText(e));
  } finally {
    setBusy(undefined);
  }
}

/** The typed word and the passphrase, for a change that deletes. Undefined: cancelled. */
function askDanger(title: string, detail: string, word: string): Promise<string | undefined> {
  return mount<string | undefined>((done) => <DangerBox title={title} detail={detail} word={word} onDone={done} />);
}
function DangerBox({ title, detail, word, onDone }: { title: string; detail: string; word: string; onDone: (pass: string | undefined) => void }) {
  const [typed, setTyped] = useState('');
  const [pass, setPass] = useState('');
  const ids = { w: useId(), p: useId() };
  return (
    <Dialog title={title} onClose={() => onDone(undefined)}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim() === word && pass) onDone(pass);
        }}
      >
        <p className="sv-small" style={{ fontSize: 15 }}>
          {detail}
        </p>
        <div className="sv-field">
          <label htmlFor={ids.w}>Type {word}</label>
          <input id={ids.w} className="sv-input" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
        </div>
        <div className="sv-field">
          <label htmlFor={ids.p}>Your passphrase</label>
          <input id={ids.p} className="sv-input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
        <div className="sv-actions">
          <button className="sv-btn" type="button" onClick={() => onDone(undefined)}>
            Cancel
          </button>
          <button className="sv-btn danger" type="submit" disabled={typed.trim() !== word || !pass}>
            Go ahead
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const DELETABLE: DataKind[] = ['prices', 'receipts', 'stats', 'logs', 'backups'];

/** Delete some: which kinds, and (if wanted) only what's older than a date; the exact count first. */
function DeleteSome({ summary, onClose }: { summary: DataSummary; onClose: () => void }) {
  const [kinds, setKinds] = useState<DataKind[]>([]);
  const [before, setBefore] = useState('');
  const [counted, setCounted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dateId = useId();
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const beforeIso = before ? new Date(before + 'T00:00:00').toISOString() : null;
  const countIt = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await data.count(kinds, beforeIso);
      const c = r.counts as Record<string, number | undefined>;
      const bits = kinds.map((k) => `${(Number(c[k]) || 0).toLocaleString('en-AU')} ${KIND_NAME[k].toLowerCase()}`);
      setCounted(`That deletes ${bits.join(', ')}${beforeIso ? ` from before ${new Date(beforeIso).toLocaleDateString('en-AU')}` : ''}.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    const pass = await askDanger('Delete it?', `${counted ?? ''} It can't be undone. ${WORD} and your passphrase to go ahead.`, WORD);
    if (!pass) return;
    setBusy(true);
    setError(undefined);
    try {
      await data.delete(kinds, beforeIso, WORD, await confirmPassphrase(pass));
      toast('Deleted');
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'approve-cancelled' ? 'Nothing was deleted: no admin phone said yes.' : deleteError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Delete some data" onClose={onClose}>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <legend className="sv-label" style={{ marginBottom: 6 }}>
          What to delete
        </legend>
        {DELETABLE.map((k) => (
          <label key={k} className="sv-row">
            <input
              type="checkbox"
              checked={kinds.includes(k)}
              onChange={(e) => {
                setCounted(undefined);
                setKinds((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)));
              }}
            />
            <span className="sv-grow">
              {KIND_NAME[k]} <span className="sv-small">· {bytes(summary.kinds[k]?.bytes)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="sv-field">
        <label htmlFor={dateId}>Only what's older than (leave empty for all of it)</label>
        <input
          id={dateId}
          className="sv-input"
          type="date"
          value={before}
          max={today}
          onChange={(e) => {
            setCounted(undefined);
            setBefore(e.target.value);
          }}
        />
      </div>
      {counted && <div className="sv-note">{counted}</div>}
      {error && (
        <p className="sv-error" role="alert">
          {error}
        </p>
      )}
      <div className="sv-actions">
        <button className="sv-btn" type="button" onClick={onClose}>
          Cancel
        </button>
        {!counted ? (
          <button className="sv-btn primary" type="button" disabled={busy || !kinds.length} onClick={() => void countIt()}>
            {busy ? 'Counting…' : 'See what goes'}
          </button>
        ) : (
          <button className="sv-btn danger" type="button" disabled={busy} onClick={() => void go()}>
            Delete…
          </button>
        )}
      </div>
    </Dialog>
  );
}

/** Delete everything: the household and all its data go; the server is new again (Set up). */
export function DeleteEverything({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string>();
  const go = async () => {
    const pass = await askDanger('Delete everything?', `The household, every phone's place on this server and all its data go. Phones keep what they have and carry on without the server. ${WORD_ALL} and your passphrase to go ahead.`, WORD_ALL);
    if (!pass) return;
    try {
      await data.deleteEverything(WORD_ALL, await confirmPassphrase(pass));
      location.reload();
    } catch (e) {
      setError(deleteError(e));
    }
  };
  return (
    <Dialog title="Delete everything on this server" onClose={onClose}>
      <p className="sv-small" style={{ fontSize: 15 }}>
        Deletes the household, every phone's place on it and all its data. Phones keep what they have and carry on without it. Download a backup first if you might want it back.
      </p>
      {error && (
        <p className="sv-error" role="alert">
          {error}
        </p>
      )}
      <div className="sv-actions">
        <button className="sv-btn" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="sv-btn danger" type="button" onClick={() => void go()}>
          Delete everything…
        </button>
      </div>
    </Dialog>
  );
}

/** Download a backup: sealed with a passphrase of its own before it leaves the server. */
export function BackupDialog({ onClose }: { onClose: () => void }) {
  const [bp, setBp] = useState('');
  const [bp2, setBp2] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = { a: useId(), b: useId(), c: useId() };
  const strength = bp ? checkPassphrase(bp, session()?.user ?? '') : undefined;
  const ok = !!strength?.ok && bp === bp2 && !!pass;
  return (
    <Dialog title="Download a backup" onClose={onClose}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          setBusy(true);
          setError(undefined);
          void (async () => {
            try {
              const { bytes: b, name } = await api3.backup(bp, await confirmPassphrase(pass));
              saveFile(name ?? `restock-server-${new Date().toISOString().slice(0, 10)}.rsb`, b as BlobPart);
              toast('Backup downloaded');
              onClose();
            } catch (err) {
              setError(err instanceof ApiError && err.code === 'current' ? "That isn't your passphrase." : errText(err));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <p className="sv-small" style={{ fontSize: 15 }}>
          Everything on this server in one file, sealed with a passphrase of its own. Keep that passphrase: the file can't be opened without it. To put it on a new server, see Updates and moving.
        </p>
        <div className="sv-field">
          <label htmlFor={ids.a}>A passphrase for the file</label>
          <input id={ids.a} className="sv-input" type="password" autoComplete="new-password" value={bp} onChange={(e) => setBp(e.target.value)} aria-invalid={!!bp && !strength?.ok} />
          {bp && !strength?.ok && <span className="sv-small">{strength?.problem}</span>}
        </div>
        <div className="sv-field">
          <label htmlFor={ids.b}>The same again</label>
          <input id={ids.b} className="sv-input" type="password" autoComplete="new-password" value={bp2} onChange={(e) => setBp2(e.target.value)} aria-invalid={!!bp2 && bp2 !== bp} />
        </div>
        <div className="sv-field">
          <label htmlFor={ids.c}>Your sign-in passphrase</label>
          <input id={ids.c} className="sv-input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
        {error && (
          <p className="sv-error" role="alert">
            {error}
          </p>
        )}
        <div className="sv-actions">
          <button className="sv-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="sv-btn primary" type="submit" disabled={!ok || busy}>
            {busy ? 'Making the backup…' : 'Download'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
