import { useEffect, useRef, useState } from 'react';
import { decodePhoto, scanBarcode } from '../../lib/barcode';
import { canSendDirect, deviceLan, fetchData, isSendCode } from '../../lib/handover';
import { describeConnections } from '../../lib/connections';
import { askPassword, confirmAction } from '../../lib/confirm';
import { isLocked, NOT_OURS, unlockBackup } from '../../lib/backupLock';
import { RestockNative } from '../../lib/sql/native';
import { syncInfo } from '../../lib/sync';
import { readBackup, restoreBackup, type BackupSummary } from '../../lib/backup';
import { lastAddCounts, type RestoreParts } from '../../lib/db';
import { Icon, Sheet } from '../components';
import { SECTION_NAMES, SECTIONS } from '../../shops';
import { PartsPicker } from './BackupParts';

/**
 * Pick what to bring back from a backup (pantry, shopping list, cards, settings), and tidy
 * pantry names on the way in ("Coles Simply Pure Honey Squeeze 400g" → "Honey").
 */
export function RestoreSheet({
  summary,
  inSetup,
  onDone,
  onClose,
}: {
  summary: BackupSummary;
  /** From setup: the phone stays in setup afterwards for the permissions step. */
  inSetup?: string;
  /** `whole`: the words are the whole message (adding alongside), not a list of what was restored. */
  onDone: (what: string, whole?: boolean) => void;
  onClose: () => void;
}) {
  const c = summary.counts;
  const inFile = SECTIONS.filter((sec) => c.bySection[sec] > 0);
  // From setup everything in the file is ticked; from Settings nothing is, so only what you
  // tick is replaced.
  const all = !!inSetup;
  const [parts, setParts] = useState<RestoreParts>({
    pantry: all && inFile.length > 0,
    sections: all ? inFile : [],
    list: all && c.list > 0,
    cards: all && c.cards > 0,
    shops: all && c.shopTabs.length > 0,
    shopSections: all ? c.shopTabs : [],
    settings: all && c.hasSettings,
    receipts: all && c.receipts > 0,
    // 0.18.3: from setup, yes when the file has them; from Settings, ticked by hand.
    connections: all && !!summary.connections,
  });
  // 0.14.0: add alongside what's here (nothing replaced; same names skipped), or replace the parts ticked.
  // From setup there's nothing here yet, so it's always the plain restore.
  const [mode, setMode] = useState<'add' | 'replace'>(inSetup ? 'replace' : 'add');
  const add = mode === 'add';
  useEffect(() => {
    if (inSetup) return;
    // Adding: everything in the file is ticked to start with (it can't overwrite anything). Replacing: nothing is.
    setParts({
      pantry: add && inFile.length > 0,
      sections: add ? inFile : [],
      list: add && c.list > 0,
      cards: add && c.cards > 0,
      shops: false,
      shopSections: [],
      settings: false,
      receipts: add && c.receipts > 0,
    });
    // Only when the choice changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  const [tidy, setTidy] = useState(summary.renames.length > 0);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const any = parts.pantry || parts.list || parts.cards || parts.shops || parts.settings || parts.receipts || parts.connections;
  const conn = describeConnections(summary.connections);
  const when = summary.exportedAt
    ? new Date(summary.exportedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
    : undefined;
  const renames = summary.renames;
  const shown = showAll ? renames : renames.slice(0, 6);
  const renaming = tidy && (parts.pantry || parts.list) ? renames.filter((r) => !skip.has(r.groupId)) : [];

  const going = useRef(false);
  const go = async () => {
    // Busy from the first tap, so a second tap (or one behind a question) can't restore twice.
    if (going.current) return;
    going.current = true;
    setBusy(true);
    setError(undefined);
    const stop = () => {
      going.current = false;
      setBusy(false);
    };
    try {
      // In a household, restoring changes everyone's things. Ask first.
      const sync = await syncInfo().catch(() => undefined);
      let household = false;
      // (Adding alongside is like adding things by hand: they sync to the household as anything new does.)
      if (sync?.paired && !add) {
        const send = await confirmAction(`This phone syncs with ${sync.household ?? 'your household'}`, {
          detail: `If you restore while it's syncing, the household's other phones get the restored things too: everyone's pantry and list will match this backup.${
            parts.cards ? " Cards from the backup are added, and no one's cards are removed." : ''
          } To restore on this phone only, choose Stop syncing first.`,
          action: 'Restore for the household',
          danger: false,
        });
        household = send;
        if (!send) {
          const onServer = !!(sync.house || sync.serverApi === 3);
          const leave = await confirmAction(onServer ? 'Leave the server, then restore?' : 'Stop syncing this phone, then restore?', {
            detail: onServer
              ? "This phone leaves your Restock server (it keeps everything, and nothing is deleted there), and the backup is restored here only. To join again later, scan a new code from the server's page."
              : 'This phone leaves the household (it keeps everything), and the backup is restored here only. To sync again later, join with a new code.',
            action: onServer ? 'Leave and restore' : 'Stop syncing and restore',
          });
          if (!leave) return stop();
          const r = await RestockNative.syncLeave();
          if (!r.left) {
            setError('This is the owner phone. Make another phone the owner first (Settings → Sync → Phones and sharing), or choose Restore for the household.');
            return stop();
          }
        }
      }
      // 0.9.0: for the household, cards are added rather than replaced (db.ts restoreParts).
      await restoreBackup(summary, parts, { stayInSetup: inSetup, renames: new Map(renaming.map((r) => [r.groupId, r.to])), household, add });
      if (add) {
        const n = lastAddCounts();
        const said = (k: 'added' | 'skipped') =>
          n
            ? [
                n[k].items && `${n[k].items} item${n[k].items === 1 ? '' : 's'}`,
                n[k].lines && `${n[k].lines} list line${n[k].lines === 1 ? '' : 's'}`,
                n[k].cards && `${n[k].cards} card${n[k].cards === 1 ? '' : 's'}`,
                n[k].receipts && `${n[k].receipts} receipt${n[k].receipts === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(', ')
            : '';
        const added = said('added');
        const skipped = said('skipped');
        onDone(`${added ? `Added ${added}` : 'Nothing new to add'}${skipped ? `. Skipped ${skipped} already here` : ''}`, true);
        return;
      }
      const what = [
        ...(parts.pantry ? (parts.sections ?? []).map((sec) => `${SECTION_NAMES[sec].toLowerCase()} items`) : []),
        parts.list && 'shopping lists',
        parts.cards && 'cards',
        parts.shops && `${(parts.shopSections ?? []).map((sec) => SECTION_NAMES[sec].toLowerCase()).join(' and ')} shops`,
        parts.settings && 'settings',
        parts.receipts && 'receipts',
        parts.connections && conn && 'connections',
      ]
        .filter(Boolean)
        .join(', ');
      onDone(renaming.length ? `${what} (${renaming.length} name${renaming.length === 1 ? '' : 's'} tidied)` : String(what));
    } catch (e) {
      stop();
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet title={inSetup ? 'Restore from a backup' : 'Import data'} onClose={onClose}>
      {!inSetup && (
        <div className="card flush" role="radiogroup" aria-label="How to bring it in">
          <label className="check">
            <input type="radio" name="import-mode" checked={add} onChange={() => setMode('add')} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Add alongside what's here
              </span>
              <span className="small">Nothing on this phone is replaced. Anything with the same name as something already here is skipped.</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name="import-mode" checked={!add} onChange={() => setMode('replace')} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Replace what's here
              </span>
              <span className="small">What you tick replaces this phone's own. Everything you don't tick stays exactly as it is.</span>
            </span>
          </label>
        </div>
      )}
      <p className="small">
        {when ? `Made on ${when}. ` : ''}Tick what to bring in.
        {add ? " Settings and shops aren't changed when adding: this phone keeps its own." : ''}
      </p>
      <PartsPicker
        counts={{
          bySection: c.bySection,
          list: c.list,
          cards: c.cards,
          giftCards: c.giftCards, // 0.9.6 (cards)
          hasSettings: add ? false : c.hasSettings,
          receipts: c.receipts,
          photos: c.photos,
          shopTabs: add ? [] : c.shopTabs,
        }}
        parts={{ ...parts, prices: true }}
        restoring
        onChange={(p) => setParts((x) => ({ ...x, ...p }))}
      />
      {parts.pantry && c.prices > 0 && (
        <p className="small">
          {add
            ? 'Items that are added come with their saved prices.'
            : `Items come back with ${c.prices.toLocaleString()} saved prices. Restoring a tab's items replaces that tab only.`}
        </p>
      )}
      {parts.list && !inSetup && !add && (
        <p className="small">
          Shopping lists are replaced tab by tab: the tabs this backup has list lines for{parts.pantry ? ', and the tabs whose items you restore' : ''}.
          Other tabs' lists stay as they are.
        </p>
      )}

      {conn && (
        <div className="card flush">
          <label className="check">
            <input type="checkbox" checked={!!parts.connections} onChange={(e) => setParts((x) => ({ ...x, connections: e.target.checked }))} aria-label="Connections" />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Connections
              </span>
              <span className="small">
                {conn[0].toUpperCase() + conn.slice(1)}.{' '}
                {summary.connections?.server?.code
                  ? 'This phone joins the server as a phone of its own, with the code in the file (once).'
                  : summary.connections?.server
                    ? "The server's addresses only: ask an admin for a code to join it."
                    : ''}
              </span>
            </span>
          </label>
        </div>
      )}

      {renames.length > 0 && (parts.pantry || parts.list) && (
        <div className="card flush">
          <label className="check">
            <input type="checkbox" className="switch" checked={tidy} onChange={(e) => setTidy(e.target.checked)} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Tidy up item names
              </span>
              <span className="small">
                Give {renames.length} item{renames.length === 1 ? '' : 's'} a short everyday name. The product name still shows underneath. Untick any
                you want to keep.
              </span>
            </span>
          </label>
          {tidy &&
            shown.map((r) => (
              <label className="check" key={r.groupId} style={{ paddingLeft: 28 }}>
                <input
                  type="checkbox"
                  checked={!skip.has(r.groupId)}
                  onChange={(e) =>
                    setSkip((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.delete(r.groupId);
                      else n.add(r.groupId);
                      return n;
                    })
                  }
                />
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <span className="title" style={{ fontSize: 15 }}>
                    {r.to}
                  </span>
                  <span className="small" style={{ textDecoration: skip.has(r.groupId) ? undefined : 'line-through' }}>
                    {r.from}
                  </span>
                </span>
              </label>
            ))}
          {tidy && renames.length > shown.length && (
            <button className="linkish small" style={{ margin: '0 14px 12px' }} onClick={() => setShowAll(true)}>
              Show all {renames.length}
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="small" style={{ color: 'var(--red-ink)' }}>
          {error}
        </p>
      )}
      <button className="btn primary block" disabled={!any || busy} onClick={go}>
        <Icon name="refresh" size={18} /> {busy ? 'Working…' : inSetup ? 'Restore' : add ? 'Add to this phone' : 'Replace'}
      </button>
    </Sheet>
  );
}

/** Read a picked file into a summary, or explain why it can't be used. */
export async function readBackupFile(file: File): Promise<BackupSummary> {
  let text = await file.text();
  // 0.9.0: a locked backup asks for its password (three goes).
  if (isLocked(text)) {
    let detail = 'This backup is locked with a password. Restock never keeps it, so only you know it.';
    for (let tries = 0; ; tries++) {
      const pw = await askPassword('Backup password', { detail, action: 'Open the backup' });
      if (!pw) throw new Error('Restore cancelled');
      try {
        text = await unlockBackup(text, pw);
        break;
      } catch (e) {
        // 0.9.0: a lock Restock didn't make won't open with any password, so don't ask again.
        if (tries >= 2 || (e instanceof Error && e.message === NOT_OURS)) throw e;
        detail = 'That password doesn’t open this backup. Try again (passwords are case-sensitive).';
      }
    }
  }
  return readBackup(text);
}

/**
 * 0.14.0, Import data: from a file, or straight from another phone that's showing a code (Export
 * data → Send to another phone, on it). Either way the next step is the same: tick what to bring in.
 */
export function ImportSheet({ onPicked, onClose, onError }: { onPicked: (s: BackupSummary) => void; onClose: () => void; onError: (msg: string) => void }) {
  const photoRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const direct = canSendDirect();

  const receive = async (code: string) => {
    const lan = deviceLan();
    if (!lan) return;
    setError(undefined);
    setBusy('Connecting to the other phone…');
    try {
      const got = await fetchData(lan, code, (part, from) => setBusy(`Receiving from ${from}… ${Math.round(part * 100)}%`));
      onPicked(readBackup(got.text));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const scan = async () => {
    const out = await scanBarcode('Scan the code on the other phone', {
      accept: (text) => (isSendCode(text) ? text.trim() : undefined),
      qr: true,
      wrong: "That isn't a code for receiving data. On the other phone, choose Export data, then Send to another phone.",
      typeHint: 'Or type the code',
    });
    if (out.ok) await receive(out.code);
  };

  return (
    <Sheet title="Import data" onClose={onClose}>
      <p className="small">Bring in a pantry, shopping lists, cards, receipts or settings. You pick what comes in on the next step.</p>
      {error && (
        <p className="banner amber small" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="small" role="status">
          {busy}
        </p>
      )}
      {/* 0.18.3: the file box itself is what's tapped (as on the first screen, 0.13.1): a button pressing a
          hidden one from code opened nothing on some phones. */}
      <label className="sync-choice welcome-file" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }} aria-disabled={!!busy}>
        <strong style={{ fontSize: 17 }}>From a file</strong>
        <span className="small">A file made with Export data, or one of Restock's backups.</span>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Import from a file"
          disabled={!!busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              onPicked(await readBackupFile(file));
            } catch (err) {
              onError(err instanceof Error ? err.message : 'Could not read that file');
            }
          }}
        />
      </label>
      <div className="sync-choice" aria-disabled={!direct} style={direct ? undefined : { opacity: 0.6 }}>
        <strong style={{ fontSize: 17 }}>From another phone</strong>
        <span className="small">
          {direct
            ? 'On the other phone: Export data, then Send to another phone. It shows a code. Both phones need to be on the same Wi-Fi, and the code only works while it stays on that screen.'
            : 'Receiving straight from another phone works in the Restock app on Android, iPhone and iPad.'}
        </span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn small primary" disabled={!!busy || !direct} onClick={() => void scan()}>
            Scan the code
          </button>
          <button className="btn small" disabled={!!busy || !direct} onClick={() => photoRef.current?.click()}>
            Use a photo of the code
          </button>
        </span>
      </div>
      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy('Reading the photo…');
          const text = await decodePhoto(file).catch(() => undefined);
          setBusy(undefined);
          if (text && isSendCode(text)) await receive(text);
          else setError("Restock couldn't find a code for receiving data in that photo. Try a clearer photo, or scan the code.");
        }}
      />
    </Sheet>
  );
}
