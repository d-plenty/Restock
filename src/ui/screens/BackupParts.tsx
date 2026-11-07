import { useEffect, useState } from 'react';
import { EVERYTHING, exportBackup, exportCounts, type ExportParts } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { SECTION_NAMES, SECTIONS, type Section } from '../../shops';
import { Icon, Sheet } from '../components';

/** What can be picked in a backup, and how many of each there are. */
export interface PartCounts {
  bySection: Record<Section, number>;
  list: number;
  cards: number;
  /** Saved prices; only offered when exporting. */
  prices?: number;
  hasSettings: boolean;
  /** Kept receipts, and how many have a photo. */
  receipts?: number;
  photos?: number;
  /** Restoring: the tabs the backup has shops for. */
  shopTabs?: Section[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Ticks for each part of a backup: items per tab (Pantry, Keg, Pharmacy), price history,
 * shopping lists, loyalty cards, and settings. Used when exporting and when restoring.
 */
export function PartsPicker({
  counts,
  parts,
  onChange,
  pricesOn,
  onPrices,
  photosOn,
  onPhotos,
  restoring,
}: {
  counts: PartCounts;
  parts: ExportParts | Omit<ExportParts, 'prices'>;
  onChange: (p: {
    pantry: boolean;
    sections: Section[];
    list: boolean;
    cards: boolean;
    settings: boolean;
    receipts: boolean;
    shops?: boolean;
    shopSections?: Section[];
  }) => void;
  pricesOn?: boolean;
  onPrices?: (v: boolean) => void;
  /** Exporting: include receipt photos. Restoring brings back whatever photos the file has. */
  photosOn?: boolean;
  onPhotos?: (v: boolean) => void;
  /** Restoring: shops and other settings are separate ticks. */
  restoring?: boolean;
}) {
  const sections = parts.pantry ? (parts.sections ?? SECTIONS) : [];
  const shopSections = parts.shops ? (parts.shopSections ?? counts.shopTabs ?? SECTIONS) : [];
  const set = (
    patch: Partial<{ sections: Section[]; list: boolean; cards: boolean; settings: boolean; receipts: boolean; shopSections: Section[] }>,
  ) => {
    const next = {
      sections,
      list: parts.list,
      cards: parts.cards,
      settings: parts.settings,
      receipts: !!parts.receipts,
      shopSections,
      ...patch,
    };
    onChange({ ...next, pantry: next.sections.length > 0, shops: next.shopSections.length > 0 });
  };
  const row = (key: string, title: string, detail: string, has: boolean, checked: boolean, toggle: (v: boolean) => void, indent = false) => (
    <label className="check" key={key} style={indent ? { paddingLeft: 28 } : undefined}>
      <input type="checkbox" checked={has && checked} disabled={!has} onChange={(e) => toggle(e.target.checked)} aria-label={title} />
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span className="title" style={{ fontSize: 14 }}>
          {title}
        </span>
        <span className="small">{has ? detail : 'Nothing to include'}</span>
      </span>
    </label>
  );
  const SHOP_WORD: Record<Section, string> = { pantry: 'supermarkets', keg: 'bottle shops', pharmacy: 'pharmacies' };
  const tabsWithItems = SECTIONS.filter((s) => counts.bySection[s] > 0);
  return (
    <div className="card flush">
      {SECTIONS.filter((s) => s === 'pantry' || counts.bySection[s] > 0).map((sec) =>
        row(
          `items-${sec}`,
          `${SECTION_NAMES[sec]} items`,
          `${plural(counts.bySection[sec], 'item')}, with their products and categories`,
          counts.bySection[sec] > 0,
          sections.includes(sec),
          (v) => set({ sections: v ? [...new Set([...sections, sec])] : sections.filter((x) => x !== sec) }),
        ),
      )}
      {onPrices &&
        counts.prices !== undefined &&
        row(
          'prices',
          'Price history',
          `${plural(counts.prices, 'saved price')} for the items above. Leave out for a much smaller file.`,
          counts.prices > 0 && tabsWithItems.some((s) => sections.includes(s)),
          !!pricesOn,
          onPrices,
          true,
        )}
      {row('list', 'Shopping lists', plural(counts.list, 'line'), counts.list > 0, parts.list, (v) => set({ list: v }))}
      {row('cards', 'Loyalty cards', `${plural(counts.cards, 'card')}, including card numbers`, counts.cards > 0, parts.cards, (v) =>
        set({ cards: v }),
      )}
      {(counts.receipts ?? 0) > 0 &&
        row(
          'receipts',
          'Receipts',
          `${plural(counts.receipts ?? 0, 'receipt')}: shop, date, total and the words read off them${
            !onPhotos && counts.photos ? `, with ${plural(counts.photos, 'photo')}` : ''
          }`,
          true,
          !!parts.receipts,
          (v) => set({ receipts: v }),
        )}
      {onPhotos &&
        (counts.photos ?? 0) > 0 &&
        row(
          'photos',
          'Receipt photos',
          `${plural(counts.photos ?? 0, 'photo')} Restock took of your receipts. These are Restock's own copies, not photos from your phone's gallery.`,
          !!parts.receipts,
          !!photosOn,
          onPhotos,
          true,
        )}
      {restoring ? (
        <>
          {(counts.shopTabs ?? []).map((sec) =>
            row(
              `shops-${sec}`,
              `${SECTION_NAMES[sec]} shops`,
              `Which ${SHOP_WORD[sec]} you use and your branches${sec === 'pantry' ? '' : `, and whether ${SECTION_NAMES[sec]} is on`}. Replaces this tab's shops only; the other tabs stay as they are.`,
              true,
              shopSections.includes(sec),
              (v) => set({ shopSections: v ? [...new Set([...shopSections, sec])] : shopSections.filter((x) => x !== sec) }),
            ),
          )}
          {row(
            'settings',
            'Other settings',
            'Alerts, colours, price checks, receipts and backup choices. Setup and this phone’s app icon stay as they are.',
            counts.hasSettings,
            parts.settings,
            (v) => set({ settings: v }),
          )}
        </>
      ) : (
        row(
          'settings',
          'Settings and shops',
          'Your shops and stores, alerts, theme, price checks and other settings',
          counts.hasSettings,
          parts.settings,
          (v) => set({ settings: v }),
        )
      )}
    </div>
  );
}

/** Export a backup: pick what goes in, then share the file. */
export function ExportSheet({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [counts, setCounts] = useState<PartCounts>();
  const [parts, setParts] = useState<ExportParts>(EVERYTHING);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void exportCounts().then((c) => {
      setCounts({ ...c, hasSettings: true });
      setParts((p) => ({
        ...p,
        sections: SECTIONS.filter((s) => c.bySection[s] > 0),
        pantry: SECTIONS.some((s) => c.bySection[s] > 0),
        list: c.list > 0,
        cards: c.cards > 0,
        receipts: c.receipts > 0,
        receiptPhotos: c.photos > 0,
      }));
    });
  }, []);
  const any = parts.pantry || parts.list || parts.cards || parts.settings || parts.receipts;
  const go = async () => {
    if (parts.cards && counts?.cards) {
      const ok = await confirmAction('Your backup includes your loyalty card numbers', {
        detail: 'Keep the file somewhere private, and only share it with people you trust.',
        action: 'Make the backup',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const name = await exportBackup(parts);
      onDone(`Backup ready: ${name}`);
      onClose();
    } catch (e) {
      setBusy(false);
      onDone(`Backup failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  return (
    <Sheet title="Export a backup" onClose={onClose}>
      <p className="small">Pick what goes in the file. Restoring it later only replaces the parts that are in it.</p>
      {counts && (
        <PartsPicker
          counts={counts}
          parts={parts}
          onChange={(p) => setParts((x) => ({ ...x, ...p }))}
          pricesOn={parts.prices}
          onPrices={(v) => setParts((x) => ({ ...x, prices: v }))}
          photosOn={parts.receiptPhotos}
          onPhotos={(v) => setParts((x) => ({ ...x, receiptPhotos: v }))}
        />
      )}
      <button className="btn primary block" disabled={!any || busy || !counts} onClick={go}>
        <Icon name="external" size={18} /> {busy ? 'Making the backup…' : 'Export'}
      </button>
    </Sheet>
  );
}
