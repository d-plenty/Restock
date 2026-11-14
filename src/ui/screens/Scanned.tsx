import { useEffect, useState, useSyncExternalStore } from 'react';
import { lookupBarcode, scanSeveral } from '../../lib/barcode';
import { allGroups, findProductByBarcode, groupProductIds } from '../../lib/db';
import { addToList } from '../../lib/listActions';
import { genericName } from '../../lib/naming';
import { addScanLine, clearDone, onScanLines, scanLines, toMatch, type ScanLine } from '../../lib/scanQueue';
import { SECTION_NAMES, type Section } from '../../shops';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';

// 0.10.7: "Scan several", as its own screen. Scan things one after another with the camera open
// (a count shows, and Done ends it). Things already in your pantry go straight on your shopping
// list. New ones are listed here to match, one at a time: after each, you come back here, with the
// next one at the top, until they're all done. The list stays if you leave and come back later.

const useLines = () => useSyncExternalStore(onScanLines, scanLines);

/** Scans one barcode in a row; returns what to say in the scanner. */
async function takeOne(code: string): Promise<string> {
  if (scanLines().some((l) => l.code === code && l.status === 'new')) return 'Already in the list below.';
  const product = await findProductByBarcode(code);
  const group = product && (await allGroups()).find((g) => groupProductIds(g).includes(product.id));
  if (group) {
    const added = await addToList(group);
    addScanLine({ code, name: group.name, groupId: group.id, status: added ? 'added' : 'already' });
    return added ? `Added to your shopping list: ${group.name}` : `Already on your shopping list: ${group.name}`;
  }
  // 0.10.7: a new one waits here to be matched. It doesn't go on the shopping list as a barcode
  // number (before, "Item 9310…" lines turned up while shopping, with no way to sort them out).
  const info = await lookupBarcode(code).catch(() => undefined);
  const name = info?.name ? genericName(info.name, info.brand) : `Barcode ${code}`;
  addScanLine({ code, name, status: 'new' });
  return `New: ${name}. Saved to match when you're done.`;
}

export function ScannedScreen({ section, start }: { section: Section; start?: boolean }) {
  const nav = useNav();
  const lines = useLines();
  const [scanning, setScanning] = useState(false);
  const left = toMatch(lines);
  const waiting = lines.filter((l) => l.status === 'new');
  const finished = lines.filter((l) => l.status !== 'new');

  const scan = async () => {
    setScanning(true);
    const before = scanLines().length;
    try {
      await scanSeveral('Scan the next thing', (code) => takeOne(code));
    } finally {
      setScanning(false);
      const n = scanLines().length - before;
      if (n > 0) nav.toast(n === 1 ? '1 barcode saved' : `${n} barcodes saved`);
    }
  };

  useEffect(() => {
    if (start) void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const row = (l: ScanLine, i: number) => (
    <div key={`${l.code}-${i}`} className="row">
      <span className={`scan-mark ${l.status === 'new' ? 'todo' : 'done'}`} aria-hidden="true">
        <Icon name={l.status === 'new' ? 'scan' : 'check'} size={18} />
      </span>
      <span className="grow">
        <span className="title" style={{ fontSize: 15 }}>
          {l.name}
        </span>
        <span className="small">
          {l.status === 'new'
            ? 'Not matched yet'
            : l.status === 'matched'
              ? 'Matched'
              : l.status === 'added'
                ? 'Added to your shopping list'
                : 'Already on your shopping list'}
        </span>
      </span>
      {l.status === 'new' && (
        <button className="btn small primary" onClick={() => nav.push({ name: 'add', barcode: l.code, section, fromScans: true, replaceEntry: l.entryId })}>
          Match it
        </button>
      )}
    </div>
  );

  return (
    <div className="screen">
      <TopBar title="Scan several" />
      <p className="small" style={{ margin: 0 }}>
        Scan whatever is running low, one after another, then tap Done. Things in your pantry go straight on your shopping list. New things wait
        here for you to match them, then go where you choose.
      </p>
      <button className="btn primary block" disabled={scanning} onClick={() => void scan()}>
        <Icon name="scan" size={18} /> {lines.length ? 'Scan more' : 'Start scanning'}
      </button>
      {waiting.length > 0 && (
        <>
          <h2 className="eyebrow" aria-live="polite">
            {left === 1 ? '1 left to match' : `${left} left to match`}
          </h2>
          <div className="card flush">{waiting.map(row)}</div>
        </>
      )}
      {waiting.length === 0 && finished.length > 0 && (
        <div className="banner green" role="status">
          <strong>{finished.length === 1 ? 'All matched' : `All ${finished.length} matched`}</strong>
          <span style={{ fontSize: 13 }}>Nothing left to match.</span>
        </div>
      )}
      {finished.length > 0 && (
        <>
          <h2 className="eyebrow">Done</h2>
          <div className="card flush">{finished.map(row)}</div>
          <div className="two">
            <button className="btn" onClick={() => clearDone()}>
              Clear the done ones
            </button>
            <button className="btn" onClick={() => nav.setTab(section)}>
              Back to {section === 'pantry' ? 'Pantry' : SECTION_NAMES[section]}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
