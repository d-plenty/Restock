import { useRef, useState } from 'react';
import { askPassword, confirmAction } from '../../lib/confirm';
import { isLocked, NOT_OURS, unlockBackup } from '../../lib/backupLock';
import { RestockNative } from '../../lib/sql/native';
import { syncInfo } from '../../lib/sync';
import { readBackup, restoreBackup, type BackupSummary } from '../../lib/backup';
import type { RestoreParts } from '../../lib/db';
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
  onDone: (what: string) => void;
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
  });
  const [tidy, setTidy] = useState(summary.renames.length > 0);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const any = parts.pantry || parts.list || parts.cards || parts.shops || parts.settings || parts.receipts;
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
      if (sync?.paired) {
        const send = await confirmAction(`This phone syncs with ${sync.household ?? 'your household'}`, {
          detail: `If you restore while it's syncing, the household's other phones get the restored things too: everyone's pantry and list will match this backup.${
            parts.cards ? " Loyalty cards from the backup are added, and no one's cards are removed." : ''
          } To restore on this phone only, choose Stop syncing first.`,
          action: 'Restore for the household',
          danger: false,
        });
        household = send;
        if (!send) {
          const leave = await confirmAction('Stop syncing this phone, then restore?', {
            detail:
              'This phone leaves the household (it keeps everything), and the backup is restored here only. To sync again later, join with a new code.',
            action: 'Stop syncing and restore',
          });
          if (!leave) return stop();
          const r = await RestockNative.syncLeave();
          if (!r.left) {
            setError('This is the owner phone. Make another phone the owner first (Settings → Sync and backups → Local sync), or choose Restore for the household.');
            return stop();
          }
        }
      }
      // 0.9.0: for the household, cards are added rather than replaced (db.ts restoreParts).
      await restoreBackup(summary, parts, { stayInSetup: inSetup, renames: new Map(renaming.map((r) => [r.groupId, r.to])), household });
      const what = [
        ...(parts.pantry ? (parts.sections ?? []).map((sec) => `${SECTION_NAMES[sec].toLowerCase()} items`) : []),
        parts.list && 'shopping lists',
        parts.cards && 'cards',
        parts.shops && `${(parts.shopSections ?? []).map((sec) => SECTION_NAMES[sec].toLowerCase()).join(' and ')} shops`,
        parts.settings && 'settings',
        parts.receipts && 'receipts',
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
    <Sheet title="Restore from a backup" onClose={onClose}>
      <p className="small">
        {when ? `Backup from ${when}. ` : ''}Tick what to bring back.
        {inSetup ? '' : ' Only what you tick is replaced. Everything else on this phone stays exactly as it is.'}
      </p>
      <PartsPicker
        counts={{
          bySection: c.bySection,
          list: c.list,
          cards: c.cards,
          hasSettings: c.hasSettings,
          receipts: c.receipts,
          photos: c.photos,
          shopTabs: c.shopTabs,
        }}
        parts={{ ...parts, prices: true }}
        restoring
        onChange={(p) => setParts((x) => ({ ...x, ...p }))}
      />
      {parts.pantry && c.prices > 0 && (
        <p className="small">Items come back with {c.prices.toLocaleString()} saved prices. Restoring a tab's items replaces that tab only.</p>
      )}
      {parts.list && !inSetup && (
        <p className="small">
          Shopping lists are replaced tab by tab: the tabs this backup has list lines for{parts.pantry ? ', and the tabs whose items you restore' : ''}.
          Other tabs' lists stay as they are.
        </p>
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
        <Icon name="refresh" size={18} /> {busy ? 'Restoring…' : 'Restore'}
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
