import { useEffect, useState } from 'react';
import { backupJson, EVERYTHING, exportBackup, exportCounts, GIFT_NO_PASSWORD_WARNING, giftCardsUnlocked, type ExportParts } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { getSettings, priceHistorySpan } from '../../lib/db';
import { SECTION_NAMES, SECTIONS, type Section, slots } from '../../shops';
import { historyLabel, type Settings } from '../../types';
import { cardsCount } from '../../lib/giftCards';
import { canSendDirect, deviceLan, offerData, type Offer } from '../../lib/handover';
import { Icon, Sheet } from '../components';
import { PairingQr } from './Sync';

/** What can be picked in a backup, and how many of each there are. */
export interface PartCounts {
  bySection: Record<Section, number>;
  list: number;
  /** Loyalty cards and (0.9.6) gift cards together. */
  cards: number;
  /** 0.9.6 (cards): how many of `cards` are gift cards. */
  giftCards?: number;
  /** Saved prices; only offered when exporting. */
  prices?: number;
  /** Exporting (0.9.1): "Includes all the prices on this phone, back to …", for the price history tick. */
  pricesNote?: string;
  hasSettings: boolean;
  /** Kept receipts, and how many have a photo. */
  receipts?: number;
  photos?: number;
  /** Restoring: the tabs the backup has shops for. */
  shopTabs?: Section[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * 0.9.1: what a backup holds of the price history, said plainly: "Includes all the prices on this
 * phone, back to 3 May 2026 (you keep 6 months)." `span` from priceHistorySpan() (sample items don't count).
 */
export function pricesIn(settings: Pick<Settings, 'historyWeeks'>, span?: { count: number; oldest?: string }): string {
  const keep = `you keep ${historyLabel(settings.historyWeeks)}`;
  const t = span?.oldest ? Date.parse(span.oldest) : NaN;
  if (!span?.count || Number.isNaN(t)) return `Includes all the prices on this phone (${keep}).`;
  const day = new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  return `Includes all the prices on this phone, back to ${day} (${keep}).`;
}

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
        <span className="title" style={{ fontSize: 15 }}>
          {title}
        </span>
        <span className="small">{has ? detail : 'Nothing to include'}</span>
      </span>
    </label>
  );
  const SHOP_WORD: Record<Section, string> = { pantry: 'supermarkets', keg: 'bottle shops', pharmacy: 'pharmacies', baby: 'baby shops', pets: 'pet shops', ...slots('shops') };
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
          `${counts.pricesNote ? `${counts.pricesNote} ` : ''}${plural(counts.prices, 'saved price')} for the items above. Leave out for a much smaller file.`,
          counts.prices > 0 && tabsWithItems.some((s) => sections.includes(s)),
          !!pricesOn,
          onPrices,
          true,
        )}
      {row('list', 'Shopping lists', plural(counts.list, 'line'), counts.list > 0, parts.list, (v) => set({ list: v }))}
      {/* 0.9.6 (cards): "Cards" (was Loyalty cards): loyalty and gift cards, for the person themself. */}
      {row(
        'cards',
        'Cards',
        `${cardsCount(counts.cards - (counts.giftCards ?? 0), counts.giftCards ?? 0)}, including card numbers${counts.giftCards ? ', PINs and photos' : ''}`,
        counts.cards > 0,
        parts.cards,
        (v) => set({ cards: v }),
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
          'Your shops and branches, alerts, theme, price checks and other settings',
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
  // 0.9.0: lock the file with a password.
  const [lock, setLock] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const pwProblem = !lock ? undefined : pw.length < 8 ? 'At least 8 characters.' : pw !== pw2 ? 'The two don’t match yet.' : undefined;
  useEffect(() => {
    void Promise.all([exportCounts(), getSettings(), priceHistorySpan().catch(() => undefined)]).then(([c, s, span]) => {
      setCounts({ ...c, hasSettings: true, pricesNote: pricesIn(s, span) });
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
    if (parts.cards && counts?.cards && !lock) {
      const ok = await confirmAction(counts.giftCards ? 'Your backup includes your card numbers and gift card PINs' : 'Your backup includes your card numbers', {
        detail: 'Keep the file somewhere private, and only share it with people you trust. Or go back and turn on "Lock it with a password".',
        action: 'Make the backup',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const name = await exportBackup({ ...parts, password: lock ? pw : undefined });
      onDone(`File ready: ${name}`);
      onClose();
    } catch (e) {
      setBusy(false);
      onDone(`Export failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  // 0.14.0: or straight to another phone on the same Wi-Fi, once (lib/handover.ts).
  const [offer, setOffer] = useState<Offer>();
  const [sent, setSent] = useState<number>();
  const [sendError, setSendError] = useState<string>();
  const [handed, setHanded] = useState(false);
  useEffect(() => () => offer?.stop(), [offer]);
  const direct = canSendDirect();
  const send = async () => {
    if (parts.cards && counts?.cards) {
      const ok = await confirmAction(counts.giftCards ? 'This sends your card numbers and gift card PINs' : 'This sends your card numbers', {
        detail: 'Only send them to someone you trust with them. Or go back and untick Cards.',
        action: 'Send them',
      });
      if (!ok) return;
    }
    const lan = deviceLan();
    if (!lan) return;
    setBusy(true);
    setSendError(undefined);
    try {
      // Prices typed in by hand stay on this phone; the transfer itself is sealed, so no password.
      const text = await backupJson({ ...parts, password: undefined, serverPhotos: false, noTypedPrices: true });
      const name = (await getSettings()).household.name || 'A Restock phone';
      const o = await offerData(lan, text, { name }, (p) => setSent(p));
      setOffer(o);
      void o.done.then((how) => {
        if (how === 'sent') setHanded(true);
        else if (how === 'expired') {
          setOffer(undefined);
          setSendError('That code ran out. Make a new one to send it.');
        }
      });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (offer)
    return (
      <Sheet title="Send to another phone" onClose={onClose}>
        {handed ? (
          <>
            <div className="banner green" role="status">
              <strong>Sent</strong>
              <span style={{ fontSize: 13 }}>The other phone has it. There it picks what to bring in.</span>
            </div>
            <button className="btn primary block" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <li>Put the other phone on the same Wi-Fi as this one.</li>
              <li>
                In Restock on it, open <strong>Settings</strong>, then <strong>Sync and backups</strong>, and choose <strong>Import data</strong>, then{' '}
                <strong>From another phone</strong>.
              </li>
              <li>Scan this code with it. Keep this screen open until it says Sent.</li>
            </ol>
            <PairingQr code={offer.code} label="Code for the other phone to scan" />
            <p className="small" role="status" style={{ margin: 0 }}>
              {sent ? `Sending… ${Math.round(sent * 100)}%` : 'Waiting for the other phone… This code works once, for 10 minutes.'}
            </p>
            <button className="btn block" onClick={onClose}>
              Stop
            </button>
          </>
        )}
      </Sheet>
    );
  return (
    <Sheet title="Export data" onClose={onClose}>
      <p className="small">Pick what goes in. Then save it as a file, or send it straight to another phone.</p>
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
      <div className="card flush">
        <label className="check">
          <input type="checkbox" className="switch" checked={lock} onChange={(e) => setLock(e.target.checked)} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Lock it with a password
            </span>
            <span className="small">The whole file is encrypted on this phone. Without the password nobody can open it, including you.</span>
          </span>
        </label>
        {lock && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 14px 12px' }}>
            <input className="input" type="password" autoComplete="new-password" placeholder="Password" aria-label="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="Type it again"
              aria-label="Type the password again"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
            {pwProblem && (pw || pw2) && <span className="small">{pwProblem}</span>}
          </div>
        )}
      </div>
      {/* 0.9.6 (review M3): gift cards ticked, no password: say so plainly. */}
      {giftCardsUnlocked({ ...parts, password: lock ? pw : undefined }, counts?.giftCards ?? 0) && (
        <p className="banner red small" role="alert">
          <Icon name="alert" size={16} /> {GIFT_NO_PASSWORD_WARNING}
        </p>
      )}
      {sendError && (
        <p className="banner amber small" role="alert">
          {sendError}
        </p>
      )}
      <button className="btn primary block" disabled={!any || busy || !counts || !!pwProblem} onClick={go}>
        <Icon name="external" size={18} /> {busy ? 'Working…' : 'Save to a file'}
      </button>
      <button className="btn block" disabled={!any || busy || !counts || !direct} onClick={() => void send()}>
        <Icon name="phone" size={18} /> Send to another phone
      </button>
      <p className="small" style={{ margin: 0 }}>
        {direct
          ? 'Sending shows a code for the other phone to scan. It goes straight across your Wi-Fi, once: iPhone or Android, either way. Prices you typed in by hand stay on this phone.'
          : 'Sending straight to another phone works in the Restock app on Android, iPhone and iPad.'}
      </p>
    </Sheet>
  );
}
